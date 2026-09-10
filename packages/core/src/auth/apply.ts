/**
 * Auth 兼容面（P0 §5.5；原 §7.5，§3.2 auth/apply）。
 *
 * 旧实现对认证 Header 无条件 append——用户显式设置同名 Header 时会产生双份
 * Authorization（UX §6.3 明文要求修复）。现在 Auth 贡献的 materialize 与合并
 * 已移入 canonical plan（request/plan.ts 的 materializeAuthContribution +
 * mergeContributions，与 buildRequestPlan 同一 primitive）；本文件保留历史入口
 * applyAuth() 作为向后兼容 wrapper：
 * - 用户已有 enabled 同名 Header（大小写不敏感）→ Auth 贡献 overridden、
 *   不追加第二条；
 * - Query API Key 冲突按 §5.6 用户 Query 规则独立判定；
 * - disabled 用户行不参与覆盖、也不阻止生成（§5.3）。
 *
 * bearer token、basic password、apikey value 可为 SecretRef——执行期由调用方
 * 注入 resolveSecret 解析（core 不碰存储），解析来源记入 secretValueTraces
 * （location 'auth'）。resolveInheritedAuth 已移入 request/plan.ts
 * （@dsh-api-client/core 汇聚出口不变）。
 */
import type { AuthConfig, ResolvedRequest } from '@dsh-api-client/shared'
import type { SecretResolver } from '../request/plan.ts'
import {
  authContributionTarget,
  isAuthQueryOverriddenByUser,
  isOverriddenByUserHeaders,
  materializeAuthContribution,
  mergeContributions,
} from '../request/plan.ts'
import { buildUrl, urlToParams } from '../request/build.ts'

export interface ApplyAuthDeps {
  resolveSecret?: SecretResolver
}

/**
 * 把（已解析 inherit 链的）AuthConfig 应用到 ResolvedRequest（兼容 wrapper）：
 * 返回新对象，headers/url 落定，secret 来源追加到 secretValueTraces。
 * 注意：调用前必须经 resolveInheritedAuth 消解 'inherit'（未消解时本函数抛错，
 * 消息与历史行为逐字一致）。
 *
 * R-03 追加（orchestrator 授权）：与 buildRequestPlan 同款惰性 materialize——
 * 先由 Auth 类型得出目标名称/位置（authContributionTarget，零解析），再用与
 * mergeContributions 同源的谓词（isOverriddenByUserHeaders / §5.6 Query 判定）
 * 判覆盖；被覆盖路径零 resolveSecret 调用、零 trace，失效 SecretRef 不反向阻断。
 */
export async function applyAuth(
  auth: AuthConfig,
  resolved: ResolvedRequest,
  deps?: ApplyAuthDeps,
): Promise<ResolvedRequest> {
  // inherit 未消解 → authContributionTarget 抛错（消息逐字兼容旧 applyAuth）。
  const target = authContributionTarget(auth)
  // resolved.headers 即本 wrapper 视角的「用户 Header」全集（其中已含上游
  // resolveRequest 自动补的 Content-Type/Accept，同名 Auth 贡献同样被覆盖）。
  const enabledUserHeaderNames = new Set(
    resolved.headers.filter((h) => h.enabled && h.key !== '').map((h) => h.key.toLowerCase()),
  )
  // §5.6：URL 文本中已有的 query 参数即「用户参数」（恒视为 enabled）。
  const userQueryKeys = urlToParams(resolved.url).map((p) => p.key)
  const overridden =
    (target.header !== undefined &&
      isOverriddenByUserHeaders(target.header.toLowerCase(), enabledUserHeaderNames)) ||
    (target.query !== undefined && isAuthQueryOverriddenByUser(target.query, userQueryKeys))

  // P0 §5.5：不再无条件 append——与 buildRequestPlan 走同一 mergeContributions；
  // overridden=true 时按遮罩形态 materialize（零解析、零 trace，R-03）。
  const materialized = await materializeAuthContribution(auth, 'resolved', deps?.resolveSecret, overridden)
  const merged = mergeContributions({
    userHeaders: resolved.headers,
    contributions:
      materialized.header !== undefined
        ? [
            {
              name: materialized.header.name,
              value: materialized.header.value,
              source: 'auth' as const,
              sensitive: true,
              suppressible: false,
            },
          ]
        : [],
    suppression: [],
    ...(materialized.query !== undefined ? { authQuery: materialized.query } : {}),
    userQueryKeys,
  })

  let url = resolved.url
  if (merged.activeAuthQuery !== undefined) {
    url = buildUrl(url, [{ key: merged.activeAuthQuery.key, value: merged.activeAuthQuery.value, enabled: true }])
  }

  return {
    ...resolved,
    url,
    headers: merged.wireHeaders,
    secretValueTraces: [...resolved.secretValueTraces, ...materialized.traces],
  }
}
