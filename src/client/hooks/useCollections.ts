/**
 * Collections 数据钩子（Host 为权威状态源，client 只做投影——D16）：
 * 每次变更后从 host 重新拉取投影，不在 client 侧维护本地副本一致性。
 */
import { useCallback, useEffect, useState } from 'react'
import type { ApiRequest, Collection } from '@dsh-api-client/shared'
import { toast } from '../components/common/Toast.tsx'
import { HostApiError, useHostApi } from './useHostApi.ts'

export interface CollectionsState {
  collections: Collection[]
  loading: boolean
  error: string | undefined
  refresh: () => void
  createCollection: (name: string) => Promise<Collection | undefined>
  renameCollection: (id: string, name: string) => Promise<void>
  deleteCollection: (id: string) => Promise<void>
  duplicateCollection: (id: string) => Promise<void>
  reorderCollection: (id: string, itemIds: string[]) => Promise<void>
  saveRequest: (collectionId: string, request: Omit<ApiRequest, 'id' | 'createdAt' | 'updatedAt' | 'collectionId'> & { folderId?: string }) => Promise<ApiRequest | undefined>
  patchRequest: (id: string, patch: Record<string, unknown>) => Promise<ApiRequest | undefined>
  deleteRequest: (id: string) => Promise<void>
  duplicateRequest: (id: string) => Promise<void>
  moveRequest: (id: string, folderId?: string) => Promise<void>
}

function report(error: unknown): string {
  const message = error instanceof HostApiError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error)
  toast.error(message)
  return message
}

export function useCollections(): CollectionsState {
  const api = useHostApi()
  const [collections, setCollections] = useState<Collection[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>()
  const [generation, setGeneration] = useState(0)

  const refresh = useCallback((): void => {
    setGeneration((g) => g + 1)
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api
      .get<Collection[]>('/collections')
      .then((list) => {
        if (cancelled) return
        setCollections(list)
        setError(undefined)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(report(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [api, generation])

  const run = useCallback(
    async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
      try {
        const result = await action()
        refresh()
        return result
      } catch (err) {
        report(err)
        return undefined
      }
    },
    [refresh],
  )

  return {
    collections,
    loading,
    error,
    refresh,
    createCollection: (name) => run(() => api.post<Collection>('/collections', { name })),
    renameCollection: async (id, name) => {
      await run(() => api.patch<Collection>(`/collections/${encodeURIComponent(id)}`, { name }))
    },
    deleteCollection: async (id) => {
      await run(() => api.delete(`/collections/${encodeURIComponent(id)}`))
    },
    duplicateCollection: async (id) => {
      await run(() => api.post<Collection>(`/collections/${encodeURIComponent(id)}/duplicate`))
    },
    reorderCollection: async (id, itemIds) => {
      await run(() => api.post<Collection>(`/collections/${encodeURIComponent(id)}/reorder`, { itemIds }))
    },
    saveRequest: (collectionId, request) => run(() => api.post<ApiRequest>(`/collections/${encodeURIComponent(collectionId)}/requests`, request)),
    patchRequest: (id, patch) => run(() => api.patch<ApiRequest>(`/requests/${encodeURIComponent(id)}`, patch)),
    deleteRequest: async (id) => {
      await run(() => api.delete(`/requests/${encodeURIComponent(id)}`))
    },
    duplicateRequest: async (id) => {
      await run(() => api.post<ApiRequest>(`/requests/${encodeURIComponent(id)}/duplicate`))
    },
    moveRequest: async (id, folderId) => {
      await run(() => api.post<ApiRequest>(`/requests/${encodeURIComponent(id)}/move`, { folderId }))
    },
  }
}
