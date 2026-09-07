/**
 * ExecutionHistory / RedactedRequestSnapshot / RedactedResponseSnapshot（§3.2 history/model）。
 * 类型本体在 packages/shared/src/types.ts（§4.1 冻结）；此处为 id 生成与预览上限常量。
 */
import type { ExecutionHistory } from '@dsh-api-client/shared'

export type { ExecutionHistory }

/** History 单条 bodyPreview 大小上限（U-N7：默认截断 64 KiB，可在 settings 调整）。 */
export const HISTORY_BODY_PREVIEW_LIMIT = 64 * 1024

export function createHistoryId(): string {
  return crypto.randomUUID()
}
