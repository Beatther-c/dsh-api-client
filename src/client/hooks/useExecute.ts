/**
 * 执行钩子（§5.1 端点 21）：Human/Agent 共用入口 POST /api-client/execute。
 * - 入参二选一：完整 request 投影（编辑器未保存草稿）或 requestId（已保存请求，
 *   「重新执行」走这条 SecretRef 链——host 侧解析，client 永不回读 secret，AC-32）；
 * - environment 为显式环境 id/name（§5.2 D-D1：无全局 switch，逐次调用显式传）。
 */
import { useCallback, useState } from 'react'
import type { ApiRequest, HttpExecutionResult, RedactedRequestSnapshot, RedactedResponseSnapshot } from '@dsh-api-client/shared'
import { toast } from '../components/common/Toast.tsx'
import { HostApiError, useHostApi } from './useHostApi.ts'

export interface ExecuteResponse {
  result: HttpExecutionResult
  historyId?: string
  requestEcho: RedactedRequestSnapshot
  /** host 跟踪脱敏的响应快照（执行期 secretValues 定点替换；「交给 Agent」优先数据源）。 */
  responseEcho: RedactedResponseSnapshot
}

export interface ExecuteState {
  executing: boolean
  execute: (input: { request?: ApiRequest; requestId?: string; environment?: string }) => Promise<ExecuteResponse | undefined>
}

export function useExecute(onExecuted?: () => void): ExecuteState {
  const api = useHostApi()
  const [executing, setExecuting] = useState(false)

  const execute = useCallback(
    async (input: { request?: ApiRequest; requestId?: string; environment?: string }): Promise<ExecuteResponse | undefined> => {
      setExecuting(true)
      try {
        const body: Record<string, unknown> = {}
        if (input.request !== undefined) body.request = input.request
        if (input.requestId !== undefined) body.requestId = input.requestId
        if (input.environment !== undefined) body.environment = input.environment
        const response = await api.post<ExecuteResponse>('/execute', body)
        onExecuted?.()
        return response
      } catch (error) {
        const message = error instanceof HostApiError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error)
        toast.error(message)
        return undefined
      } finally {
        setExecuting(false)
      }
    },
    [api, onExecuted],
  )

  return { executing, execute }
}
