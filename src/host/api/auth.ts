/**
 * Host API 鉴权中间件（§3.4 api/auth；§24.4；由 M0 remote-api-probe 的
 * 鉴权围栏实测形态沉淀，§3.5 处置）。
 *
 * 判定链（顺序即语义，任一失败即拒）：
 * 1. 显式跨站标记 `Sec-Fetch-Site: cross-site` → 403（loopback 也不放行，
 *    WP0 实测形态保留）；
 * 2. loopback-first：非 loopback socket 必须持 trusted-proxy token
 *    （Workbench 反代场景，§22/§24.4），否则 403；
 * 3. plugin token：`Authorization: Bearer <plugin-token>`，缺失 401 / 错误 401
 *    （TC-API-08）；token 发放走同源 bootstrap（index-inject 全局行，见 index.ts
 *    与 WP2 报告）；
 * 4. Origin 校验：携带 Origin 时其 host 必须与本请求 Host 头一致——伪造
 *    origin（cross-site 但无 Sec-Fetch-Site 标记的客户端）→ 403（TC-API-09）；
 * 5. CSRF-safe mutation contract：非 GET 请求必须带自定义头
 *    `X-Dsh-Api-Client-Request: 1`（浏览器跨站表单无法伪造自定义头），
 *    缺失 403（TC-API-10）；
 * 6. audit source identity 提取（§24.4）：`X-Dsh-Api-Client-Source: agent`
 *    → agent，否则 human（审计语义，安全边界仍是 token——见 WP2 报告）。
 */
import type { IncomingMessage } from 'node:http'
import { ApiError } from './router.ts'

export const CSRF_HEADER = 'x-dsh-api-client-request'
export const SOURCE_HEADER = 'x-dsh-api-client-source'
export const PROXY_TOKEN_HEADER = 'x-dsh-api-client-proxy-token'

export interface PluginAuthConfig {
  /** 插件激活期生成的随机 token（内存持有，不落盘；同源 bootstrap 发放）。 */
  pluginToken: string
  /** Workbench 反代场景的 trusted-proxy token（config 或环境变量注入；未配置时非 loopback 一律拒）。 */
  trustedProxyToken?: string
}

export interface AuthContext {
  /** 执行/审计来源身份（TC-API-11）。 */
  source: 'human' | 'agent'
  /** 是否经 trusted-proxy 通道到达。 */
  viaProxy: boolean
}

/** loopback 字面判定（WP0 实测形态原样保留：IPv4/IPv6/IPv4-mapped）。 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function extractBearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization
  if (typeof header !== 'string') return undefined
  const match = /^Bearer\s+(.+)$/.exec(header.trim())
  return match?.[1]?.trim()
}

/** Origin 头与本请求 Host 的一致性（伪造 origin 判定）。 */
function isOriginConsistent(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (typeof origin !== 'string') return true
  let originHost: string
  try {
    originHost = new URL(origin).host
  } catch {
    return false
  }
  const host = req.headers.host
  if (typeof host !== 'string') return false
  return originHost.toLowerCase() === host.toLowerCase()
}

/**
 * 统一鉴权入口（router 中间件挂载点）。通过 → AuthContext；拒绝 → ApiError。
 */
export function authenticateRequest(req: IncomingMessage, config: PluginAuthConfig): AuthContext {
  // 1. 显式跨站标记（任何通道都拒，WP0 实测形态）。
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    throw new ApiError(403, 'cross-site-refused', 'cross-site requests are refused')
  }

  // 2. loopback-first / trusted-proxy。
  const loopback = isLoopbackAddress(req.socket.remoteAddress)
  let viaProxy = false
  if (!loopback) {
    const proxyToken = req.headers[PROXY_TOKEN_HEADER]
    if (
      config.trustedProxyToken === undefined ||
      typeof proxyToken !== 'string' ||
      proxyToken !== config.trustedProxyToken
    ) {
      throw new ApiError(403, 'untrusted-proxy', 'non-loopback peer without a trusted-proxy token')
    }
    viaProxy = true
  }

  // 3. plugin token（全部端点的凭证，§5.1）。
  const token = extractBearerToken(req)
  if (token === undefined) {
    throw new ApiError(401, 'missing-token', 'plugin token required (Authorization: Bearer)')
  }
  if (token !== config.pluginToken) {
    throw new ApiError(401, 'invalid-token', 'invalid plugin token')
  }

  // 4. Origin 一致性（伪造 origin → 拒，TC-API-09）。
  if (!isOriginConsistent(req)) {
    throw new ApiError(403, 'origin-mismatch', 'origin does not match the request host')
  }

  // 5. CSRF-safe mutation contract（非 GET 强制自定义头，TC-API-10）。
  const method = (req.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && req.headers[CSRF_HEADER] !== '1') {
    throw new ApiError(403, 'missing-csrf-header', `mutation requires header X-Dsh-Api-Client-Request: 1`)
  }

  // 6. audit source identity（§24.4；agent 通道显式声明，缺省 human）。
  const source: AuthContext['source'] = req.headers[SOURCE_HEADER] === 'agent' ? 'agent' : 'human'
  return { source, viaProxy }
}
