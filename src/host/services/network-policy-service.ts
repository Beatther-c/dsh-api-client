/**
 * Network policy service（§3.4；§24.3）：profile 策略加载 + core 纯评估函数的宿主接线。
 *
 * 合成规则（profile 可继承 shared default，§4.2 scope 表）：
 *   profile settings.networkPolicy（SettingsService 内存权威）
 *   → 缺省时读 `shared/network-policy.default.json`
 *   → 再缺省回退 core DEFAULT_NETWORK_POLICY（fail-closed 基线）。
 * 随后 §25 标量覆盖执行参数：defaultTimeoutMs / maxResponseBytes /
 * followRedirects → redirectPolicy（executor 的唯一策略来源，TC-SEC-07 的生效路径）。
 */
import type { NetworkPolicy } from '@dsh-api-client/shared'
import type { PolicyDecision, PolicyTarget } from '@dsh-api-client/core'
import { DEFAULT_NETWORK_POLICY, evaluateNetworkPolicy } from '@dsh-api-client/core'
import { FileStore } from './storage/file-store.ts'
import { SettingsService } from './settings-service.ts'

export class NetworkPolicyService {
  constructor(
    private readonly store: FileStore,
    private readonly settings: SettingsService,
  ) {}

  /** 当前生效策略（settings 标量覆盖执行参数后的合成结果）。 */
  getPolicy(): NetworkPolicy {
    const settings = this.settings.get()
    const base =
      settings.networkPolicy ??
      this.store.readJson<NetworkPolicy>(this.store.layout.networkPolicyDefaultFile) ??
      DEFAULT_NETWORK_POLICY
    return {
      ...base,
      timeoutMs: settings.defaultTimeoutMs,
      maxResponseBytes: settings.maxResponseBytes,
      redirectPolicy: settings.followRedirects ? 'follow' : 'none',
    }
  }

  /** core 纯评估函数接线（executor 的 preflight / redirect 每跳共用同一入口）。 */
  evaluate(target: PolicyTarget): PolicyDecision {
    return evaluateNetworkPolicy(this.getPolicy(), target)
  }
}
