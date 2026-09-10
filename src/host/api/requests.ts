/**
 * §5.1 端点 9–14：Request CRUD / duplicate / move。
 * 响应一律经 redaction-service 投影（auth 材料只出 `<redacted>`/SecretRef 形态）。
 *
 * P0 扩展（实施设计 §3.2/§3.3/§4.1.1）：
 * - POST /collections/:id/requests 与 PATCH /requests/:id 接受
 *   suppressedGeneratedHeaders：拒绝 source 'auth'/'runtime'、空/非字符串 name、
 *   未知 source、非数组（400 invalid-input）；写入前 name.trim().toLowerCase()
 *   规范化 + (name,source) 去重；新建缺省持久化 []；
 * - PATCH 增加 name 非空校验（既有端点此前对 name 无校验）。
 */
import type { ApiRequest, SuppressedGeneratedHeader } from '@dsh-api-client/shared'
import type { CollectionService, NewRequestInput, RequestPatch } from '../services/collection-service.ts'
import { CollectionNotFoundError, RequestNotFoundError } from '../services/collection-service.ts'
import type { RedactionService } from '../services/redaction-service.ts'
import type { ApiRouter } from './router.ts'
import { ApiError, sendJson, sendNoContent } from './router.ts'

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])

/** §3.3：允许持久化的 suppression source 只有 body / client-default（auth/runtime 不可抑制，§5.8）。 */
const SUPPRESSIBLE_SOURCES = new Set<string>(['body', 'client-default'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toNotFound(error: unknown): never {
  if (error instanceof CollectionNotFoundError || error instanceof RequestNotFoundError) {
    throw new ApiError(404, error.code, error.message)
  }
  throw error
}

/**
 * §3.3 suppressedGeneratedHeaders 校验 + 规范化：
 * 拒绝非数组 / 非对象项 / 空或非字符串 name / 'auth'/'runtime' / 未知 source；
 * 通过项做 name.trim().toLowerCase()，并按 (name,source) 去重（保留首个）。
 */
function parseSuppressedGeneratedHeaders(value: unknown): SuppressedGeneratedHeader[] {
  if (!Array.isArray(value)) throw new ApiError(400, 'invalid-input', 'suppressedGeneratedHeaders 必须是数组')
  const out: SuppressedGeneratedHeader[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!isRecord(item)) throw new ApiError(400, 'invalid-input', 'suppressedGeneratedHeaders 项必须是对象')
    if (typeof item.name !== 'string' || item.name.trim() === '') {
      throw new ApiError(400, 'invalid-input', 'suppressedGeneratedHeaders.name 必须是非空字符串')
    }
    if (typeof item.source !== 'string' || !SUPPRESSIBLE_SOURCES.has(item.source)) {
      throw new ApiError(400, 'invalid-input', "suppressedGeneratedHeaders.source 仅支持 'body'/'client-default'（auth/runtime 不可抑制）")
    }
    const name = item.name.trim().toLowerCase()
    const key = `${name}\u0000${item.source}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ name, source: item.source as SuppressedGeneratedHeader['source'] })
  }
  return out
}

/** POST 保存请求的请求体验证（§5.1 端点 9：ApiRequest 无 id + folderId?；P0 §3.2：suppressedGeneratedHeaders 默认 []）。 */
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
  const suppressedGeneratedHeaders =
    body.suppressedGeneratedHeaders !== undefined ? parseSuppressedGeneratedHeaders(body.suppressedGeneratedHeaders) : []
  return {
    name: body.name,
    ...(body.method !== undefined ? { method: (body.method as string).toUpperCase() as NewRequestInput['method'] } : {}),
    ...(body.url !== undefined ? { url: body.url as string } : {}),
    ...(body.params !== undefined ? { params: body.params as NewRequestInput['params'] } : {}),
    ...(body.headers !== undefined ? { headers: body.headers as NewRequestInput['headers'] } : {}),
    ...(body.auth !== undefined ? { auth: body.auth as NewRequestInput['auth'] } : {}),
    ...(body.body !== undefined ? { body: body.body as NewRequestInput['body'] } : {}),
    suppressedGeneratedHeaders,
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

  // 11. PATCH /api-client/requests/:id —— 部分字段（P0 §3.2：name 非空校验 + suppressedGeneratedHeaders）。
  api.patch('/api-client/requests/:id', async (ctx) => {
    const body = await ctx.json()
    if (!isRecord(body)) throw new ApiError(400, 'invalid-input', 'patch body must be an object')
    if (body.name !== undefined && (typeof body.name !== 'string' || body.name.trim() === '')) {
      throw new ApiError(400, 'invalid-input', 'request 名称必须是非空字符串')
    }
    if (body.method !== undefined && (typeof body.method !== 'string' || !HTTP_METHODS.has(body.method.toUpperCase()))) {
      throw new ApiError(400, 'invalid-input', `method must be one of ${[...HTTP_METHODS].join(', ')}`)
    }
    // folderId 不能经 PATCH 改（只改字段不迁移树节点会损坏结构）——走 move 端点。
    if (body.folderId !== undefined) {
      throw new ApiError(400, 'invalid-input', 'folderId changes must use POST /api-client/requests/:id/move')
    }
    if (body.suppressedGeneratedHeaders !== undefined) {
      // 先于写入完成 §3.3 校验 + 规范化（trim/lowercase/去重），非法 → 400 不落库。
      body.suppressedGeneratedHeaders = parseSuppressedGeneratedHeaders(body.suppressedGeneratedHeaders)
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
