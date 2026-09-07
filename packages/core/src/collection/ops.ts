/**
 * Collection CRUD / 重命名 / 删除 / 排序 / 搜索 / Duplicate（§3.2 collection/ops）。
 * 全部纯函数：不修改入参，返回新的 Collection（structuredClone 后改副本）。
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
