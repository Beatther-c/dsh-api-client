/**
 * Collection service（§3.4）：Collection 权威状态 + 持久化（shared scope，
 * `shared/collections.json`）。树操作全部委托 core collection/ops 纯函数，
 * 本服务只负责内存权威态、落盘与跨 collection 的 request 定位。
 *
 * auth 材料（bearer token 等）按 §4.1 可含 SecretRef；API 投影脱敏由
 * redaction-service 负责，本服务不做投影。
 */
import type { ApiRequest, AuthConfig, Collection, CollectionVariable, HttpMethod } from '@dsh-api-client/shared'
import {
  addRequest,
  createCollection,
  createRequest,
  deleteRequest,
  duplicateCollection,
  duplicateRequest,
  findRequest,
  moveRequest,
  renameCollection,
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
    const collection = createCollection({ name })
    this.collections = [...this.collections, collection]
    this.persist()
    return collection
  }

  patch(id: string, patch: CollectionPatch): Collection {
    let collection = this.require(id)
    if (patch.name !== undefined) collection = renameCollection(collection, patch.name)
    if (patch.variables !== undefined) collection = { ...collection, variables: patch.variables, updatedAt: Date.now() }
    if (patch.auth !== undefined) collection = { ...collection, auth: patch.auth, updatedAt: Date.now() }
    return this.replace(collection)
  }

  delete(id: string): void {
    this.require(id)
    this.collections = this.collections.filter((c) => c.id !== id)
    this.persist()
  }

  duplicate(id: string): Collection {
    const copy = duplicateCollection(this.require(id))
    this.collections = [...this.collections, copy]
    this.persist()
    return copy
  }

  /** 导入落库：adapter 已生成全新 id 的完整 Collection 直接追加（import-service 用）。 */
  importCollection(collection: Collection): Collection {
    this.collections = [...this.collections, collection]
    this.persist()
    return collection
  }

  /** §5.1 端点 8：顶层 requests 按 itemIds 重排（未列出的保持原相对顺序附后）。 */
  reorder(id: string, itemIds: string[]): Collection {
    return this.replace(reorderRequests(this.require(id), undefined, itemIds))
  }

  addRequest(collectionId: string, input: NewRequestInput): ApiRequest {
    const collection = this.require(collectionId)
    const request = createRequest({
      name: input.name,
      collectionId,
      ...(input.method !== undefined ? { method: input.method } : {}),
      ...(input.url !== undefined ? { url: input.url } : {}),
      ...(input.folderId !== undefined ? { folderId: input.folderId } : {}),
    })
    if (input.params !== undefined) request.params = input.params
    if (input.headers !== undefined) request.headers = input.headers
    if (input.auth !== undefined) request.auth = input.auth
    if (input.body !== undefined) request.body = input.body
    this.replace(addRequest(collection, request))
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

  requireRequest(requestId: string): { collection: Collection; request: ApiRequest } {
    const hit = this.findRequestLocation(requestId)
    if (hit === undefined) throw new RequestNotFoundError(requestId)
    return hit
  }

  patchRequest(requestId: string, patch: RequestPatch): ApiRequest {
    const { collection } = this.requireRequest(requestId)
    const updated = this.replace(updateRequest(collection, requestId, patch))
    return findRequest(updated, requestId)!.request
  }

  deleteRequest(requestId: string): void {
    const { collection } = this.requireRequest(requestId)
    this.replace(deleteRequest(collection, requestId))
  }

  duplicateRequest(requestId: string): ApiRequest {
    const { collection } = this.requireRequest(requestId)
    const before = new Set(this.listRequestIds(collection))
    const updated = this.replace(duplicateRequest(collection, requestId))
    const copy = this.listRequestIds(updated).find((id) => !before.has(id))
    return findRequest(updated, copy!)!.request
  }

  moveRequest(requestId: string, folderId: string | undefined): ApiRequest {
    const { collection } = this.requireRequest(requestId)
    const updated = this.replace(moveRequest(collection, requestId, folderId))
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
