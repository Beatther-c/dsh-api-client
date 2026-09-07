/**
 * Execution service（§3.4；§13.8）：Human/Agent 共用执行入口——
 * core executor + network-policy-service + history-service + audit-service。
 *
 * SecretRef 解析链（§4.3）：
 *   environments（SecretRef）→ environments.createSecretResolver（悬空 ref 错误带
 *   envKey；无环境时回退 secret-store.resolveSecret 唯一明文出口）
 *   → 执行期内存（本服务包一层 tracking，供 requestEcho/responseEcho 脱敏）
 *   → core executor；history 由 core recorder 生成脱敏快照后 history-service 落盘。
 *
 * 纪律：
 * - 传给 executor 的 Environment 必须是权威态（含 SecretRef 对象），绝不传投影
 *   （投影的 `<secret-ref:key>` 字符串不是 SecretRef，会被当明文发送）；
 * - response body 原样返回（§5.1 端点 21）；requestEcho/responseEcho 永远脱敏
 *   （responseEcho 供 WP5 Agent 工具返回契约，§5.2 脱敏投影）；
 * - 每次执行（成功/失败）写 audit（source identity / 时间 / 目标 host / 结论）。
 */
import type {
  ApiRequest,
  Environment,
  ExecutionHistory,
  HttpExecutionResult,
  RedactedRequestSnapshot,
  RedactedResponseSnapshot,
  SecretRef,
} from '@dsh-api-client/shared'
import type { SecretResolver } from '@dsh-api-client/core'
import {
  executeRequest,
  HISTORY_BODY_PREVIEW_LIMIT,
  redactRequestSnapshot,
  redactResponseSnapshot,
  resolveInheritedAuth,
} from '@dsh-api-client/core'
import { CollectionService, RequestNotFoundError } from './collection-service.ts'
import { EnvironmentService } from './environment-service.ts'
import { SecretStoreService } from './secret-store-service.ts'
import { HistoryService } from './history-service.ts'
import { AuditService } from './audit-service.ts'
import { NetworkPolicyService } from './network-policy-service.ts'
import { SettingsService } from './settings-service.ts'
import { ProfileService } from './profile-service.ts'

export interface ExecuteInput {
  /** 临时请求（§5.1：完整 ApiRequest 形态；id/collectionId/时间戳可缺省，本服务补齐）。 */
  request?: Partial<ApiRequest> & Pick<ApiRequest, 'method' | 'url'>
  /** 已保存请求 id（与 request 二选一）。 */
  requestId?: string
  /** per-call environment（id 或唯一 name；缺省回退 settings.activeEnvironmentId）。 */
  environment?: string
  /** 执行来源身份（auth.ts 提取）。 */
  source: 'human' | 'agent'
}

export interface ExecuteOutput {
  result: HttpExecutionResult
  historyId?: string
  requestEcho: RedactedRequestSnapshot
  /** 响应脱敏投影（§5.2 Agent 工具返回契约；与 history 快照同源的 redactor 出口）。 */
  responseEcho: RedactedResponseSnapshot
}

export class ExecuteInputError extends Error {
  readonly code = 'invalid-execute-input'
  /** router 统一错误映射（§5.1 错误格式）。 */
  readonly httpStatus = 400
  constructor(message: string) {
    super(message)
    this.name = 'ExecuteInputError'
  }
}

export interface ExecutionServiceDeps {
  collections: CollectionService
  environments: EnvironmentService
  secrets: SecretStoreService
  history: HistoryService
  audit: AuditService
  networkPolicy: NetworkPolicyService
  settings: SettingsService
  profile: ProfileService
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return '(unresolved-url)'
  }
}

export class ExecutionService {
  constructor(private readonly deps: ExecutionServiceDeps) {}

  private normalizeAdhocRequest(input: ExecuteInput['request']): ApiRequest {
    if (input === undefined) throw new ExecuteInputError('execute requires request or requestId')
    const now = Date.now()
    return {
      id: input.id ?? crypto.randomUUID(),
      name: input.name ?? `${input.method} ${input.url}`,
      method: input.method,
      url: input.url,
      params: input.params ?? [],
      headers: input.headers ?? [],
      auth: input.auth ?? { type: 'none' },
      body: input.body ?? { type: 'none' },
      ...(input.scripts !== undefined ? { scripts: input.scripts } : {}),
      collectionId: input.collectionId ?? '',
      ...(input.folderId !== undefined ? { folderId: input.folderId } : {}),
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    }
  }

  private resolveEnvironment(ref: string | undefined): Environment | undefined {
    const key = ref ?? this.deps.settings.get().activeEnvironmentId
    if (key === undefined) return undefined
    const environment = this.deps.environments.resolve(key)
    if (environment === undefined) throw new ExecuteInputError(`environment not found: ${key}`)
    return environment
  }

  async execute(input: ExecuteInput): Promise<ExecuteOutput> {
    // 1. 请求来源：requestId（含所属 collection，供 inherit auth / collection 变量）或临时请求。
    let request: ApiRequest
    let collection = undefined as ReturnType<CollectionService['get']>
    if (input.requestId !== undefined) {
      const hit = this.deps.collections.findRequestLocation(input.requestId)
      if (hit === undefined) throw new RequestNotFoundError(input.requestId)
      request = hit.request
      collection = hit.collection
    } else {
      request = this.normalizeAdhocRequest(input.request)
    }

    // 2. per-call environment（权威态，含 SecretRef——绝不传投影，见文件头纪律）。
    const environment = this.resolveEnvironment(input.environment)

    // 3. SecretRef 解析链：有环境时经 environments.createSecretResolver（悬空 ref
    //    错误带 envKey，§4.3）；无环境（仅 auth SecretRef 场景）回退 secret-store 直读。
    //    本服务再包一层 tracking（仅内存），供 requestEcho/responseEcho 定点脱敏。
    const secretValues = new Map<string, string>()
    const baseResolver: SecretResolver =
      environment !== undefined ? this.deps.environments.createSecretResolver(environment.id) : this.deps.secrets.resolveSecret
    const resolveSecret: SecretResolver = async (ref: SecretRef) => {
      const value = await baseResolver(ref)
      secretValues.set(ref.$ref, value)
      return value
    }

    const settings = this.deps.settings.get()
    const effectiveAuth = resolveInheritedAuth(request, collection)
    const auditBase = {
      timestamp: Date.now(),
      source: input.source,
      method: request.method,
      host: hostOf(request.url),
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    }

    try {
      const outcome = await executeRequest(request, {
        ...(environment !== undefined ? { environment } : {}),
        ...(collection !== undefined ? { collection } : {}),
        resolveSecret,
        policy: this.deps.networkPolicy.getPolicy(),
        historyContext: {
          profileId: this.deps.profile.profileId,
          source: input.source,
          ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
          ...(environment !== undefined ? { environmentId: environment.id } : {}),
        },
        recordHistory: (entry: ExecutionHistory) => {
          if (settings.saveHistory) this.deps.history.append(entry)
        },
      })

      // 4. requestEcho/responseEcho：永远脱敏（与 history 快照同源的 redactor 出口；
      //    bodyPreview 截断与 core recorder 同限）。
      const requestEcho = redactRequestSnapshot(outcome.resolved, { secretValues }, { auth: effectiveAuth })
      const responseSnapshot = redactResponseSnapshot(outcome.result, { secretValues })
      const responseEcho: RedactedResponseSnapshot = {
        ...responseSnapshot,
        ...(responseSnapshot.bodyPreview !== undefined
          ? { bodyPreview: responseSnapshot.bodyPreview.slice(0, HISTORY_BODY_PREVIEW_LIMIT) }
          : {}),
      }

      // 5. audit（成功结论）。
      this.deps.audit.record({
        ...auditBase,
        outcome: 'success',
        ...(outcome.history !== undefined ? { historyId: outcome.history.id } : {}),
      })

      return {
        result: outcome.result,
        ...(outcome.history !== undefined ? { historyId: outcome.history.id } : {}),
        requestEcho,
        responseEcho,
      }
    } catch (error) {
      // audit（失败结论；message 已经 core sanitize，这里不再二次接触明文路径）。
      try {
        this.deps.audit.record({
          ...auditBase,
          outcome: 'error',
          error: error instanceof Error ? error.message : String(error),
        })
      } catch {
        // audit 失败不掩盖执行错误本身
      }
      throw error
    }
  }
}
