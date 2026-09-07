/**
 * Audit service（§3.4；§10/§24.4/AC-19）：执行审计落 `profiles/<pid>/audit.jsonl`。
 *
 * 每条记录：source identity（human/agent）、时间、目标 host、结论
 * （TC-API-11 / TC-SEC-10 的断言面）。message 入场前必须已脱敏
 * （调用方经 redaction-service；本服务不接触任何明文路径）。
 *
 * profile unresolved → fail-closed 显式报错（§4.4）。
 */
import type { HttpMethod } from '@dsh-api-client/shared'
import { profileLayout } from '@dsh-api-client/shared'
import { FileStore } from './storage/file-store.ts'
import { ProfileService } from './profile-service.ts'

export interface AuditEntry {
  timestamp: number
  /** 执行来源身份（auth.ts 从请求通道提取；§24.4 audit source identity）。 */
  source: 'human' | 'agent' | 'runner'
  method: HttpMethod
  /** 目标 host（不含凭据/路径——审计面最小化）。 */
  host: string
  outcome: 'success' | 'error'
  historyId?: string
  requestId?: string
  /** 错误消息（已脱敏）。 */
  error?: string
}

export class AuditService {
  constructor(
    private readonly store: FileStore,
    private readonly profile: ProfileService,
  ) {}

  private file(): string {
    return profileLayout(this.store.layout, this.profile.profileId).auditFile
  }

  record(entry: AuditEntry): void {
    this.profile.assertResolved('audit')
    this.store.initProfileDir(this.profile.profileId)
    this.store.appendJsonl(this.file(), entry)
  }

  /** 读全部审计记录（测试与 WP8 复核用）。 */
  list(): AuditEntry[] {
    this.profile.assertResolved('audit')
    return this.store.readJsonl<AuditEntry>(this.file())
  }
}
