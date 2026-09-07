/**
 * 全链路 Redactor（§24.2 / §24.6，§3.2 security/redactor）。
 *
 * 覆盖：History / Agent Context / Logs / Import Report / Error Message / Telemetry / Debug dump。
 * 敏感位置：Headers / Cookies / Query / URL / Auth config / JSON·Form Body / Environment /
 * Response 用户声明字段 / SecretRef 展示形态。
 *
 * 替换策略：
 * - 敏感头（§24.6，大小写不敏感）→ 值整体替换为 `<redacted>`；
 * - 已知 secret 解析值（secretValueTraces 对应值）→ 在其出现的任何字符串中原样替换
 *   （URL 同时尝试 encodeURIComponent 形态），天然覆盖 userinfo/path/query/嵌套 JSON；
 * - apikey in query → URL 中该参数值 `<redacted>`，其余 query 保留；
 * - response 用户声明敏感字段 → `<redacted>`（嵌套 JSON 逐层匹配 key）；整体敏感 → bodyPreview 省略；
 * - SecretRef 投影一律 `<secret-ref:envKey>`，不解析。
 *
 * 纯函数，零 I/O。
 */
import type {
  AuthConfig,
  BodyConfig,
  CollectionSummary,
  Environment,
  ExecutionMetadata,
  HttpExecutionResult,
  HttpMethod,
  KeyValue,
  RedactedRequestSnapshot,
  RedactedResponseSnapshot,
  ResolvedRequest,
  SafeApiDebugContext,
  Variable,
} from '@dsh-api-client/shared'
import { formatSecretRef } from '@dsh-api-client/shared'
import { findHeader } from '../request/build.ts'
import type { AuthProjection } from '../auth/types.ts'
import { isSensitiveHeader } from './sensitive-headers.ts'

export const REDACTED = '<redacted>'

/** 脱敏上下文：secretRef id → 执行期解析值（仅内存，绝不持久化）；也可直接给值列表。 */
export interface RedactionContext {
  secretValues?: ReadonlyMap<string, string> | Record<string, string> | readonly string[]
  /** 调用方追加的敏感头（大小写不敏感）。 */
  extraSensitiveHeaders?: readonly string[]
}

function secretValueList(ctx: RedactionContext | undefined): string[] {
  const source = ctx?.secretValues
  if (!source) return []
  const values = source instanceof Map ? [...source.values()] : Object.values(source)
  // 长值优先，避免短值先替换破坏长值匹配
  return values.filter((v) => v !== '').sort((a, b) => b.length - a.length)
}

/** 通用文本脱敏：已知 secret 解析值全部替换为 `<redacted>`（Logs / Error / Import Report / dump 的统一出口）。 */
export function redactText(text: string, ctx?: RedactionContext): string {
  let out = text
  for (const value of secretValueList(ctx)) {
    out = out.split(value).join(REDACTED)
  }
  return out
}

/** 统一出域出口（§24.2：所有出域字符串经此过一道；TC-R-12 的钩子形态）。 */
export function redactOutboundText(text: string, ctx?: RedactionContext): string {
  return redactText(text, ctx)
}

/** Headers 脱敏：§24.6 敏感头整体 `<redacted>`；其余头值中的 secret 解析值片段替换。 */
export function redactHeaders(headers: KeyValue[], ctx?: RedactionContext): KeyValue[] {
  return headers.map((h) => {
    if (isSensitiveHeader(h.key, ctx?.extraSensitiveHeaders)) {
      return { ...h, value: REDACTED }
    }
    return { ...h, value: redactText(h.value, ctx) }
  })
}

export interface RedactUrlOptions {
  /** 有效 auth 配置（apikey in query 时按 key 定点脱敏，其余 query 保留——TC-R-04）。 */
  auth?: AuthConfig
}

function redactApiKeyQueryParam(url: string, key: string): string {
  const hashIndex = url.indexOf('#')
  const withoutHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : ''
  const queryIndex = withoutHash.indexOf('?')
  if (queryIndex < 0) return url
  const base = withoutHash.slice(0, queryIndex)
  const query = withoutHash.slice(queryIndex + 1)
  const redactedQuery = query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=')
      const rawKey = eq < 0 ? pair : pair.slice(0, eq)
      let decodedKey = rawKey
      try {
        decodedKey = decodeURIComponent(rawKey)
      } catch {
        // 非法编码按原文比较
      }
      if (decodedKey !== key) return pair
      return eq < 0 ? `${rawKey}=${REDACTED}` : `${rawKey}=${REDACTED}`
    })
    .join('&')
  return `${base}?${redactedQuery}${hash}`
}

/**
 * URL 脱敏（TC-R-04/05）：
 * - secret 解析值（含 encodeURIComponent 形态）在 userinfo / path / query 中出现 → `<redacted>`；
 * - apikey in query → 该参数值 `<redacted>`，其余保留。
 */
export function redactUrl(url: string, ctx?: RedactionContext, options?: RedactUrlOptions): string {
  let out = url
  for (const value of secretValueList(ctx)) {
    out = out.split(value).join(REDACTED)
    const encoded = encodeURIComponent(value)
    if (encoded !== value) out = out.split(encoded).join(REDACTED)
  }
  if (options?.auth?.type === 'apikey' && options.auth.in === 'query') {
    out = redactApiKeyQueryParam(out, options.auth.key)
  }
  return out
}

/** Auth 投影：只留 type，不留材料（TC-R-02/03）。 */
export function redactAuthConfig(auth: AuthConfig): AuthProjection {
  return { type: auth.type }
}

function bodyToText(body: string | Uint8Array): string {
  return typeof body === 'string' ? body : new TextDecoder().decode(body)
}

/** Body 预览脱敏（TC-R-06）：secret 解析值（含嵌套 JSON 路径中的出现）→ `<redacted>`。 */
export function redactBodyText(bodyText: string, ctx?: RedactionContext): string {
  return redactText(bodyText, ctx)
}

/**
 * Response body 用户声明敏感字段脱敏（TC-R-07）：
 * JSON 可解析时按 key 名逐层（含嵌套）替换为 `<redacted>`；不可解析时退回文本替换。
 */
export function redactSensitiveJsonFields(bodyText: string, sensitiveFields: readonly string[]): string {
  if (sensitiveFields.length === 0) return bodyText
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    return bodyText
  }
  const fields = new Set(sensitiveFields)
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (typeof node === 'object' && node !== null) {
      for (const [key, value] of Object.entries(node)) {
        if (fields.has(key)) {
          ;(node as Record<string, unknown>)[key] = REDACTED
        } else {
          walk(value)
        }
      }
    }
  }
  walk(parsed)
  return JSON.stringify(parsed, null, 2)
}

export interface RedactResponseBodyOptions {
  /** 用户声明的敏感字段名（JSON key，含嵌套）。 */
  sensitiveFields?: readonly string[]
  /** 整体声明敏感：bodyPreview 省略（TC-R-07 后段）。 */
  wholeBodySensitive?: boolean
}

/** Response bodyPreview 脱敏：整体敏感 → undefined（省略）；否则字段级 + secret 值替换。 */
export function redactResponseBodyPreview(
  bodyText: string,
  ctx?: RedactionContext,
  options?: RedactResponseBodyOptions,
): string | undefined {
  if (options?.wholeBodySensitive) return undefined
  let out = bodyText
  if (options?.sensitiveFields !== undefined && options.sensitiveFields.length > 0) {
    out = redactSensitiveJsonFields(out, options.sensitiveFields)
  }
  return redactText(out, ctx)
}

/** 请求脱敏快照（History / Agent Context 共用形态）。 */
export function redactRequestSnapshot(
  resolved: ResolvedRequest,
  ctx?: RedactionContext,
  options?: RedactUrlOptions,
): RedactedRequestSnapshot {
  return {
    method: resolved.method,
    displayUrl: redactUrl(resolved.url, ctx, options),
    headers: redactHeaders(resolved.headers, ctx),
    ...(resolved.body !== undefined
      ? { bodyPreview: redactBodyText(bodyToText(resolved.body), ctx) }
      : {}),
    auth: options?.auth !== undefined ? redactAuthConfig(options.auth) : { type: 'none' },
  }
}

/** 响应脱敏快照（Set-Cookie 属 §24.6 敏感头，随 headers 一并脱敏）。 */
export function redactResponseSnapshot(
  result: HttpExecutionResult,
  ctx?: RedactionContext,
  options?: RedactResponseBodyOptions,
): RedactedResponseSnapshot {
  const preview = redactResponseBodyPreview(result.bodyText, ctx, options)
  return {
    status: result.status,
    statusText: result.statusText,
    headers: redactHeaders(result.headers, ctx),
    ...(preview !== undefined ? { bodyPreview: preview } : {}),
    size: result.size,
    durationMs: result.durationMs,
  }
}

/** SecretRef 投影（TC-R-08）：secret 变量一律展示 `<secret-ref:envKey>`，不解析。 */
export function projectVariable(variable: Variable): Variable {
  if (variable.secret) {
    return { ...variable, currentValue: formatSecretRef(variable.key) }
  }
  return { ...variable }
}

/** Environment 投影：secret 变量 currentValue → `<secret-ref:envKey>` 字符串，绝不解析。 */
export function projectEnvironment(environment: Environment): Environment {
  return { ...environment, variables: environment.variables.map(projectVariable) }
}

/** error.message 出场前必经（§24.2 Error Message 面；executor/errors 的约定入口背后实现）。 */
export function sanitizeErrorMessage(message: string, ctx?: RedactionContext): string {
  return redactText(message, ctx)
}

/** 供调用方从响应头取 content-type 的小工具（executor 内部用）。 */
export function responseContentType(headers: KeyValue[]): string | undefined {
  return findHeader(headers, 'content-type')?.value
}

// ---- Agent Context（§14 / V01 §5.3，WP7）：SafeApiDebugContext 构建与出域渲染 ----
//
// 安全论证（为什么本结构的每条数据流都不含明文）：
// - client 侧持有的全部是 host 的脱敏投影：request 投影的 auth 材料已是 `<redacted>`
//   占位或不透明 SecretRef（redaction-service.projectAuth），environment 投影的 secret
//   变量恒 `<secret-ref:key>` 字符串（projectEnvironment）；SecretRef 解析只发生在 host
//   执行期内存，client 永不回读（AC-32/AC-42）——因此 draft 中不存在任何已解析明文，
//   URL/headers/body 里最多是 `{{var}}` 模板与用户自填文本。
// - requestEcho 是 host /execute 返回的 RedactedRequestSnapshot：构建时带了执行期
//   secretValues 跟踪（secret 解析值在 URL/headers/body 中的出现已定点替换），是
//   比本地重建更强的脱敏面，存在时优先采用。
// - responseEcho（WP8 起随 /execute 下发）是 host 带执行期 secretValues 跟踪的脱敏响应
//   快照，存在时优先采用；缺省时回退 response 在本函数内经 redactResponseSnapshot：
//   Set-Cookie 等敏感头恒 `<redacted>`；body 属「被标记敏感的 response body」（§14.4），
//   默认 wholeBodySensitive 省略 bodyPreview，仅在用户弹窗勾选（includeResponseBody=true）后纳入。
// - 兜底：每个进入结构的自有文本（name/environmentName）与最终渲染文本都再过一道
//   redactOutboundText（§24.2 统一出域出口）；client 侧无 secretValues 时该调用是
//   结构性 no-op，但保证了任何未来带上 RedactionContext 的调用方自动获得全量替换。

/** Safe context 的请求侧输入：client draft 投影（auth 材料已是占位形态，绝无解析值）。 */
export interface SafeContextRequestDraft {
  method: HttpMethod
  url: string
  headers: KeyValue[]
  body: BodyConfig
  auth: AuthConfig
}

export interface BuildSafeApiDebugContextInput {
  /** 请求显示名（编辑器顶栏名称）。 */
  requestName: string
  /** 当前编辑器 draft 投影；无 requestEcho 时本地重建脱敏快照的数据源。 */
  draft: SafeContextRequestDraft
  /** host /execute 的脱敏请求快照（带 secretValues 跟踪，存在时优先于 draft 重建）。 */
  requestEcho?: RedactedRequestSnapshot
  /** execute 返回的原始 result；头与 body 在本函数内脱敏，无执行时缺省（仅发请求上下文）。
   *  responseEcho 存在时本字段不参与出域结构（本地脱敏无 secretValues 跟踪，弱于 host 快照）。 */
  response?: HttpExecutionResult
  /** host /execute 的脱敏响应快照（带执行期 secretValues 跟踪，WP8 起随端点 21 下发）：
   *  存在时优先于 response 本地脱敏——消除 response body 回显 secret 的残余面（WP8 小修 C-1）。 */
  responseEcho?: RedactedResponseSnapshot
  /** §14.4：敏感 response body 仅在用户弹窗主动勾选后纳入；缺省/false = 不注入。 */
  includeResponseBody?: boolean
  /** 只给名字，不给变量（§4.1）。 */
  environmentName?: string
  execution?: ExecutionMetadata
  collection?: CollectionSummary
}

/** draft body → 预览文本（urlencoded/form-data 取启用字段的 key=value 行；不脱敏之外不做改写）。 */
function draftBodyPreviewText(body: BodyConfig): string | undefined {
  switch (body.type) {
    case 'none':
      return undefined
    case 'raw':
      return body.raw
    case 'json':
      return body.json
    case 'urlencoded':
    case 'form-data': {
      const lines = body.fields.filter((f) => f.enabled).map((f) => `${f.key}=${f.value}`)
      return lines.length === 0 ? undefined : lines.join('\n')
    }
  }
}

/**
 * 由 client 侧已持有的投影数据构建 SafeApiDebugContext（§4.1；§5.3 全流程的 Redactor 环节）。
 * 纯函数，零 I/O；输出是唯一允许出域的形态，redactionSummary 直接驱动 §14.4 弹窗 ✓/✗ 清单。
 */
export function buildSafeApiDebugContext(input: BuildSafeApiDebugContextInput): SafeApiDebugContext {
  let snapshot: RedactedRequestSnapshot
  if (input.requestEcho !== undefined) {
    snapshot = input.requestEcho
  } else {
    const bodyPreview = draftBodyPreviewText(input.draft.body)
    snapshot = {
      method: input.draft.method,
      displayUrl: redactUrl(input.draft.url, undefined, { auth: input.draft.auth }),
      headers: redactHeaders(input.draft.headers),
      ...(bodyPreview !== undefined && bodyPreview !== '' ? { bodyPreview: redactBodyText(bodyPreview) } : {}),
      auth: redactAuthConfig(input.draft.auth),
    }
  }
  const request: SafeApiDebugContext['request'] = { ...snapshot, name: redactOutboundText(input.requestName) }

  const hasResponseBody =
    input.responseEcho !== undefined
      ? (input.responseEcho.bodyPreview ?? '') !== ''
      : input.response !== undefined && input.response.bodyText !== ''
  // §14.4：body 默认视为敏感不注入；勾选后显式纳入（仍过 redactResponseSnapshot 头/字段脱敏）。
  const includeBody = input.includeResponseBody === true && hasResponseBody
  let response: RedactedResponseSnapshot | undefined
  if (input.responseEcho !== undefined) {
    // host 跟踪脱敏快照优先（WP8 C-1）：secretValues 已在 host 执行期定点替换；
    // 未勾选 body 时省略 bodyPreview（与 wholeBodySensitive 同语义）。
    const echo = input.responseEcho
    response = includeBody
      ? echo
      : { status: echo.status, statusText: echo.statusText, headers: echo.headers, size: echo.size, durationMs: echo.durationMs }
  } else if (input.response !== undefined) {
    response = redactResponseSnapshot(input.response, undefined, { wholeBodySensitive: !includeBody })
  }

  const environmentName =
    input.environmentName !== undefined && input.environmentName !== ''
      ? redactOutboundText(input.environmentName)
      : undefined

  // §14.4 确认弹窗 ✓/✗ 清单数据源（动态生成，非硬编码文案）。
  const redactionSummary: string[] = []
  redactionSummary.push('✓ Request metadata：method / URL / headers / body（敏感头与 apikey in query 恒 <redacted>）')
  if (request.auth.type !== 'none') {
    redactionSummary.push(`✓ Auth 类型：${request.auth.type}（仅类型；材料一律不发送）`)
  }
  if (response !== undefined) {
    redactionSummary.push('✓ Response metadata：status / headers / timing（Set-Cookie 等敏感头恒 <redacted>）')
    if (hasResponseBody) {
      redactionSummary.push(
        includeBody
          ? '✓ Response body：用户勾选纳入（脱敏投影）'
          : '✗ Response body：默认不发送（勾选「包含 response body」后纳入）',
      )
    }
  }
  if (environmentName !== undefined) {
    redactionSummary.push(`✓ Environment 名称：${environmentName}（仅名字，变量与值一律不发送）`)
  }
  if (input.execution !== undefined) {
    redactionSummary.push('✓ Execution metadata：historyId / durationMs / source')
  }
  redactionSummary.push('✗ Secret 明文：无条件不发送（SecretRef 恒 <secret-ref:key> 展示形态，绝不解析）')
  redactionSummary.push('✗ Auth 材料 / Environment 变量值：一律不发送')

  return {
    ...(input.collection !== undefined ? { collection: input.collection } : {}),
    request,
    ...(response !== undefined ? { response } : {}),
    ...(environmentName !== undefined ? { environmentName } : {}),
    ...(input.execution !== undefined ? { execution: input.execution } : {}),
    redactionSummary,
  }
}

/**
 * Safe context → composer 注入用的 Markdown 摘要（§5.3：请求/响应/环境名/脱敏标记）。
 * 输入必须已是 buildSafeApiDebugContext 的输出；最终文本再过一道 redactOutboundText。
 */
export function renderSafeApiDebugContextMarkdown(safe: SafeApiDebugContext): string {
  const lines: string[] = []
  lines.push('## API 调试上下文（dsh-api-client · 已脱敏）')
  lines.push('')
  if (safe.collection !== undefined) {
    lines.push(`**Collection**: ${safe.collection.name}（${safe.collection.requestCount} requests）`)
  }
  lines.push(`**Request**: \`${safe.request.method}\` ${safe.request.displayUrl}`)
  lines.push(`- name: ${safe.request.name}`)
  if (safe.request.headers.length > 0) {
    lines.push('- headers:')
    for (const header of safe.request.headers) {
      lines.push(`  - ${header.key}: ${header.value}`)
    }
  }
  if (safe.request.bodyPreview !== undefined && safe.request.bodyPreview !== '') {
    lines.push('- body:')
    lines.push('```')
    lines.push(safe.request.bodyPreview)
    lines.push('```')
  }
  lines.push(`- auth: ${safe.request.auth.type}`)
  if (safe.response !== undefined) {
    lines.push('')
    lines.push(
      `**Response**: \`${safe.response.status} ${safe.response.statusText}\` · ${safe.response.durationMs} ms · ${safe.response.size} B`,
    )
    if (safe.response.headers.length > 0) {
      lines.push('- headers:')
      for (const header of safe.response.headers) {
        lines.push(`  - ${header.key}: ${header.value}`)
      }
    }
    if (safe.response.bodyPreview !== undefined && safe.response.bodyPreview !== '') {
      lines.push('- body（已脱敏）:')
      lines.push('```')
      lines.push(safe.response.bodyPreview)
      lines.push('```')
    } else {
      lines.push('- body: （未包含 —— 敏感 response body 默认不发送）')
    }
  }
  if (safe.environmentName !== undefined) {
    lines.push('')
    lines.push(`**Environment**: ${safe.environmentName}（仅名称，变量不发送）`)
  }
  if (safe.execution !== undefined) {
    lines.push(
      `**Execution**: historyId=${safe.execution.historyId} · durationMs=${safe.execution.durationMs} · source=${safe.execution.source}`,
    )
  }
  lines.push('')
  lines.push('**出域清单（redactionSummary）**:')
  for (const item of safe.redactionSummary) {
    lines.push(`- ${item}`)
  }
  return redactOutboundText(lines.join('\n'))
}
