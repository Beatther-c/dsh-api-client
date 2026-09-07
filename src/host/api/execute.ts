/**
 * §5.1 端点 21：POST /api-client/execute —— Human/Agent 共用执行入口。
 * 请求体 `{ request?, requestId?, environment? }`；响应
 * `{ result, historyId, requestEcho, responseEcho }`（requestEcho/responseEcho 永远脱敏
 * ——responseEcho 带执行期 secretValues 跟踪，WP8 起随响应下发，供 client
 * 「交给 Agent」链路优先采用；response body 原样返回仅在 result.bodyText）。
 *
 * 错误映射：输入校验 400 / requestId 未找到 404 / 变量未解析 400 /
 * network-policy 拒绝 403 / 传输与执行失败 502；message 统一经 redaction（router）。
 */
import type { ApiRequest } from '@dsh-api-client/shared'
import { ExecutorError, UnresolvedVariablesError } from '@dsh-api-client/core'
import { RequestNotFoundError } from '../services/collection-service.ts'
import type { ExecutionService, ExecuteInput } from '../services/execution-service.ts'
import { ExecuteInputError } from '../services/execution-service.ts'
import type { ApiRouter } from './router.ts'
import { ApiError, sendJson } from './router.ts'

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseExecuteBody(body: unknown, source: 'human' | 'agent'): ExecuteInput {
  if (!isRecord(body)) throw new ApiError(400, 'invalid-input', 'execute body must be an object')
  if (body.request !== undefined && body.requestId !== undefined) {
    throw new ApiError(400, 'invalid-input', 'pass either request or requestId, not both')
  }
  if (body.environment !== undefined && typeof body.environment !== 'string') {
    throw new ApiError(400, 'invalid-input', 'environment must be a string (id or name)')
  }
  let request: ExecuteInput['request']
  if (body.request !== undefined) {
    if (!isRecord(body.request)) throw new ApiError(400, 'invalid-input', 'request must be an object')
    const raw = body.request
    if (typeof raw.method !== 'string' || !HTTP_METHODS.has(raw.method.toUpperCase())) {
      throw new ApiError(400, 'invalid-input', `request.method must be one of ${[...HTTP_METHODS].join(', ')}`)
    }
    if (typeof raw.url !== 'string') {
      throw new ApiError(400, 'invalid-input', 'request.url must be a string')
    }
    request = { ...(raw as unknown as ApiRequest), method: raw.method.toUpperCase() as ApiRequest['method'] }
  }
  return {
    ...(request !== undefined ? { request } : {}),
    ...(typeof body.requestId === 'string' ? { requestId: body.requestId } : {}),
    ...(typeof body.environment === 'string' ? { environment: body.environment } : {}),
    source,
  }
}

/** core 执行错误 → HTTP 语义（message 已随 §5.1 错误格式经 redaction）。 */
function mapExecutionError(error: unknown): never {
  if (error instanceof RequestNotFoundError) {
    throw new ApiError(404, 'request-not-found', error.message)
  }
  if (error instanceof UnresolvedVariablesError) {
    throw new ApiError(400, 'unresolved-variables', error.message)
  }
  if (error instanceof ExecutorError) {
    switch (error.kind) {
      case 'invalid-request':
      case 'unresolved-variables':
        throw new ApiError(400, error.kind, error.message)
      case 'permission-denied':
      case 'network-policy-denied':
        throw new ApiError(403, error.kind, error.message)
      default:
        throw new ApiError(502, error.kind, error.message)
    }
  }
  throw error
}

export function registerExecuteRoutes(api: ApiRouter, execution: ExecutionService): void {
  api.post('/api-client/execute', async (ctx) => {
    const input = parseExecuteBody(await ctx.json(), ctx.auth.source)
    try {
      const output = await execution.execute(input)
      sendJson(ctx.res, 200, {
        result: output.result,
        ...(output.historyId !== undefined ? { historyId: output.historyId } : {}),
        requestEcho: output.requestEcho,
        responseEcho: output.responseEcho,
      })
    } catch (error) {
      if (error instanceof ExecuteInputError) throw new ApiError(400, error.code, error.message)
      mapExecutionError(error)
    }
  })
}
