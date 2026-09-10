/**
 * Collection service（§3.4）：Collection 权威状态 + 持久化（shared scope，
 * `shared/collections.json`）。树操作全部委托 core collection/ops 纯函数，
 * 本服务只负责内存权威态、落盘与跨 collection 的 request/folder 定位。
 *
 * auth 材料（bearer token 等）按 §4.1 可含 SecretRef；API 投影脱敏由
 * redaction-service 负责，本服务不做投影。
 *
 * P0「常用交互优化」扩展（实施设计 §3.1/§4.3/§4.4）：
 * - Folder CRUD 服务方法（createFolder/renameFolder/deleteFolder，含乐观锁版本校验）；
 * - nextTimestamp 单调时间（§4.3）：本服务全部写路径统一使用，保证同一实体
 *   连续 mutation 的 updatedAt 严格递增（Cut token 依赖该语义检测版本变化）；
 * - commitCollections：接收完整 nextCollections[] 的**单次**原子落盘
 *   （跨 Collection move / clipboard paste 专用，§4.4 步骤 5/6：写盘成功后
 *   才替换内存权威态，失败则内存保持原状）。
 */
import type { ApiRequest, AuthConfig, Collection, CollectionVariable, Folder, HttpMethod, SuppressedGeneratedHeader } from '@dsh-api-client/shared'
import {
  addFolder,
  addRequest,
  collectionVersionMatches,
  createCollection,
  createRequest,
  deleteFolder as deleteFolderOp,
  deleteRequest,
  duplicateCollection,
  duplicateRequest,
  findFolder,
  findRequest,
  moveRequest,
  renameCollection,
  renameFolder as renameFolderOp,
  reorderRequests,
  updateRequest,
} from '@dsh-api-client/core'
import { FileStore } from './storage/file-store.ts'

export class CollectionNotFoundError extends Error {
  readonly code = 'collection-not-found'
  constructor(id: string) {
    super(`collection not found: ${id}`)
    this.name = 'CollectionNotFoundError'
  }
}

export class RequestNotFoundError extends Error {
  readonly code = 'request-not-found'
  constructor(id: string) {
    super(`request not found: ${id}`)
    this.name = 'RequestNotFoundError'
  }
}

/** Folder 定位失败（P0 §3.1 Folder/clipboard 端点的 404 folder-not-found 出口）。 */
export class FolderNotFoundError extends Error {
  readonly code = 'folder-not-found'
  readonly httpStatus = 404
  constructor(id: string) {
    super(`folder 不存在: ${id}`)
    this.name = 'FolderNotFoundError'
  }
}

/** 409 响应体 message 逐字文案（实施设计 §3.1.1 冻结；用户可见中文，PROJECT.md 红线 6）。 */
export const VERSION_CONFLICT_MESSAGE = '数据已被其他操作修改，请刷新后重试'

/**
 * 乐观锁版本冲突（实施设计 §3.1.1 / §4.3）：expected updatedAt 与权威值不严格相等。
 * message 恒等于 VERSION_CONFLICT_MESSAGE——API 层直接以此构造 409 响应，
 * 不得附加任何上下文（防止把节点内容带进错误出口）。
 */
export class VersionConflictError extends Error {
  readonly code = 'version-conflict'
  readonly httpStatus = 409
  constructor() {
    super(VERSION_CONFLICT_MESSAGE)
    this.name = 'VersionConflictError'
  }
}

export interface CollectionPatch {
  name?: string
  variables?: CollectionVariable[]
  auth?: AuthConfig
}

/** POST /collections/:id/requests 的请求体（§5.1 端点 9：ApiRequest 无 id + folderId?）。 */
export interface NewRequestInput {
  name: string
  method?: HttpMethod
  url?: string
  params?: ApiRequest['params']
  headers?: ApiRequest['headers']
  auth?: AuthConfig
  body?: ApiRequest['body']
  /** P0 §3.2/§4.1.1：入参必须已在 API 边界（api/requests.ts §3.3）完成校验+规范化；缺省持久化为 []。 */
  suppressedGeneratedHeaders?: SuppressedGeneratedHeader[]
  folderId?: string
}

export type RequestPatch = Partial<Omit<ApiRequest, 'id' | 'collectionId' | 'createdAt' | 'updatedAt'>>

export class CollectionService {
  private collections: Collection[]

  constructor(private readonly store: FileStore) {
    this.collections = this.store.readJson<Collection[]>(this.store.layout.collectionsFile) ?? []
  }

  private persist(): void {
    this.store.writeJson(this.store.layout.collectionsFile, this.collections)
  }

  private replace(updated: Collection): Collection {
    this.collections = this.collections.map((c) => (c.id === updated.id ? updated : c))
    this.persist()
    return updated
  }

  /**
   * 单调时间戳（实施设计 §4.3）：max(Date.now(), ...entities.updatedAt + 1)。
   * 本服务全部 mutation 写路径统一经此取 now——同一实体连续写入（即使落在同一
   * 毫秒）updatedAt 也严格递增，Cut token / expectedCollectionUpdatedAt 才能
   * 可靠检测「剪切/读取后被修改」。
   */
  nextTimestamp(...entities: Array<{ updatedAt: number }>): number {
    let max = Date.now()
    for (const entity of entities) {
      if (entity.updatedAt + 1 > max) max = entity.updatedAt + 1
    }
    return max
  }

  /**
   * 多 Collection 单次原子提交（实施设计 §4.4 步骤 5/6）：接收调用方在内存中
   * 组装好的**完整** nextCollections[]，一次 FileStore.writeJson 落盘；
   * 写盘成功后才替换内存权威态——写盘抛错时 this.collections 保持原状
   * （clipboard cut/copy paste 的跨 Collection 事务出口，绝不逐 Collection 分次写）。
   */
  commitCollections(nextCollections: Collection[]): void {
    this.store.writeJson(this.store.layout.collectionsFile, nextCollections)
    this.collections = nextCollections
  }

  list(): Collection[] {
    return this.collections
  }

  get(id: string): Collection | undefined {
    return this.collections.find((c) => c.id === id)
  }

  require(id: string): Collection {
    const collection = this.get(id)
    if (collection === undefined) throw new CollectionNotFoundError(id)
    return collection
  }

  create(name: string): Collection {
    const collection = createCollection({ name, now: this.nextTimestamp() })
    this.collections = [...this.collections, collection]
    this.persist()
    return collection
  }

  patch(id: string, patch: CollectionPatch): Collection {
    let collection = this.require(id)
    const now = this.nextTimestamp(collection)
    if (patch.name !== undefined) collection = renameCollection(collection, patch.name, now)
    if (patch.variables !== undefined) collection = { ...collection, variables: patch.variables, updatedAt: now }
    if (patch.auth !== undefined) collection = { ...collection, auth: patch.auth, updatedAt: now }
    return this.replace(collection)
  }

  delete(id: string): void {
    this.require(id)
    this.collections = this.collections.filter((c) => c.id !== id)
    this.persist()
  }

  duplicate(id: string): Collection {
    const source = this.require(id)
    const copy = duplicateCollection(source, this.nextTimestamp(source))
    this.collections = [...this.collections, copy]
    this.persist()
    return copy
  }

  /** 导入落库：adapter 已生成全新 id 的完整 Collection 直接追加（import-service 用；时间戳由 adapter 生成，不属既有实体的版本序列）。 */
  importCollection(collection: Collection): Collection {
    this.collections = [...this.collections, collection]
    this.persist()
    return collection
  }

  /** §5.1 端点 8：顶层 requests 按 itemIds 重排（未列出的保持原相对顺序附后）。 */
  reorder(id: string, itemIds: string[]): Collection {
    const collection = this.require(id)
    return this.replace(reorderRequests(collection, undefined, itemIds, this.nextTimestamp(collection)))
  }

  // ---- Folder CRUD（P0 §3.1 冻结合同；全部经乐观锁版本校验 + 单调时间戳）----

  /**
   * 新建 Folder（parentFolderId 缺省 = 顶层）。
   * 版本不符 → VersionConflictError（409）；parent 不存在 → FolderNotFoundError（404）。
   */
  createFolder(collectionId: string, name: string, expectedCollectionUpdatedAt: number, parentFolderId?: string): Folder {
    const collection = this.require(collectionId)
    this.assertVersion(collection, expectedCollectionUpdatedAt)
    if (parentFolderId !== undefined && findFolder(collection, parentFolderId) === undefined) {
      throw new FolderNotFoundError(parentFolderId)
    }
    const { collection: next, folder } = addFolder(collection, name, parentFolderId, this.nextTimestamp(collection))
    this.replace(next)
    return folder
  }

  /** 重命名 Folder（P0 §3.2 行内重命名端点）。 */
  renameFolder(collectionId: string, folderId: string, name: string, expectedCollectionUpdatedAt: number): Folder {
    const collection = this.require(collectionId)
    this.assertVersion(collection, expectedCollectionUpdatedAt)
    if (findFolder(collection, folderId) === undefined) throw new FolderNotFoundError(folderId)
    const next = renameFolderOp(collection, folderId, name, this.nextTimestamp(collection))
    this.replace(next)
    return findFolder(next, folderId)!
  }

  /** 递归删除 Folder（含全部子 Folder 与其中 Request，UX §4.7）。 */
  deleteFolder(collectionId: string, folderId: string, expectedCollectionUpdatedAt: number): void {
    const collection = this.require(collectionId)
    this.assertVersion(collection, expectedCollectionUpdatedAt)
    if (findFolder(collection, folderId) === undefined) throw new FolderNotFoundError(folderId)
    this.replace(deleteFolderOp(collection, folderId, this.nextTimestamp(collection)))
  }

  /** Folder 端点的乐观锁闸（实施设计 §4.3 / §3.1.1）：updatedAt 严格相等，否则 409。 */
  private assertVersion(collection: Collection, expectedUpdatedAt: number): void {
    if (!collectionVersionMatches(collection, expectedUpdatedAt)) throw new VersionConflictError()
  }

  addRequest(collectionId: string, input: NewRequestInput): ApiRequest {
    const collection = this.require(collectionId)
    const now = this.nextTimestamp(collection)
    const request = createRequest({
      name: input.name,
      collectionId,
      now,
      ...(input.method !== undefined ? { method: input.method } : {}),
      ...(input.url !== undefined ? { url: input.url } : {}),
      ...(input.folderId !== undefined ? { folderId: input.folderId } : {}),
    })
    if (input.params !== undefined) request.params = input.params
    if (input.headers !== undefined) request.headers = input.headers
    if (input.auth !== undefined) request.auth = input.auth
    if (input.body !== undefined) request.body = input.body
    // P0 §4.1.1：新建 Request 一律写出规范化数组（API 边界已 trim/lowercase/去重；缺省 []）。
    request.suppressedGeneratedHeaders = input.suppressedGeneratedHeaders ?? []
    this.replace(addRequest(collection, request, now))
    return request
  }

  /** 跨 collection 定位 request（GET/PATCH/DELETE /requests/:id 不按 collection 分组，§5.1）。 */
  findRequestLocation(requestId: string): { collection: Collection; request: ApiRequest } | undefined {
    for (const collection of this.collections) {
      const hit = findRequest(collection, requestId)
      if (hit !== undefined) return { collection, request: hit.request }
    }
    return undefined
  }

  /** 跨 collection 定位 folder（P0 clipboard paste 未显式给 targetCollectionId 时的权威解析）。 */
  findFolderLocation(folderId: string): { collection: Collection; folder: Folder } | undefined {
    for (const collection of this.collections) {
      const folder = findFolder(collection, folderId)
      if (folder !== undefined) return { collection, folder }
    }
    return undefined
  }

  requireRequest(requestId: string): { collection: Collection; request: ApiRequest } {
    const hit = this.findRequestLocation(requestId)
    if (hit === undefined) throw new RequestNotFoundError(requestId)
    return hit
  }

  patchRequest(requestId: string, patch: RequestPatch): ApiRequest {
    const { collection, request } = this.requireRequest(requestId)
    // §4.3：request.updatedAt 与 collection.updatedAt 均严格递增（Cut token 检测依赖）。
    const updated = this.replace(updateRequest(collection, requestId, patch, this.nextTimestamp(collection, request)))
    return findRequest(updated, requestId)!.request
  }

  deleteRequest(requestId: string): void {
    const { collection } = this.requireRequest(requestId)
    this.replace(deleteRequest(collection, requestId, this.nextTimestamp(collection)))
  }

  duplicateRequest(requestId: string): ApiRequest {
    const { collection } = this.requireRequest(requestId)
    const before = new Set(this.listRequestIds(collection))
    const updated = this.replace(duplicateRequest(collection, requestId, this.nextTimestamp(collection)))
    const copy = this.listRequestIds(updated).find((id) => !before.has(id))
    return findRequest(updated, copy!)!.request
  }

  moveRequest(requestId: string, folderId: string | undefined): ApiRequest {
    const { collection, request } = this.requireRequest(requestId)
    const updated = this.replace(moveRequest(collection, requestId, folderId, this.nextTimestamp(collection, request)))
    return findRequest(updated, requestId)!.request
  }

  private listRequestIds(collection: Collection): string[] {
    const ids: string[] = collection.requests.map((r) => r.id)
    const walk = (folders: Collection['folders']): void => {
      for (const folder of folders) {
        ids.push(...folder.requests.map((r) => r.id))
        walk(folder.folders)
      }
    }
    walk(collection.folders)
    return ids
  }
}
