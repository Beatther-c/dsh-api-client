/**
 * §5.1 端点 9–14：Request CRUD / duplicate / move。
 * 响应一律经 redaction-service 投影（auth 材料只出 `<redacted>`/SecretRef 形态）。
 */
import type { ApiRequest } from '@dsh-api-client/shared'
import type { CollectionService, NewRequestInput, RequestPatch } from '../services/collection-service.ts'
import { CollectionNotFoundError, RequestNotFoundError } from '../services/collection-service.ts'
import type { RedactionService } from '../services/redaction-service.ts'
import type { ApiRouter } from './router.ts'
import { ApiError, sendJson, sendNoContent } from './router.ts'

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toNotFound(error: unknown): never {
  if (error instanceof CollectionNotFoundError || error instanceof RequestNotFoundError) {
    throw new ApiError(404, error.code, error.message)
  }
  throw error
}

/** POST 保存请求的请求体验证（§5.1 端点 9：ApiRequest 无 id + folderId?）。 */
function parseNewRequest(body: unknown): NewRequestInput {
  if (!isRecord(body) || typeof body.name !== 'string' || body.name.trim() === '') {
    throw new ApiError(400, 'invalid-input', 'request name is required')
  }
  if (body.method !== undefined && (typeof body.method !== 'string' || !HTTP_METHODS.has(body.method.toUpperCase()))) {
    throw new ApiError(400, 'invalid-input', `method must be one of ${[...HTTP_METHODS].join(', ')}`)
  }
  if (body.url !== undefined && typeof body.url !== 'string') {
    throw new ApiError(400, 'invalid-input', 'url must be a string')
  }
  if (body.folderId !== undefined && typeof body.folderId !== 'string') {
    throw new ApiError(400, 'invalid-input', 'folderId must be a string')
  }
  return {
    name: body.name,
    ...(body.method !== undefined ? { method: (body.method as string).toUpperCase() as NewRequestInput['method'] } : {}),
    ...(body.url !== undefined ? { url: body.url as string } : {}),
    ...(body.params !== undefined ? { params: body.params as NewRequestInput['params'] } : {}),
    ...(body.headers !== undefined ? { headers: body.headers as NewRequestInput['headers'] } : {}),
    ...(body.auth !== undefined ? { auth: body.auth as NewRequestInput['auth'] } : {}),
    ...(body.body !== undefined ? { body: body.body as NewRequestInput['body'] } : {}),
    ...(body.folderId !== undefined ? { folderId: body.folderId as string } : {}),
  }
}

export function registerRequestRoutes(
  api: ApiRouter,
  collections: CollectionService,
  redaction: RedactionService,
): void {
  // 9. POST /api-client/collections/:id/requests —— 保存请求（AC-16）。
  api.post('/api-client/collections/:id/requests', async (ctx) => {
    const input = parseNewRequest(await ctx.json())
    try {
      sendJson(ctx.res, 200, redaction.projectRequest(collections.addRequest(ctx.params.id!, input)))
    } catch (error) {
      toNotFound(error)
    }
  })

  // 10. GET /api-client/requests/:id —— 单条（投影）。
  api.get('/api-client/requests/:id', (ctx) => {
    const hit = collections.findRequestLocation(ctx.params.id!)
    if (hit === undefined) throw new ApiError(404, 'request-not-found', `request not found: ${ctx.params.id}`)
    sendJson(ctx.res, 200, redaction.projectRequest(hit.request))
  })

  // 11. PATCH /api-client/requests/:id —— 部分字段。
  api.patch('/api-client/requests/:id', async (ctx) => {
    const body = await ctx.json()
    if (!isRecord(body)) throw new ApiError(400, 'invalid-input', 'patch body must be an object')
    if (body.method !== undefined && (typeof body.method !== 'string' || !HTTP_METHODS.has(body.method.toUpperCase()))) {
      throw new ApiError(400, 'invalid-input', `method must be one of ${[...HTTP_METHODS].join(', ')}`)
    }
    // folderId 不能经 PATCH 改（只改字段不迁移树节点会损坏结构）——走 move 端点。
    if (body.folderId !== undefined) {
      throw new ApiError(400, 'invalid-input', 'folderId changes must use POST /api-client/requests/:id/move')
    }
    const { id: _id, collectionId: _cid, createdAt: _cat, updatedAt: _uat, ...rest } = body
    const patch = rest as RequestPatch
    try {
      const updated = collections.patchRequest(ctx.params.id!, patch)
      sendJson(ctx.res, 200, redaction.projectRequest(updated as ApiRequest))
    } catch (error) {
      toNotFound(error)
    }
  })

  // 12. DELETE /api-client/requests/:id —— 204。
  api.delete('/api-client/requests/:id', (ctx) => {
    try {
      collections.deleteRequest(ctx.params.id!)
    } catch (error) {
      toNotFound(error)
    }
    sendNoContent(ctx.res)
  })

  // 13. POST /api-client/requests/:id/duplicate。
  api.post('/api-client/requests/:id/duplicate', (ctx) => {
    try {
      sendJson(ctx.res, 200, redaction.projectRequest(collections.duplicateRequest(ctx.params.id!)))
    } catch (error) {
      toNotFound(error)
    }
  })

  // 14. POST /api-client/requests/:id/move —— { folderId? }（缺省移到顶层）。
  api.post('/api-client/requests/:id/move', async (ctx) => {
    const body = await ctx.json()
    if (body !== undefined && !isRecord(body)) throw new ApiError(400, 'invalid-input', 'move body must be an object')
    const folderId = body?.folderId
    if (folderId !== undefined && folderId !== null && typeof folderId !== 'string') {
      throw new ApiError(400, 'invalid-input', 'folderId must be a string')
    }
    try {
      sendJson(
        ctx.res,
        200,
        redaction.projectRequest(
          collections.moveRequest(ctx.params.id!, folderId === null ? undefined : (folderId as string | undefined)),
        ),
      )
    } catch (error) {
      toNotFound(error)
    }
  })
}
