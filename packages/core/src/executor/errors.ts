/**
 * 执行错误类型（§3.2 executor/errors）。
 * 约定：任何 error.message 出场（History / API / Agent / Log）前必经 redactor——
 * `sanitizeExecutionError` 是该约定的入口，executor 在 rethrow 前统一调用（TC-R-09）。
 */
import type { RedactionContext } from '../security/redactor.ts'
import { sanitizeErrorMessage } from '../security/redactor.ts'

export type ExecutorErrorKind =
  | 'invalid-request'
  | 'unresolved-variables'
  | 'permission-denied'
  | 'network-policy-denied'
  | 'timeout'
  | 'response-too-large'
  | 'too-many-redirects'
  | 'network'

export class ExecutorError extends Error {
  readonly kind: ExecutorErrorKind
  /** 结构化细节（如 response-too-large 的 limit/received），供调用方记录 size（TC-C-15）。 */
  readonly details?: Record<string, unknown>

  constructor(kind: ExecutorErrorKind, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'ExecutorError'
    this.kind = kind
    if (details !== undefined) this.details = details
  }
}

/**
 * 错误出场前的 redactor 约定入口：把已知 secret 解析值从 message 中抹除。
 * 原地改写 message（保留 stack / kind / details），返回原实例。
 */
export function sanitizeExecutionError<T>(error: T, ctx?: RedactionContext): T {
  if (error instanceof Error) {
    error.message = sanitizeErrorMessage(error.message, ctx)
  }
  return error
}
