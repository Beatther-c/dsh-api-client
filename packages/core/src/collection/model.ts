/**
 * Collection / Folder 树模型与 id 生成（§3.2 collection/model）。
 * 纯函数，零 I/O。
 */
import type { ApiRequest, AuthConfig, BodyConfig, Collection, Folder, HttpMethod } from '@dsh-api-client/shared'

export function generateId(): string {
  return crypto.randomUUID()
}

export interface CreateCollectionInput {
  name: string
  auth?: AuthConfig
  now?: number
}

export function createCollection(input: CreateCollectionInput): Collection {
  const now = input.now ?? Date.now()
  return {
    id: generateId(),
    name: input.name,
    ...(input.auth !== undefined ? { auth: input.auth } : {}),
    variables: [],
    folders: [],
    requests: [],
    createdAt: now,
    updatedAt: now,
  }
}

export function createFolder(name: string): Folder {
  return { id: generateId(), name, folders: [], requests: [] }
}

export interface CreateRequestInput {
  name: string
  method?: HttpMethod
  url?: string
  collectionId: string
  folderId?: string
  now?: number
}

export const DEFAULT_REQUEST_AUTH: AuthConfig = { type: 'none' }
export const DEFAULT_REQUEST_BODY: BodyConfig = { type: 'none' }

export function createRequest(input: CreateRequestInput): ApiRequest {
  const now = input.now ?? Date.now()
  return {
    id: generateId(),
    name: input.name,
    method: input.method ?? 'GET',
    url: input.url ?? '',
    params: [],
    headers: [],
    auth: DEFAULT_REQUEST_AUTH,
    body: DEFAULT_REQUEST_BODY,
    collectionId: input.collectionId,
    ...(input.folderId !== undefined ? { folderId: input.folderId } : {}),
    createdAt: now,
    updatedAt: now,
  }
}
