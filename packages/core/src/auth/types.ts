/**
 * AuthConfig 判别联合（§7.5 V0.1 五项）与类型守卫。
 * 联合本体定义于 packages/shared/src/types.ts（§4.1 冻结），此处提供操作侧的辅助类型。
 */
import type { AuthConfig } from '@dsh-api-client/shared'

export type { AuthConfig }

export type AuthType = AuthConfig['type']

export const AUTH_TYPES: readonly AuthType[] = ['none', 'bearer', 'basic', 'apikey', 'inherit']

export function isAuthType(value: unknown): value is AuthType {
  return typeof value === 'string' && (AUTH_TYPES as readonly string[]).includes(value)
}

export type BearerAuth = Extract<AuthConfig, { type: 'bearer' }>
export type BasicAuth = Extract<AuthConfig, { type: 'basic' }>
export type ApiKeyAuth = Extract<AuthConfig, { type: 'apikey' }>

/** auth 投影（redactor 输出形态）：只留 type，不留材料（TC-R-02/03）。 */
export interface AuthProjection {
  type: AuthType
}
