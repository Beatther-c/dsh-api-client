/**
 * P0 §3.1 冻结合同：Folder 三端点（新建/重命名/递归删除）。
 *
 * - 响应形态 FolderDescriptor {id,name}——不含任何节点内容/敏感材料，无需投影；
 * - 三端点均要求 expectedCollectionUpdatedAt（乐观锁，§4.3）：版本不符 →
 *   409 version-conflict，message 为 §3.1.1 逐字文案且不写任何文件；
 * - 错误走 router 既有出口（ApiError + sendJson/sendNoContent + redactError），
 *   与 collections.ts/requests.ts 同风格；用户可见新文案中文（PROJECT.md 红线 6）。
 */
import type { Folder } from '@dsh-api-client/shared'
import type { CollectionService } from '../services/collection-service.ts'
import { CollectionNotFoundError, FolderNotFoundError, VERSION_CONFLICT_MESSAGE, VersionConflictError } from '../services/collection-service.ts'
import type { ApiRouter } from './router.ts'
import { ApiError, sendJson, sendNoContent } from './router.ts'

/** §3.1 返回形态：仅 id 与 name。 */
export interface FolderDescriptor {
  id: string
  name: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toDescriptor(folder: Folder): FolderDescriptor {
  return { id: folder.id, name: folder.name }
}

function requireRecord(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) throw new ApiError(400, 'invalid-input', '请求体必须是 JSON 对象')
  return body
}

/** name 必填非空（§3.1；POST/PATCH 同口径）。 */
function requireFolderName(body: Record<string, unknown>): string {
  if (typeof body.name !== 'string' || body.name.trim() === '') {
    throw new ApiError(400, 'invalid-input', 'folder 名称必填且必须是非空字符串')
  }
  return body.name
}

/** expectedCollectionUpdatedAt 必填有限数字（§3.1；缺失/非数字 → 400，不进服务层）。 */
function requireExpectedVersion(body: Record<string, unknown>): number {
  const value = body.expectedCollectionUpdatedAt
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ApiError(400, 'invalid-input', 'expectedCollectionUpdatedAt 必填且必须是有限数字')
  }
  return value
}

/** 服务层错误 → API 错误（409 用 §3.1.1 逐字文案，不透传服务层 message 以外的内容）。 */
function toFolderApiError(error: unknown): never {
  if (error instanceof CollectionNotFoundError) throw new ApiError(404, 'collection-not-found', error.message)
  if (error instanceof FolderNotFoundError) throw new ApiError(404, 'folder-not-found', error.message)
  if (error instanceof VersionConflictError) throw new ApiError(409, 'version-conflict', VERSION_CONFLICT_MESSAGE)
  throw error
}

export function registerFolderRoutes(api: ApiRouter, collections: CollectionService): void {
  // POST /api-client/collections/:id/folders —— 新建顶层或子 Folder（§3.1）。
  api.post('/api-client/collections/:id/folders', async (ctx) => {
    const body = requireRecord(await ctx.json())
    const name = requireFolderName(body)
    const expected = requireExpectedVersion(body)
    if (body.parentFolderId !== undefined && typeof body.parentFolderId !== 'string') {
      throw new ApiError(400, 'invalid-input', 'parentFolderId 必须是字符串')
    }
    try {
      const folder = collections.createFolder(ctx.params.id!, name, expected, body.parentFolderId as string | undefined)
      sendJson(ctx.res, 200, toDescriptor(folder))
    } catch (error) {
      toFolderApiError(error)
    }
  })

  // PATCH /api-client/collections/:id/folders/:folderId —— 重命名（§3.1/§3.2 行内重命名）。
  api.patch('/api-client/collections/:id/folders/:folderId', async (ctx) => {
    const body = requireRecord(await ctx.json())
    const name = requireFolderName(body)
    const expected = requireExpectedVersion(body)
    try {
      const folder = collections.renameFolder(ctx.params.id!, ctx.params.folderId!, name, expected)
      sendJson(ctx.res, 200, toDescriptor(folder))
    } catch (error) {
      toFolderApiError(error)
    }
  })

  // DELETE /api-client/collections/:id/folders/:folderId —— 递归删除（§3.1；JSON body 带版本，router ctx.json() 支持 DELETE 带 body）。
  api.delete('/api-client/collections/:id/folders/:folderId', async (ctx) => {
    const body = requireRecord(await ctx.json())
    const expected = requireExpectedVersion(body)
    try {
      collections.deleteFolder(ctx.params.id!, ctx.params.folderId!, expected)
    } catch (error) {
      toFolderApiError(error)
    }
    sendNoContent(ctx.res)
  })
}
