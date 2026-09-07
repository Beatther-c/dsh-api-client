/**
 * api_client_* 工具名常量（§5.2 定稿 6 个；无 api_client_switch_environment —— D-D1）。
 * 供 host tools 注册与 TC-T-03/TC-T-06 命名空间回归共用。
 */

export const TOOL_API_CLIENT_REQUEST = 'api_client_request'
export const TOOL_API_CLIENT_RUN_REQUEST = 'api_client_run_request'
export const TOOL_API_CLIENT_LIST_COLLECTIONS = 'api_client_list_collections'
export const TOOL_API_CLIENT_LIST_REQUESTS = 'api_client_list_requests'
export const TOOL_API_CLIENT_GET_REQUEST = 'api_client_get_request'
export const TOOL_API_CLIENT_GET_LAST_RESPONSE = 'api_client_get_last_response'

/** 定稿工具清单（§5.2，6 个；显式不含 switch_environment）。 */
export const API_CLIENT_TOOL_NAMES = [
  TOOL_API_CLIENT_REQUEST,
  TOOL_API_CLIENT_RUN_REQUEST,
  TOOL_API_CLIENT_LIST_COLLECTIONS,
  TOOL_API_CLIENT_LIST_REQUESTS,
  TOOL_API_CLIENT_GET_REQUEST,
  TOOL_API_CLIENT_GET_LAST_RESPONSE,
] as const

export type ApiClientToolName = (typeof API_CLIENT_TOOL_NAMES)[number]

/** 全部工具名匹配 ^api_client_ 命名空间（TC-T-03）。 */
export const API_CLIENT_TOOL_NAMESPACE_PATTERN = /^api_client_/
