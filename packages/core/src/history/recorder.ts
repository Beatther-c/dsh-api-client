/**
 * History recorder（§3.2 history/recorder；§10.1 History Redactor）。
 * 由 ResolvedRequest + traces + HttpExecutionResult 生成**脱敏**历史记录——
 * 纯函数无 I/O；持久化（JSONL append）由 host history-service 负责。
 */
import type {
  AuthConfig,
  ExecutionHistory,
  HttpExecutionResult,
  ResolvedRequest,
} from '@dsh-api-client/shared'
import type { RedactionContext } from '../security/redactor.ts'
import { redactRequestSnapshot, redactResponseSnapshot } from '../security/redactor.ts'
import { createHistoryId, HISTORY_BODY_PREVIEW_LIMIT } from './model.ts'

export interface RecordExecutionInput {
  resolved: ResolvedRequest
  /** 有效 auth（inherit 链已消解）；投影只留 type。 */
  auth: AuthConfig
  result: HttpExecutionResult
  /** secretRef id → 执行期解析值（仅内存），供 redactor 定点替换。 */
  secretValues?: RedactionContext['secretValues']
  requestId?: string
  source: 'human' | 'agent' | 'runner'
  /** profile scope 强制（§4.1）。 */
  profileId: string
  environmentId?: string
  /** 用户声明的 response 敏感字段（JSON key，含嵌套）。 */
  sensitiveResponseFields?: readonly string[]
  /** 整体声明敏感 → bodyPreview 省略。 */
  responseBodySensitive?: boolean
  timestamp?: number
  id?: string
  bodyPreviewLimit?: number
}

function truncate(text: string | undefined, limit: number): string | undefined {
  if (text === undefined) return undefined
  return text.length > limit ? text.slice(0, limit) : text
}

/**
 * 生成脱敏历史记录（TC-C-20）：traced secret 位置全部 `<redacted>`，
 * 敏感头 `<redacted>`，auth 只留 type，response 用户声明字段按规则脱敏。
 */
export function recordExecution(input: RecordExecutionInput): ExecutionHistory {
  const ctx: RedactionContext = {}
  if (input.secretValues !== undefined) ctx.secretValues = input.secretValues

  const limit = input.bodyPreviewLimit ?? HISTORY_BODY_PREVIEW_LIMIT
  const requestSnapshot = redactRequestSnapshot(input.resolved, ctx, { auth: input.auth })
  const responseOptions: { sensitiveFields?: readonly string[]; wholeBodySensitive?: boolean } = {}
  if (input.sensitiveResponseFields !== undefined) responseOptions.sensitiveFields = input.sensitiveResponseFields
  if (input.responseBodySensitive !== undefined) responseOptions.wholeBodySensitive = input.responseBodySensitive
  const responseSnapshot = redactResponseSnapshot(input.result, ctx, responseOptions)

  const trimmedRequest = {
    ...requestSnapshot,
    ...(requestSnapshot.bodyPreview !== undefined
      ? { bodyPreview: truncate(requestSnapshot.bodyPreview, limit) }
      : {}),
  }
  const trimmedResponse = {
    ...responseSnapshot,
    ...(responseSnapshot.bodyPreview !== undefined
      ? { bodyPreview: truncate(responseSnapshot.bodyPreview, limit) }
      : {}),
  }

  return {
    id: input.id ?? createHistoryId(),
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    timestamp: input.timestamp ?? Date.now(),
    method: input.resolved.method,
    displayUrl: trimmedRequest.displayUrl,
    requestSnapshot: trimmedRequest,
    responseSnapshot: trimmedResponse,
    duration: input.result.durationMs,
    source: input.source,
    ...(input.environmentId !== undefined ? { environmentId: input.environmentId } : {}),
    profileId: input.profileId,
  }
}
