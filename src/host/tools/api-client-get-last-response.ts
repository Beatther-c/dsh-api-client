/**
 * `api_client_get_last_response`（§13.7 修订版；§5.2 REVIEW 低级 #6）：
 * 读取最近一次（或指定 historyId 的）执行历史快照。
 *
 * **永远脱敏**：history 只存 redactor 生成的脱敏快照，本工具原样出域；
 * schema 中不存在任何明文开关参数（TC-T-05 回归锁）。唯一明文 override 路径
 * 在 Human UI 的 human-present reveal（§5.2），与本工具无关。
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ExecutionHistory } from '@dsh-api-client/shared'
import { TOOL_API_CLIENT_GET_LAST_RESPONSE } from '@dsh-api-client/shared'
import type { ApiClientToolsDeps } from './register.ts'
import { renderJsonBlocks } from './register.ts'

/** 工具返回：脱敏请求/响应快照 + 定位元数据（全部出自已脱敏的 history 条目）。 */
export interface LastResponseProjection {
  historyId: string
  timestamp: number
  method: ExecutionHistory['method']
  displayUrl: string
  source: ExecutionHistory['source']
  durationMs: number
  requestSnapshot: ExecutionHistory['requestSnapshot']
  responseSnapshot: ExecutionHistory['responseSnapshot']
}

// §5.2：除可选 historyId 外无任何参数——不存在 reveal/plain/raw 一类明文开关。
const PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    historyId: {
      type: 'string',
      description: 'Optional history entry id; defaults to the most recent execution.',
    },
  },
  required: [],
  additionalProperties: false,
}

const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    historyId: { type: 'string' },
    timestamp: { type: 'number' },
    method: { type: 'string' },
    displayUrl: { type: 'string' },
    source: { type: 'string' },
    durationMs: { type: 'number' },
    requestSnapshot: { type: 'object' },
    responseSnapshot: { type: 'object' },
  },
  required: ['historyId', 'timestamp', 'method', 'displayUrl', 'source', 'durationMs', 'requestSnapshot', 'responseSnapshot'],
}

export function buildGetLastResponseToolDefinition(deps: ApiClientToolsDeps): ToolDefinition {
  return {
    name: TOOL_API_CLIENT_GET_LAST_RESPONSE,
    description:
      'Fetch the redacted request/response snapshot of the most recent execution (or of a given historyId). ' +
      'Always redacted: there is no parameter or switch that returns plaintext secrets.',
    parameters: PARAMETERS as ToolDefinition['parameters'],
    output: {
      schema: OUTPUT_SCHEMA as ToolDefinition['output']['schema'],
      render: renderJsonBlocks,
    },
    async execute(args: unknown): Promise<LastResponseProjection> {
      let historyId: string | undefined
      if (args !== undefined) {
        if (typeof args !== 'object' || args === null) {
          throw new Error(`${TOOL_API_CLIENT_GET_LAST_RESPONSE}: arguments must be an object`)
        }
        const record = args as Record<string, unknown>
        if (record.historyId !== undefined && typeof record.historyId !== 'string') {
          throw new Error(`${TOOL_API_CLIENT_GET_LAST_RESPONSE}: historyId must be a string`)
        }
        historyId = record.historyId as string | undefined
      }
      const entry = historyId !== undefined ? deps.history.get(historyId) : deps.history.list({ limit: 1 })[0]
      if (entry === undefined) {
        throw new Error(
          historyId !== undefined
            ? `${TOOL_API_CLIENT_GET_LAST_RESPONSE}: history entry not found: ${historyId}`
            : `${TOOL_API_CLIENT_GET_LAST_RESPONSE}: no execution history yet`,
        )
      }
      return {
        historyId: entry.id,
        timestamp: entry.timestamp,
        method: entry.method,
        displayUrl: entry.displayUrl,
        source: entry.source,
        durationMs: entry.duration,
        requestSnapshot: entry.requestSnapshot,
        responseSnapshot: entry.responseSnapshot,
      }
    },
  }
}
