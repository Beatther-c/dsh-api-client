/**
 * Secret store service（§3.4；REVIEW 中级 #1；AC-42）：
 * `shared/secrets/<id>.json` 的唯一读写出口（§8.2 高危核查点 7）。
 *
 * - 落盘即 chmod：目录 0700（init 时）、文件 0600（每次写入显式 chmod，TC-S-06）；
 * - SecretRecord 是唯一含明文的文件；解析结果只存在于执行期内存（§4.3），
 *   本服务不做任何缓存、不回写任何存储（TC-S-08）；
 * - 悬空 SecretRef（文件已删）在解析时显式报错，不静默置空（TC-S-09）。
 */
import type { SecretRecord, SecretRef } from '@dsh-api-client/shared'
import { SECRET_FILE_MODE, SECRETS_DIR_MODE, createSecretRef, secretRecordFile } from '@dsh-api-client/shared'
import type { SecretResolver } from '@dsh-api-client/core'
import { FileStore } from './storage/file-store.ts'

/** 悬空 SecretRef 解析错误（TC-S-09：env key 由解析链调用方补充上下文）。 */
export class DanglingSecretRefError extends Error {
  readonly code = 'dangling-secret-ref'
  /** router 统一错误映射（§5.1 错误格式）。 */
  readonly httpStatus = 400
  /** 持有该 ref 的环境变量 key（environment-service 解析链补充；缺省 = 来源未知）。 */
  readonly envKey?: string

  constructor(ref: SecretRef, envKey?: string) {
    super(
      envKey === undefined
        ? `secret ref "${ref.$ref}" has no stored record (deleted or never written)`
        : `secret ref "${ref.$ref}" for environment variable "${envKey}" has no stored record (deleted or never written)`,
    )
    this.name = 'DanglingSecretRefError'
    if (envKey !== undefined) this.envKey = envKey
  }
}

export class SecretStoreService {
  constructor(private readonly store: FileStore) {}

  private fileFor(ref: SecretRef): string {
    return secretRecordFile(this.store.layout, ref.$ref)
  }

  /** 写入明文 → 返回持有其 id 的 SecretRef（落盘 0600，目录确保 0700）。 */
  writeSecret(value: string): SecretRef {
    const ref = createSecretRef()
    const now = Date.now()
    const record: SecretRecord = { id: ref.$ref, value, createdAt: now, updatedAt: now }
    this.store.ensureDir(this.store.layout.secretsDir, SECRETS_DIR_MODE)
    this.store.writeJson(this.fileFor(ref), record, { mode: SECRET_FILE_MODE })
    return ref
  }

  /** 读取明文（唯一出口）。只在执行期内存中使用返回值；悬空 ref 显式报错。 */
  readSecret(ref: SecretRef): string {
    const record = this.store.readJson<SecretRecord>(this.fileFor(ref))
    if (record === undefined) throw new DanglingSecretRefError(ref)
    return record.value
  }

  /** 删除 secret 文件（不存在为 no-op——与 deleteEnvironment 级联删除幂等）。 */
  deleteSecret(ref: SecretRef): void {
    this.store.remove(this.fileFor(ref))
  }

  /**
   * core executor 注入形态（§4.3 解析链的唯一宿主出口）：
   * environment-service SecretRef → 本函数 → 执行期内存解析值。
   */
  readonly resolveSecret: SecretResolver = (ref: SecretRef): string => {
    return this.readSecret(ref)
  }
}
