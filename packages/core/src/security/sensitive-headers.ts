/**
 * §24.6 默认敏感头清单（大小写不敏感匹配，TC-R-01）。
 * 纯常量 + 纯函数。
 */

/** §24.6 五个默认敏感头（小写存储，匹配时大小写不敏感）。 */
export const DEFAULT_SENSITIVE_HEADERS = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'proxy-authorization',
] as const

/** 大小写不敏感敏感头判定；extra 为调用方追加的敏感头（同样大小写不敏感）。 */
export function isSensitiveHeader(name: string, extra?: readonly string[]): boolean {
  const lower = name.toLowerCase()
  if ((DEFAULT_SENSITIVE_HEADERS as readonly string[]).includes(lower)) return true
  return extra?.some((h) => h.toLowerCase() === lower) ?? false
}
