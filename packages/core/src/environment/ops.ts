/**
 * Environment CRUD、变量启停、SecretRef 绑定/解绑（§3.2 environment/ops）。
 * 全部纯函数：不修改入参，返回新 Environment。
 */
import type { Environment, SecretRef, Variable } from '@dsh-api-client/shared'
import { isSecretRef } from '@dsh-api-client/shared'
import { assertEnvironmentInvariant, createVariable, generateEnvironmentId } from './model.ts'

function clone(environment: Environment): Environment {
  return structuredClone(environment)
}

export function renameEnvironment(environment: Environment, name: string): Environment {
  const next = clone(environment)
  next.name = name
  return next
}

export function getVariable(environment: Environment, key: string): Variable | undefined {
  return environment.variables.find((v) => v.key === key)
}

/** 新增或替换普通（非 secret）变量；同 key secret 变量不被本函数降级。 */
export function upsertVariable(
  environment: Environment,
  key: string,
  value: string,
  options?: { enabled?: boolean; initialValue?: string },
): Environment {
  const next = clone(environment)
  const existing = next.variables.find((v) => v.key === key)
  if (existing) {
    if (existing.secret) throw new Error(`variable "${key}" is secret; use unbindSecret first`)
    existing.currentValue = value
    if (options?.enabled !== undefined) existing.enabled = options.enabled
    if (options?.initialValue !== undefined) existing.initialValue = options.initialValue
  } else {
    next.variables.push(
      createVariable({
        key,
        value,
        ...(options?.enabled !== undefined ? { enabled: options.enabled } : {}),
        ...(options?.initialValue !== undefined ? { initialValue: options.initialValue } : {}),
      }),
    )
  }
  return next
}

export function removeVariable(environment: Environment, key: string): Environment {
  const next = clone(environment)
  next.variables = next.variables.filter((v) => v.key !== key)
  return next
}

/** 变量启停（TC-C-19）：disabled 变量不参与解析。 */
export function setVariableEnabled(environment: Environment, key: string, enabled: boolean): Environment {
  const next = clone(environment)
  const variable = next.variables.find((v) => v.key === key)
  if (!variable) throw new Error(`variable not found: ${key}`)
  variable.enabled = enabled
  return next
}

/**
 * SecretRef 绑定（§4.3）：写入 secret 后由 host 把 $ref 绑到变量上；
 * 本函数只接受 SecretRef，拒绝任何明文（AC-42 正向机制）。
 */
export function bindSecret(environment: Environment, key: string, secretRef: SecretRef): Environment {
  if (!isSecretRef(secretRef)) throw new Error('bindSecret requires a SecretRef')
  const next = clone(environment)
  const existing = next.variables.find((v) => v.key === key)
  if (existing) {
    existing.currentValue = secretRef
    existing.secret = true
  } else {
    next.variables.push(createVariable({ key, secretRef }))
  }
  assertEnvironmentInvariant(next)
  return next
}

/** 解绑：secret 变量降级为普通变量（value 缺省空串；secret 文件删除由 host 负责）。 */
export function unbindSecret(environment: Environment, key: string, value = ''): Environment {
  const next = clone(environment)
  const variable = next.variables.find((v) => v.key === key)
  if (!variable) throw new Error(`variable not found: ${key}`)
  variable.currentValue = value
  variable.secret = false
  return next
}

/** Environment 级 CRUD 辅助（列表形态，纯函数）。 */
export function addEnvironment(environments: Environment[], name: string): Environment[] {
  return [...environments, { id: generateEnvironmentId(), name, variables: [] }]
}

export function deleteEnvironment(environments: Environment[], environmentId: string): Environment[] {
  return environments.filter((e) => e.id !== environmentId)
}
