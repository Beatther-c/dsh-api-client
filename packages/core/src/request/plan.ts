/**
 * canonical buildRequestPlan（P0 实施设计 §5；UX §6.3/§6.4 的唯一权威合并 primitive）。
 *
 * §5.1 目标：Preview 与 Send 不再各自持有一套合并算法——贡献来源、优先级、
 * suppression、Header 名称比较、Query API Key 冲突、Body→Content-Type、
 * Auth→Header|Query、default Accept、runtime catalog 全部只在本文件计算一次。
 * 两模式唯一差异 = 变量与 SecretRef 如何 materialize（§5.1/§5.2）：
 *
 * - preview：不解析任何变量/SecretRef（绝不调用 resolveSecret）；敏感项
 *   valuePreview 恒 SECRET_VALUE_PREVIEW；未解析普通变量保留 `{{name}}`；
 *   form-data boundary 显示占位符（§5.7 不伪造最终值）；输出不含任何可恢复
 *   secret 的材料（PROJECT.md 红线 3）。
 * - resolved：变量按 §7.2 优先级链（Local > Environment > Collection）解析、
 *   SecretRef 经注入的 resolveSecret 解析并记入 secretValueTraces，产出
 *   ResolvedRequest（executor → undici 链消费）+ 同一份安全 preview 投影
 *  （§8.1.1 wire 一致性测试的对比基准）。
 *
 * 冻结优先级（§5.3/UX §6.3）：
 *   启用用户 Header > 未被 suppression 的 Auth/Body 生成值
 *     > 未被 suppression 的客户端默认值 > 网络运行时最终值
 *   disabled 用户行不参与覆盖、也不阻止生成。
 *
 * 本文件同时承载（§5.10/§3.3）：
 * - suppression 规范化纯函数：读取侧宽容（sanitize）+ 写入侧严格（normalize，
 *   供 Host 端点 WP3/WP8 复用；校验发生在 host API 层，core 只提供纯函数）；
 * - Copy URL / 安全 cURL 纯函数（WP5/WP8 消费）：POSIX 单引号转义、secret
 *   一律 <redacted>、普通用户字面量按用户主动复制行为允许（UX §6.4）。
 *
 * 原 variables/resolver 的解析机器（TemplateResolver 等）与 auth/apply 的
 * inherit 链/Auth 材料 materialize 已并入本文件（§2.2「将变量解析能力接入
 * canonical plan」）；resolver.ts / apply.ts 保留兼容 wrapper，最终都调用
 * 这里的同一 primitive——不允许存在第二套优先级算法。
 *
 * 零 DSH/React import；本文件为纯函数（网络 I/O 仍只在 executor/http-client）。
 */
import type {
  ApiRequest,
  AuthConfig,
  BodyConfig,
  Collection,
  CollectionVariable,
  Environment,
  GeneratedHeaderPreview,
  GeneratedItemSource,
  GeneratedItemStatus,
  GeneratedQueryPreview,
  KeyValue,
  RequestPlanPreview,
  ResolvedRequest,
  SecretRef,
  SecretTrace,
  SuppressedGeneratedHeader,
  SuppressibleGeneratedHeaderSource,
} from '@dsh-api-client/shared'
import { isSecretRef } from '@dsh-api-client/shared'
import { extractVariables, replaceVariables } from '../variables/parser.ts'
import {
  appendRawQuery,
  buildUrl,
  buildUrlKeepingTemplates,
  collapseMirroredQuery,
  DEFAULT_ACCEPT,
  encodeKeepingTemplates,
  urlToParams,
} from './build.ts'
import type { SerializedBody } from './body.ts'
import { bodyContentType, serializeBody } from './body.ts'
import { REDACTED } from '../security/redactor.ts'
import { isSensitiveHeader } from '../security/sensitive-headers.ts'

// ---- 常量（§4.1.2/§5.7/§0.6）----

/** 敏感项 valuePreview 的唯一占位（§4.1.2：真实值不得进任何隐藏属性/title——红线 3）。 */
export const SECRET_VALUE_PREVIEW = '••••••••'

/** runtime 项 valuePreview 的唯一占位（§0.6：能确定来源但发送时才决定 → 显示「发送时计算」，不伪造最终值）。 */
export const RUNTIME_VALUE_PREVIEW = '发送时计算'

/** §3.3：允许的持久化 suppression source 只有 body / client-default（auth/runtime 不提供 checkbox，§5.8）。 */
const SUPPRESSIBLE_SOURCES: readonly string[] = ['body', 'client-default']

// ---- runtime catalog（§0.6 + §8.1.2）----

export interface RuntimeHeaderSpec {
  /** 展示拼写。 */
  name: string
  /** 适用条件：'always' 每个请求；'has-body' 仅当本次发送存在 body。 */
  appliesWhen: 'always' | 'has-body'
  /**
   * 用户同名 Header 是否可真实覆盖（经 undici 探测固化）。
   * true → 用户同名 enabled 行存在时 status='overridden'；
   * false → status='invalid-user-override'（UX §6.3：不能用统一优先级作虚假承诺）。
   */
  userOverridable: boolean
}

/**
 * runtime Header catalog（§0.6/§8.1.2）：每一条都必须经 tests/p0-undici-wire.spec.ts
 * 对 undici@8.10.2（executeHop 同款 request() + headers 对象调用方式）的真实探测
 * 固化后才能收录；禁止因为「通常 HTTP 会这样」就硬编码展示。
 *
 * 探测结论（2026-09-10，undici@8.10.2，本地 node:http echo server）：
 * - host：每个请求实际发送 `host: <hostname:port>`；用户提供同名 Header 时被真实
 *   采用（server 收到用户值）→ userOverridable=true；
 * - content-length：存在 body 时由 undici 自动计算发送；用户同名值与 body 一致时
 *   被采用，不一致时抛 UND_ERR_REQ_CONTENT_LENGTH_MISMATCH（发送前清晰错误，符合
 *   UX §6.3「可覆盖或报清晰错误」）→ userOverridable=true；无 body 时 undici 不
 *   发送 content-length（用户提供的值也被 undici 丢弃）→ appliesWhen='has-body'；
 * - accept-encoding：undici request() 默认**不**自动添加（server 未收到）→ 不收录
 *  （§8.1.2：只有真实运行时行为才进 catalog）；用户显式行按普通用户 Header 发送；
 * - connection: keep-alive 每次由 undici 发送，但不在 §8.1.2 点名范围且未做用户
 *   覆盖探测 → P0 不收录（不扩宽冻结范围）。
 */
export const RUNTIME_HEADER_CATALOG: readonly RuntimeHeaderSpec[] = [
  { name: 'Host', appliesWhen: 'always', userOverridable: true },
  { name: 'Content-Length', appliesWhen: 'has-body', userOverridable: true },
]

// ---- 变量解析机器（自 variables/resolver.ts 并入；§7.2 优先级链，TC-C-02/03）----

/** 执行期由调用方注入的 secret 解析函数（core 不接触存储，§4.3 唯一出口在 host secret-store）。 */
export type SecretResolver = (ref: SecretRef) => string | Promise<string>

/** TC-C-03：未定义变量显式报错，变量名全列出（仅 resolved 模式；preview 永不因变量失败，UX §9）。 */
export class UnresolvedVariablesError extends Error {
  readonly variables: string[]

  constructor(variables: string[]) {
    super(`unresolved variable(s): ${variables.join(', ')}`)
    this.name = 'UnresolvedVariablesError'
    this.variables = variables
  }
}

/** plan 内部解析上下文（与 resolver.ts 的公开 ResolutionContext 同构；仅 resolved 模式使用）。 */
interface PlanResolutionContext {
  local?: Record<string, string>
  environment?: Environment
  collectionVariables?: CollectionVariable[]
  resolveSecret?: SecretResolver
}

interface LookupHit {
  value: string
  secretRefId?: string
}

class TemplateResolver {
  private readonly missing = new Set<string>()
  readonly traces: SecretTrace[] = []

  constructor(private readonly ctx: PlanResolutionContext) {}

  /** 优先级链：Local > Environment > Collection（§7.2，TC-C-02）。 */
  private async lookup(name: string): Promise<LookupHit | undefined> {
    const { local, environment, collectionVariables, resolveSecret } = this.ctx
    if (local !== undefined && Object.hasOwn(local, name)) {
      return { value: local[name] ?? '' }
    }
    const envVar = environment?.variables.find((v) => v.key === name && v.enabled)
    if (envVar) {
      if (isSecretRef(envVar.currentValue)) {
        if (!resolveSecret) {
          throw new Error(`secret variable "${name}" needs an injected resolveSecret`)
        }
        const value = await resolveSecret(envVar.currentValue)
        return { value, secretRefId: envVar.currentValue.$ref }
      }
      return { value: envVar.currentValue }
    }
    const collectionVar = collectionVariables?.find((v) => v.key === name && v.enabled)
    if (collectionVar) return { value: collectionVar.value }
    return undefined
  }

  async resolveTemplate(
    template: string,
    location: SecretTrace['location'],
    traceKey: (variableName: string) => string,
  ): Promise<string> {
    const values = new Map<string, string>()
    for (const name of extractVariables(template)) {
      const hit = await this.lookup(name)
      if (!hit) {
        this.missing.add(name)
        continue
      }
      values.set(name, hit.value)
      if (hit.secretRefId !== undefined) {
        this.traces.push({ location, key: traceKey(name), secretRef: hit.secretRefId })
      }
    }
    return replaceVariables(template, (name) => values.get(name))
  }

  get missingVariables(): string[] {
    return [...this.missing]
  }
}

async function resolveKeyValues(
  resolver: TemplateResolver,
  rows: KeyValue[],
  location: SecretTrace['location'],
): Promise<KeyValue[]> {
  const out: KeyValue[] = []
  for (const row of rows) {
    if (!row.enabled) {
      out.push(row)
      continue
    }
    const key = await resolver.resolveTemplate(row.key, location, () => row.key)
    const value = await resolver.resolveTemplate(row.value, location, () => row.key)
    out.push({ ...row, key, value })
  }
  return out
}

async function resolveBodyConfig(resolver: TemplateResolver, body: BodyConfig): Promise<BodyConfig> {
  switch (body.type) {
    case 'none':
      return body
    case 'raw':
      return { type: 'raw', raw: await resolver.resolveTemplate(body.raw, 'body', (name) => name) }
    case 'json':
      return { type: 'json', json: await resolver.resolveTemplate(body.json, 'body', (name) => name) }
    case 'form-data':
      return { type: 'form-data', fields: await resolveKeyValues(resolver, body.fields, 'body') }
    case 'urlencoded':
      return { type: 'urlencoded', fields: await resolveKeyValues(resolver, body.fields, 'body') }
  }
}

// ---- Auth 链与材料 materialize（自 auth/apply.ts 并入；§7.5/§5.5）----

/**
 * Inherit Auth From Parent：folder → collection 链向上查找（TC-C-09）。
 * V0.1 模型中 Folder 无 auth 字段（§4.1 冻结），链上唯一可提供 auth 的
 * 父级是 collection；folder 无 auth 时落到 collection.auth，再无则 none。
 */
export function resolveInheritedAuth(request: ApiRequest, collection?: Collection): AuthConfig {
  if (request.auth.type !== 'inherit') return request.auth
  if (collection?.auth !== undefined) return collection.auth
  return { type: 'none' }
}

function toBase64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}

async function resolveMaterial(
  material: string | SecretRef,
  resolveSecret: SecretResolver | undefined,
  trace: Omit<SecretTrace, 'secretRef'>,
): Promise<{ value: string; trace?: SecretTrace }> {
  if (!isSecretRef(material)) return { value: material }
  if (!resolveSecret) {
    throw new Error(`auth material "${trace.key}" is a SecretRef; an injected resolveSecret is required`)
  }
  const value = await resolveSecret(material)
  return { value, trace: { ...trace, secretRef: material.$ref } }
}

export interface MaterializedAuthTarget {
  /** Header 名或 Query 参数名（保留用户在 Auth 配置中的拼写）。 */
  name: string
  /** resolved 模式 = 真实材料；preview 模式 = 恒 SECRET_VALUE_PREVIEW（绝不解析）。 */
  value: string
}

export interface MaterializedAuthContribution {
  /** Header 贡献：bearer/basic → Authorization；apikey in header → auth.key（§5.5）。 */
  header?: MaterializedAuthTarget
  /** Query 贡献：apikey in query（§5.6，只进 RequestPlanPreview.query，不计入 header 数）。 */
  query?: MaterializedAuthTarget
  /** SecretRef 解析 trace（location 'auth'）；preview 模式恒空——从不解析。 */
  traces: SecretTrace[]
}

/**
 * Auth 贡献 materialize（两模式唯一差异点之二，§5.1）：
 * preview 模式绝不触碰 resolveSecret（红线 3：preview 输出不含可恢复 secret 材料），
 * 敏感值一律 SECRET_VALUE_PREVIEW；resolved 模式解析 SecretRef 并收集 trace。
 * 注意：Auth 材料中的 {{var}} 模板不做变量解析（与既有 applyAuth 语义一致，
 * 变量解析只覆盖 URL/params/headers/body——TC-C-06…08 冻结）。
 */
export async function materializeAuthContribution(
  auth: AuthConfig,
  mode: 'preview' | 'resolved',
  resolveSecret?: SecretResolver,
): Promise<MaterializedAuthContribution> {
  switch (auth.type) {
    case 'none':
      return { traces: [] }
    case 'inherit':
      throw new Error('resolve the inherit chain (resolveInheritedAuth) before applyAuth')
    case 'bearer': {
      if (mode === 'preview') {
        return { header: { name: 'Authorization', value: SECRET_VALUE_PREVIEW }, traces: [] }
      }
      const { value, trace } = await resolveMaterial(auth.token, resolveSecret, { location: 'auth', key: 'token' })
      return {
        header: { name: 'Authorization', value: `Bearer ${value}` },
        traces: trace !== undefined ? [trace] : [],
      }
    }
    case 'basic': {
      if (mode === 'preview') {
        return { header: { name: 'Authorization', value: SECRET_VALUE_PREVIEW }, traces: [] }
      }
      const { value: password, trace } = await resolveMaterial(auth.password, resolveSecret, {
        location: 'auth',
        key: 'password',
      })
      return {
        header: { name: 'Authorization', value: `Basic ${toBase64(`${auth.username}:${password}`)}` },
        traces: trace !== undefined ? [trace] : [],
      }
    }
    case 'apikey': {
      if (mode === 'preview') {
        const masked = { name: auth.key, value: SECRET_VALUE_PREVIEW }
        return auth.in === 'header' ? { header: masked, traces: [] } : { query: masked, traces: [] }
      }
      const { value, trace } = await resolveMaterial(auth.value, resolveSecret, { location: 'auth', key: auth.key })
      const target = { name: auth.key, value }
      return {
        ...(auth.in === 'header' ? { header: target } : { query: target }),
        traces: trace !== undefined ? [trace] : [],
      }
    }
  }
}

// ---- suppression 规范化（§3.3 + §5.8）----

/** P0 §3.3：写入侧严格校验失败（Host 端点 WP3/WP8 负责映射为 400；core 只提供纯函数与错误形态）。 */
export class SuppressedGeneratedHeadersValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SuppressedGeneratedHeadersValidationError'
  }
}

function dedupeKey(name: string, source: string): string {
  return `${name}\u0000${source}`
}

/**
 * 读取侧宽容规范化（§4.1.1 读取语义 `request.suppressedGeneratedHeaders ?? []`）：
 * name trim+lowercase；只保留 source ∈ {body, client-default} 的合法记录；
 * 非法记录静默丢弃（旧数据/脏数据不得让 preview 失败——UX §9「预览失败不阻断编辑」）；
 * (name, source) 去重。buildRequestPlan 合并前一律经本函数。
 */
export function sanitizeSuppressedGeneratedHeaders(
  input: readonly unknown[] | undefined,
): SuppressedGeneratedHeader[] {
  const out: SuppressedGeneratedHeader[] = []
  const seen = new Set<string>()
  for (const entry of input ?? []) {
    if (typeof entry !== 'object' || entry === null) continue
    const { name, source } = entry as { name?: unknown; source?: unknown }
    if (typeof name !== 'string') continue
    const normalized = name.trim().toLowerCase()
    if (normalized === '' || typeof source !== 'string' || !SUPPRESSIBLE_SOURCES.includes(source)) continue
    const key = dedupeKey(normalized, source)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ name: normalized, source: source as SuppressibleGeneratedHeaderSource })
  }
  return out
}

/**
 * 写入侧严格校验 + 规范化（§3.3 冻结规则，供 Host mutation 端点复用）：
 * 拒绝非数组 / 非对象条目 / 非字符串 name / 空 name（trim 后）/ 未知 source——
 * 特别地，source 'auth' 与 'runtime' 明确不可 suppression（§5.8）；
 * name = name.trim().toLowerCase()；同 (name, source) 去重。
 */
export function normalizeSuppressedGeneratedHeaders(input: unknown): SuppressedGeneratedHeader[] {
  if (!Array.isArray(input)) {
    throw new SuppressedGeneratedHeadersValidationError('suppressedGeneratedHeaders must be an array')
  }
  const out: SuppressedGeneratedHeader[] = []
  const seen = new Set<string>()
  for (const [index, entry] of input.entries()) {
    if (typeof entry !== 'object' || entry === null) {
      throw new SuppressedGeneratedHeadersValidationError(`suppressedGeneratedHeaders[${index}] must be an object`)
    }
    const { name, source } = entry as { name?: unknown; source?: unknown }
    if (typeof name !== 'string') {
      throw new SuppressedGeneratedHeadersValidationError(`suppressedGeneratedHeaders[${index}].name must be a string`)
    }
    const normalized = name.trim().toLowerCase()
    if (normalized === '') {
      throw new SuppressedGeneratedHeadersValidationError(`suppressedGeneratedHeaders[${index}].name must not be empty`)
    }
    if (typeof source !== 'string' || !SUPPRESSIBLE_SOURCES.includes(source)) {
      throw new SuppressedGeneratedHeadersValidationError(
        `suppressedGeneratedHeaders[${index}].source must be one of: ${SUPPRESSIBLE_SOURCES.join(', ')}`,
      )
    }
    const key = dedupeKey(normalized, source)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ name: normalized, source: source as SuppressibleGeneratedHeaderSource })
  }
  return out
}

// ---- 唯一合并 primitive（§5.3 九步；§5.4/§5.6/§5.8）----

export interface GeneratedContribution {
  /** 展示/wire 拼写（Content-Type / Accept / Authorization / auth.key 用户拼写）。 */
  name: string
  /** 已按模式 materialize 的值（preview 模式敏感项恒 SECRET_VALUE_PREVIEW；form-data CT 为占位模板）。 */
  value: string
  source: GeneratedItemSource
  sensitive: boolean
  /** 仅 body / client-default 为 true（§5.8：Auth/runtime 不提供 checkbox）。 */
  suppressible: boolean
}

export interface MergeContributionsInput {
  /** 用户 Header 行（已按模式 materialize；disabled 行在内部被过滤——不参与覆盖也不阻止生成，§5.3）。 */
  userHeaders: KeyValue[]
  /** 发送前贡献，顺序 = 冻结优先级：Body Content-Type → Auth Header → client-default Accept（§5.3）。 */
  contributions: GeneratedContribution[]
  /** 已规范化的 suppression 记录（sanitizeSuppressedGeneratedHeaders 输出）。 */
  suppression: readonly SuppressedGeneratedHeader[]
  /** Auth Query 贡献（apikey in query；值已按模式 materialize）。 */
  authQuery?: MaterializedAuthTarget
  /** 用户 URL/Params enabled 参数 key（§5.6 冲突判定；query 名按大小写敏感精确比较——RFC 3986 无大小写折叠）。 */
  userQueryKeys?: readonly string[]
  /** 已按适用性过滤的 runtime 条目（§0.6：只形成 projection，绝不进 wire、绝不预造最终 value）。 */
  runtime?: readonly RuntimeHeaderSpec[]
}

export interface MergeContributionsResult {
  /** wire Header 序列：enabled 用户行（原顺序、原拼写、重复行全保留）+ active 贡献（§5.3 步骤 7–8）。 */
  wireHeaders: KeyValue[]
  /** 进入 wire 的 Auth Query（overridden 时 undefined；调用方负责追加进 URL）。 */
  activeAuthQuery?: { key: string; value: string }
  /** Generated Header 预览项（含 runtime 条目；敏感项恒遮罩）。 */
  headerItems: GeneratedHeaderPreview[]
  /** Generated Query 预览项（只进 Params 页，不计入 header 数，§5.6）。 */
  queryItems: GeneratedQueryPreview[]
  /** 标题拆分「发送前 N 项 · 运行时 M 项」（UX §6.4；N+M = headers.length）。 */
  preSendHeaderCount: number
  runtimeHeaderCount: number
}

/**
 * §5.3 具体算法（冻结九步）：
 * 1. 收集所有 enabled user headers（空 key 行不进 wire）；
 * 2. 按 lowercase name 建 userHeaderNames（disabled 行不进入本集合）；
 * 3–5. Body / Auth / client-default 贡献由调用方按模式 materialize 后传入；
 * 6. 应用 suppression（(name, source) 精确匹配；同名不同来源互不误伤，UX §6.2）；
 * 7. userHeaderNames 已存在同名 → status='overridden'，不进 resolved wire；
 * 8. 其余 active Generated 进入 wire；
 * 9. runtime 只形成 projection，不预造最终 value。
 *
 * status 判定次序 = 步骤次序：suppressed 先于 overridden（被停用的行即使存在
 * 同名用户 Header 也显示「已停用」；用户 Header 删除后旧 suppression 继续生效，§5.8）。
 */
export function mergeContributions(input: MergeContributionsInput): MergeContributionsResult {
  // 步骤 1–2
  const enabledUser = input.userHeaders.filter((h) => h.enabled && h.key !== '')
  const userHeaderNames = new Set(enabledUser.map((h) => h.key.toLowerCase()))

  // 步骤 3–8：发送前贡献
  const wireHeaders: KeyValue[] = [...enabledUser]
  const headerItems: GeneratedHeaderPreview[] = []
  for (const contribution of input.contributions) {
    const lower = contribution.name.toLowerCase()
    let status: GeneratedItemStatus
    if (
      contribution.suppressible &&
      input.suppression.some((s) => s.name === lower && s.source === contribution.source)
    ) {
      status = 'suppressed'
    } else if (userHeaderNames.has(lower)) {
      status = 'overridden'
    } else {
      status = 'active'
    }
    if (status === 'active') {
      wireHeaders.push({ key: contribution.name, value: contribution.value, enabled: true })
    }
    headerItems.push({
      name: contribution.name,
      valuePreview: contribution.sensitive ? SECRET_VALUE_PREVIEW : contribution.value,
      source: contribution.source,
      status,
      sensitive: contribution.sensitive,
      suppressible: contribution.suppressible,
    })
  }

  // 步骤 9：runtime projection（不进 wire；用户同名时按探测固化的可覆盖性给状态，UX §6.3）
  let runtimeHeaderCount = 0
  for (const spec of input.runtime ?? []) {
    runtimeHeaderCount += 1
    const status: GeneratedItemStatus = userHeaderNames.has(spec.name.toLowerCase())
      ? spec.userOverridable
        ? 'overridden'
        : 'invalid-user-override'
      : 'runtime-pending'
    headerItems.push({
      name: spec.name,
      valuePreview: RUNTIME_VALUE_PREVIEW,
      source: 'runtime',
      status,
      sensitive: false,
      suppressible: false,
    })
  }

  // Query API Key（§5.6：独立于 Header 的冲突规则——URL/Params 存在至少一个 enabled
  // 同名用户参数 → overridden、不追加；只有 disabled 同名行时仍生成）。
  const queryItems: GeneratedQueryPreview[] = []
  let activeAuthQuery: { key: string; value: string } | undefined
  if (input.authQuery !== undefined) {
    const overridden = (input.userQueryKeys ?? []).includes(input.authQuery.name)
    queryItems.push({
      name: input.authQuery.name,
      valuePreview: SECRET_VALUE_PREVIEW,
      source: 'auth',
      status: overridden ? 'overridden' : 'active',
      sensitive: true,
    })
    if (!overridden) {
      activeAuthQuery = { key: input.authQuery.name, value: input.authQuery.value }
    }
  }

  return {
    wireHeaders,
    ...(activeAuthQuery !== undefined ? { activeAuthQuery } : {}),
    headerItems,
    queryItems,
    preSendHeaderCount: headerItems.length - runtimeHeaderCount,
    runtimeHeaderCount,
  }
}

// ---- buildRequestPlan（§5.2 推荐接口）----

export interface BuildRequestPlanOptions {
  /** preview = 安全投影（UI）；resolved = 执行链消费的 ResolvedRequest + plan 元数据。 */
  mode: 'preview' | 'resolved'
  environment?: Environment
  /** inherit auth 链 + collection 变量来源。 */
  collection?: Collection
  local?: Record<string, string>
  /** 仅 resolved 模式使用；preview 模式绝不调用（红线 3）。 */
  resolveSecret?: SecretResolver
  /** form-data 序列化 boundary 注入（测试确定性输出；Send 缺省由编码器随机生成，§5.7）。 */
  boundary?: string
}

export interface RequestPlanPreviewResult {
  mode: 'preview'
  /** 安全投影：敏感项恒遮罩、runtime 项恒「发送时计算」、不含任何可恢复 secret 材料。 */
  preview: RequestPlanPreview
  /** inherit 链消解后的有效 auth 类型（只留 type 投影，不留材料——RedactedRequestSnapshot.auth 同形态）。 */
  authType: AuthConfig['type']
}

export interface RequestPlanResolvedResult {
  mode: 'resolved'
  /** 与 preview 模式同一套安全投影规则（§8.1.1：wire 一致性测试的对比基准）。 */
  preview: RequestPlanPreview
  authType: AuthConfig['type']
  /** 变量/SecretRef 已 materialize + 已合并的 wire 形态（仅执行期内存，可含解析后的 secret）。 */
  resolved: ResolvedRequest
  /** 有效 auth（含材料/SecretRef）——executor 供 history recorder / redactor 投影用，绝不出域。 */
  effectiveAuth: AuthConfig
}

export type RequestPlan = RequestPlanPreviewResult | RequestPlanResolvedResult

/** §5.6：用户 Query key 集合 = URL 文本已有 query（恒视为 enabled）+ Params 表 enabled 行。 */
function userQueryKeysOf(url: string, params: KeyValue[]): string[] {
  return [
    ...urlToParams(url).map((p) => p.key),
    ...params.filter((p) => p.enabled && p.key !== '').map((p) => p.key),
  ]
}

/**
 * canonical request plan（§5.2/§13.4）：Headers/Params 预览（mode='preview'）与
 * Host Send（mode='resolved'）调用同一 primitive；两模式共享贡献来源/优先级/
 * suppression/名称比较/Query 冲突/Body→Content-Type/Auth→Header|Query/default
 * Accept/runtime catalog，唯一差异 = 变量与 SecretRef 的 materialize 方式。
 */
export async function buildRequestPlan(
  request: ApiRequest,
  options: BuildRequestPlanOptions & { mode: 'resolved' },
): Promise<RequestPlanResolvedResult>
export async function buildRequestPlan(
  request: ApiRequest,
  options: BuildRequestPlanOptions & { mode: 'preview' },
): Promise<RequestPlanPreviewResult>
export async function buildRequestPlan(
  request: ApiRequest,
  options: BuildRequestPlanOptions,
): Promise<RequestPlan>
export async function buildRequestPlan(
  request: ApiRequest,
  options: BuildRequestPlanOptions,
): Promise<RequestPlan> {
  // §5.8 + §4.1.1：读取语义 ?? []；宽容规范化（脏数据静默丢弃，preview 不阻断编辑）。
  const suppression = sanitizeSuppressedGeneratedHeaders(request.suppressedGeneratedHeaders ?? [])
  const effectiveAuth = resolveInheritedAuth(request, options.collection)

  // ---- 两模式差异点之一：变量 materialize（§5.1）----
  let userHeaders: KeyValue[]
  let userQueryKeys: string[]
  let bodyContributionValue: string | undefined
  let baseUrl = ''
  let serialized: SerializedBody = {}
  let templateTraces: SecretTrace[] = []
  if (options.mode === 'resolved') {
    const resolver = new TemplateResolver({
      local: options.local,
      environment: options.environment,
      collectionVariables: options.collection?.variables,
      resolveSecret: options.resolveSecret,
    })
    const urlTemplate = await resolver.resolveTemplate(request.url, 'url', (name) => name)
    const params = await resolveKeyValues(resolver, request.params, 'query')
    userHeaders = await resolveKeyValues(resolver, request.headers, 'header')
    const resolvedBody = await resolveBodyConfig(resolver, request.body)
    // TC-C-03：未定义变量显式报错并列出变量名（先于 auth 材料解析，与旧 resolveRequest→applyAuth 次序一致）。
    if (resolver.missingVariables.length > 0) {
      throw new UnresolvedVariablesError(resolver.missingVariables)
    }
    templateTraces = resolver.traces
    // §5.7：同一次 body encoder 生成 boundary，并同时写入 body 与 Content-Type。
    serialized = serializeBody(resolvedBody, options.boundary !== undefined ? { boundary: options.boundary } : {})
    bodyContributionValue = serialized.contentType
    baseUrl = buildUrl(urlTemplate, params)
    userQueryKeys = userQueryKeysOf(urlTemplate, params)
  } else {
    // preview：不解析任何变量/SecretRef——普通变量保留 {{name}}（§6.4），
    // form-data Content-Type 显示占位 boundary（§5.7 不伪造随机最终值）。
    userHeaders = request.headers
    bodyContributionValue = bodyContentType(request.body)
    userQueryKeys = userQueryKeysOf(request.url, request.params)
  }

  // ---- 两模式差异点之二：Auth materialize（preview 绝不触碰 resolveSecret）----
  const auth = await materializeAuthContribution(effectiveAuth, options.mode, options.resolveSecret)

  // ---- 贡献组装（顺序 = §5.3 冻结优先级：Body → Auth → client-default）----
  const contributions: GeneratedContribution[] = []
  if (bodyContributionValue !== undefined) {
    contributions.push({
      name: 'Content-Type',
      value: bodyContributionValue,
      source: 'body',
      sensitive: false,
      suppressible: true,
    })
  }
  if (auth.header !== undefined) {
    contributions.push({
      name: auth.header.name,
      value: auth.header.value,
      source: 'auth',
      sensitive: true,
      suppressible: false,
    })
  }
  contributions.push({
    name: 'Accept',
    value: DEFAULT_ACCEPT,
    source: 'client-default',
    sensitive: false,
    suppressible: true,
  })

  // ---- runtime 适用性（§0.6：只有真实会由 transport 计算的条目才进 projection）----
  const hasBody =
    options.mode === 'resolved' ? serialized.data !== undefined : request.body.type !== 'none'
  const runtime = RUNTIME_HEADER_CATALOG.filter((spec) => spec.appliesWhen === 'always' || hasBody)

  const merged = mergeContributions({
    userHeaders,
    contributions,
    suppression,
    ...(auth.query !== undefined ? { authQuery: auth.query } : {}),
    userQueryKeys,
    runtime,
  })

  const preview: RequestPlanPreview = {
    headers: merged.headerItems,
    query: merged.queryItems,
    preSendHeaderCount: merged.preSendHeaderCount,
    runtimeHeaderCount: merged.runtimeHeaderCount,
  }

  if (options.mode === 'preview') {
    return { mode: 'preview', preview, authType: effectiveAuth.type }
  }

  // resolved：Auth Query 追加进 URL（overridden 时不追加，§5.6）。
  let url = baseUrl
  if (merged.activeAuthQuery !== undefined) {
    url = buildUrl(url, [{ key: merged.activeAuthQuery.key, value: merged.activeAuthQuery.value, enabled: true }])
  }
  const resolved: ResolvedRequest = {
    method: request.method,
    url,
    headers: merged.wireHeaders,
    ...(serialized.data !== undefined ? { body: serialized.data } : {}),
    secretValueTraces: [...templateTraces, ...auth.traces],
  }
  return { mode: 'resolved', preview, authType: effectiveAuth.type, resolved, effectiveAuth }
}

// ---- 安全 Copy URL / cURL（§5.10，WP5/WP8 消费）----

export interface SafeCopyOptions {
  /** 仅用于识别 secret 环境变量（读取 key/enabled/secret/currentValue 形态；绝不解析 SecretRef——红线 3）。 */
  environment?: Environment
  /** inherit auth 链上下文（Query API Key 投影需要有效 auth）。 */
  collection?: Collection
  /** 调用方追加的敏感 Header 名（大小写不敏感；与 redactor/sensitive-headers 同语义）。 */
  extraSensitiveHeaders?: readonly string[]
}

function secretVariableNames(environment: Environment | undefined): Set<string> {
  const names = new Set<string>()
  for (const variable of environment?.variables ?? []) {
    if (variable.enabled && (variable.secret || isSecretRef(variable.currentValue))) {
      names.add(variable.key)
    }
  }
  return names
}

/** secret 环境变量的 {{name}} 引用 → <redacted>；普通变量保留 {{name}} 原文（§5.10/UX §6.4）。 */
function redactSecretVariableRefs(template: string, secretNames: ReadonlySet<string>): string {
  return replaceVariables(template, (name) => (secretNames.has(name) ? REDACTED : undefined))
}

/**
 * Copy URL（§5.10）：编辑器字面量投影——普通未解析变量保留 `{{name}}`；
 * secret 环境变量引用 → `<redacted>`；Auth Query 派生值 → `api_key=<redacted>`
 * 原始形态（与 redactor.redactUrl 的 displayUrl 约定一致），冲突规则与 §5.6 同源
 * （用户 enabled 同名参数存在时不追加）。镜像 query 先 collapse（与执行链同源，
 * 避免 `?x=1&x=1` 双份）。
 */
export function buildCopyUrl(request: ApiRequest, options?: SafeCopyOptions): string {
  const secretNames = secretVariableNames(options?.environment)
  const collapsed = collapseMirroredQuery(request.url, request.params)
  let url = buildUrlKeepingTemplates(collapsed, request.params)
  const effectiveAuth = resolveInheritedAuth(request, options?.collection)
  if (effectiveAuth.type === 'apikey' && effectiveAuth.in === 'query') {
    const userKeys = userQueryKeysOf(collapsed, request.params)
    if (!userKeys.includes(effectiveAuth.key)) {
      url = appendRawQuery(url, `${effectiveAuth.key}=${REDACTED}`)
    }
  }
  return redactSecretVariableRefs(url, secretNames)
}

/** POSIX 单引号转义（§5.10）：`abc'def` → `'abc'\''def'`。 */
export function posixShellQuote(text: string): string {
  return `'${text.split("'").join(`'\\''`)}'`
}

/**
 * 安全 cURL（§5.10/UX §6.4）：包含 method、URL（buildCopyUrl 同源投影）、enabled
 * 用户 Header、Body 与 active 的安全自动项；POSIX 单引号转义。
 *
 * redaction 规则：
 * - 敏感 Header 名（Authorization/Cookie/X-API-Key…）下的用户字面量 → <redacted>；
 * - secret 环境变量引用（URL/Header/Body 内）→ <redacted>；普通变量保留 {{name}}；
 * - Auth 派生项不进 cURL（§5.10「active、安全可复制的自动项」；P0 不提供复制已解析
 *   secret 的 cURL）——Auth Query 已在 URL 中以 <redacted> 形态出现；
 * - runtime 项不进 cURL（发送前无可复制值，§0.6 不伪造）；
 * - form-data 不复制 Content-Type 占位 boundary（§5.7）——改用 --form-string 行，
 *   由 curl 发送时自己生成真实 boundary；--form-string 同时避免 -F 对 @/< 前缀的
 *   「文件上传」语义偏差。
 *
 * 普通非敏感用户 Header/Body 字面量按用户主动复制行为允许进入系统剪贴板（UX §6.4）。
 */
export function buildCurlCommand(request: ApiRequest, options?: SafeCopyOptions): string {
  const secretNames = secretVariableNames(options?.environment)
  const redact = (text: string): string => redactSecretVariableRefs(text, secretNames)
  const parts: string[] = ['curl', '-X', request.method, posixShellQuote(buildCopyUrl(request, options))]

  // enabled 用户 Header（原拼写、原顺序；重复行全保留——与 wire 语义一致，§5.4）。
  for (const h of request.headers) {
    if (!h.enabled || h.key === '') continue
    const value = isSensitiveHeader(h.key, options?.extraSensitiveHeaders) ? REDACTED : redact(h.value)
    parts.push('-H', posixShellQuote(`${h.key}: ${value}`))
  }

  // 安全自动项：状态判定与 §5.3 同源（复用 mergeContributions，不另设算法）——
  // 仅 active 且非敏感（Body Content-Type / default Accept）进入。
  const isFormData = request.body.type === 'form-data'
  const contentType = bodyContentType(request.body)
  const merged = mergeContributions({
    userHeaders: request.headers,
    contributions: [
      ...(contentType !== undefined && !isFormData
        ? [{ name: 'Content-Type', value: contentType, source: 'body' as const, sensitive: false, suppressible: true }]
        : []),
      { name: 'Accept', value: DEFAULT_ACCEPT, source: 'client-default' as const, sensitive: false, suppressible: true },
    ],
    suppression: sanitizeSuppressedGeneratedHeaders(request.suppressedGeneratedHeaders ?? []),
  })
  for (const item of merged.headerItems) {
    if (item.status !== 'active' || item.sensitive) continue
    parts.push('-H', posixShellQuote(`${item.name}: ${item.valuePreview}`))
  }

  // Body（编辑器字面量；secret 环境变量引用 → <redacted>）。
  switch (request.body.type) {
    case 'none':
      break
    case 'raw':
      parts.push('--data-raw', posixShellQuote(redact(request.body.raw)))
      break
    case 'json':
      parts.push('--data-raw', posixShellQuote(redact(request.body.json)))
      break
    case 'urlencoded': {
      const pairs = request.body.fields
        .filter((f) => f.enabled)
        .map((f) => `${redact(encodeKeepingTemplates(f.key))}=${redact(encodeKeepingTemplates(f.value))}`)
      parts.push('--data-raw', posixShellQuote(pairs.join('&')))
      break
    }
    case 'form-data': {
      for (const f of request.body.fields) {
        if (!f.enabled) continue
        parts.push('--form-string', posixShellQuote(`${redact(f.key)}=${redact(f.value)}`))
      }
      break
    }
  }

  return parts.join(' ')
}
