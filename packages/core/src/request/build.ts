/**
 * Build URL / headers（§7.3/§7.4，§3.2 request/build）。
 * 纯函数，零 I/O。URL ↔ Params 双向同步为互逆纯函数（TC-C-05）。
 * P0（实施设计 §2.2）：本文件另承载 Header 大小写辅助与「用户 Header 分组
 * primitive」（§5.4，http-client wire 转换共用），以及 Copy URL/cURL 的
 * 模板保留编码投影工具（§5.10，request/plan.ts 消费）。
 * canonical 合并（贡献来源/优先级/suppression）唯一出口在 request/plan.ts。
 */
import type { KeyValue } from '@dsh-api-client/shared'
import { TEMPLATE_PATTERN } from '../variables/parser.ts'

function splitUrl(url: string): { base: string; query: string; hash: string } {
  const hashIndex = url.indexOf('#')
  const withoutHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : ''
  const queryIndex = withoutHash.indexOf('?')
  if (queryIndex < 0) return { base: withoutHash, query: '', hash }
  return { base: withoutHash.slice(0, queryIndex), query: withoutHash.slice(queryIndex + 1), hash }
}

function encodePair(key: string, value: string): string {
  return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
}

function decodeComponent(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text // 容错：非法百分号序列按原文保留
  }
}

function enabledParams(params: KeyValue[]): KeyValue[] {
  // 空 key 行无意义，不进 URL；空 value 保留为 `k=`（TC-C-04）
  return params.filter((p) => p.enabled && p.key !== '')
}

export function serializeParams(params: KeyValue[]): string {
  return enabledParams(params)
    .map((p) => encodePair(p.key, p.value))
    .join('&')
}

/**
 * Build URL（TC-C-04）：把 enabled params 合并进 URL 现有 query——
 * 重复 key 全保留、空值保留 `k=`、百分号编码、disabled 不进 URL。
 * URL 中已有的 query 原样保留，params 追加其后。
 */
export function buildUrl(url: string, params: KeyValue[]): string {
  const { base, query, hash } = splitUrl(url)
  const extra = serializeParams(params)
  const merged = query === '' ? extra : extra === '' ? query : `${query}&${extra}`
  return merged === '' ? `${base}${hash}` : `${base}?${merged}${hash}`
}

/** URL → Params（双向同步方向一）：提取 query 为 KeyValue 表（enabled=true，重复 key 保留）。 */
export function urlToParams(url: string): KeyValue[] {
  const { query } = splitUrl(url)
  if (query === '') return []
  return query.split('&').map((pair) => {
    const eq = pair.indexOf('=')
    const key = eq < 0 ? pair : pair.slice(0, eq)
    const value = eq < 0 ? '' : pair.slice(eq + 1)
    return { key: decodeComponent(key), value: decodeComponent(value), enabled: true }
  })
}

/** Params → URL（双向同步方向二）：用 params 整体替换 URL 的 query 部分（hash 保留）。 */
export function paramsToUrl(url: string, params: KeyValue[]): string {
  const { base, hash } = splitUrl(url)
  const query = serializeParams(params)
  return query === '' ? `${base}${hash}` : `${base}?${query}${hash}`
}

/**
 * 双向同步幂等（§7.3；sweep 遗留 #3 的修复点）：URL bar 与 params 表格互为镜像
 * （url.query 恰为 enabled params 的序列化——urlToParams/paramsToUrl 同步的不变量）
 * 时，执行/落库前剥离 URL 自带 query，由 params 单一承载——否则 resolveRequest 的
 * buildUrl 合并会把同一 key 复制成双份（`?x=1&x=1`）。
 * 非镜像（手写的 url query 与独立 params 合并语义，TC-C-04）原样返回；
 * params 表格内的合法重复 key 不受影响（它们经 serializeParams 全保留）。
 */
export function collapseMirroredQuery(url: string, params: KeyValue[]): string {
  const mirrored = serializeParams(urlToParams(url))
  if (mirrored === '' || mirrored !== serializeParams(params)) return url
  const { base, hash } = splitUrl(url)
  return `${base}${hash}`
}

/** 大小写不敏感 header 查找（§7.4）。 */
export function findHeader(headers: KeyValue[], name: string): KeyValue | undefined {
  const lower = name.toLowerCase()
  return headers.find((h) => h.key.toLowerCase() === lower)
}

export const DEFAULT_ACCEPT = '*/*'

/**
 * Build headers（TC-C-10 配套）：enabled headers（重复 header 保留），
 * 用户未显式设置时自动补 Content-Type（按 body 形态）与 Accept。
 *
 * P0 注：这是历史兼容投影（HeadersEditor 过渡期消费）；canonical 合并
 * （含 suppression/Auth 覆盖/runtime 状态）唯一出口是 request/plan.ts 的
 * buildRequestPlan——P0 起 Preview/Send 均不再经本函数，其规则是本文件
 * 冻结优先级（用户 > Body Content-Type > 默认 Accept，大小写不敏感）的
 * 无 suppression/无 Auth 子集，不得在此扩展第二套优先级。
 */
export function buildHeaders(headers: KeyValue[], contentType?: string): KeyValue[] {
  const out = headers.filter((h) => h.enabled && h.key !== '')
  if (contentType !== undefined && !findHeader(out, 'Content-Type')) {
    out.push({ key: 'Content-Type', value: contentType, enabled: true })
  }
  if (!findHeader(out, 'Accept')) {
    out.push({ key: 'Accept', value: DEFAULT_ACCEPT, enabled: true })
  }
  return out
}

/**
 * 用户 Header 分组 primitive（P0 §5.4，UX §6.3）：按 lowercase 名称聚合——
 * 保留第一行用户拼写作为分组名，值按原用户顺序收集。wire 转换
 * （executor/http-client headersToWire）与任何需要「大小写不敏感同名归组」
 * 的地方共用本函数；不得由于大小写差异创建两个 wire object keys。
 * 重复 Header 的实际 undici 行为由 tests/p0-undici-wire.spec.ts 集成固化。
 */
export function groupHeadersByLowerName(headers: KeyValue[]): Array<{ name: string; values: string[] }> {
  const order: string[] = []
  const byLower = new Map<string, { name: string; values: string[] }>()
  for (const h of headers) {
    const lower = h.key.toLowerCase()
    const hit = byLower.get(lower)
    if (hit === undefined) {
      const entry = { name: h.key, values: [h.value] }
      byLower.set(lower, entry)
      order.push(lower)
      continue
    }
    hit.values.push(h.value)
  }
  return order.map((lower) => byLower.get(lower)!)
}

/**
 * Copy URL / 安全 cURL 专用编码（P0 §5.10）：`{{name}}` 模板原样保留，
 * 其余文本按 URI 规则百分号编码——「复制 URL/安全 cURL 保留未解析普通变量」
 * （UX §6.4）。执行链（buildUrl）仍是先解析后全量编码，二者用途不同、互不影响。
 */
export function encodeKeepingTemplates(text: string): string {
  let out = ''
  let last = 0
  for (const match of text.matchAll(TEMPLATE_PATTERN)) {
    const index = match.index ?? text.length
    out += encodeURIComponent(text.slice(last, index)) + match[0]
    last = index + match[0].length
  }
  return out + encodeURIComponent(text.slice(last))
}

/** buildUrl 的 Copy 投影变体（P0 §5.10）：合并 enabled params 且 `{{name}}` 模板原样保留。 */
export function buildUrlKeepingTemplates(url: string, params: KeyValue[]): string {
  const { base, query, hash } = splitUrl(url)
  const extra = enabledParams(params)
    .map((p) => `${encodeKeepingTemplates(p.key)}=${encodeKeepingTemplates(p.value)}`)
    .join('&')
  const merged = query === '' ? extra : extra === '' ? query : `${query}&${extra}`
  return merged === '' ? `${base}${hash}` : `${base}?${merged}${hash}`
}

/**
 * 在 hash 前追加一段「原样（不百分号编码）」的 query 对——redaction 投影专用
 * （P0 §5.10：`api_key=<redacted>` 形态与 redactor.redactUrl 的 displayUrl
 * 约定一致，`<`/`>` 不得被编码）。
 */
export function appendRawQuery(url: string, rawPair: string): string {
  const { base, query, hash } = splitUrl(url)
  const merged = query === '' ? rawPair : `${query}&${rawPair}`
  return `${base}?${merged}${hash}`
}
