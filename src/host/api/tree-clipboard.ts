/**
 * P0 §3.1 冻结合同：tree clipboard 四端点（copy/cut/paste/clear）。
 * 不另造 /tree/mutate、/tree/copy、/tree/move 等第二套通用 mutation API（§0.1/§0.2，AC-46）。
 *
 * - 响应绝不下发 snapshot/name/URL 之外的节点内容：copy/cut 只回
 *   TreeClipboardDescriptor（四字段），paste 只回 TreePasteResult（三字段），
 *   clear 204（token 不存在仍幂等 204）；
 * - 409 响应体 message 为 §3.1.1 逐字文案：「数据已被其他操作修改，请刷新后重试」；
 * - 400 码位（§3.1）：copy → invalid-input；cut → cut-only-request|invalid-input；
 *   paste 的全部入参/矩阵违规 → invalid-paste-target；
 * - 鉴权/错误格式/redaction 走 router 既有出口（ApiError + redactError）。
 */
import type { TreeClipboardService } from '../services/tree-clipboard-service.ts'
import { ClipboardNotFoundError, InvalidPasteTargetError } from '../services/tree-clipboard-service.ts'
import { CollectionNotFoundError, FolderNotFoundError, RequestNotFoundError, VERSION_CONFLICT_MESSAGE, VersionConflictError } from '../services/collection-service.ts'
import type { ApiRouter } from './router.ts'
import { ApiError, sendJson, sendNoContent } from './router.ts'
import type { PasteTargetKind } from '../services/tree-clipboard-service.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireRecord(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) throw new ApiError(400, 'invalid-input', '请求体必须是 JSON 对象')
  return body
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') throw new ApiError(400, 'invalid-input', `${field} 必填且必须是非空字符串`)
  return value
}

function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ApiError(400, 'invalid-input', `${field} 必填且必须是有限数字`)
  return value
}

/** 服务层 404/409 → API 错误（clipboard 端点共用；409 用 §3.1.1 逐字文案）。 */
function toClipboardApiError(error: unknown): never {
  if (error instanceof CollectionNotFoundError) throw new ApiError(404, 'collection-not-found', error.message)
  if (error instanceof FolderNotFoundError) throw new ApiError(404, 'folder-not-found', error.message)
  if (error instanceof RequestNotFoundError) throw new ApiError(404, 'request-not-found', error.message)
  if (error instanceof VersionConflictError) throw new ApiError(409, 'version-conflict', VERSION_CONFLICT_MESSAGE)
  throw error
}

/** paste 专用错误映射：404 面多一个 clipboard-not-found，400 面是 invalid-paste-target。 */
function toPasteApiError(error: unknown): never {
  if (error instanceof ClipboardNotFoundError) throw new ApiError(404, 'clipboard-not-found', error.message)
  if (error instanceof InvalidPasteTargetError) throw new ApiError(400, 'invalid-paste-target', error.message)
  toClipboardApiError(error)
}

export function registerTreeClipboardRoutes(api: ApiRouter, clipboard: TreeClipboardService): void {
  // POST /api-client/tree/clipboard/copy —— Host 捕获 Collection/Folder/Request 权威快照（§3.1）。
  api.post('/api-client/tree/clipboard/copy', async (ctx) => {
    const body = requireRecord(await ctx.json())
    const kind = body.kind
    if (kind !== 'collection' && kind !== 'folder' && kind !== 'request') {
      throw new ApiError(400, 'invalid-input', "kind 必须是 'collection'/'folder'/'request'")
    }
    const collectionId = requireNonEmptyString(body.collectionId, 'collectionId')
    if (kind === 'collection') {
      try {
        sendJson(ctx.res, 200, clipboard.copy({ kind, collectionId }))
      } catch (error) {
        toClipboardApiError(error)
      }
      return
    }
    const nodeId = requireNonEmptyString(body.nodeId, `${kind} 复制的 nodeId`)
    try {
      sendJson(ctx.res, 200, clipboard.copy({ kind, collectionId, nodeId }))
    } catch (error) {
      toClipboardApiError(error)
    }
  })

  // POST /api-client/tree/clipboard/cut —— 创建 Request Cut 引用（P0 剪切仅支持 Request，AC-17）。
  api.post('/api-client/tree/clipboard/cut', async (ctx) => {
    const body = requireRecord(await ctx.json())
    // §3.1 400 cut-only-request：显式携带非 request 的 kind → 直接拒绝（Collection/Folder 无 Cut）。
    if (body.kind !== undefined && body.kind !== 'request') {
      throw new ApiError(400, 'cut-only-request', 'P0 剪切仅支持 Request 节点')
    }
    const requestId = requireNonEmptyString(body.requestId, 'requestId')
    const requestUpdatedAt = requireFiniteNumber(body.requestUpdatedAt, 'requestUpdatedAt')
    const sourceCollectionUpdatedAt = requireFiniteNumber(body.sourceCollectionUpdatedAt, 'sourceCollectionUpdatedAt')
    try {
      sendJson(ctx.res, 200, clipboard.cut({ requestId, requestUpdatedAt, sourceCollectionUpdatedAt }))
    } catch (error) {
      toClipboardApiError(error)
    }
  })

  // POST /api-client/tree/clipboard/:token/paste —— 按 §6.5 矩阵原子 copy/move（§3.1）。
  api.post('/api-client/tree/clipboard/:token/paste', async (ctx) => {
    const body = requireRecord(await ctx.json())
    const targetKind = body.targetKind
    if (targetKind !== 'root' && targetKind !== 'collection' && targetKind !== 'folder' && targetKind !== 'request') {
      throw new ApiError(400, 'invalid-paste-target', "targetKind 必须是 'root'/'collection'/'folder'/'request'")
    }
    // 可选字段的类型闸（缺失与否的语义校验在服务层矩阵/定位中完成 → invalid-paste-target）。
    for (const field of ['targetId', 'targetCollectionId'] as const) {
      if (body[field] !== undefined && (typeof body[field] !== 'string' || body[field] === '')) {
        throw new ApiError(400, 'invalid-paste-target', `${field} 必须是非空字符串`)
      }
    }
    if (
      body.expectedTargetCollectionUpdatedAt !== undefined &&
      (typeof body.expectedTargetCollectionUpdatedAt !== 'number' || !Number.isFinite(body.expectedTargetCollectionUpdatedAt))
    ) {
      throw new ApiError(400, 'invalid-paste-target', 'expectedTargetCollectionUpdatedAt 必须是有限数字')
    }
    try {
      sendJson(
        ctx.res,
        200,
        clipboard.paste(ctx.params.token!, {
          targetKind: targetKind as PasteTargetKind,
          ...(body.targetId !== undefined ? { targetId: body.targetId as string } : {}),
          ...(body.targetCollectionId !== undefined ? { targetCollectionId: body.targetCollectionId as string } : {}),
          ...(body.expectedTargetCollectionUpdatedAt !== undefined
            ? { expectedTargetCollectionUpdatedAt: body.expectedTargetCollectionUpdatedAt as number }
            : {}),
        }),
      )
    } catch (error) {
      toPasteApiError(error)
    }
  })

  // DELETE /api-client/tree/clipboard/:token —— 主动清空；token 不存在仍幂等 204（§3.1）。
  api.delete('/api-client/tree/clipboard/:token', (ctx) => {
    clipboard.clear(ctx.params.token!)
    sendNoContent(ctx.res)
  })
}
