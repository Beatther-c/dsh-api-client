/**
 * History 数据钩子（§10）：列表与详情都是 host 侧脱敏快照；
 * 清空为 human-only 操作（§5.1 端点 24）。
 */
import { useCallback, useEffect, useState } from 'react'
import type { ExecutionHistory } from '@dsh-api-client/shared'
import { toast } from '../components/common/Toast.tsx'
import { HostApiError, useHostApi } from './useHostApi.ts'

export interface HistoryState {
  entries: ExecutionHistory[]
  loading: boolean
  error: string | undefined
  refresh: () => void
  getEntry: (id: string) => Promise<ExecutionHistory | undefined>
  clear: () => Promise<void>
}

function report(error: unknown): string {
  const message = error instanceof HostApiError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error)
  toast.error(message)
  return message
}

export function useHistory(): HistoryState {
  const api = useHostApi()
  const [entries, setEntries] = useState<ExecutionHistory[]>([])
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
      .get<ExecutionHistory[]>('/history?limit=200')
      .then((list) => {
        if (cancelled) return
        setEntries(list)
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

  const getEntry = useCallback(
    async (id: string): Promise<ExecutionHistory | undefined> => {
      try {
        return await api.get<ExecutionHistory>(`/history/${encodeURIComponent(id)}`)
      } catch (err) {
        report(err)
        return undefined
      }
    },
    [api],
  )

  const clear = useCallback(async (): Promise<void> => {
    try {
      await api.delete('/history')
      refresh()
    } catch (err) {
      report(err)
    }
  }, [api, refresh])

  return { entries, loading, error, refresh, getEntry, clear }
}
