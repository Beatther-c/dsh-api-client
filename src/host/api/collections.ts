/**
 * §5.1 端点 2–8：Collection CRUD / duplicate / reorder。
 * 响应一律经 redaction-service 投影（auth 材料只出 `<redacted>`/SecretRef 形态）。
 */
import type { CollectionService, CollectionPatch } from '../services/collection-service.ts'
import { CollectionNotFoundError } from '../services/collection-service.ts'
import type { RedactionService } from '../services/redaction-service.ts'
import type { ApiRouter } from './router.ts'
import { ApiError, sendJson, sendNoContent } from './router.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function registerCollectionRoutes(
  api: ApiRouter,
  collections: CollectionService,
  redaction: RedactionService,
): void {
  // 2. GET /api-client/collections —— 列表（投影）。
  api.get('/api-client/collections', ({ res }) => {
    sendJson(res, 200, redaction.projectCollections(collections.list()))
  })

  // 3. POST /api-client/collections —— 新建 { name }。
  api.post('/api-client/collections', async (ctx) => {
    const body = await ctx.json()
    if (!isRecord(body) || typeof body.name !== 'string' || body.name.trim() === '') {
      throw new ApiError(400, 'invalid-input', 'collection name is required')
    }
    sendJson(ctx.res, 200, redaction.projectCollection(collections.create(body.name)))
  })

  // 4. GET /api-client/collections/:id —— 单棵完整树。
  api.get('/api-client/collections/:id', (ctx) => {
    const collection = collections.get(ctx.params.id!)
    if (collection === undefined) throw new ApiError(404, 'collection-not-found', `collection not found: ${ctx.params.id}`)
    sendJson(ctx.res, 200, redaction.projectCollection(collection))
  })

  // 5. PATCH /api-client/collections/:id —— 重命名/变量/auth。
  api.patch('/api-client/collections/:id', async (ctx) => {
    const body = await ctx.json()
    if (!isRecord(body)) throw new ApiError(400, 'invalid-input', 'patch body must be an object')
    const patch: CollectionPatch = {}
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || body.name.trim() === '') {
        throw new ApiError(400, 'invalid-input', 'collection name must be a non-empty string')
      }
      patch.name = body.name
    }
    if (body.variables !== undefined) {
      if (!Array.isArray(body.variables)) throw new ApiError(400, 'invalid-input', 'variables must be an array')
      patch.variables = body.variables as CollectionPatch['variables']
    }
    if (body.auth !== undefined) {
      if (!isRecord(body.auth) || typeof body.auth.type !== 'string') {
        throw new ApiError(400, 'invalid-input', 'auth must be an AuthConfig object')
      }
      patch.auth = body.auth as CollectionPatch['auth']
    }
    try {
      sendJson(ctx.res, 200, redaction.projectCollection(collections.patch(ctx.params.id!, patch)))
    } catch (error) {
      if (error instanceof CollectionNotFoundError) {
        throw new ApiError(404, 'collection-not-found', error.message)
      }
      throw error
    }
  })

  // 6. DELETE /api-client/collections/:id —— 204。
  api.delete('/api-client/collections/:id', (ctx) => {
    try {
      collections.delete(ctx.params.id!)
    } catch (error) {
      if (error instanceof CollectionNotFoundError) {
        throw new ApiError(404, 'collection-not-found', error.message)
      }
      throw error
    }
    sendNoContent(ctx.res)
  })

  // 7. POST /api-client/collections/:id/duplicate —— Duplicate（深拷贝新 id）。
  api.post('/api-client/collections/:id/duplicate', (ctx) => {
    try {
      sendJson(ctx.res, 200, redaction.projectCollection(collections.duplicate(ctx.params.id!)))
    } catch (error) {
      if (error instanceof CollectionNotFoundError) {
        throw new ApiError(404, 'collection-not-found', error.message)
      }
      throw error
    }
  })

  // 8. POST /api-client/collections/:id/reorder —— { itemIds: string[] }。
  api.post('/api-client/collections/:id/reorder', async (ctx) => {
    const body = await ctx.json()
    if (!isRecord(body) || !Array.isArray(body.itemIds) || body.itemIds.some((id) => typeof id !== 'string')) {
      throw new ApiError(400, 'invalid-input', 'reorder requires { itemIds: string[] }')
    }
    try {
      sendJson(ctx.res, 200, redaction.projectCollection(collections.reorder(ctx.params.id!, body.itemIds as string[])))
    } catch (error) {
      if (error instanceof CollectionNotFoundError) {
        throw new ApiError(404, 'collection-not-found', error.message)
      }
      throw error
    }
  })
}
