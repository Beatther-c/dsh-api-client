/**
 * Normalize（V01 §3.3 normalize.ts）：Postman v2.1 文档 → 内部 Collection 模型。
 *
 * §15.1 完整支持映射：
 * - Collection / Folder（任意嵌套）/ Request / Method（七种）；
 * - URL 四形态：raw 字符串 / url.raw / protocol+host+path 组装 / `:pathVar` → `{{pathVar}}`；
 * - Query → params（disabled 保留为 enabled=false）；Headers 同理；
 * - Body：raw（language=json → json，其余 → raw）/ urlencoded / formdata（file 字段丢弃+警告）；
 * - Auth：basic / bearer / apikey（header·query）；noauth/inherit 直通；
 *   其余（oauth2/digest/…）降级 No Auth + `auth-downgraded` 警告，item 标记 partial；
 * - Collection Variables → CollectionVariable（disabled 保留）。
 *
 * 单项不可转换（未知 method 等）不阻塞整体导入：该 item 标记 unsupported，
 * 其余照常（TC-P-12，§15.4「不兼容内容不得阻塞整个 Collection 导入」）。
 */
import type { ApiRequest, AuthConfig, BodyConfig, KeyValue } from '@dsh-api-client/shared'
import type { ImportFinding, ImportItemResult, NormalizedImport } from '@dsh-api-client/core'
import { createCollection, createFolder, createRequest } from '@dsh-api-client/core'
import type {
  PostmanAuth,
  PostmanBody,
  PostmanCollectionDoc,
  PostmanItem,
  PostmanKeyValue,
  PostmanRequest,
  PostmanUrl,
} from './schema.ts'
import { SCRIPTS_WARNING, authAttribute, classifyAuth, extractEventScripts } from './compat-scanner.ts'

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])

/** `:pathVar` → `{{pathVar}}`（URL path 段内的 Postman 路径变量归一化；查询串/片段不动）。 */
export function normalizePathVariables(url: string): string {
  return url
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':') || segment.length < 2) return segment
      const end = segment.search(/[?#]/)
      const name = end < 0 ? segment.slice(1) : segment.slice(1, end)
      const rest = end < 0 ? '' : segment.slice(end)
      return `{{${name}}}${rest}`
    })
    .join('/')
}

function kvList(rows: PostmanKeyValue[] | undefined): KeyValue[] {
  return (rows ?? [])
    .filter((row) => typeof row.key === 'string')
    .map((row) => ({
      key: row.key!,
      value: typeof row.value === 'string' ? row.value : row.value === undefined ? '' : JSON.stringify(row.value),
      enabled: row.disabled !== true,
    }))
}

/** URL → 内部 url 字符串。四形态：string / raw / host+path 组装 / 含 `:pathVar`。 */
function normalizeUrl(url: string | PostmanUrl | undefined): string {
  if (url === undefined) return ''
  if (typeof url === 'string') return normalizePathVariables(url)
  const raw = typeof url.raw === 'string' ? url.raw : undefined
  if (raw !== undefined) return normalizePathVariables(raw)
  const host = Array.isArray(url.host) ? url.host.join('.') : (url.host ?? '')
  const path = Array.isArray(url.path) ? url.path.join('/') : (url.path ?? '')
  const protocol = url.protocol !== undefined && url.protocol !== '' ? `${url.protocol}://` : ''
  return normalizePathVariables(`${protocol}${host}${path !== '' ? `/${path}` : ''}`)
}

/** Query 数组 → params（disabled 保留为 enabled=false；raw 串内 query 不重复拆解）。 */
function normalizeQuery(url: string | PostmanUrl | undefined): KeyValue[] {
  if (url === undefined || typeof url === 'string') return []
  return kvList(url.query)
}

function normalizeBody(body: PostmanBody | undefined, path: string, findings: ImportFinding[]): BodyConfig {
  if (body === undefined || body.mode === undefined || body.mode === 'none') return { type: 'none' }
  switch (body.mode) {
    case 'raw': {
      if (body.options?.raw?.language === 'json') return { type: 'json', json: body.raw ?? '' }
      return { type: 'raw', raw: body.raw ?? '' }
    }
    case 'urlencoded':
      return { type: 'urlencoded', fields: kvList(body.urlencoded) }
    case 'formdata': {
      const fileRows = (body.formdata ?? []).filter((row) => row.type === 'file')
      if (fileRows.length > 0) {
        findings.push({
          itemPath: path,
          level: 'warn',
          kind: 'field-dropped',
          message: `form-data file field(s) dropped: ${fileRows.map((row) => row.key ?? '?').join(', ')}`,
        })
      }
      return { type: 'form-data', fields: kvList((body.formdata ?? []).filter((row) => row.type !== 'file')) }
    }
    default:
      findings.push({
        itemPath: path,
        level: 'warn',
        kind: 'field-dropped',
        message: `body mode "${body.mode}" not supported; imported as none`,
      })
      return { type: 'none' }
  }
}

/**
 * Auth 映射与降级表（§15.1/§15.2）：
 * noauth/缺省 → none；basic/bearer/apikey → 同名配置（材料原样保留，出场脱敏是 redactor 职责）；
 * inherit → inherit；oauth2/digest/hawk/awsv4/ntlm/… → none + `auth-downgraded` 警告。
 */
function normalizeAuth(auth: PostmanAuth | undefined, path: string): { auth: AuthConfig; findings: ImportFinding[] } {
  const classification = classifyAuth(auth)
  if (classification.support === 'downgraded') {
    return {
      auth: { type: 'none' },
      findings: [
        {
          itemPath: path,
          level: 'warn',
          kind: 'auth-downgraded',
          message: `auth type "${classification.authType}" not supported in V0.1; downgraded to No Auth`,
        },
      ],
    }
  }
  switch (classification.authType) {
    case 'basic':
      return {
        auth: {
          type: 'basic',
          username: authAttribute(auth?.basic, 'username'),
          password: authAttribute(auth?.basic, 'password'),
        },
        findings: [],
      }
    case 'bearer':
      return { auth: { type: 'bearer', token: authAttribute(auth?.bearer, 'token') }, findings: [] }
    case 'apikey':
      return {
        auth: {
          type: 'apikey',
          key: authAttribute(auth?.apikey, 'key'),
          value: authAttribute(auth?.apikey, 'value'),
          in: authAttribute(auth?.apikey, 'in') === 'query' ? 'query' : 'header',
        },
        findings: [],
      }
    case 'inherit':
      return { auth: { type: 'inherit' }, findings: [] }
    default:
      return { auth: { type: 'none' }, findings: [] }
  }
}

/** request 级 events → ScriptConfig（原文保留）+ 逐脚本 `script-not-executed` 警告。 */
function normalizeScripts(
  item: PostmanItem,
  path: string,
  findings: ImportFinding[],
): ApiRequest['scripts'] | undefined {
  let preRequest: string | undefined
  let tests: string | undefined
  for (const script of extractEventScripts(item.event)) {
    if (script.listen === 'prerequest') preRequest = script.code
    else if (script.listen === 'test') tests = script.code
    findings.push({
      itemPath: path,
      level: 'warn',
      kind: 'script-not-executed',
      message: `${script.listen} script preserved but not executed. ${SCRIPTS_WARNING}`,
    })
  }
  if (preRequest === undefined && tests === undefined) return undefined
  return {
    ...(preRequest !== undefined ? { preRequest } : {}),
    ...(tests !== undefined ? { tests } : {}),
    source: 'postman',
    warning: SCRIPTS_WARNING,
  }
}

function convertRequest(
  item: PostmanItem,
  collectionId: string,
  path: string,
  items: ImportItemResult[],
): ApiRequest {
  const raw = item.request
  if (raw === undefined) throw new Error('item has no request')
  const request: PostmanRequest = typeof raw === 'string' ? { method: 'GET', url: raw } : raw
  const method = (request.method ?? 'GET').toUpperCase()
  if (!HTTP_METHODS.has(method)) throw new Error(`unsupported method: ${method}`)

  const findings: ImportFinding[] = []
  const converted = createRequest({
    name: item.name ?? '(unnamed)',
    method: method as ApiRequest['method'],
    collectionId,
  })
  converted.url = normalizeUrl(request.url)
  converted.params = normalizeQuery(request.url)
  converted.headers = kvList(request.header)
  converted.body = normalizeBody(request.body, path, findings)
  const { auth, findings: authFindings } = normalizeAuth(request.auth, path)
  converted.auth = auth
  findings.push(...authFindings)

  const scripts = normalizeScripts(item, path, findings)
  if (scripts !== undefined) converted.scripts = scripts

  items.push({
    itemPath: path,
    compatibility: findings.some((finding) => finding.level === 'warn') ? 'partial' : 'full',
    findings,
  })
  return converted
}

/** Normalize 入口：doc → 内部 Collection + 逐项兼容度结果。 */
export function normalizePostmanCollection(doc: PostmanCollectionDoc): NormalizedImport {
  const collection = createCollection({ name: doc.info.name ?? 'Imported Collection' })
  const items: ImportItemResult[] = []

  if (doc.auth !== undefined) {
    const { auth, findings } = normalizeAuth(doc.auth, '(collection)')
    collection.auth = auth
    if (findings.length > 0) items.push({ itemPath: '(collection)', compatibility: 'partial', findings })
  }

  collection.variables = (doc.variable ?? [])
    .filter((variable) => typeof variable.key === 'string')
    .map((variable) => ({
      key: variable.key!,
      value: typeof variable.value === 'string' ? variable.value : '',
      enabled: variable.disabled !== true,
    }))

  const convertItems = (
    postmanItems: PostmanItem[],
    trail: string[],
  ): { folders: typeof collection.folders; requests: ApiRequest[] } => {
    const folders: typeof collection.folders = []
    const requests: ApiRequest[] = []
    for (const item of postmanItems) {
      const name = item.name ?? '(unnamed)'
      const path = [...trail, name].join('/')
      if (Array.isArray(item.item)) {
        const folder = createFolder(name)
        const children = convertItems(item.item, [...trail, name])
        folder.folders = children.folders
        folder.requests = children.requests
        folders.push(folder)
        continue
      }
      try {
        requests.push(convertRequest(item, collection.id, path, items))
      } catch (error) {
        items.push({
          itemPath: path,
          compatibility: 'unsupported',
          findings: [
            {
              itemPath: path,
              level: 'warn',
              kind: 'field-dropped',
              message: `item could not be converted: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        })
      }
    }
    return { folders, requests }
  }

  const top = convertItems(doc.item, [])
  collection.folders = top.folders
  collection.requests = top.requests
  return { collection, items }
}
