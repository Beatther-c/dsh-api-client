/**
 * 变量解析兼容面（P0 §5.2；原 §3.2 variables/resolver）。
 *
 * 解析机器（§7.2 优先级链 Local > Environment > Collection、TC-C-03 未定义变量
 * 显式报错、secretValueTraces 收集）已随 canonical plan 移入 request/plan.ts
 * （§2.2「将变量解析能力接入 canonical plan」）；本文件保留历史入口
 * resolveRequest() 作为向后兼容 wrapper——内部最终调用同一 primitive
 * buildRequestPlan(mode='resolved')，不允许保留第二套优先级算法（§5.1/§5.2）。
 *
 * resolveRequest 的历史契约 = 只解析变量 + build URL/Headers/Body，**不应用
 * auth**（auth 由 auth/apply.applyAuth 组合完成，TC-C-06…09），因此 wrapper
 * 进入 plan 前把 request.auth 中和为 none；Auth 贡献由 applyAuth 经 plan 的
 * 同一 mergeContributions 应用。
 *
 * 公开符号 SecretResolver / UnresolvedVariablesError 现由 request/plan.ts 定义
 * 并导出（@dsh-api-client/core 汇聚出口不变，消费方 import 路径无需改动）。
 */
import type {
  ApiRequest,
  Collection,
  CollectionVariable,
  Environment,
  ResolvedRequest,
} from '@dsh-api-client/shared'
import type { SecretResolver } from '../request/plan.ts'
import { buildRequestPlan } from '../request/plan.ts'

export interface ResolutionContext {
  /** Local 层（最高优先级，如 per-call 覆盖）。 */
  local?: Record<string, string>
  /** Environment 层。 */
  environment?: Environment
  /** Collection 层（最低优先级）。 */
  collectionVariables?: CollectionVariable[]
  resolveSecret?: SecretResolver
}

export interface ResolveRequestOptions {
  /** 透传给 form-data 序列化（测试注入固定 boundary）。 */
  boundary?: string
}

/**
 * 解析请求（兼容 wrapper）：URL / params / headers / body 中的 {{var}} 全部解析，
 * params 合并进 URL（buildUrl 语义），自动 Content-Type / Accept（含 suppression
 * 与用户覆盖——canonical plan 语义，P0 §5.3）。secret 来源位置记入
 * secretValueTraces（供 redactor）。
 */
export async function resolveRequest(
  request: ApiRequest,
  ctx: ResolutionContext,
  options?: ResolveRequestOptions,
): Promise<ResolvedRequest> {
  // BuildRequestPlanOptions.collection 同时承载 inherit 链与 collection 变量；
  // 本 wrapper 的 auth 已中和，仅需变量层——用最小 Collection 壳承载 collectionVariables。
  const planCollection: Collection | undefined =
    ctx.collectionVariables !== undefined
      ? {
          id: '',
          name: '',
          variables: ctx.collectionVariables,
          folders: [],
          requests: [],
          createdAt: 0,
          updatedAt: 0,
        }
      : undefined
  const plan = await buildRequestPlan({ ...request, auth: { type: 'none' } }, {
    mode: 'resolved',
    local: ctx.local,
    environment: ctx.environment,
    collection: planCollection,
    resolveSecret: ctx.resolveSecret,
    boundary: options?.boundary,
  })
  return plan.resolved
}
