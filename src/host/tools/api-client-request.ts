/**
 * `api_client_request`（§13.1；§5.2）：临时请求执行。
 * schema 与 M0 回显桩一致（{method,url,headers?,query?,body?,environment?}），
 * 实现换真 execution-service——与 Human Send 同一个 core executor（§13.8，TC-T-01）。
 *
 * 返回 `{ status, statusText, headers, bodyPreview, size, durationMs, historyId }`
 * 脱敏投影（execution-service responseEcho 出口）；执行写 history source='agent'
 * + audit.jsonl（由 execution-service 保证，TC-T-09）。
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { BodyConfig, HttpMethod } from '@dsh-api-client/shared'
import { TOOL_API_CLIENT_REQUEST } from '@dsh-api-client/shared'
import type { ApiClientToolsDeps } from './register.ts'
import { renderJsonBlocks, toKeyValueList, toToolExecutionResult } from './register.ts'

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const

export interface RequestToolArgs {
  method: string
  url: string
  headers?: Record<string, string>
  query?: Record<string, string>
  body?: unknown
  environment?: string
}

const PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    method: {
      type: 'string',
      enum: [...HTTP_METHODS],
      description: 'HTTP method of the request.',
    },
    url: { type: 'string', description: 'Absolute request URL; may contain {{variable}} placeholders.' },
    headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Optional request headers.' },
    query: { type: 'object', additionalProperties: { type: 'string' }, description: 'Optional query parameters.' },
    body: {
      description:
        'Optional request body. A string is sent as raw text; any other JSON value is serialized and sent as application/json.',
    },
    environment: {
      type: 'string',
      description: 'Optional per-call environment (id or unique name). No global environment switch exists.',
    },
  },
  required: ['method', 'url'],
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

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === 'string')
  )
}

function mapBody(body: unknown): BodyConfig {
  if (body === undefined || body === null) return { type: 'none' }
  if (typeof body === 'string') return { type: 'raw', raw: body }
  return { type: 'json', json: JSON.stringify(body) }
}

function parseArgs(args: unknown): RequestToolArgs {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new Error(`${TOOL_API_CLIENT_REQUEST}: arguments must be an object`)
  }
  const record = args as Record<string, unknown>
  if (typeof record.method !== 'string' || !HTTP_METHODS.includes(record.method.toUpperCase() as (typeof HTTP_METHODS)[number])) {
    throw new Error(`${TOOL_API_CLIENT_REQUEST}: method must be one of ${HTTP_METHODS.join(', ')}`)
  }
  if (typeof record.url !== 'string' || record.url === '') {
    throw new Error(`${TOOL_API_CLIENT_REQUEST}: url is required and must be a string`)
  }
  if (record.headers !== undefined && !isStringRecord(record.headers)) {
    throw new Error(`${TOOL_API_CLIENT_REQUEST}: headers must be a Record<string, string>`)
  }
  if (record.query !== undefined && !isStringRecord(record.query)) {
    throw new Error(`${TOOL_API_CLIENT_REQUEST}: query must be a Record<string, string>`)
  }
  if (record.environment !== undefined && typeof record.environment !== 'string') {
    throw new Error(`${TOOL_API_CLIENT_REQUEST}: environment must be a string (id or name)`)
  }
  const parsed: RequestToolArgs = { method: record.method, url: record.url }
  if (record.headers !== undefined) parsed.headers = record.headers
  if (record.query !== undefined) parsed.query = record.query
  if (record.body !== undefined) parsed.body = record.body
  if (record.environment !== undefined) parsed.environment = record.environment
  return parsed
}

export function buildRequestToolDefinition(deps: ApiClientToolsDeps): ToolDefinition {
  return {
    name: TOOL_API_CLIENT_REQUEST,
    description:
      'Execute an ad-hoc HTTP request through the dsh-api-client executor (the same executor the Human UI Send uses). ' +
      'An optional per-call `environment` (id or unique name) resolves {{variables}} and secrets; there is no global ' +
      'environment-switch tool. The result is always a redacted projection — resolved secrets never appear in it.',
    parameters: PARAMETERS as ToolDefinition['parameters'],
    output: {
      schema: OUTPUT_SCHEMA as ToolDefinition['output']['schema'],
      render: renderJsonBlocks,
    },
    async execute(args: unknown) {
      const parsed = parseArgs(args)
      const output = await deps.execution.execute({
        request: {
          method: parsed.method.toUpperCase() as HttpMethod,
          url: parsed.url,
          headers: toKeyValueList(parsed.headers),
          params: toKeyValueList(parsed.query),
          body: mapBody(parsed.body),
        },
        ...(parsed.environment !== undefined ? { environment: parsed.environment } : {}),
        source: 'agent',
      })
      return toToolExecutionResult(output)
    },
  }
}
