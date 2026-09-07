/**
 * 变量解析（§3.2 variables/resolver；§7.2 优先级链 Local > Environment > Collection）。
 *
 * - 未定义变量显式报错并列出变量名（TC-C-03），不静默置空；
 * - disabled 变量不参与解析（落到下一层，或报未定义）；
 * - secret 变量（currentValue 为 SecretRef）经调用方注入的 resolveSecret 解析——
 *   core 不碰存储（§4.3：secret-store 是唯一出口，由 host 注入）；
 * - 输出 ResolvedRequest 且带 secretValueTraces（location/key/secretRef），供 redactor。
 */
import type {
  ApiRequest,
  BodyConfig,
  CollectionVariable,
  Environment,
  KeyValue,
  ResolvedRequest,
  SecretRef,
  SecretTrace,
} from '@dsh-api-client/shared'
import { isSecretRef } from '@dsh-api-client/shared'
import { extractVariables, replaceVariables } from './parser.ts'
import { buildHeaders, buildUrl } from '../request/build.ts'
import { serializeBody } from '../request/body.ts'

/** 执行期由调用方注入的 secret 解析函数（core 不接触存储）。 */
export type SecretResolver = (ref: SecretRef) => string | Promise<string>

export interface ResolutionContext {
  /** Local 层（最高优先级，如 per-call 覆盖）。 */
  local?: Record<string, string>
  /** Environment 层。 */
  environment?: Environment
  /** Collection 层（最低优先级）。 */
  collectionVariables?: CollectionVariable[]
  resolveSecret?: SecretResolver
}

/** TC-C-03：未定义变量显式报错，变量名全列出。 */
export class UnresolvedVariablesError extends Error {
  readonly variables: string[]

  constructor(variables: string[]) {
    super(`unresolved variable(s): ${variables.join(', ')}`)
    this.name = 'UnresolvedVariablesError'
    this.variables = variables
  }
}

interface LookupHit {
  value: string
  secretRefId?: string
}

class TemplateResolver {
  private readonly missing = new Set<string>()
  readonly traces: SecretTrace[] = []

  constructor(private readonly ctx: ResolutionContext) {}

  /** 优先级链：Local > Environment > Collection（§7.2，TC-C-02）。 */
  private async lookup(name: string): Promise<LookupHit | undefined> {
    const { local, environment, collectionVariables, resolveSecret } = this.ctx
    if (local !== undefined && Object.hasOwn(local, name)) {
      return { value: local[name] ?? '' }
    }
    const envVar = environment?.variables.find((v) => v.key === name && v.enabled)
    if (envVar) {
      if (isSecretRef(envVar.currentValue)) {
        if (!resolveSecret) {
          throw new Error(`secret variable "${name}" needs an injected resolveSecret`)
        }
        const value = await resolveSecret(envVar.currentValue)
        return { value, secretRefId: envVar.currentValue.$ref }
      }
      return { value: envVar.currentValue }
    }
    const collectionVar = collectionVariables?.find((v) => v.key === name && v.enabled)
    if (collectionVar) return { value: collectionVar.value }
    return undefined
  }

  async resolveTemplate(
    template: string,
    location: SecretTrace['location'],
    traceKey: (variableName: string) => string,
  ): Promise<string> {
    const values = new Map<string, string>()
    for (const name of extractVariables(template)) {
      const hit = await this.lookup(name)
      if (!hit) {
        this.missing.add(name)
        continue
      }
      values.set(name, hit.value)
      if (hit.secretRefId !== undefined) {
        this.traces.push({ location, key: traceKey(name), secretRef: hit.secretRefId })
      }
    }
    return replaceVariables(template, (name) => values.get(name))
  }

  get missingVariables(): string[] {
    return [...this.missing]
  }
}

async function resolveKeyValues(
  resolver: TemplateResolver,
  rows: KeyValue[],
  location: SecretTrace['location'],
): Promise<KeyValue[]> {
  const out: KeyValue[] = []
  for (const row of rows) {
    if (!row.enabled) {
      out.push(row)
      continue
    }
    const key = await resolver.resolveTemplate(row.key, location, () => row.key)
    const value = await resolver.resolveTemplate(row.value, location, () => row.key)
    out.push({ ...row, key, value })
  }
  return out
}

async function resolveBody(resolver: TemplateResolver, body: BodyConfig): Promise<BodyConfig> {
  switch (body.type) {
    case 'none':
      return body
    case 'raw':
      return { type: 'raw', raw: await resolver.resolveTemplate(body.raw, 'body', (name) => name) }
    case 'json':
      return { type: 'json', json: await resolver.resolveTemplate(body.json, 'body', (name) => name) }
    case 'form-data':
      return { type: 'form-data', fields: await resolveKeyValues(resolver, body.fields, 'body') }
    case 'urlencoded':
      return { type: 'urlencoded', fields: await resolveKeyValues(resolver, body.fields, 'body') }
  }
}

export interface ResolveRequestOptions {
  /** 透传给 form-data 序列化（测试注入固定 boundary）。 */
  boundary?: string
}

/**
 * 解析请求：URL / params / headers / body 中的 {{var}} 全部解析，
 * params 合并进 URL（buildUrl 语义），自动 Content-Type / Accept。
 * secret 来源位置记入 secretValueTraces（供 redactor）。
 */
export async function resolveRequest(
  request: ApiRequest,
  ctx: ResolutionContext,
  options?: ResolveRequestOptions,
): Promise<ResolvedRequest> {
  const resolver = new TemplateResolver(ctx)

  const url = await resolver.resolveTemplate(request.url, 'url', (name) => name)
  const params = await resolveKeyValues(resolver, request.params, 'query')
  const headers = await resolveKeyValues(resolver, request.headers, 'header')
  const bodyConfig = await resolveBody(resolver, request.body)

  if (resolver.missingVariables.length > 0) {
    throw new UnresolvedVariablesError(resolver.missingVariables)
  }

  const serialized = serializeBody(bodyConfig, options?.boundary !== undefined ? { boundary: options.boundary } : {})

  return {
    method: request.method,
    url: buildUrl(url, params),
    headers: buildHeaders(headers, serialized.contentType),
    ...(serialized.data !== undefined ? { body: serialized.data } : {}),
    secretValueTraces: resolver.traces,
  }
}
