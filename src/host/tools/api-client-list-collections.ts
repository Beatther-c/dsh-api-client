/**
 * `api_client_list_collections`（§13.3；§5.2）：只读列出全部 Collection 摘要
 * （`CollectionSummary[]` = {id,name,requestCount}；requestCount 为全树请求数）。
 * 低风险只读工具，不触发 Approval。
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { CollectionSummary } from '@dsh-api-client/shared'
import { TOOL_API_CLIENT_LIST_COLLECTIONS } from '@dsh-api-client/shared'
import type { ApiClientToolsDeps } from './register.ts'
import { flattenRequests, renderJsonBlocks } from './register.ts'

const PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false,
}

const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      requestCount: { type: 'number' },
    },
    required: ['id', 'name', 'requestCount'],
  },
}

export function buildListCollectionsToolDefinition(deps: ApiClientToolsDeps): ToolDefinition {
  return {
    name: TOOL_API_CLIENT_LIST_COLLECTIONS,
    description: 'List all API client collections as summaries (id, name, requestCount). Read-only.',
    parameters: PARAMETERS as ToolDefinition['parameters'],
    output: {
      schema: OUTPUT_SCHEMA as ToolDefinition['output']['schema'],
      render: renderJsonBlocks,
    },
    async execute(): Promise<CollectionSummary[]> {
      return deps.collections.list().map((collection) => ({
        id: collection.id,
        name: collection.name,
        requestCount: flattenRequests(collection).length,
      }))
    },
  }
}
