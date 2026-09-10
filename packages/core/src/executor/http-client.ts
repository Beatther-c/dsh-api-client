/**
 * Node/undici HTTP 封装（§3.2 executor/http-client；§8.1 24.3 执行点）。
 *
 * - timeout：整体 AbortController 到时中断（TC-C-14）；
 * - redirect 手工逐跳（maxRedirections=0 + 自循环），每跳重新过 network policy（TC-C-16）；
 * - maxResponseBytes：流式累计，超限即报错并记录 size（TC-C-15）；
 * - DNS rebinding 防护执行点：连接前解析一次、按解析 IP 再评估、并把该 IP 固定给
 *   connect.lookup——TCP 连接精确落到已验证的 IP 上（解析器可注入，便于 mock 测试）。
 *
 * 这是 core 中唯一允许网络 I/O 的文件。
 */
import { STATUS_CODES } from 'node:http'
import dns from 'node:dns/promises'
import { Agent, request as undiciRequest } from 'undici'
import type { Dispatcher } from 'undici'
import type { HttpMethod, KeyValue } from '@dsh-api-client/shared'
import type { PolicyDecision, PolicyTarget } from '../security/network-policy.ts'
import { groupHeadersByLowerName } from '../request/build.ts'
import { ExecutorError } from './errors.ts'

export type PolicyEvaluator = (target: PolicyTarget) => PolicyDecision

export interface ResolvedAddress {
  address: string
  family: number
}

/** 可注入的 DNS 解析器（mock resolver 用于 rebinding 测试，TC-SEC-05 的挂点）。 */
export type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>

const defaultResolver: HostResolver = async (hostname) => {
  const addresses = await dns.lookup(hostname, { all: true })
  return addresses.map((a) => ({ address: a.address, family: a.family }))
}

export interface HttpClientOptions {
  timeoutMs: number
  maxResponseBytes: number
  /** 每跳（含首跳）连接前调用；dnsRebindingProtection 时解析 IP 后再调一次。 */
  evaluatePolicy: PolicyEvaluator
  /** redirectPolicy==='follow' 时 true（'none'/'manual-block' 均不自动跟随，见 §3.2 说明）。 */
  followRedirects: boolean
  dnsRebindingProtection: boolean
  maxRedirects?: number
  resolveHost?: HostResolver
}

export interface HttpWireRequest {
  method: HttpMethod
  url: string
  headers: KeyValue[]
  body?: string | Uint8Array
}

export interface HttpWireResponse {
  status: number
  statusText: string
  headers: KeyValue[]
  bodyText: string
  redirected: boolean
  finalUrl: string
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const DEFAULT_MAX_REDIRECTS = 10

function headersToWire(headers: KeyValue[]): Record<string, string | string[]> {
  // P0 §5.4 / UX §6.3：按 lowercase 名称聚合——保留第一行用户拼写作为 object key，
  // 值按原用户顺序 string[]（undici 对数组值逐条发送为重复 Header 行；实际重复
  // Header 行为由 tests/p0-undici-wire.spec.ts 集成固化，不承诺协议不允许的语义）。
  // 不得由于大小写差异创建两个 wire object keys。
  const out: Record<string, string | string[]> = {}
  for (const group of groupHeadersByLowerName(headers)) {
    out[group.name] = group.values.length === 1 ? (group.values[0] as string) : group.values
  }
  return out
}

function wireToKeyValues(headers: Record<string, string | string[] | undefined>): KeyValue[] {
  const out: KeyValue[] = []
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const v of value) out.push({ key, value: v, enabled: true })
    } else {
      out.push({ key, value, enabled: true })
    }
  }
  return out
}

function portOf(url: URL): number {
  if (url.port !== '') return Number.parseInt(url.port, 10)
  return url.protocol === 'https:' ? 443 : 80
}

/** DNS 固定 dispatcher：解析一次 → 按解析 IP 评估 → 把该 IP 固定给 connect.lookup。 */
function pinnedDispatcher(
  port: number,
  evaluatePolicy: PolicyEvaluator,
  resolveHost: HostResolver,
): Dispatcher {
  return new Agent({
    connect: {
      lookup: (hostname, lookupOptions, callback) => {
        resolveHost(hostname)
          .then((addresses) => {
            const first = addresses[0]
            if (!first) {
              callback(Object.assign(new Error(`DNS resolution failed for ${hostname}`), { code: 'ENOTFOUND' }), '', 4)
              return
            }
            const decision = evaluatePolicy({ host: hostname, port, resolvedIp: first.address })
            if (!decision.allowed) {
              callback(
                Object.assign(new Error(`network policy denied resolved ip ${first.address}: ${decision.reason}`), {
                  code: 'ECONNREFUSED',
                }),
                '',
                4,
              )
              return
            }
            // 固定到已验证的单个 IP；net.connect 以 all:true 调用时需数组形态
            if (lookupOptions.all === true) {
              callback(null, [{ address: first.address, family: first.family }])
            } else {
              callback(null, first.address, first.family)
            }
          })
          .catch((error: unknown) => {
            callback(error instanceof Error ? error : new Error(String(error)), '', 4)
          })
      },
    },
  })
}

async function readBodyWithCap(body: AsyncIterable<Uint8Array>, maxResponseBytes: number): Promise<string> {
  const chunks: Buffer[] = []
  let received = 0
  try {
    for await (const chunk of body) {
      received += chunk.length
      if (received > maxResponseBytes) {
        throw new ExecutorError(
          'response-too-large',
          `response body exceeds maxResponseBytes (received ${received} > limit ${maxResponseBytes})`,
          { limit: maxResponseBytes, received },
        )
      }
      chunks.push(Buffer.from(chunk))
    }
  } catch (error) {
    ;(body as unknown as { destroy?: () => void }).destroy?.()
    throw error
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** 单跳执行：policy 预检 →（可选）DNS 固定连接 → 发请求 → 限时读 body。 */
async function executeHop(
  wire: HttpWireRequest,
  url: URL,
  options: HttpClientOptions,
): Promise<{ status: number; headers: KeyValue[]; bodyText: string }> {
  const host = url.hostname
  const port = portOf(url)
  const decision = options.evaluatePolicy({ host, port })
  if (!decision.allowed) {
    throw new ExecutorError(
      'network-policy-denied',
      `network policy denied ${host}:${port} — ${decision.reason}`,
      { host, port },
    )
  }

  const dispatcher = options.dnsRebindingProtection
    ? pinnedDispatcher(port, options.evaluatePolicy, options.resolveHost ?? defaultResolver)
    : undefined

  const ac = new AbortController()
  const timer = setTimeout(() => {
    ac.abort(new ExecutorError('timeout', `request timed out after ${options.timeoutMs}ms`))
  }, options.timeoutMs)

  try {
    const response = await undiciRequest(url, {
      method: wire.method,
      headers: headersToWire(wire.headers),
      ...(wire.body !== undefined ? { body: wire.body } : {}),
      signal: ac.signal,
      ...(dispatcher !== undefined ? { dispatcher } : {}),
    })
    const bodyText = await readBodyWithCap(response.body, options.maxResponseBytes)
    return {
      status: response.statusCode,
      headers: wireToKeyValues(response.headers as Record<string, string | string[] | undefined>),
      bodyText,
    }
  } catch (error) {
    if (error instanceof ExecutorError) throw error
    if (ac.signal.aborted) {
      throw new ExecutorError('timeout', `request timed out after ${options.timeoutMs}ms`)
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new ExecutorError('network', `network error: ${message}`)
  } finally {
    clearTimeout(timer)
    if (dispatcher !== undefined) {
      await dispatcher.close().catch(() => {})
    }
  }
}

/** fetch 规范的 redirect 方法改写：303 一律 GET；301/302 + POST → GET；其余保持。 */
function redirectWire(wire: HttpWireRequest, status: number): HttpWireRequest {
  const toGet = status === 303 || ((status === 301 || status === 302) && wire.method === 'POST')
  if (!toGet) return wire
  const headers = wire.headers.filter((h) => {
    const lower = h.key.toLowerCase()
    return lower !== 'content-type' && lower !== 'content-length'
  })
  const next: HttpWireRequest = { method: 'GET', url: wire.url, headers }
  return next
}

/**
 * 手工逐跳 redirect：每跳重新过 network policy（hostname 预检 + 解析 IP 复检），
 * 命中 redirectPolicy!=='follow' 时 3xx 原样返回（redirected=false）。
 */
export async function executeHttp(wire: HttpWireRequest, options: HttpClientOptions): Promise<HttpWireResponse> {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  let current = wire
  let currentUrl = new URL(wire.url)
  let redirected = false

  for (let hop = 0; ; hop++) {
    const { status, headers, bodyText } = await executeHop(current, currentUrl, options)
    const location = headers.find((h) => h.key.toLowerCase() === 'location')?.value
    if (REDIRECT_STATUSES.has(status) && location !== undefined && options.followRedirects) {
      if (hop >= maxRedirects) {
        throw new ExecutorError('too-many-redirects', `redirect limit exceeded (${maxRedirects})`)
      }
      currentUrl = new URL(location, currentUrl)
      current = { ...redirectWire(current, status), url: currentUrl.toString() }
      redirected = true
      continue
    }
    return {
      status,
      statusText: STATUS_CODES[status] ?? '',
      headers,
      bodyText,
      redirected,
      finalUrl: currentUrl.toString(),
    }
  }
}
