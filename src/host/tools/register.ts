/**
 * Agent 工具统一注册/注销（§3.4；§5.2 共用纪律）：
 * 6 个 `api_client_*` 工具 + 风险等级表 + Agent Permission/Approval 挂接点。
 *
 * DSH 原生 permission/approval 面侦查结论（dsh-tools @ 0.1.2-rc.1，
 * ~/.dsh/profiles/web/node_modules 只读）：
 * - 存在原生面：`tools/pre-execute` waterfall 事件（cordis Events 增强声明）——
 *   listener 收 `(exec, next)`，返回 `{kind:'allow'}` / `{kind:'deny',reason}` /
 *   `{kind:'ask',reason?}`；`ask` 由 ToolRuntime 经 `ctx.get('approval')`
 *   （dsh-user-approval ApprovalService）解析，无 ApprovalService 时降级 deny；
 * - 本模块把策略评估（settings.agentPermission：highRiskMethodsRequireApproval
 *   + hostRules allow/approval/deny，§24.5）接线到该事件；
 * - `approvalHook` 是可注入的带内 ask 解析面（测试 mock / 无头部署，TC-T-07）；
 *   缺省时 `ask` 交给 DSH 原生 Approval 通道，本模块不自建第二套 UI。
 *
 * 风险等级（§5.2）：method ∈ {POST,PUT,PATCH,DELETE} = 高；其余执行方法 = 中；
 * list/get 只读工具 = 低。Human Send 走 Host API，不经本 agent 通道（§24.5）。
 *
 * 注册形态沿用 WP0 tool-probe 实测：`ctx.tools.register(definition)` 返回精确
 * 注销 disposer；dispose 逆序注销全部工具并摘下 pre-execute listener（TC-T-10）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { AgentPermissionPolicy, ApiRequest, Collection, Folder, HttpMethod, KeyValue } from '@dsh-api-client/shared'
import {
  API_CLIENT_TOOL_NAMES,
  API_CLIENT_TOOL_NAMESPACE_PATTERN,
  TOOL_API_CLIENT_REQUEST,
  TOOL_API_CLIENT_RUN_REQUEST,
} from '@dsh-api-client/shared'
import type { CollectionService } from '../services/collection-service.ts'
import type { ExecutionService, ExecuteOutput } from '../services/execution-service.ts'
import type { HistoryService } from '../services/history-service.ts'
import type { RedactionService } from '../services/redaction-service.ts'
import type { SettingsService } from '../services/settings-service.ts'
import type { HostLog } from '../host-log.ts'
import { buildRequestToolDefinition } from './api-client-request.ts'
import { buildRunRequestToolDefinition } from './api-client-run-request.ts'
import { buildListCollectionsToolDefinition } from './api-client-list-collections.ts'
import { buildListRequestsToolDefinition } from './api-client-list-requests.ts'
import { buildGetRequestToolDefinition } from './api-client-get-request.ts'
import { buildGetLastResponseToolDefinition } from './api-client-get-last-response.ts'

// ---- 风险等级表（§3.4/§5.2）----

export type ToolRiskLevel = 'low' | 'medium' | 'high'

/** 高风险方法（§24.5：默认进 Approval）。 */
export const HIGH_RISK_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** 执行类工具按目标请求 method 定级；list/get 只读工具固定 low。 */
export function riskOfMethod(method: string): 'medium' | 'high' {
  return HIGH_RISK_METHODS.has(method.toUpperCase()) ? 'high' : 'medium'
}

/** 定稿 6 工具的风险形态（'per-method' = 由目标请求 method 决定，见 riskOfMethod）。 */
export const TOOL_RISK_LEVELS: Record<(typeof API_CLIENT_TOOL_NAMES)[number], ToolRiskLevel | 'per-method'> = {
  api_client_request: 'per-method',
  api_client_run_request: 'per-method',
  api_client_list_collections: 'low',
  api_client_list_requests: 'low',
  api_client_get_request: 'low',
  api_client_get_last_response: 'low',
}

// ---- Agent Permission 策略评估（§24.5；纯函数，TC-T-07 直接驱动）----

export type PermissionAction = 'allow' | 'ask' | 'deny'

export interface PermissionVerdict {
  action: PermissionAction
  reason: string
}

export interface PermissionTarget {
  method: string
  /** URL 解析出的 host；含 {{变量}} 等不可解析形态时为 undefined（仅 method 策略生效）。 */
  host?: string
}

/** hostRules 匹配：精确等值，或 `*.example.com` 后缀通配（与 network-policy 同形态）。 */
function hostRuleMatches(ruleHost: string, host: string): boolean {
  if (ruleHost === host) return true
  if (ruleHost.startsWith('*.')) {
    const suffix = ruleHost.slice(2)
    return host === suffix || host.endsWith(`.${suffix}`)
  }
  return false
}

/**
 * 策略评估（纯函数）：hostRules 首条命中规则优先于方法默认策略
 * （显式 allow 覆盖高风险方法默认；deny 直接拒绝）；无命中时高风险方法
 * 且 highRiskMethodsRequireApproval → ask。
 */
export function evaluateAgentPermission(policy: AgentPermissionPolicy, target: PermissionTarget): PermissionVerdict {
  if (target.host !== undefined) {
    for (const rule of policy.hostRules) {
      if (!hostRuleMatches(rule.host, target.host)) continue
      switch (rule.action) {
        case 'deny':
          return { action: 'deny', reason: `host rule denied ${target.host}` }
        case 'approval':
          return { action: 'ask', reason: `host rule requires approval for ${target.host}` }
        case 'allow':
          return { action: 'allow', reason: `host rule allows ${target.host}` }
      }
    }
  }
  if (HIGH_RISK_METHODS.has(target.method.toUpperCase()) && policy.highRiskMethodsRequireApproval) {
    return { action: 'ask', reason: `high-risk method ${target.method.toUpperCase()} requires approval` }
  }
  return { action: 'allow', reason: 'no approval policy matched' }
}

// ---- Approval 挂接（tools/pre-execute 原生面 + 可注入 hook）----

/** 注入 approval hook 的请求上下文（TC-T-07 mock 断言面）。 */
export interface ApprovalRequest {
  tool: string
  method: string
  host?: string
  reason: string
}

/** 可注入的带内 ask 解析：返回 true = 批准放行，false = 拒绝。 */
export type ApprovalHook = (request: ApprovalRequest) => boolean | Promise<boolean>

/** pre-execute listener 眼中的最小 exec 形态（dsh-tools ToolExecution 的结构子集）。 */
export interface ToolExecutionLike {
  name: string
  arguments: unknown
}

export type PreExecuteNext = () => Promise<PreToolDecision>
export type AgentPermissionGate = (exec: ToolExecutionLike, next: PreExecuteNext) => Promise<PreToolDecision>

export interface AgentPermissionGateDeps {
  /** 读 settings.agentPermission（每次调用现取，patch 即生效）。 */
  policy: () => AgentPermissionPolicy
  /** 从工具入参静态解析目标 method/host；不可解析（如不存在的 requestId）→ undefined 放行给工具自身报错。 */
  resolveTarget: (exec: ToolExecutionLike) => PermissionTarget | undefined
  /** 可注入的带内 ask 解析面；缺省时 ask 交 DSH 原生 ApprovalService。 */
  approvalHook?: ApprovalHook
}

/**
 * 生成 `tools/pre-execute` listener：只处理 api_client_* 命名空间，
 * 其余工具一律 next() 透传。ask 决策：注入 hook → 带内解析（拒绝转 deny）；
 * 未注入 → 返回 {kind:'ask'} 由 DSH 原生 Approval 通道解析。
 */
export function createAgentPermissionGate(deps: AgentPermissionGateDeps): AgentPermissionGate {
  return async (exec, next) => {
    if (!API_CLIENT_TOOL_NAMESPACE_PATTERN.test(exec.name)) return next()
    const target = deps.resolveTarget(exec)
    if (target === undefined) return next()
    const verdict = evaluateAgentPermission(deps.policy(), target)
    if (verdict.action === 'allow') return next()
    if (verdict.action === 'deny') return { kind: 'deny', reason: verdict.reason }
    if (deps.approvalHook !== undefined) {
      const request: ApprovalRequest = { tool: exec.name, method: target.method, reason: verdict.reason }
      if (target.host !== undefined) request.host = target.host
      const approved = await deps.approvalHook(request)
      return approved ? next() : { kind: 'deny', reason: `approval denied: ${verdict.reason}` }
    }
    return { kind: 'ask', reason: verdict.reason }
  }
}

// ---- 工具模块共享的小工具（函数声明提升，register ↔ tool 模块循环引用安全）----

/** 统一 JSON 渲染形态（沿用 WP0 tool-probe 的 ContentBlock text 形态）。 */
export function renderJsonBlocks(_args: unknown, value: unknown): ContentBlock[] {
  return [{ type: 'text', text: '```json\n' + JSON.stringify(value, null, 2) + '\n```' }]
}

/** Record<string,string> → KeyValue[]（enabled: true；§13.1 入参形态 → §4.1 实体形态）。 */
export function toKeyValueList(record: Record<string, string> | undefined): KeyValue[] {
  if (record === undefined) return []
  return Object.entries(record).map(([key, value]) => ({ key, value, enabled: true }))
}

/** URL host 解析（含 {{变量}} 等不可解析形态 → undefined；策略评估 best-effort）。 */
export function hostOfUrl(url: string): string | undefined {
  try {
    return new URL(url).hostname
  } catch {
    return undefined
  }
}

/** collection 全树请求（顶层 + 任意嵌套 folder，§6 层级）。 */
export function flattenRequests(collection: Collection): ApiRequest[] {
  const out: ApiRequest[] = [...collection.requests]
  const walk = (folders: Folder[]): void => {
    for (const folder of folders) {
      out.push(...folder.requests)
      walk(folder.folders)
    }
  }
  walk(collection.folders)
  return out
}

/** run_request 的 {collection, request} 名字解析：collection 名唯一 + 请求名全树唯一。 */
export function findRequestByNames(
  collections: CollectionService,
  collectionName: string,
  requestName: string,
): ApiRequest | undefined {
  const matched = collections.list().filter((c) => c.name === collectionName)
  if (matched.length !== 1) return undefined
  const found = flattenRequests(matched[0]!).filter((r) => r.name === requestName)
  return found.length === 1 ? found[0] : undefined
}

/**
 * 执行类工具返回契约（§5.2 脱敏投影）：
 * `{ status, statusText, headers, bodyPreview, size, durationMs, historyId }`——
 * 数据全部出自 execution-service 的 responseEcho（redactor 出口），绝不含原始 bodyText。
 */
export interface ToolExecutionResult {
  status: number
  statusText: string
  headers: KeyValue[]
  bodyPreview?: string
  size: number
  durationMs: number
  historyId?: string
}

export function toToolExecutionResult(output: ExecuteOutput): ToolExecutionResult {
  const echo = output.responseEcho
  const result: ToolExecutionResult = {
    status: echo.status,
    statusText: echo.statusText,
    headers: echo.headers,
    size: echo.size,
    durationMs: echo.durationMs,
  }
  if (echo.bodyPreview !== undefined) result.bodyPreview = echo.bodyPreview
  if (output.historyId !== undefined) result.historyId = output.historyId
  return result
}

/** pre-execute 目标解析：仅两个执行类工具有风险语义；只读工具不进门。 */
function resolveExecutionTarget(collections: CollectionService, exec: ToolExecutionLike): PermissionTarget | undefined {
  if (exec.name === TOOL_API_CLIENT_REQUEST) {
    if (typeof exec.arguments !== 'object' || exec.arguments === null) return undefined
    const args = exec.arguments as Record<string, unknown>
    if (typeof args.method !== 'string') return undefined
    const target: PermissionTarget = { method: args.method.toUpperCase() }
    const host = typeof args.url === 'string' ? hostOfUrl(args.url) : undefined
    if (host !== undefined) target.host = host
    return target
  }
  if (exec.name === TOOL_API_CLIENT_RUN_REQUEST) {
    if (typeof exec.arguments !== 'object' || exec.arguments === null) return undefined
    const args = exec.arguments as Record<string, unknown>
    let request: ApiRequest | undefined
    if (typeof args.requestId === 'string') {
      request = collections.findRequestLocation(args.requestId)?.request
    } else if (typeof args.collection === 'string' && typeof args.request === 'string') {
      request = findRequestByNames(collections, args.collection, args.request)
    }
    if (request === undefined) return undefined
    const target: PermissionTarget = { method: request.method }
    const host = hostOfUrl(request.url)
    if (host !== undefined) target.host = host
    return target
  }
  return undefined
}

// ---- 统一注册/注销 ----

export interface ApiClientToolsDeps {
  execution: ExecutionService
  collections: CollectionService
  history: HistoryService
  redaction: RedactionService
  settings: SettingsService
}

export interface RegisterApiClientToolsOptions {
  /** 可注入 approval hook（TC-T-07 / 无头部署）；缺省走 DSH 原生 Approval 通道。 */
  approvalHook?: ApprovalHook
}

export interface ApiClientToolsRegistration {
  status: 'registered' | 'unavailable'
  /** 实际注册的工具名（定稿 6 个，§5.2）。 */
  toolNames: readonly string[]
  dispose: () => void
}

interface ToolsRegistryLike {
  register(definition: ToolDefinition): () => void
}

/** 构建定稿 6 个工具定义（顺序即 API_CLIENT_TOOL_NAMES）。 */
export function buildApiClientToolDefinitions(deps: ApiClientToolsDeps): ToolDefinition[] {
  return [
    buildRequestToolDefinition(deps),
    buildRunRequestToolDefinition(deps),
    buildListCollectionsToolDefinition(deps),
    buildListRequestsToolDefinition(deps),
    buildGetRequestToolDefinition(deps),
    buildGetLastResponseToolDefinition(deps),
  ]
}

/**
 * 注册全部 6 工具 + pre-execute 权限门。永不向宿主抛错；
 * dispose 注销全部工具并摘下 listener（AC-23 / TC-T-10），幂等。
 */
export function registerApiClientTools(
  ctx: Context,
  deps: ApiClientToolsDeps,
  log: HostLog,
  options: RegisterApiClientToolsOptions = {},
): ApiClientToolsRegistration {
  const tools = (ctx as { tools?: ToolsRegistryLike }).tools
  if (tools === undefined || typeof tools.register !== 'function') {
    log.log('tools', 'unavailable', { reason: 'ctx.tools missing' })
    return { status: 'unavailable', toolNames: [], dispose: () => {} }
  }
  try {
    const definitions = buildApiClientToolDefinitions(deps)
    const unregisters = definitions.map((definition) => tools.register(definition))
    const gate = createAgentPermissionGate({
      policy: () => deps.settings.get().agentPermission,
      resolveTarget: (exec) => resolveExecutionTarget(deps.collections, exec),
      ...(options.approvalHook !== undefined ? { approvalHook: options.approvalHook } : {}),
    })
    const offPreExecute = ctx.on('tools/pre-execute', gate)
    const toolNames = definitions.map((d) => d.name)
    log.log('tools', 'register', { tools: toolNames, approvalHook: options.approvalHook !== undefined ? 'injected' : 'dsh-native' })
    let disposed = false
    return {
      status: 'registered',
      toolNames,
      dispose() {
        if (disposed) return
        disposed = true
        offPreExecute()
        for (const unregister of unregisters.slice().reverse()) unregister()
        log.log('tools', 'dispose', { tools: toolNames })
      },
    }
  } catch (error) {
    log.log('tools', 'error', { message: error instanceof Error ? error.message : String(error) })
    return { status: 'unavailable', toolNames: [], dispose: () => {} }
  }
}
