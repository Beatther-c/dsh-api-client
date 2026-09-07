/**
 * §24.3 Network Policy 策略模型与纯评估函数（§3.2 security/network-policy）。
 * 默认 fail-closed：localhost/private 拒、public 放；blocked ports 基线 22/23/25/3306/5432/6379/27017。
 * 纯函数，零 I/O；执行点在 executor/http-client（连接前 + redirect 每跳 + DNS 解析后固定 IP 再评估）。
 */
import type { NetworkPolicy } from '@dsh-api-client/shared'

/** §8.1 blocked ports 基线。 */
export const DEFAULT_BLOCKED_PORTS: readonly number[] = [22, 23, 25, 3306, 5432, 6379, 27017]

export const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024
export const DEFAULT_TIMEOUT_MS = 30_000

/** 默认策略（§24.3 fail-closed）。 */
export const DEFAULT_NETWORK_POLICY: NetworkPolicy = {
  allowLocalhost: false,
  allowPrivateNetwork: false,
  allowPublicNetwork: true,
  blockedHosts: [],
  allowedHosts: [],
  blockedPorts: [...DEFAULT_BLOCKED_PORTS],
  redirectPolicy: 'follow',
  maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  dnsRebindingProtection: true,
}

export type PolicyDecision = { allowed: true } | { allowed: false; reason: string }

export interface PolicyTarget {
  host: string
  port: number
  /** DNS 解析结果（rebinding 防护执行点提供）；给出时按解析 IP 分类。 */
  resolvedIp?: string
}

function deny(reason: string): PolicyDecision {
  return { allowed: false, reason }
}

const ALLOWED: PolicyDecision = { allowed: true }

/** 通配 host 匹配：`*.example.com` 匹配其子域；其余为精确匹配（大小写不敏感）。 */
export function matchHostPattern(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase()
  const h = host.toLowerCase()
  if (p.startsWith('*.')) {
    const suffix = p.slice(1) // ".example.com"
    return h.endsWith(suffix) && h.length > suffix.length
  }
  return p === h
}

function matchAnyPattern(patterns: readonly string[], host: string): boolean {
  return patterns.some((p) => matchHostPattern(p, host))
}

// ---- IP 分类（纯函数）----

export function parseIpv4(ip: string): [number, number, number, number] | undefined {
  const parts = ip.split('.')
  if (parts.length !== 4) return undefined
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number.parseInt(p, 10) : Number.NaN))
  if (nums.some((n) => Number.isNaN(n) || n > 255)) return undefined
  return [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0, nums[3] ?? 0]
}

export function isLoopbackIpv4(ip: string): boolean {
  const parsed = parseIpv4(ip)
  return parsed !== undefined && (parsed[0] === 127 || ip === '0.0.0.0')
}

/** 私网段：10/8、172.16/12、192.168/16、169.254/16（§24.3 / TC-SEC-02）。 */
export function isPrivateIpv4(ip: string): boolean {
  const parsed = parseIpv4(ip)
  if (!parsed) return false
  const [a, b] = parsed
  if (a === 10) return true
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  return false
}

function normalizeIpv6(ip: string): string {
  return ip.toLowerCase().replace(/^\[|\]$/g, '')
}

export function isLoopbackIpv6(ip: string): boolean {
  const v = normalizeIpv6(ip)
  return v === '::1' || v === '0:0:0:0:0:0:0:1'
}

/** IPv6 私网：ULA fc00::/7、link-local fe80::/10。 */
export function isPrivateIpv6(ip: string): boolean {
  const v = normalizeIpv6(ip)
  return v.startsWith('fc') || v.startsWith('fd') || /^fe[89ab]/.test(v)
}

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase()
  return h === 'localhost' || h.endsWith('.localhost') || isLoopbackIpv4(h) || isLoopbackIpv6(h)
}

export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase()
  return isPrivateIpv4(h) || isPrivateIpv6(h)
}

export type HostClass = 'localhost' | 'private' | 'public'

/** host 分类：IP 字面量按地址分类；域名形式 localhost/*.localhost 归为 localhost，其余域名视为 public。 */
export function classifyHost(host: string): HostClass {
  if (isLoopbackHost(host)) return 'localhost'
  if (isPrivateHost(host)) return 'private'
  return 'public'
}

/**
 * 纯评估（TC-SEC-01…04 的评估核心；WP1 由 TC-C-16 驱动每跳重评估）。
 * 判定顺序：allowedHosts 白名单 → blockedHosts → blockedPorts → 网段分类（resolvedIp 优先）。
 */
export function evaluateNetworkPolicy(policy: NetworkPolicy, target: PolicyTarget): PolicyDecision {
  const { host, port, resolvedIp } = target

  if (policy.allowedHosts.length > 0 && !matchAnyPattern(policy.allowedHosts, host)) {
    return deny(`host "${host}" not in allowedHosts (whitelist mode)`)
  }
  if (matchAnyPattern(policy.blockedHosts, host)) {
    return deny(`host "${host}" matches blockedHosts`)
  }
  if (policy.blockedPorts.includes(port)) {
    return deny(`port ${port} is in blockedPorts baseline`)
  }

  // 域名 host 给出 resolvedIp 时按解析结果分类（DNS rebinding 防护执行点）。
  const classificationTarget = resolvedIp ?? host
  const klass = classifyHost(classificationTarget)
  if (klass === 'localhost' && !policy.allowLocalhost) {
    return deny(`localhost target "${classificationTarget}" denied by policy (allowLocalhost=false)`)
  }
  if (klass === 'private' && !policy.allowPrivateNetwork) {
    return deny(`private network target "${classificationTarget}" denied by policy (allowPrivateNetwork=false)`)
  }
  if (klass === 'public' && !policy.allowPublicNetwork) {
    return deny(`public network target "${classificationTarget}" denied by policy (allowPublicNetwork=false)`)
  }
  return ALLOWED
}
