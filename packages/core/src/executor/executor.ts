/**
 * §12 十二步执行流编排（§3.2 executor/executor）：
 * plan（resolve + auth + build，P0 §5 canonical buildRequestPlan）→ permission →
 * network-policy → execute → 计时 → parse → history → events。
 *
 * - Human Send 与 Agent Tool 共用本入口（§13.8，无双套 HTTP client）；
 * - secret 解析依赖（resolveSecret）以接口注入——core 不碰存储（§4.3）；
 * - 解析出的 secret 值在执行期被跟踪收集（仅内存），供 history/redactor 定点脱敏；
 * - 任何错误 rethrow 前必经 redactor（§24.2 Error Message 面，TC-R-09）。
 */
import type {
  ApiRequest,
  Collection,
  Environment,
  ExecutionHistory,
  HttpExecutionResult,
  NetworkPolicy,
  ResolvedRequest,
  SecretRef,
} from '@dsh-api-client/shared'
import { buildRequestPlan } from '../request/plan.ts'
import type { SecretResolver } from '../request/plan.ts'
import { DEFAULT_NETWORK_POLICY, evaluateNetworkPolicy } from '../security/network-policy.ts'
import type { PolicyEvaluator } from './http-client.ts'
import { executeHttp } from './http-client.ts'
import type { HostResolver, HttpWireRequest, HttpWireResponse } from './http-client.ts'
import { detectBodyKind, computeSize } from '../response/parse.ts'
import { cookiesToKeyValues } from '../response/cookies.ts'
import { findHeader } from '../request/build.ts'
import { recordExecution } from '../history/recorder.ts'
import { sanitizeExecutionError } from './errors.ts'
import { ExecutorError } from './errors.ts'

export interface ExecutorEvent {
  type:
    | 'resolved'
    | 'auth-applied'
    | 'built'
    | 'permission-passed'
    | 'policy-passed'
    | 'executing'
    | 'finished'
    | 'history-recorded'
    | 'failed'
  message?: string
}

export interface HistoryContext {
  profileId: string
  source: 'human' | 'agent' | 'runner'
  requestId?: string
  environmentId?: string
}

export interface ExecuteOptions {
  local?: Record<string, string>
  environment?: Environment
  /** inherit auth 链与 collection 变量来源。 */
  collection?: Collection
  /** 执行期注入的 secret 解析函数（§4.3 唯一出口在 host secret-store）。 */
  resolveSecret?: SecretResolver
  /** 第 6 步 permission check（§24.5；host 注入 Approval 挂接）。 */
  permissionCheck?: (request: ResolvedRequest) => void | Promise<void>
  policy?: NetworkPolicy
  /** 覆盖策略评估函数（测试挂点；默认 closure 到 policy 上）。 */
  evaluatePolicy?: PolicyEvaluator
  /** 覆盖传输层（测试挂点；默认 undici executeHttp）。 */
  transport?: (wire: HttpWireRequest, options: Parameters<typeof executeHttp>[1]) => Promise<HttpWireResponse>
  resolveHost?: HostResolver
  /** 第 11 步 history 持久化注入（host history-service；core 只生成脱敏记录）。 */
  recordHistory?: (entry: ExecutionHistory) => void | Promise<void>
  historyContext?: HistoryContext
  /** 第 12 步 events。 */
  onEvent?: (event: ExecutorEvent) => void
  sensitiveResponseFields?: readonly string[]
  responseBodySensitive?: boolean
  now?: () => number
}

export interface ExecutionOutcome {
  resolved: ResolvedRequest
  result: HttpExecutionResult
  history?: ExecutionHistory
}

function portOf(url: URL): number {
  if (url.port !== '') return Number.parseInt(url.port, 10)
  return url.protocol === 'https:' ? 443 : 80
}

export async function executeRequest(request: ApiRequest, options: ExecuteOptions = {}): Promise<ExecutionOutcome> {
  const emit = (type: ExecutorEvent['type'], message?: string): void => {
    const event: ExecutorEvent = { type }
    if (message !== undefined) event.message = message
    options.onEvent?.(event)
  }
  const now = options.now ?? (() => performance.now())

  // 执行期跟踪 secret 解析值（仅内存），供 history 脱敏与错误 redactor 使用。
  const secretValues = new Map<string, string>()
  const trackingResolveSecret: SecretResolver | undefined = options.resolveSecret
    ? async (ref: SecretRef) => {
        const value = await options.resolveSecret?.(ref)
        const resolvedValue = value ?? ''
        secretValues.set(ref.$ref, resolvedValue)
        return resolvedValue
      }
    : undefined

  try {
    // 1–5. Canonical plan（P0 §5.1/§5.2/§13.4）：resolve → auth → build 一次经唯一
    //      合并 primitive 完成——executor 不再形成第二套 Auth append / Header 合并。
    //      事件序列保持十二步历史形态：三个事件现在于同一 primitive 完成后相邻
    //      触发（语义 = 变量解析完成 / auth 贡献已合并 / wire 形态已落定）。
    const plan = await buildRequestPlan(request, {
      mode: 'resolved',
      local: options.local,
      environment: options.environment,
      collection: options.collection,
      resolveSecret: trackingResolveSecret,
    })
    const resolved = plan.resolved
    const effectiveAuth = plan.effectiveAuth
    emit('resolved')
    emit('auth-applied')
    emit('built')

    // 6. Permission check（§24.5 挂接点，发起连接之前）
    await options.permissionCheck?.(resolved)
    emit('permission-passed')

    // 7. Network policy check（发起连接之前；redirect 每跳由 http-client 再评估）
    const policy = options.policy ?? DEFAULT_NETWORK_POLICY
    const evaluate: PolicyEvaluator = options.evaluatePolicy ?? ((target) => evaluateNetworkPolicy(policy, target))
    let target: URL
    try {
      target = new URL(resolved.url)
    } catch {
      throw new ExecutorError('invalid-request', `invalid URL after resolution`)
    }
    const preflight = evaluate({ host: target.hostname, port: portOf(target) })
    if (!preflight.allowed) {
      throw new ExecutorError(
        'network-policy-denied',
        `network policy denied ${target.hostname}:${portOf(target)} — ${preflight.reason}`,
        { host: target.hostname },
      )
    }
    emit('policy-passed')

    // 8. Execute + 9. Measure duration
    emit('executing')
    const started = now()
    const wire: HttpWireRequest = { method: resolved.method, url: resolved.url, headers: resolved.headers }
    if (resolved.body !== undefined) wire.body = resolved.body
    const transport = options.transport ?? executeHttp
    const httpOptions: Parameters<typeof executeHttp>[1] = {
      timeoutMs: policy.timeoutMs,
      maxResponseBytes: policy.maxResponseBytes,
      evaluatePolicy: evaluate,
      followRedirects: policy.redirectPolicy === 'follow',
      dnsRebindingProtection: policy.dnsRebindingProtection,
    }
    if (options.resolveHost !== undefined) httpOptions.resolveHost = options.resolveHost
    const wireResponse = await transport(wire, httpOptions)
    const durationMs = Math.max(now() - started, 0.001)

    // 10. Parse response（bodyKind / cookies / size）
    const contentType = findHeader(wireResponse.headers, 'content-type')?.value
    const result: HttpExecutionResult = {
      status: wireResponse.status,
      statusText: wireResponse.statusText,
      headers: wireResponse.headers,
      cookies: cookiesToKeyValues(wireResponse.headers),
      bodyText: wireResponse.bodyText,
      bodyKind: detectBodyKind(contentType, wireResponse.bodyText),
      size: computeSize(wireResponse.bodyText),
      durationMs,
      redirected: wireResponse.redirected,
      finalUrl: wireResponse.finalUrl,
    }

    // 11. Persist history（core 只生成脱敏记录；落盘由注入的 recordHistory 完成）
    let history: ExecutionHistory | undefined
    if (options.recordHistory !== undefined && options.historyContext !== undefined) {
      history = recordExecution({
        resolved,
        auth: effectiveAuth,
        result,
        secretValues,
        source: options.historyContext.source,
        profileId: options.historyContext.profileId,
        ...(options.historyContext.requestId !== undefined
          ? { requestId: options.historyContext.requestId }
          : {}),
        ...(options.historyContext.environmentId !== undefined
          ? { environmentId: options.historyContext.environmentId }
          : {}),
        ...(options.sensitiveResponseFields !== undefined
          ? { sensitiveResponseFields: options.sensitiveResponseFields }
          : {}),
        ...(options.responseBodySensitive !== undefined
          ? { responseBodySensitive: options.responseBodySensitive }
          : {}),
        timestamp: Date.now(),
      })
      await options.recordHistory(history)
      emit('history-recorded')
    }

    emit('finished')
    return { resolved, result, ...(history !== undefined ? { history } : {}) }
  } catch (error) {
    emit('failed', error instanceof Error ? error.message : String(error))
    // 错误出场前必经 redactor（§24.2；TC-R-09）：message 中不得含任何已解析 secret。
    throw sanitizeExecutionError(error, { secretValues })
  }
}
