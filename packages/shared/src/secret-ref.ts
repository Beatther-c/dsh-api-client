/**
 * SecretRef（§4.1 / §4.3 / §14.2）：
 * - 持久化形态：`{ $ref: uuid }`，不编码任何明文信息；
 * - 展示形态：`<secret-ref:envKey>`，任何 UI/API/Agent 投影中一律展示不解析。
 *
 * 纯函数 + uuid 生成，零 I/O。
 */
import type { SecretRef } from './types.ts'

/** 生成稳定不透明 id 的 SecretRef（crypto.randomUUID，不编码明文）。 */
export function createSecretRef(id?: string): SecretRef {
  return { $ref: id ?? crypto.randomUUID() }
}

/** 类型守卫：`{ $ref: string }` 形态即 SecretRef。 */
export function isSecretRef(value: unknown): value is SecretRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { $ref?: unknown }).$ref === 'string' &&
    Object.keys(value as object).length === 1
  )
}

/**
 * 展示形态（§14.2 推荐）：`<secret-ref:envKey>`。
 * envKey 为环境变量 key（可含限定名，如 `prod.api_key`）。
 */
export function formatSecretRef(envKey: string): string {
  return `<secret-ref:${envKey}>`
}

const SECRET_REF_DISPLAY_PATTERN = /^<secret-ref:([^<>]+)>$/

/** 解析展示形态，返回 envKey；非展示形态返回 null。 */
export function parseSecretRefDisplay(text: string): string | null {
  const match = SECRET_REF_DISPLAY_PATTERN.exec(text)
  return match ? (match[1] ?? null) : null
}
