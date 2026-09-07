/**
 * `api_client_get_request`（§13.5；§5.2）：只读取单个已保存请求。
 * 返回 ApiRequest 投影——auth 材料经 redaction-service 脱敏（明文材料 →
 * `<redacted>`；SecretRef 材料保留不透明 `$ref` 形态，不编码明文）。低风险，不触发 Approval。
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ApiRequest } from '@dsh-api-client/shared'
import { TOOL_API_CLIENT_GET_REQUEST } from '@dsh-api-client/shared'
import type { ApiClientToolsDeps } from './register.ts'
import { renderJsonBlocks } from './register.ts'

const PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    requestId: { type: 'string', description: 'Id of the saved request to fetch.' },
  },
  required: ['requestId'],
  additionalProperties: false,
}

const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    method: { type: 'string' },
    url: { type: 'string' },
  },
  required: ['id', 'name', 'method', 'url'],
  additionalProperties: true,
}

export function buildGetRequestToolDefinition(deps: ApiClientToolsDeps): ToolDefinition {
  return {
    name: TOOL_API_CLIENT_GET_REQUEST,
    description:
      'Fetch one saved request by id. Auth material and secrets are redacted in the projection ' +
      '(inline material becomes <redacted>; SecretRef stays an opaque reference). Read-only.',
    parameters: PARAMETERS as ToolDefinition['parameters'],
    output: {
      schema: OUTPUT_SCHEMA as ToolDefinition['output']['schema'],
      render: renderJsonBlocks,
    },
    async execute(args: unknown): Promise<ApiRequest> {
      if (typeof args !== 'object' || args === null || typeof (args as Record<string, unknown>).requestId !== 'string') {
        throw new Error(`${TOOL_API_CLIENT_GET_REQUEST}: requestId is required and must be a string`)
      }
      const { request } = deps.collections.requireRequest((args as { requestId: string }).requestId)
      return deps.redaction.projectRequest(request)
    },
  }
}
