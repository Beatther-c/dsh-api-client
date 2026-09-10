/**
 * Collection CRUD / 重命名 / 删除 / 排序 / 搜索 / Duplicate（§3.2 collection/ops），
 * 以及 P0 树 mutation 纯函数（快照拷贝 / 副本命名 / 跨 Collection 移动 / 统计 / 版本谓词，
 * 见文末「P0 树操作」分节；依据 docs/design/api-client-everyday-ux-p0-implementation-design.md
 * §4.4–§4.6、§7.1 与 UX spec §4.6/§4.7 冻结语义）。
 * 全部纯函数：不修改入参，返回新对象（structuredClone 后改副本）。
 */
import type { ApiRequest, Collection, Folder } from '@dsh-api-client/shared'
import { generateId } from './model.ts'

function clone(collection: Collection): Collection {
  return structuredClone(collection)
}

function touch(collection: Collection, now?: number): Collection {
  collection.updatedAt = now ?? Date.now()
  return collection
}

// ---- 查找 ----

export function findFolder(collection: Collection, folderId: string): Folder | undefined {
  const walk = (folders: Folder[]): Folder | undefined => {
    for (const folder of folders) {
      if (folder.id === folderId) return folder
      const hit = walk(folder.folders)
      if (hit) return hit
    }
    return undefined
  }
  return walk(collection.folders)
}

/** 自根到目标 folder 的链（含目标）；找不到返回空数组。供 inherit auth 向上查找。 */
export function findFolderChain(collection: Collection, folderId: string): Folder[] {
  const walk = (folders: Folder[], trail: Folder[]): Folder[] | undefined => {
    for (const folder of folders) {
      const next = [...trail, folder]
      if (folder.id === folderId) return next
      const hit = walk(folder.folders, next)
      if (hit) return hit
    }
    return undefined
  }
  return walk(collection.folders, []) ?? []
}

export function findRequest(
  collection: Collection,
  requestId: string,
): { request: ApiRequest; folder?: Folder } | undefined {
  const top = collection.requests.find((r) => r.id === requestId)
  if (top) return { request: top }
  const walk = (folders: Folder[]): { request: ApiRequest; folder: Folder } | undefined => {
    for (const folder of folders) {
      const hit = folder.requests.find((r) => r.id === requestId)
      if (hit) return { request: hit, folder }
      const nested = walk(folder.folders)
      if (nested) return nested
    }
    return undefined
  }
  return walk(collection.folders)
}

export function listAllRequests(collection: Collection): ApiRequest[] {
  const out: ApiRequest[] = [...collection.requests]
  const walk = (folders: Folder[]): void => {
    for (const folder of folders) {
      out.push(...folder.requests)
      walk(folder.folders)
    }
  }
  walk(collection.folders)
  return out
}

// ---- Collection 级 ----

export function renameCollection(collection: Collection, name: string, now?: number): Collection {
  const next = clone(collection)
  next.name = name
  return touch(next, now)
}

// ---- Folder 级 ----

export function addFolder(
  collection: Collection,
  name: string,
  parentFolderId?: string,
  now?: number,
): { collection: Collection; folder: Folder } {
  const next = clone(collection)
  const folder: Folder = { id: generateId(), name, folders: [], requests: [] }
  if (parentFolderId === undefined) {
    next.folders.push(folder)
  } else {
    const parent = findFolder(next, parentFolderId)
    if (!parent) throw new Error(`folder not found: ${parentFolderId}`)
    parent.folders.push(folder)
  }
  return { collection: touch(next, now), folder }
}

export function renameFolder(collection: Collection, folderId: string, name: string, now?: number): Collection {
  const next = clone(collection)
  const folder = findFolder(next, folderId)
  if (!folder) throw new Error(`folder not found: ${folderId}`)
  folder.name = name
  return touch(next, now)
}

/** 删除 folder（含其全部子树与其中请求）。 */
export function deleteFolder(collection: Collection, folderId: string, now?: number): Collection {
  const next = clone(collection)
  const removeFrom = (folders: Folder[]): boolean => {
    const index = folders.findIndex((f) => f.id === folderId)
    if (index >= 0) {
      folders.splice(index, 1)
      return true
    }
    return folders.some((f) => removeFrom(f.folders))
  }
  if (!removeFrom(next.folders)) throw new Error(`folder not found: ${folderId}`)
  return touch(next, now)
}

// ---- Request 级 ----

/** 保存请求：request.folderId 决定容器（缺省顶层）；（AC-16）。 */
export function addRequest(collection: Collection, request: ApiRequest, now?: number): Collection {
  const next = clone(collection)
  if (request.folderId === undefined) {
    next.requests.push(request)
  } else {
    const folder = findFolder(next, request.folderId)
    if (!folder) throw new Error(`folder not found: ${request.folderId}`)
    folder.requests.push(request)
  }
  return touch(next, now)
}

export function updateRequest(
  collection: Collection,
  requestId: string,
  patch: Partial<Omit<ApiRequest, 'id' | 'collectionId' | 'createdAt'>>,
  now?: number,
): Collection {
  const next = clone(collection)
  const hit = findRequest(next, requestId)
  if (!hit) throw new Error(`request not found: ${requestId}`)
  Object.assign(hit.request, patch, { updatedAt: now ?? Date.now() })
  return touch(next, now)
}

export function renameRequest(collection: Collection, requestId: string, name: string, now?: number): Collection {
  return updateRequest(collection, requestId, { name }, now)
}

export function deleteRequest(collection: Collection, requestId: string, now?: number): Collection {
  const next = clone(collection)
  const topIndex = next.requests.findIndex((r) => r.id === requestId)
  if (topIndex >= 0) {
    next.requests.splice(topIndex, 1)
    return touch(next, now)
  }
  const hit = findRequest(next, requestId)
  if (!hit || !hit.folder) throw new Error(`request not found: ${requestId}`)
  hit.folder.requests = hit.folder.requests.filter((r) => r.id !== requestId)
  return touch(next, now)
}

/** 跨 folder 移动（folderId 缺省 = 移到顶层）。 */
export function moveRequest(
  collection: Collection,
  requestId: string,
  folderId: string | undefined,
  now?: number,
): Collection {
  const next = clone(collection)
  const hit = findRequest(next, requestId)
  if (!hit) throw new Error(`request not found: ${requestId}`)
  const request = hit.request
  if (hit.folder) {
    hit.folder.requests = hit.folder.requests.filter((r) => r.id !== requestId)
  } else {
    next.requests = next.requests.filter((r) => r.id !== requestId)
  }
  if (folderId === undefined) {
    delete request.folderId
    next.requests.push(request)
  } else {
    const folder = findFolder(next, folderId)
    if (!folder) throw new Error(`folder not found: ${folderId}`)
    request.folderId = folderId
    folder.requests.push(request)
  }
  request.updatedAt = now ?? Date.now()
  return touch(next, now)
}

/** 排序：按 orderedIds 重排目标容器（缺省顶层）的 requests；未列出的保持原相对顺序附后。 */
export function reorderRequests(
  collection: Collection,
  folderId: string | undefined,
  orderedIds: string[],
  now?: number,
): Collection {
  const next = clone(collection)
  const container: { requests: ApiRequest[] } =
    folderId === undefined
      ? next
      : (() => {
          const folder = findFolder(next, folderId)
          if (!folder) throw new Error(`folder not found: ${folderId}`)
          return folder
        })()
  const byId = new Map(container.requests.map((r) => [r.id, r]))
  const listed: ApiRequest[] = []
  for (const id of orderedIds) {
    const request = byId.get(id)
    if (request) {
      listed.push(request)
      byId.delete(id)
    }
  }
  const rest = container.requests.filter((r) => byId.has(r.id))
  container.requests = [...listed, ...rest]
  return touch(next, now)
}

/** 搜索：name 或 url 大小写不敏感子串匹配（含 folder 内请求）。 */
export function searchRequests(collection: Collection, query: string): ApiRequest[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return []
  return listAllRequests(collection).filter(
    (r) => r.name.toLowerCase().includes(needle) || r.url.toLowerCase().includes(needle),
  )
}

// ---- Duplicate（深拷贝且新 id）----

function duplicateRequestTree(request: ApiRequest, collectionId: string, now: number): ApiRequest {
  const copy = structuredClone(request)
  copy.id = generateId()
  copy.collectionId = collectionId
  copy.createdAt = now
  copy.updatedAt = now
  return copy
}

export function duplicateRequest(collection: Collection, requestId: string, now?: number): Collection {
  const at = now ?? Date.now()
  const next = clone(collection)
  const hit = findRequest(next, requestId)
  if (!hit) throw new Error(`request not found: ${requestId}`)
  const copy = duplicateRequestTree(hit.request, next.id, at)
  copy.name = `${hit.request.name} (copy)`
  const container = hit.folder ?? next
  const index = container.requests.findIndex((r) => r.id === requestId)
  container.requests.splice(index + 1, 0, copy)
  return touch(next, now)
}

function duplicateFolderTree(folder: Folder, collectionId: string, now: number): Folder {
  return {
    id: generateId(),
    name: folder.name,
    folders: folder.folders.map((f) => duplicateFolderTree(f, collectionId, now)),
    requests: folder.requests.map((r) => duplicateRequestTree(r, collectionId, now)),
  }
}

export function duplicateFolder(collection: Collection, folderId: string, now?: number): Collection {
  const at = now ?? Date.now()
  const next = clone(collection)
  const insertInto = (folders: Folder[]): boolean => {
    const index = folders.findIndex((f) => f.id === folderId)
    if (index < 0) return folders.some((f) => insertInto(f.folders))
    const original = folders[index]
    if (!original) return false
    const copy = duplicateFolderTree(original, next.id, at)
    copy.name = `${original.name} (copy)`
    folders.splice(index + 1, 0, copy)
    return true
  }
  if (!insertInto(next.folders)) throw new Error(`folder not found: ${folderId}`)
  return touch(next, now)
}

/** Duplicate Collection：深拷贝，collection/folder/request 全部新 id（TC-C-18）。 */
export function duplicateCollection(collection: Collection, now?: number): Collection {
  const at = now ?? Date.now()
  const id = generateId()
  return {
    id,
    name: `${collection.name} (copy)`,
    ...(collection.auth !== undefined ? { auth: structuredClone(collection.auth) } : {}),
    variables: structuredClone(collection.variables),
    folders: collection.folders.map((f) => duplicateFolderTree(f, id, at)),
    requests: collection.requests.map((r) => duplicateRequestTree(r, id, at)),
    createdAt: at,
    updatedAt: at,
  }
}

// ===========================================================================
// P0 树操作（「常用交互优化 P0」实施设计 §4.4–§4.6、§7.1；UX spec §4.6/§4.7）。
// 与上方兼容 Duplicate 分节的区别（实施设计 §0.2：现有 /duplicate 端点保留，P0 树不复用）：
// - Copy 命名不加 "(copy)" 后缀，由调用方（Host paste）按 §4.6 走 nextCopyName；
// - 全部结构 ID 重建，Request 的 collectionId/folderId 按新结构/目标容器重写；
// - 插入位置由调用方按 §4.5 粘贴矩阵决定，本层只提供纯计算；
// - 零 I/O、零 token/存储概念；单调时间戳由 Host nextTimestamp（§4.3）经 now 传入。
// ===========================================================================

/** P0 移动/粘贴的目标位置（§3.1 paste targetKind 中 Request 相关行的 core 语义，§4.5 插入矩阵）。 */
export type MoveRequestTarget =
  | { kind: 'collection-top' }
  | { kind: 'folder'; folderId: string }
  | { kind: 'after-request'; requestId: string }

/**
 * Request 完整快照拷贝（UX §4.6「完整快照」条款）：复制当前持久化全部字段——含嵌套顺序、
 * Body/Auth 配置、SecretRef、suppressedGeneratedHeaders、scripts，`{{variable}}` 引用文本原样；
 * 不复制 History/实际响应/运行时派生数据（它们本就不在 ApiRequest 持久化模型上）。
 * 新 id、createdAt/updatedAt=now、collectionId/folderId 重写为目标容器；targetFolderId 缺省时删除 folderId。
 * 名称保留原值：Copy 粘贴是否套 nextCopyName 由调用方按目标容器 sibling 决定（§4.6）；
 * Cut/move 保留原名，不走副本命名。
 */
export function copyRequestSnapshot(
  request: ApiRequest,
  targetCollectionId: string,
  targetFolderId?: string,
  now?: number,
): ApiRequest {
  const at = now ?? Date.now()
  const copy = structuredClone(request)
  copy.id = generateId()
  copy.collectionId = targetCollectionId
  if (targetFolderId === undefined) {
    delete copy.folderId
  } else {
    copy.folderId = targetFolderId
  }
  copy.createdAt = at
  copy.updatedAt = at
  return copy
}

/**
 * Folder 完整子树快照拷贝（UX §4.6；实施设计 §4.5 Folder paste 行）：
 * 自身与全部后代 Folder/Request 生成新 id；每个 Request 的 collectionId 重写为 targetCollectionId、
 * folderId 重写为新结构中对应的新 Folder id。名称保留原文，由调用方按 §4.6 命名并决定插入位置
 * （追加 targetCollection.folders / targetFolder.folders 末尾）。
 */
export function copyFolderTree(folder: Folder, targetCollectionId: string, now?: number): Folder {
  const at = now ?? Date.now()
  const walk = (source: Folder): Folder => {
    const id = generateId()
    return {
      id,
      name: source.name,
      folders: source.folders.map((child) => walk(child)),
      requests: source.requests.map((r) => copyRequestSnapshot(r, targetCollectionId, id, at)),
    }
  }
  return walk(folder)
}

/**
 * Collection 完整子树快照拷贝（UX §4.6；实施设计 §4.5 Collection paste 行）。
 * 与兼容 duplicateCollection 的区别：不加 "(copy)" 后缀（命名由调用方按 §4.6 nextCopyName
 * 「副本」规则决定），不隐含插入位置（追加根末尾 / 插在目标 Collection 后由调用方决定）。
 * Collection/Folder/Request 全部新 id；Request 的 collectionId 指向新 Collection、
 * folderId 按新结构重写；variables/auth 深拷贝；createdAt/updatedAt=now。
 */
export function copyCollectionTree(collection: Collection, now?: number): Collection {
  const at = now ?? Date.now()
  const id = generateId()
  return {
    id,
    name: collection.name,
    ...(collection.auth !== undefined ? { auth: structuredClone(collection.auth) } : {}),
    variables: structuredClone(collection.variables),
    folders: collection.folders.map((f) => copyFolderTree(f, id, at)),
    requests: collection.requests.map((r) => copyRequestSnapshot(r, id, undefined, at)),
    createdAt: at,
    updatedAt: at,
  }
}

/**
 * 稳定副本命名（实施设计 §4.6 / UX §4.6）：「名称 副本」→「名称 副本 2」→「名称 副本 3」…，
 * 按序号升序取第一个不冲突者。冲突范围仅同目标容器、同节点类型的 sibling names——
 * 即调用方须传入目标容器中同类节点（Collection/Folder/Request 之一）的名称列表。
 * Cut/move 保留原名且允许目标已有同名，不走本函数。
 */
export function nextCopyName(originalName: string, siblingNames: readonly string[]): string {
  const taken = new Set(siblingNames)
  const base = `${originalName} 副本`
  if (!taken.has(base)) return base
  let seq = 2
  while (taken.has(`${base} ${seq}`)) seq += 1
  return `${base} ${seq}`
}

/** 内部：从（已克隆的）Collection 中移除给定 id 的 Request；folder 缺省 = 顶层容器。 */
function detachRequest(collection: Collection, folder: Folder | undefined, requestId: string): void {
  if (folder === undefined) {
    collection.requests = collection.requests.filter((r) => r.id !== requestId)
  } else {
    folder.requests = folder.requests.filter((r) => r.id !== requestId)
  }
}

/**
 * 内部：把 Request 放入（已克隆的）Collection 的目标位置，并按目标容器重写
 * collectionId/folderId（§4.5）：collection-top → 顶层 requests 末尾且删除 folderId；
 * folder → folder.requests 末尾；after-request → 紧跟锚点 Request 之后、继承锚点所在容器。
 * 锚点为被移动 Request 自身时（其已被移除）按 not found 抛错：「移动到自身之后」
 * 不在 §4.5 粘贴矩阵内，视为非法目标。
 */
function placeRequest(collection: Collection, request: ApiRequest, target: MoveRequestTarget): void {
  request.collectionId = collection.id
  switch (target.kind) {
    case 'collection-top':
      delete request.folderId
      collection.requests.push(request)
      return
    case 'folder': {
      const folder = findFolder(collection, target.folderId)
      if (!folder) throw new Error(`folder not found: ${target.folderId}`)
      request.folderId = folder.id
      folder.requests.push(request)
      return
    }
    case 'after-request': {
      const anchor = findRequest(collection, target.requestId)
      if (!anchor) throw new Error(`request not found: ${target.requestId}`)
      const container = anchor.folder ?? collection
      const index = container.requests.findIndex((r) => r.id === target.requestId)
      if (anchor.folder === undefined) {
        delete request.folderId
      } else {
        request.folderId = anchor.folder.id
      }
      container.requests.splice(index + 1, 0, request)
      return
    }
  }
}

/**
 * Copy 粘贴用插入辅助：把 request（典型为 copyRequestSnapshot 产物，已含新 id 与副本名）
 * 插入 collection 的目标位置。纯函数：对 request 深拷贝后插入（返回值不与入参共享引用），
 * 并按目标容器重写 collectionId/folderId；不改其 id/name/createdAt/updatedAt
 * （ID 重建与命名分别是 copyRequestSnapshot / nextCopyName 的职责）。
 */
export function insertRequestAt(
  collection: Collection,
  request: ApiRequest,
  target: MoveRequestTarget,
  now?: number,
): Collection {
  const next = clone(collection)
  placeRequest(next, structuredClone(request), target)
  return touch(next, now)
}

/**
 * 跨 Collection 原子移动 Request（实施设计 §4.4；UX §4.6 Cut 行）：源中移除、目标中按
 * target 语义插入；request.collectionId 重写为目标 Collection、folderId 按目标容器设置或删除；
 * Cut 保留原名与原 id（不走 nextCopyName、不重建 ID）。request.updatedAt 与两个 Collection 的
 * updatedAt 均写为 now——Host 应以 nextTimestamp（§4.3 单调时间）传入以保证版本严格递增。
 *
 * 同 Collection 内移动也走本函数：此时返回同一个新对象的两个引用（nextSource === nextTarget），
 * 调用方据此只做一次持久化；调用方须为两个入参传入同一权威对象（或内容一致的同 id 副本）。
 * 跨 Collection 时返回两个相互独立的新 Collection，由调用方在内存中组成完整 nextCollections[]
 * 后一次写盘（§4.4 步骤 4/5），本函数不做任何 I/O。
 */
export function moveRequestAcrossCollections(
  sourceCollection: Collection,
  targetCollection: Collection,
  requestId: string,
  target: MoveRequestTarget,
  now?: number,
): { nextSource: Collection; nextTarget: Collection } {
  const at = now ?? Date.now()
  if (sourceCollection.id === targetCollection.id) {
    const next = clone(sourceCollection)
    const hit = findRequest(next, requestId)
    if (!hit) throw new Error(`request not found: ${requestId}`)
    detachRequest(next, hit.folder, requestId)
    placeRequest(next, hit.request, target)
    hit.request.updatedAt = at
    touch(next, at)
    return { nextSource: next, nextTarget: next }
  }
  const nextSource = clone(sourceCollection)
  const hit = findRequest(nextSource, requestId)
  if (!hit) throw new Error(`request not found: ${requestId}`)
  detachRequest(nextSource, hit.folder, requestId)
  touch(nextSource, at)
  const nextTarget = clone(targetCollection)
  placeRequest(nextTarget, hit.request, target)
  hit.request.updatedAt = at
  touch(nextTarget, at)
  return { nextSource, nextTarget }
}

/**
 * Folder 递归统计（实施设计 §7.1 Folder 删除确认；UX §4.7）：
 * 目标 Folder 本身不计入 folderCount；requestCount 含直接请求与全部嵌套后代请求。
 */
export function countFolderDescendants(folder: Folder): { folderCount: number; requestCount: number } {
  let folderCount = 0
  let requestCount = folder.requests.length
  const walk = (folders: Folder[]): void => {
    for (const child of folders) {
      folderCount += 1
      requestCount += child.requests.length
      walk(child.folders)
    }
  }
  walk(folder.folders)
  return { folderCount, requestCount }
}

/**
 * Collection 递归 Request 总数（实施设计 §7.1 Collection 删除确认；UX §4.7）。
 * core 权威实现：client 侧 ApiClientView 的同名局部函数属临时实现，WP8 汇聚时应替换为本函数。
 */
export function countCollectionRequests(collection: Collection): number {
  return listAllRequests(collection).length
}

/** 乐观锁版本谓词（实施设计 §4.3、§3.1.1 409 判定）：Collection.updatedAt 严格相等。 */
export function collectionVersionMatches(collection: Collection, expectedUpdatedAt: number): boolean {
  return collection.updatedAt === expectedUpdatedAt
}

/** 乐观锁版本谓词（实施设计 §4.3）：Request.updatedAt 严格相等（Cut 粘贴前校验 Request 未被修改）。 */
export function requestVersionMatches(request: ApiRequest, expectedUpdatedAt: number): boolean {
  return request.updatedAt === expectedUpdatedAt
}
