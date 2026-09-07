/**
 * Host API fetch 封装（§5.1 公共契约 + bootstrap 契约）：
 * - bootstrap：同源 index.html 注入的 `window.__DSH_API_CLIENT_BOOTSTRAP__ = { base, token }`
 *   （常量名与 src/host/index.ts 的 API_BASE / TOKEN_GLOBAL_NAME 同名字符串，client 侧自行声明）；
 * - 调用纪律：全部请求带 `Authorization: Bearer <token>`；非 GET 必带
 *   `X-Dsh-Api-Client-Request: 1`（CSRF-safe mutation contract，api/auth.ts）；
 * - 错误规整：非 2xx 一律抛 HostApiError { status, code, message }（host 错误格式
 *   `{ error: { code, message } }`，message 已经 host redaction）。
 *
 * 本文件不 import 任何 DSH 包（TC-A-03）。
 */

/** 与 host 侧 API_BASE 同名字符串（src/host/index.ts）。 */
export const API_BASE = '/api-client'
/** 与 host 侧 TOKEN_GLOBAL_NAME 同名字符串（src/host/index.ts）。 */
export const TOKEN_GLOBAL_NAME = '__DSH_API_CLIENT_BOOTSTRAP__'
/** CSRF-safe mutation contract 自定义头（api/auth.ts CSRF_HEADER 的大写形态）。 */
export const CSRF_HEADER = 'X-Dsh-Api-Client-Request'

export interface HostApiBootstrap {
  base: string
  token: string
}

/** 规整后的 API 错误（UI 只消费 code/message，绝不展示原始响应体）。 */
export class HostApiError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'HostApiError'
    this.status = status
    this.code = code
  }
}

/** 读取同源 bootstrap；未注入（插件 host 半未装配或非 DSH 页面）返回 undefined。 */
export function readBootstrap(globalRef: Record<string, unknown> = globalThis as Record<string, unknown>): HostApiBootstrap | undefined {
  const raw = globalRef[TOKEN_GLOBAL_NAME]
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  if (typeof record.base !== 'string' || typeof record.token !== 'string') return undefined
  return { base: record.base, token: record.token }
}

export interface HostApiClient {
  /** bootstrap 是否可用；不可用时 UI 显示降级提示而非反复失败。 */
  readonly available: boolean
  request<T>(method: string, path: string, body?: unknown): Promise<T>
  get<T>(path: string): Promise<T>
  post<T>(path: string, body?: unknown): Promise<T>
  patch<T>(path: string, body?: unknown): Promise<T>
  put<T>(path: string, body?: unknown): Promise<T>
  delete(path: string): Promise<void>
}

function normalizeErrorBody(status: number, payload: unknown): HostApiError {
  if (typeof payload === 'object' && payload !== null) {
    const error = (payload as { error?: unknown }).error
    if (typeof error === 'object' && error !== null) {
      const record = error as Record<string, unknown>
      if (typeof record.code === 'string' && typeof record.message === 'string') {
        return new HostApiError(status, record.code, record.message)
      }
    }
  }
  return new HostApiError(status, 'http-error', `request failed with status ${status}`)
}

/**
 * 创建 Host API client（每次 render 调用成本可忽略；bootstrap 缺失时 available=false，
 * 请求直接抛 HostApiError(0,'bootstrap-missing') 而不发网络请求）。
 */
export function createHostApi(): HostApiClient {
  const bootstrap = readBootstrap()

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (bootstrap === undefined) {
      throw new HostApiError(0, 'bootstrap-missing', 'host api bootstrap missing (plugin host half not active)')
    }
    const verb = method.toUpperCase()
    const headers: Record<string, string> = { Authorization: `Bearer ${bootstrap.token}` }
    if (verb !== 'GET') headers[CSRF_HEADER] = '1'
    if (body !== undefined) headers['content-type'] = 'application/json'
    let response: Response
    try {
      response = await fetch(`${bootstrap.base}${path}`, {
        method: verb,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
    } catch (error) {
      throw new HostApiError(0, 'network-error', error instanceof Error ? error.message : String(error))
    }
    if (response.status === 204) return undefined as T
    const text = await response.text()
    let payload: unknown
    try {
      payload = text === '' ? undefined : JSON.parse(text)
    } catch {
      throw new HostApiError(response.status, 'invalid-response', 'host returned a non-JSON response')
    }
    if (!response.ok) throw normalizeErrorBody(response.status, payload)
    return payload as T
  }

  return {
    available: bootstrap !== undefined,
    request,
    get: <T>(path: string) => request<T>('GET', path),
    post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
    patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
    put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
    delete: async (path: string) => {
      await request<undefined>('DELETE', path)
    },
  }
}

/** React hook 形态：返回稳定的 client 引用（bootstrap 在页面生命周期内不变）。 */
export function useHostApi(): HostApiClient {
  return cached ??= createHostApi()
}

let cached: HostApiClient | undefined
