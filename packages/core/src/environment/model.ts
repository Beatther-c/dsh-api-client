/**
 * Environment / Variable 模型（§3.2 environment/model）。
 * secret 变量 currentValue 只持 SecretRef，明文绝不进入本结构（AC-42）。
 */
import type { Environment, SecretRef, Variable } from '@dsh-api-client/shared'
import { isSecretRef } from '@dsh-api-client/shared'

export function generateEnvironmentId(): string {
  return crypto.randomUUID()
}

export function createEnvironment(name: string): Environment {
  return { id: generateEnvironmentId(), name, variables: [] }
}

export interface CreateVariableInput {
  key: string
  value?: string
  secretRef?: SecretRef
  initialValue?: string
  enabled?: boolean
}

/**
 * 创建变量：传 secretRef 即 secret 变量（currentValue 只持 SecretRef）；
 * 否则为普通变量（currentValue 为明文非敏感值）。
 */
export function createVariable(input: CreateVariableInput): Variable {
  return {
    key: input.key,
    ...(input.initialValue !== undefined ? { initialValue: input.initialValue } : {}),
    currentValue: input.secretRef ?? input.value ?? '',
    secret: input.secretRef !== undefined,
    enabled: input.enabled ?? true,
  }
}

/** 模型不变量：secret=true ⇔ currentValue 为 SecretRef（AC-42 的模型侧断言）。 */
export function assertVariableInvariant(variable: Variable): void {
  if (variable.secret && !isSecretRef(variable.currentValue)) {
    throw new Error(`secret variable "${variable.key}" must hold a SecretRef, got plaintext`)
  }
}

export function assertEnvironmentInvariant(environment: Environment): void {
  for (const variable of environment.variables) assertVariableInvariant(variable)
}
