/**
 * Host API router（§3.4 api/router）：webServer.register 抽象 + 统一鉴权中间件挂载。
 *
 * 注册机制（WP0 U-7 实测）：`ctx.webServer.register({ kind, path, handler })`
 * over raw node:http；duplicate (kind, path) throws。
 *
 * **SPA fallback 坑的处置**：DSH Web composition 的 fallback 席位归 SPA dist
 * server——未命名路由匹配的路径会吃到 200 index.html。因此本 router 只向
 * webServer 注册**一条 prefix 路由 `/api-client`**，内部自分发；未匹配路径
 * 返回 JSON 404（`{ error: { code: 'not-found' } }`），绝不让 API 路径漏进
 * SPA fallback（M0 V-17 的「ping 404」语义由本 404 出口继承）。
 *
 * 错误格式统一 `{ error: { code, message } }`，message 出场前经 redaction-service。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { AuthContext } from './auth.ts'

/** webServer 注册面的最小结构（真实 WebServer 与测试 fake 共用）。 */
export interface WebServerLike {
  register(route: WebRoute): () => void
}

/** API 错误：handler/service 抛出后由 router 统一格式化。 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export interface ApiRequestContext {
  req: IncomingMessage
  res: ServerResponse
  method: string
  /** pathname（含 base 前缀）。 */
  path: string
  /** `:param` 路径参数。 */
  params: Record<string, string>
  query: URLSearchParams
  /** 统一鉴权结果（source identity 等，§24.4）。 */
  auth: AuthContext
  /** JSON body 解析（memoized；非法 JSON → 400；空 body → undefined）。 */
  json<T = unknown>(): Promise<T | undefined>
}

export type ApiHandler = (ctx: ApiRequestContext) => void | Promise<void>

interface RouteEntry {
  method: string
  pattern: string
  segments: string[]
  handler: ApiHandler
}

export interface ApiRouterOptions {
  /** 挂载前缀（默认 '/api-client'，§5.1 Base）。 */
  base?: string
  /** 统一鉴权中间件（api/auth.ts）；抛 ApiError 即拒。 */
  authenticate: (req: IncomingMessage) => AuthContext
  /** 错误消息出场前的 redaction 出口（redaction-service）。 */
  redactError: (error: unknown) => string
}

const BODY_LIMIT_BYTES = 1024 * 1024

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

export function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, { 'cache-control': 'no-store' })
  res.end()
}

export class ApiRouter {
  readonly base: string
  private readonly routes: RouteEntry[] = []

  constructor(private readonly options: ApiRouterOptions) {
    this.base = options.base ?? '/api-client'
  }

  addRoute(method: string, pattern: string, handler: ApiHandler): void {
    const segments = pattern.split('/').filter((s) => s !== '')
    this.routes.push({ method: method.toUpperCase(), pattern, segments, handler })
  }

  get(pattern: string, handler: ApiHandler): void {
    this.addRoute('GET', pattern, handler)
  }

  post(pattern: string, handler: ApiHandler): void {
    this.addRoute('POST', pattern, handler)
  }

  patch(pattern: string, handler: ApiHandler): void {
    this.addRoute('PATCH', pattern, handler)
  }

  put(pattern: string, handler: ApiHandler): void {
    this.addRoute('PUT', pattern, handler)
  }

  delete(pattern: string, handler: ApiHandler): void {
    this.addRoute('DELETE', pattern, handler)
  }

  /**
   * 向 webServer 注册单条 prefix 路由（SPA fallback 处置，见文件头）。
   * duplicate (kind, path) 由 webServer 抛出——组合级契约冲突不吞。
   * 返回注销 disposer。
   */
  attach(webServer: WebServerLike): () => void {
    const route: WebRoute = {
      kind: 'prefix',
      path: this.base,
      handler: (req, res) => this.handle(req, res),
    }
    return webServer.register(route)
  }

  /** 请求分发（attach 的 handler 与测试用 node http server 共用此入口）。 */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      // 统一鉴权中间件（全部端点无一例外，§5.1）。
      const auth = this.options.authenticate(req)

      const url = new URL(req.url ?? '/', 'http://localhost')
      const path = url.pathname.replace(/\/+$/, '') || '/'
      const segments = path.split('/').filter((s) => s !== '')

      let pathMatched = false
      for (const route of this.routes) {
        const params = matchSegments(route.segments, segments)
        if (params === undefined) continue
        pathMatched = true
        if (route.method !== (req.method ?? 'GET').toUpperCase()) continue
        const ctx = this.buildContext(req, res, path, params, url.searchParams, auth)
        await route.handler(ctx)
        return
      }
      if (pathMatched) {
        throw new ApiError(405, 'method-not-allowed', `method ${req.method} not allowed on ${path}`)
      }
      throw new ApiError(404, 'not-found', `no api-client route for ${req.method} ${path}`)
    } catch (error) {
      this.respondError(res, error)
    }
  }

  private buildContext(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    params: Record<string, string>,
    query: URLSearchParams,
    auth: AuthContext,
  ): ApiRequestContext {
    let bodyPromise: Promise<unknown> | undefined
    return {
      req,
      res,
      method: (req.method ?? 'GET').toUpperCase(),
      path,
      params,
      query,
      auth,
      json<T = unknown>(): Promise<T | undefined> {
        bodyPromise ??= readJsonBody(req)
        return bodyPromise as Promise<T | undefined>
      },
    }
  }

  private respondError(res: ServerResponse, error: unknown): void {
    if (res.headersSent) {
      res.end()
      return
    }
    if (error instanceof ApiError) {
      sendJson(res, error.status, { error: { code: error.code, message: this.options.redactError(error) } })
      return
    }
    // 服务层带码错误（ProfileUnresolvedError / SettingsValidationError 等）：
    // duck-typed { code, httpStatus }，错误格式与 ApiError 一致。
    const coded = error as { code?: unknown; httpStatus?: unknown }
    if (typeof coded.code === 'string' && typeof coded.httpStatus === 'number') {
      sendJson(res, coded.httpStatus, { error: { code: coded.code, message: this.options.redactError(error) } })
      return
    }
    sendJson(res, 500, { error: { code: 'internal-error', message: this.options.redactError(error) } })
  }
}

/** 段匹配：`:name` 段收集参数；段数不等或静态段不匹配 → undefined。 */
function matchSegments(pattern: string[], actual: string[]): Record<string, string> | undefined {
  if (pattern.length !== actual.length) return undefined
  const params: Record<string, string> = {}
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i]!
    const a = actual[i]!
    if (p.startsWith(':')) {
      params[p.slice(1)] = decodeURIComponent(a)
    } else if (p !== a) {
      return undefined
    }
  }
  return params
}

/** JSON body 读取（1 MiB 上限；非法 JSON → 400；空 body → undefined）。 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.byteLength
    if (size > BODY_LIMIT_BYTES) throw new ApiError(413, 'body-too-large', `body exceeds ${BODY_LIMIT_BYTES} bytes`)
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    throw new ApiError(400, 'invalid-json', 'request body is not valid JSON')
  }
}
