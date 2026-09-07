/**
 * File store（§3.4 services/storage/file-store；§4.2 写入纪律）：
 * - 所有 JSON 写入原子化（tmp + rename），中断不留半截文件（TC-S-10 的机制基础）；
 * - 目录初始化按 §4.2 树；`secrets/` 目录创建即 0700、secret 文件写入即 0600
 *   （显式 chmod，不依赖 umask，TC-S-06）；
 * - JSONL 逐行 append（history/audit），整文件重写用于 retention/clear。
 *
 * 本模块只做存储原语，不含任何业务语义；业务不变量（如 environments.json 的
 * SecretRef 断言）由各 service 在调用前保证。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { appendFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { StorageLayout } from '@dsh-api-client/shared'
import { SECRETS_DIR_MODE, profileLayout } from '@dsh-api-client/shared'

let tmpCounter = 0

export class FileStore {
  constructor(readonly layout: StorageLayout) {}

  /** 创建目录（recursive）；给出 mode 时显式 chmod（§4.2：umask 不可依赖）。 */
  ensureDir(dir: string, mode?: number): void {
    mkdirSync(dir, { recursive: true })
    if (mode !== undefined) chmodSync(dir, mode)
  }

  /**
   * §4.2 目录树初始化（TC-S-01）：root/shared/secrets(0700)/profiles/
   * profiles/unresolved/（§4.4 fail-closed 隔离目录）/imports。
   * resolved profile 的 profiles/<pid>/history/ 由 initProfileDir 落地。
   */
  initLayout(): void {
    this.ensureDir(this.layout.root)
    this.ensureDir(this.layout.sharedDir)
    this.ensureDir(this.layout.secretsDir, SECRETS_DIR_MODE)
    this.ensureDir(this.layout.profilesDir)
    this.ensureDir(this.layout.unresolvedProfileDir)
    this.ensureDir(this.layout.importsDir)
  }

  /** profile scope 目录初始化（history/ 子目录随 profile 目录一并建）。 */
  initProfileDir(profileId: string): void {
    const { profileDir } = profileLayout(this.layout, profileId)
    this.ensureDir(profileDir)
    this.ensureDir(`${profileDir}/history`)
  }

  exists(file: string): boolean {
    return existsSync(file)
  }

  /** 读 JSON；文件不存在返回 undefined，存在但非法 JSON 抛错（不静默吞）。 */
  readJson<T>(file: string): T | undefined {
    if (!existsSync(file)) return undefined
    return JSON.parse(readFileSync(file, 'utf8')) as T
  }

  /**
   * 原子写 JSON（tmp + rename）：tmp 文件与目标同目录（rename 不跨文件系统），
   * 可选 mode 在 rename 前 chmod（secret 文件 0600，§4.2）。
   */
  writeJson(file: string, value: unknown, options?: { mode?: number }): void {
    this.ensureDir(dirname(file))
    const tmp = `${file}.tmp-${process.pid}-${tmpCounter++}`
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
    if (options?.mode !== undefined) chmodSync(tmp, options.mode)
    renameSync(tmp, file)
  }

  /** JSONL 追加一行（同步写，低频次事件，突发退出不丢缓冲）。 */
  appendJsonl(file: string, record: unknown): void {
    this.ensureDir(dirname(file))
    appendFileSync(file, JSON.stringify(record) + '\n', 'utf8')
  }

  /** 读 JSONL 全部行；文件不存在返回空数组；空行跳过，非法行抛错。 */
  readJsonl<T>(file: string): T[] {
    if (!existsSync(file)) return []
    const text = readFileSync(file, 'utf8')
    const out: T[] = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      out.push(JSON.parse(line) as T)
    }
    return out
  }

  /** 原子重写 JSONL（retention 清理 / clear 用）。 */
  writeJsonl(file: string, records: unknown[]): void {
    this.ensureDir(dirname(file))
    const tmp = `${file}.tmp-${process.pid}-${tmpCounter++}`
    writeFileSync(tmp, records.map((r) => JSON.stringify(r)).join('\n') + (records.length > 0 ? '\n' : ''), 'utf8')
    renameSync(tmp, file)
  }

  /** 删除文件；不存在为 no-op。 */
  remove(file: string): void {
    rmSync(file, { force: true })
  }
}
