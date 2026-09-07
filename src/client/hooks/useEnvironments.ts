/**
 * Environments 数据钩子（Host 权威投影，D16）：
 * - GET 只返回 SecretRef 投影（secret currentValue = `<secret-ref:key>` 或 {$ref} 形态）；
 * - secret 写入走 write-only 端点（PUT …/secrets/:key），明文只在请求体里出现一次，
 *   UI 不回读（任何 GET 永不返回 value，§5.1 端点 19）。
 */
import { useCallback, useEffect, useState } from 'react'
import type { Environment } from '@dsh-api-client/shared'
import { toast } from '../components/common/Toast.tsx'
import { HostApiError, useHostApi } from './useHostApi.ts'

export interface PlainVariableInput {
  key: string
  value: string
  enabled?: boolean
  initialValue?: string
}

export interface EnvironmentsState {
  environments: Environment[]
  loading: boolean
  error: string | undefined
  refresh: () => void
  createEnvironment: (name: string) => Promise<Environment | undefined>
  renameEnvironment: (id: string, name: string) => Promise<void>
  patchVariables: (id: string, variables: PlainVariableInput[]) => Promise<void>
  deleteEnvironment: (id: string) => Promise<void>
  writeSecret: (id: string, key: string, value: string) => Promise<void>
  deleteSecret: (id: string, key: string) => Promise<void>
}

function report(error: unknown): string {
  const message = error instanceof HostApiError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error)
  toast.error(message)
  return message
}

export function useEnvironments(): EnvironmentsState {
  const api = useHostApi()
  const [environments, setEnvironments] = useState<Environment[]>([])
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
      .get<Environment[]>('/environments')
      .then((list) => {
        if (cancelled) return
        setEnvironments(list)
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
    environments,
    loading,
    error,
    refresh,
    createEnvironment: (name) => run(() => api.post<Environment>('/environments', { name })),
    renameEnvironment: async (id, name) => {
      await run(() => api.patch<Environment>(`/environments/${encodeURIComponent(id)}`, { name }))
    },
    patchVariables: async (id, variables) => {
      await run(() => api.patch<Environment>(`/environments/${encodeURIComponent(id)}`, { variables }))
    },
    deleteEnvironment: async (id) => {
      await run(() => api.delete(`/environments/${encodeURIComponent(id)}`))
    },
    writeSecret: async (id, key, value) => {
      await run(() => api.put<{ secretRef: string }>(`/environments/${encodeURIComponent(id)}/secrets/${encodeURIComponent(key)}`, { value }))
    },
    deleteSecret: async (id, key) => {
      await run(() => api.delete(`/environments/${encodeURIComponent(id)}/secrets/${encodeURIComponent(key)}`))
    },
  }
}
