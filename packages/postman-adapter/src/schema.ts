/**
 * Postman Collection v2.1 schema 类型与校验（V01 §3.3 schema.ts）。
 *
 * 只定义适配器消费的最小结构子集（官方 schema 的超集输入一律按宽松读取，
 * 未知字段忽略——postmanCompatibility 默认 lenient 语义，见 §25）。
 * `info.schema` URL 校验是 v2.1 身份判定的权威依据。
 */

/** 官方 v2.1 schema URL（精确匹配，含尾版本段）。 */
export const POSTMAN_V21_SCHEMA_URL =
  'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'

/** schema.getpostman.com 任一版本的 URL 前缀（用于区分「其他版本 Postman」与「非 Postman」）。 */
export const POSTMAN_SCHEMA_URL_PREFIX = 'https://schema.getpostman.com/json/collection/'

export interface PostmanKeyValue {
  key?: string
  value?: unknown
  description?: unknown
  disabled?: boolean
  type?: string
}

/** auth 属性块：v2.1 常见为 [{key, value}] 列表，也存在对象形态（宽松兼容）。 */
export type PostmanAuthAttributes = PostmanKeyValue[] | Record<string, unknown>

export interface PostmanAuth {
  type?: string
  basic?: PostmanAuthAttributes
  bearer?: PostmanAuthAttributes
  apikey?: PostmanAuthAttributes
  [authType: string]: unknown
}

export interface PostmanUrl {
  raw?: string
  protocol?: string
  host?: string | string[]
  path?: string | string[]
  query?: PostmanKeyValue[]
  variable?: PostmanKeyValue[]
}

export interface PostmanBody {
  mode?: string
  raw?: string
  options?: { raw?: { language?: string } }
  urlencoded?: PostmanKeyValue[]
  formdata?: PostmanKeyValue[]
}

export interface PostmanRequest {
  method?: string
  url?: string | PostmanUrl
  header?: PostmanKeyValue[]
  body?: PostmanBody
  auth?: PostmanAuth
  description?: unknown
}

export interface PostmanScript {
  type?: string
  exec?: string | string[]
}

export interface PostmanEvent {
  listen?: string
  script?: PostmanScript
}

export interface PostmanItem {
  name?: string
  /** 存在 item 数组即 folder（可任意嵌套）。 */
  item?: PostmanItem[]
  request?: string | PostmanRequest
  response?: unknown
  event?: PostmanEvent[]
}

export interface PostmanCollectionDoc {
  info: {
    name?: string
    schema?: string
    _postman_id?: string
    [key: string]: unknown
  }
  item: PostmanItem[]
  variable?: PostmanKeyValue[]
  auth?: PostmanAuth
  event?: PostmanEvent[]
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** info.schema 是否官方 v2.1 URL（精确匹配；允许 http/https 与结尾斜杠差异）。 */
export function isV21SchemaUrl(schema: unknown): schema is string {
  if (typeof schema !== 'string') return false
  const normalized = schema.trim().replace(/\/$/, '').replace(/^http:\/\//, 'https://')
  return normalized === POSTMAN_V21_SCHEMA_URL
}

/** info.schema 是否任一 Postman 官方 schema URL（用于错误文案区分版本不符与非 Postman）。 */
export function isPostmanSchemaUrl(schema: unknown): schema is string {
  return typeof schema === 'string' && schema.startsWith(POSTMAN_SCHEMA_URL_PREFIX)
}
