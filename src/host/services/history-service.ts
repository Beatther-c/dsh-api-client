/**
 * History service（§3.4）：profile-scoped history 持久化
 * （`profiles/<pid>/history/history.jsonl` append + retention）。
 *
 * - 入口记录必须是 core history/recorder 生成的脱敏快照；本服务 append 前
 *   再经 redaction-service 统一出口过一道（§24.2「写入前必经 redaction-service」
 *   的纵深防御——对快照各字符串字段做最终脱敏，不改变结构）；
 * - profile unresolved → fail-closed 显式报错（§4.4）；
 * - retention：append 后按 retentionDays 清理旧条目（原子重写，TC-S-11）。
 */
import type { ExecutionHistory } from '@dsh-api-client/shared'
import { profileLayout } from '@dsh-api-client/shared'
import { FileStore } from './storage/file-store.ts'
import { ProfileService } from './profile-service.ts'
import { RedactionService } from './redaction-service.ts'

export interface HistoryListOptions {
  /** 默认 50，上限 500。 */
  limit?: number
  /** 分页游标：已跳过条数（字符串化 offset；按 timestamp 倒序切片）。 */
  cursor?: string
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 500

export class HistoryService {
  constructor(
    private readonly store: FileStore,
    private readonly profile: ProfileService,
    private readonly redaction: RedactionService,
    private readonly retentionDays: () => number,
  ) {
    // §4.2 首启目录树落地（TC-S-01）：resolved profile 的 profiles/<pid>/history/
    // 随服务装配创建；unresolved 时不建任何 <pid> 目录（fail-closed，§4.4）。
    if (this.profile.resolved) this.store.initProfileDir(this.profile.profileId)
  }

  private file(): string {
    return profileLayout(this.store.layout, this.profile.profileId).historyFile
  }

  /**
   * append 一条（必为脱敏快照）。写入前经 redaction-service 出口；
   * profile unresolved → ProfileUnresolvedError（fail-closed，§4.4）。
   */
  append(entry: ExecutionHistory): void {
    this.profile.assertResolved('history')
    this.store.initProfileDir(this.profile.profileId)
    this.store.appendJsonl(this.file(), this.reproject(entry))
    this.enforceRetention()
  }

  /** 脱敏快照的最终出口投影：快照内全部字符串字段过 redactor（结构不变）。 */
  private reproject(entry: ExecutionHistory): ExecutionHistory {
    const redact = (text: string): string => this.redaction.redactText(text)
    return {
      ...entry,
      displayUrl: redact(entry.displayUrl),
      requestSnapshot: {
        ...entry.requestSnapshot,
        displayUrl: redact(entry.requestSnapshot.displayUrl),
        headers: entry.requestSnapshot.headers.map((h) => ({ ...h, value: redact(h.value) })),
        ...(entry.requestSnapshot.bodyPreview !== undefined
          ? { bodyPreview: redact(entry.requestSnapshot.bodyPreview) }
          : {}),
      },
      responseSnapshot: {
        ...entry.responseSnapshot,
        headers: entry.responseSnapshot.headers.map((h) => ({ ...h, value: redact(h.value) })),
        ...(entry.responseSnapshot.bodyPreview !== undefined
          ? { bodyPreview: redact(entry.responseSnapshot.bodyPreview) }
          : {}),
      },
    }
  }

  /** 读全部（timestamp 倒序）。 */
  private readAll(): ExecutionHistory[] {
    return this.store.readJsonl<ExecutionHistory>(this.file()).sort((a, b) => b.timestamp - a.timestamp)
  }

  /** 列表（§5.1 端点 22：limit/cursor 切片后的脱敏快照数组）。 */
  list(options: HistoryListOptions = {}): ExecutionHistory[] {
    this.profile.assertResolved('history')
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
    const offset = options.cursor !== undefined ? Number.parseInt(options.cursor, 10) : 0
    return this.readAll().slice(Number.isNaN(offset) ? 0 : offset, (Number.isNaN(offset) ? 0 : offset) + limit)
  }

  get(id: string): ExecutionHistory | undefined {
    this.profile.assertResolved('history')
    return this.readAll().find((e) => e.id === id)
  }

  /** 清空（§5.1 端点 24，human-only 语义由调用方保证；原子重写为空文件）。 */
  clear(): void {
    this.profile.assertResolved('history')
    this.store.writeJsonl(this.file(), [])
  }

  /** retention：超过 retentionDays 的条目清理（原子重写，TC-S-11）。 */
  private enforceRetention(): void {
    const days = this.retentionDays()
    if (!Number.isFinite(days) || days <= 0) return
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
    const all = this.store.readJsonl<ExecutionHistory>(this.file())
    const kept = all.filter((e) => e.timestamp >= cutoff)
    if (kept.length !== all.length) this.store.writeJsonl(this.file(), kept)
  }
}
