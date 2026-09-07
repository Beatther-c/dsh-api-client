/**
 * `api_client_run_request`（§13.2；§5.2）：执行 Collection 中已保存的请求。
 * 入参 `{ requestId }` 或 `{ collection, request }`（均为名字、各自唯一命中），
 * 可加 per-call `{ environment? }`；风险等级由目标请求的 method 决定（§5.2）。
 *
 * 执行走同一个 execution-service（source='agent'）；返回与 api_client_request
 * 相同的脱敏投影。
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { TOOL_API_CLIENT_RUN_REQUEST } from '@dsh-api-client/shared'
import type { ApiClientToolsDeps } from './register.ts'
import { findRequestByNames, renderJsonBlocks, toToolExecutionResult } from './register.ts'

export interface RunRequestToolArgs {
  requestId?: string
  collection?: string
  request?: string
  environment?: string
}

const PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    requestId: { type: 'string', description: 'Id of the saved request to run.' },
    collection: {
      type: 'string',
      description: 'Collection name (unique match); must be paired with `request`. Alternative to `requestId`.',
    },
    request: {
      type: 'string',
      description: 'Request name within the collection (unique match across folders); paired with `collection`.',
    },
    environment: {
      type: 'string',
      description: 'Optional per-call environment (id or unique name). No global environment switch exists.',
    },
  },
  required: [],
  additionalProperties: false,
}

const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    status: { type: 'number' },
    statusText: { type: 'string' },
    headers: { type: 'array' },
    bodyPreview: { type: 'string' },
    size: { type: 'number' },
    durationMs: { type: 'number' },
    historyId: { type: 'string' },
  },
  required: ['status', 'statusText', 'headers', 'size', 'durationMs'],
  additionalProperties: true,
}

function parseArgs(args: unknown): RunRequestToolArgs {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new Error(`${TOOL_API_CLIENT_RUN_REQUEST}: arguments must be an object`)
  }
  const record = args as Record<string, unknown>
  for (const key of ['requestId', 'collection', 'request', 'environment'] as const) {
    if (record[key] !== undefined && typeof record[key] !== 'string') {
      throw new Error(`${TOOL_API_CLIENT_RUN_REQUEST}: ${key} must be a string`)
    }
  }
  const hasId = typeof record.requestId === 'string'
  const hasNames = typeof record.collection === 'string' || typeof record.request === 'string'
  if (hasId === hasNames) {
    throw new Error(`${TOOL_API_CLIENT_RUN_REQUEST}: pass exactly one of requestId or {collection, request}`)
  }
  if (hasNames && (typeof record.collection !== 'string' || typeof record.request !== 'string')) {
    throw new Error(`${TOOL_API_CLIENT_RUN_REQUEST}: collection and request must be passed together`)
  }
  const parsed: RunRequestToolArgs = {}
  if (typeof record.requestId === 'string') parsed.requestId = record.requestId
  if (typeof record.collection === 'string') parsed.collection = record.collection
  if (typeof record.request === 'string') parsed.request = record.request
  if (typeof record.environment === 'string') parsed.environment = record.environment
  return parsed
}

export function buildRunRequestToolDefinition(deps: ApiClientToolsDeps): ToolDefinition {
  return {
    name: TOOL_API_CLIENT_RUN_REQUEST,
    description:
      'Run a request saved in a collection, by `requestId` or by unique `{collection, request}` names. ' +
      'An optional per-call `environment` (id or unique name) applies to this run only. ' +
      'The result is always a redacted projection — resolved secrets never appear in it.',
    parameters: PARAMETERS as ToolDefinition['parameters'],
    output: {
      schema: OUTPUT_SCHEMA as ToolDefinition['output']['schema'],
      render: renderJsonBlocks,
    },
    async execute(args: unknown) {
      const parsed = parseArgs(args)
      let requestId = parsed.requestId
      if (requestId === undefined) {
        const found = findRequestByNames(deps.collections, parsed.collection!, parsed.request!)
        if (found === undefined) {
          throw new Error(
            `${TOOL_API_CLIENT_RUN_REQUEST}: request not found (unique match required): ${parsed.collection} / ${parsed.request}`,
          )
        }
        requestId = found.id
      }
      const output = await deps.execution.execute({
        requestId,
        ...(parsed.environment !== undefined ? { environment: parsed.environment } : {}),
        source: 'agent',
      })
      return toToolExecutionResult(output)
    },
  }
}
