/**
 * `api_client_list_requests`（§13.4；§5.2）：只读列出某 Collection 全树请求
 * （顶层 + 任意嵌套 folder），投影 `{ id, name, method, displayUrl }[]`。
 * displayUrl 经 redaction-service 出域出口（纵深防御）；低风险，不触发 Approval。
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { HttpMethod } from '@dsh-api-client/shared'
import { TOOL_API_CLIENT_LIST_REQUESTS } from '@dsh-api-client/shared'
import type { ApiClientToolsDeps } from './register.ts'
import { flattenRequests, renderJsonBlocks } from './register.ts'

export interface RequestSummary {
  id: string
  name: string
  method: HttpMethod
  displayUrl: string
}

const PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    collectionId: { type: 'string', description: 'Id of the collection whose requests to list.' },
  },
  required: ['collectionId'],
  additionalProperties: false,
}

const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      method: { type: 'string' },
      displayUrl: { type: 'string' },
    },
    required: ['id', 'name', 'method', 'displayUrl'],
  },
}

export function buildListRequestsToolDefinition(deps: ApiClientToolsDeps): ToolDefinition {
  return {
    name: TOOL_API_CLIENT_LIST_REQUESTS,
    description: 'List all requests of a collection (including folders) as {id, name, method, displayUrl}. Read-only.',
    parameters: PARAMETERS as ToolDefinition['parameters'],
    output: {
      schema: OUTPUT_SCHEMA as ToolDefinition['output']['schema'],
      render: renderJsonBlocks,
    },
    async execute(args: unknown): Promise<RequestSummary[]> {
      if (typeof args !== 'object' || args === null || typeof (args as Record<string, unknown>).collectionId !== 'string') {
        throw new Error(`${TOOL_API_CLIENT_LIST_REQUESTS}: collectionId is required and must be a string`)
      }
      const collectionId = (args as { collectionId: string }).collectionId
      const collection = deps.collections.require(collectionId)
      return flattenRequests(collection).map((request) => ({
        id: request.id,
        name: request.name,
        method: request.method,
        displayUrl: deps.redaction.redactText(request.url),
      }))
    },
  }
}
