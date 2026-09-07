/**
 * Auth 应用（§7.5，§3.2 auth/apply）：
 * Bearer / Basic（base64）/ API Key（header 或 query）/ Inherit Auth From Parent。
 *
 * bearer token、basic password、apikey value 可为 SecretRef——执行期由调用方
 * 注入 resolveSecret 解析（core 不碰存储），解析来源记入 secretValueTraces（location 'auth'）。
 */
import type { ApiRequest, AuthConfig, Collection, ResolvedRequest, SecretRef, SecretTrace } from '@dsh-api-client/shared'
import { isSecretRef } from '@dsh-api-client/shared'
import type { SecretResolver } from '../variables/resolver.ts'
import { buildUrl } from '../request/build.ts'

export interface ApplyAuthDeps {
  resolveSecret?: SecretResolver
}

function toBase64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}

async function resolveMaterial(
  material: string | SecretRef,
  deps: ApplyAuthDeps | undefined,
  trace: Omit<SecretTrace, 'secretRef'>,
): Promise<{ value: string; trace?: SecretTrace }> {
  if (!isSecretRef(material)) return { value: material }
  if (!deps?.resolveSecret) {
    throw new Error(`auth material "${trace.key}" is a SecretRef; an injected resolveSecret is required`)
  }
  const value = await deps.resolveSecret(material)
  return { value, trace: { ...trace, secretRef: material.$ref } }
}

/**
 * 把（已解析 inherit 链的）AuthConfig 应用到 ResolvedRequest：
 * 返回新对象，headers/url 落定，secret 来源追加到 secretValueTraces。
 * 注意：调用前必须经 resolveInheritedAuth 消解 'inherit'。
 */
export async function applyAuth(
  auth: AuthConfig,
  resolved: ResolvedRequest,
  deps?: ApplyAuthDeps,
): Promise<ResolvedRequest> {
  const headers = [...resolved.headers]
  const traces = [...resolved.secretValueTraces]
  let url = resolved.url

  switch (auth.type) {
    case 'none':
      break
    case 'inherit':
      throw new Error('resolve the inherit chain (resolveInheritedAuth) before applyAuth')
    case 'bearer': {
      const { value, trace } = await resolveMaterial(auth.token, deps, { location: 'auth', key: 'token' })
      if (trace) traces.push(trace)
      headers.push({ key: 'Authorization', value: `Bearer ${value}`, enabled: true })
      break
    }
    case 'basic': {
      const { value: password, trace } = await resolveMaterial(auth.password, deps, {
        location: 'auth',
        key: 'password',
      })
      if (trace) traces.push(trace)
      headers.push({
        key: 'Authorization',
        value: `Basic ${toBase64(`${auth.username}:${password}`)}`,
        enabled: true,
      })
      break
    }
    case 'apikey': {
      const { value, trace } = await resolveMaterial(auth.value, deps, { location: 'auth', key: auth.key })
      if (trace) traces.push(trace)
      if (auth.in === 'header') {
        headers.push({ key: auth.key, value, enabled: true })
      } else {
        url = buildUrl(url, [{ key: auth.key, value, enabled: true }])
      }
      break
    }
  }

  return { ...resolved, url, headers, secretValueTraces: traces }
}

/**
 * Inherit Auth From Parent：folder → collection 链向上查找（TC-C-09）。
 * V0.1 模型中 Folder 无 auth 字段（§4.1 冻结），链上唯一可提供 auth 的
 * 父级是 collection；folder 无 auth 时落到 collection.auth，再无则 none。
 */
export function resolveInheritedAuth(request: ApiRequest, collection?: Collection): AuthConfig {
  if (request.auth.type !== 'inherit') return request.auth
  if (collection?.auth !== undefined) return collection.auth
  return { type: 'none' }
}
