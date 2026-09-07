/**
 * Set-Cookie 解析（§8 Response Viewer Cookies tab；§3.2 response/cookies）。
 * 纯函数，零 I/O。
 */
import type { KeyValue } from '@dsh-api-client/shared'

export interface ParsedCookie extends KeyValue {
  /** Set-Cookie 属性（Path/Domain/Max-Age/Expires/SameSite…），原样保留。 */
  attributes: Record<string, string | true>
}

/**
 * 解析单条 Set-Cookie 头值：第一对 name=value 为 cookie 本体，其余为属性。
 * 解析失败（无 name）返回 undefined。
 */
export function parseSetCookie(headerValue: string): ParsedCookie | undefined {
  const segments = headerValue.split(';')
  const first = segments.shift()
  if (first === undefined) return undefined
  const eq = first.indexOf('=')
  const name = (eq < 0 ? first : first.slice(0, eq)).trim()
  if (name === '') return undefined
  const value = eq < 0 ? '' : first.slice(eq + 1).trim()
  const attributes: Record<string, string | true> = {}
  for (const segment of segments) {
    const attrEq = segment.indexOf('=')
    if (attrEq < 0) {
      const flag = segment.trim()
      if (flag !== '') attributes[flag] = true
    } else {
      attributes[segment.slice(0, attrEq).trim()] = segment.slice(attrEq + 1).trim()
    }
  }
  return { key: name, value, enabled: true, attributes }
}

/** 从响应头表提取全部 Set-Cookie（重复头逐条解析），输出 Cookies tab 数据。 */
export function extractCookies(headers: KeyValue[]): ParsedCookie[] {
  return headers
    .filter((h) => h.key.toLowerCase() === 'set-cookie')
    .map((h) => parseSetCookie(h.value))
    .filter((c): c is ParsedCookie => c !== undefined)
}

/** 压平为 KeyValue[]（HttpExecutionResult.cookies 形态）。 */
export function cookiesToKeyValues(headers: KeyValue[]): KeyValue[] {
  return extractCookies(headers).map((c) => ({ key: c.key, value: c.value, enabled: true }))
}
