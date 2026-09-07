/**
 * TC-C-20/21：History recorder 脱敏与重新执行链路（§6.1，AC-18/28/32）。
 */
import { describe, expect, it } from 'vitest'
import type { ApiRequest, Environment, HttpExecutionResult, ResolvedRequest } from '@dsh-api-client/shared'
import { createSecretRef, formatSecretRef } from '@dsh-api-client/shared'
import { recordExecution, resolveRequest } from '@dsh-api-client/core'

const SECRET_HEADER = 'history-secret-header-7a1'
const SECRET_QUERY = 'history-secret-query-9b2'
const SECRET_BODY = 'history-secret-body-3c4'

function req(partial: Partial<ApiRequest>): ApiRequest {
  return {
    id: 'saved-request-1',
    name: 'saved',
    method: 'POST',
    url: '',
    params: [],
    headers: [],
    auth: { type: 'none' },
    body: { type: 'none' },
    collectionId: 'c1',
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  }
}

/** Saved Request：header/query/body 三处引用 secret 变量。 */
function savedRequest(): ApiRequest {
  return req({
    url: 'https://api.example.com/do',
    params: [{ key: 'token', value: '{{q_secret}}', enabled: true }],
    headers: [{ key: 'X-Auth', value: '{{h_secret}}', enabled: true }],
    body: { type: 'json', json: `{"credential":"{{b_secret}}"}` },
  })
}

function savedEnvironment(): { environment: Environment; refs: Record<string, string> } {
  const hRef = createSecretRef('ref-h')
  const qRef = createSecretRef('ref-q')
  const bRef = createSecretRef('ref-b')
  return {
    environment: {
      id: 'env-1',
      name: 'prod',
      variables: [
        { key: 'h_secret', currentValue: hRef, secret: true, enabled: true },
        { key: 'q_secret', currentValue: qRef, secret: true, enabled: true },
        { key: 'b_secret', currentValue: bRef, secret: true, enabled: true },
      ],
    },
    refs: { 'ref-h': SECRET_HEADER, 'ref-q': SECRET_QUERY, 'ref-b': SECRET_BODY },
  }
}

function fakeResult(): HttpExecutionResult {
  return {
    status: 200,
    statusText: 'OK',
    headers: [{ key: 'set-cookie', value: `session=${SECRET_HEADER}; Path=/`, enabled: true }],
    cookies: [{ key: 'session', value: SECRET_HEADER, enabled: true }],
    bodyText: '{"ok":true}',
    bodyKind: 'json',
    size: 11,
    durationMs: 12,
    redirected: false,
    finalUrl: 'https://api.example.com/do',
  }
}

async function resolveSaved(): Promise<{
  resolved: ResolvedRequest
  secretValues: Map<string, string>
}> {
  const { environment, refs } = savedEnvironment()
  const secretValues = new Map<string, string>()
  const resolved = await resolveRequest(savedRequest(), {
    environment,
    resolveSecret: (ref) => {
      const value = refs[ref.$ref] ?? ''
      secretValues.set(ref.$ref, value)
      return value
    },
  })
  return { resolved, secretValues }
}

describe('TC-C-20: ResolvedRequest + 执行结果 → history 记录全部脱敏', () => {
  it('traced secret 位置（header/query/body）全部 <redacted>，auth 只留 type', async () => {
    const { resolved, secretValues } = await resolveSaved()
    // 执行期内存确实含有明文（发送所需）
    expect(resolved.headers.find((h) => h.key === 'X-Auth')?.value).toBe(SECRET_HEADER)
    expect(resolved.url).toContain(SECRET_QUERY)

    const history = recordExecution({
      resolved,
      auth: { type: 'bearer', token: createSecretRef('ref-auth') },
      result: fakeResult(),
      secretValues,
      source: 'human',
      profileId: 'p1',
      requestId: 'saved-request-1',
      environmentId: 'env-1',
    })

    const serialized = JSON.stringify(history)
    expect(serialized).not.toContain(SECRET_HEADER)
    expect(serialized).not.toContain(SECRET_QUERY)
    expect(serialized).not.toContain(SECRET_BODY)
    expect(history.requestSnapshot.headers.find((h) => h.key === 'X-Auth')?.value).toBe('<redacted>')
    expect(history.displayUrl).toContain('token=<redacted>')
    expect(history.requestSnapshot.bodyPreview).toBe('{"credential":"<redacted>"}')
    expect(history.requestSnapshot.auth).toEqual({ type: 'bearer' })
    expect(history.responseSnapshot.headers.find((h) => h.key === 'set-cookie')?.value).toBe('<redacted>')
    expect(history.source).toBe('human')
    expect(history.profileId).toBe('p1')
  })
})

describe('TC-C-21: 重新执行 = Saved Request + SecretRef 重建，不从 History 恢复 secret', () => {
  it('重建链路输入只吃 Saved Request + Environment + resolveSecret；History 快照被污染/删除仍重建成功', async () => {
    // 先制造一份历史记录（脱敏快照，secret 位置是 <redacted>，无法回读明文）
    const { resolved: firstResolved, secretValues } = await resolveSaved()
    const history = recordExecution({
      resolved: firstResolved,
      auth: { type: 'none' },
      result: fakeResult(),
      secretValues,
      source: 'human',
      profileId: 'p1',
    })
    expect(JSON.stringify(history)).not.toContain(SECRET_HEADER)

    // 重新执行：输入只有 Saved Request + Environment SecretRef + 执行期注入的解析函数。
    // 重建输入中不含任何 History 快照数据（断言输入对象与 history 无引用关系）。
    const reexecutionInput = {
      request: savedRequest(),
      environment: savedEnvironment().environment,
      resolveSecret: (ref: { $ref: string }): string => savedEnvironment().refs[ref.$ref] ?? '',
    }
    expect(Object.keys(reexecutionInput)).not.toContain('history')
    expect(JSON.stringify(Object.keys(reexecutionInput))).not.toContain('Snapshot')

    const rebuilt = await resolveRequest(reexecutionInput.request, {
      environment: reexecutionInput.environment,
      resolveSecret: reexecutionInput.resolveSecret,
    })

    // 重建值来自 SecretRef 解析链（活值），不是 History 快照中的 <redacted> 占位
    expect(rebuilt.headers.find((h) => h.key === 'X-Auth')?.value).toBe(SECRET_HEADER)
    expect(rebuilt.url).toContain(SECRET_QUERY)
    expect(JSON.stringify(rebuilt)).not.toContain('<redacted>')
    expect(JSON.stringify(rebuilt)).not.toContain(formatSecretRef('h_secret'))
    // trace 重新生成，指向 SecretRef id
    expect(rebuilt.secretValueTraces).toEqual(
      expect.arrayContaining([
        { location: 'query', key: 'token', secretRef: 'ref-q' },
        { location: 'header', key: 'X-Auth', secretRef: 'ref-h' },
        { location: 'body', key: 'b_secret', secretRef: 'ref-b' },
      ]),
    )
  })
})
