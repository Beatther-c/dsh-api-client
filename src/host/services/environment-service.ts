/**
 * Environment service（§3.4；§4.2 写入纪律）：Environment 权威状态（shared scope）。
 *
 * - secret 变量只经 secret-store-service：本服务绝不持久化明文（§4.3）；
 * - environments.json 序列化前断言：任何 `secret === true` 的变量其 currentValue
 *   必须是 SecretRef，发现明文直接抛错拒写（§4.2，TC-S-07 的正向机制——
 *   core assertEnvironmentInvariant 在持久化边界再执行一次）；
 * - 删除 environment 级联删除其 secret 变量的 secret 文件（不留明文残留）；
 * - secret 写入端点语义：value 经 secret-store 落盘，变量绑定 SecretRef，
 *   响应只给 `<secret-ref:key>` 展示形态（§5.1 端点 19，write-only）。
 */
import type { Environment, SecretRef } from '@dsh-api-client/shared'
import { formatSecretRef, isSecretRef } from '@dsh-api-client/shared'
import type { SecretResolver } from '@dsh-api-client/core'
import {
  addEnvironment,
  assertEnvironmentInvariant,
  bindSecret,
  deleteEnvironment,
  removeVariable,
  renameEnvironment,
  setVariableEnabled,
  upsertVariable,
} from '@dsh-api-client/core'
import { FileStore } from './storage/file-store.ts'
import { DanglingSecretRefError, SecretStoreService } from './secret-store-service.ts'

export class EnvironmentNotFoundError extends Error {
  readonly code = 'environment-not-found'
  constructor(id: string) {
    super(`environment not found: ${id}`)
    this.name = 'EnvironmentNotFoundError'
  }
}

export interface PlainVariablePatch {
  key: string
  value: string
  enabled?: boolean
  initialValue?: string
}

export interface EnvironmentPatch {
  name?: string
  /** 普通（非 secret）变量 upsert 列表；secret 变量一律拒绝（走 secrets 端点）。 */
  variables?: PlainVariablePatch[]
}

export class EnvironmentService {
  private environments: Environment[]

  constructor(
    private readonly store: FileStore,
    private readonly secrets: SecretStoreService,
  ) {
    this.environments = this.store.readJson<Environment[]>(this.store.layout.environmentsFile) ?? []
  }

  /** §4.2 写入纪律：序列化前断言 secret 变量只持 SecretRef，明文抛错拒写。 */
  private persist(): void {
    for (const environment of this.environments) assertEnvironmentInvariant(environment)
    this.store.writeJson(this.store.layout.environmentsFile, this.environments)
  }

  /** 权威列表（内存对象含 SecretRef；投影由 redaction-service 负责）。 */
  list(): Environment[] {
    return this.environments
  }

  get(id: string): Environment | undefined {
    return this.environments.find((e) => e.id === id)
  }

  /** per-call environment 解析（§13.1）：先按 id，再按 name（唯一命中才算）。 */
  resolve(idOrName: string): Environment | undefined {
    const byId = this.get(idOrName)
    if (byId !== undefined) return byId
    const byName = this.environments.filter((e) => e.name === idOrName)
    return byName.length === 1 ? byName[0] : undefined
  }

  /**
   * SecretRef 解析链宿主入口（§4.3；TC-S-08/09）：
   * environment 权威态（SecretRef）→ secret-store.read → 执行期内存解析值。
   * 悬空 SecretRef（secret 文件已删）显式报错并指明 env key（不静默置空）；
   * 解析结果只存在于执行期内存，本服务不回写任何存储。
   */
  createSecretResolver(idOrName: string): SecretResolver {
    const environment = this.resolve(idOrName)
    if (environment === undefined) throw new EnvironmentNotFoundError(idOrName)
    const keyOf = (ref: SecretRef): string | undefined =>
      environment.variables.find(
        (v) => v.secret && isSecretRef(v.currentValue) && v.currentValue.$ref === ref.$ref,
      )?.key
    return (ref: SecretRef): string => {
      try {
        return this.secrets.readSecret(ref)
      } catch (error) {
        if (error instanceof DanglingSecretRefError) throw new DanglingSecretRefError(ref, keyOf(ref))
        throw error
      }
    }
  }

  create(name: string): Environment {
    this.environments = addEnvironment(this.environments, name)
    this.persist()
    return this.environments[this.environments.length - 1]!
  }

  /** 改名 / 普通变量 upsert / 变量启停；secret 变量经此路径操作一律报错。 */
  patch(id: string, patch: EnvironmentPatch): Environment {
    let environment = this.get(id)
    if (environment === undefined) throw new EnvironmentNotFoundError(id)
    if (patch.name !== undefined) environment = renameEnvironment(environment, patch.name)
    for (const variable of patch.variables ?? []) {
      const existing = environment.variables.find((v) => v.key === variable.key)
      if (existing?.secret === true) {
        throw new Error(`variable "${variable.key}" is secret; use the secrets endpoint (write-only)`)
      }
      environment = upsertVariable(environment, variable.key, variable.value, {
        ...(variable.enabled !== undefined ? { enabled: variable.enabled } : {}),
        ...(variable.initialValue !== undefined ? { initialValue: variable.initialValue } : {}),
      })
    }
    this.environments = this.environments.map((e) => (e.id === id ? environment : e))
    this.persist()
    return environment
  }

  setVariableEnabled(id: string, key: string, enabled: boolean): Environment {
    let environment = this.get(id)
    if (environment === undefined) throw new EnvironmentNotFoundError(id)
    environment = setVariableEnabled(environment, key, enabled)
    this.environments = this.environments.map((e) => (e.id === id ? environment : e))
    this.persist()
    return environment
  }

  /** 删除 environment；其 secret 变量的 secret 文件级联删除（无残留明文）。 */
  delete(id: string): void {
    const environment = this.get(id)
    if (environment === undefined) throw new EnvironmentNotFoundError(id)
    for (const variable of environment.variables) {
      if (variable.secret && isSecretRef(variable.currentValue)) {
        this.secrets.deleteSecret(variable.currentValue)
      }
    }
    this.environments = deleteEnvironment(this.environments, id)
    this.persist()
  }

  /**
   * secret 写入（§5.1 端点 19，write-only）：明文只进 secret-store；
   * 同名旧 secret 变量的 secret 文件先删后写（替换语义，不留孤儿文件）。
   * 返回 `<secret-ref:key>` 展示形态——value 永不出现在任何响应中。
   */
  writeSecret(id: string, key: string, value: string): { secretRef: string } {
    let environment = this.get(id)
    if (environment === undefined) throw new EnvironmentNotFoundError(id)
    const existing = environment.variables.find((v) => v.key === key)
    if (existing?.secret === true && isSecretRef(existing.currentValue)) {
      this.secrets.deleteSecret(existing.currentValue)
    }
    const ref: SecretRef = this.secrets.writeSecret(value)
    environment = bindSecret(environment, key, ref)
    this.environments = this.environments.map((e) => (e.id === id ? environment : e))
    this.persist()
    return { secretRef: formatSecretRef(key) }
  }

  /** secret 删除（§5.1 端点 20）：删 SecretRef 绑定（移除变量）+ secret 文件。 */
  deleteSecret(id: string, key: string): void {
    let environment = this.get(id)
    if (environment === undefined) throw new EnvironmentNotFoundError(id)
    const variable = environment.variables.find((v) => v.key === key)
    if (variable === undefined || !variable.secret) {
      throw new Error(`secret variable not found: ${key}`)
    }
    if (isSecretRef(variable.currentValue)) {
      this.secrets.deleteSecret(variable.currentValue)
    }
    environment = removeVariable(environment, key)
    this.environments = this.environments.map((e) => (e.id === id ? environment : e))
    this.persist()
  }
}
