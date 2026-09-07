/**
 * Redaction service（§3.4；§24.2）：core redactor 的服务化封装——
 * History / API 响应 / Agent Context / Import Report / Error / Logs 的统一出域出口。
 *
 * 投影纪律（§5.1 公共契约）：
 * - environment 投影：secret 变量 currentValue → `<secret-ref:envKey>`（core projectEnvironment）；
 * - auth 投影：bearer token / basic password / apikey value → `<redacted>`；
 *   材料为 SecretRef 时保留 `$ref` 形态（不透明 id，不编码明文）；
 * - 错误消息出场前过 redactText（§24.2 Error Message 面）。
 */
import type { ApiRequest, AuthConfig, Collection, Environment, Folder, SecretRef } from '@dsh-api-client/shared'
import { isSecretRef } from '@dsh-api-client/shared'
import type { RedactionContext } from '@dsh-api-client/core'
import { REDACTED, projectEnvironment, redactText } from '@dsh-api-client/core'

export class RedactionService {
  /** 通用文本脱敏（Logs / Error / Import Report / dump 出口，TC-R-12 钩子）。 */
  redactText(text: string, ctx?: RedactionContext): string {
    return redactText(text, ctx)
  }

  /** 错误消息出场出口：非 Error 值先字符串化，再脱敏。 */
  errorMessage(error: unknown, ctx?: RedactionContext): string {
    const message = error instanceof Error ? error.message : String(error)
    return redactText(message, ctx)
  }

  /** Environment 投影：secret 变量只出 `<secret-ref:envKey>`（TC-R-08 / TC-API-03）。 */
  projectEnvironment(environment: Environment): Environment {
    return projectEnvironment(environment)
  }

  projectEnvironments(environments: Environment[]): Environment[] {
    return environments.map((e) => this.projectEnvironment(e))
  }

  /** Auth 投影：保留 type 与非敏感字段，敏感材料 → `<redacted>`；SecretRef 材料原样保留。 */
  projectAuth(auth: AuthConfig): AuthConfig {
    switch (auth.type) {
      case 'none':
      case 'inherit':
        return auth
      case 'bearer':
        return { type: 'bearer', token: this.projectMaterial(auth.token) }
      case 'basic':
        return { type: 'basic', username: auth.username, password: this.projectMaterial(auth.password) }
      case 'apikey':
        return { type: 'apikey', key: auth.key, value: this.projectMaterial(auth.value), in: auth.in }
    }
  }

  private projectMaterial(material: string | SecretRef): string | SecretRef {
    return isSecretRef(material) ? material : REDACTED
  }

  /** ApiRequest 投影：auth 材料脱敏，其余字段原样。 */
  projectRequest(request: ApiRequest): ApiRequest {
    return { ...request, auth: this.projectAuth(request.auth) }
  }

  /** Collection 投影：collection/folder/request 三层 auth 全部脱敏（深拷贝投影，不改原对象）。 */
  projectCollection(collection: Collection): Collection {
    const projectFolder = (folder: Folder): Folder => ({
      ...folder,
      folders: folder.folders.map(projectFolder),
      requests: folder.requests.map((r) => this.projectRequest(r)),
    })
    return {
      ...collection,
      ...(collection.auth !== undefined ? { auth: this.projectAuth(collection.auth) } : {}),
      folders: collection.folders.map(projectFolder),
      requests: collection.requests.map((r) => this.projectRequest(r)),
    }
  }

  projectCollections(collections: Collection[]): Collection[] {
    return collections.map((c) => this.projectCollection(c))
  }
}
