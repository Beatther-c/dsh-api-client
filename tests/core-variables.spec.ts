/**
 * TC-C-01…05：变量解析与 params 边界（§6.1，AC-14/AC-11）。
 * 解析链：Local > Environment > Collection（§7.2）；未定义变量显式报错（TC-C-03）。
 */
import { describe, expect, it } from 'vitest'
import type { ApiRequest, CollectionVariable, Environment } from '@dsh-api-client/shared'
import { createSecretRef } from '@dsh-api-client/shared'
import { UnresolvedVariablesError, extractVariables, resolveRequest } from '@dsh-api-client/core'

function req(partial: Partial<ApiRequest>): ApiRequest {
  return {
    id: 'r1',
    name: 'r',
    method: 'GET',
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

function env(variables: Environment['variables']): Environment {
  return { id: 'e1', name: 'dev', variables }
}

describe('variables parser', () => {
  it('extractVariables: 去重并保持出现顺序，允许花括号内空白', () => {
    expect(extractVariables('{{base_url}}/users/{{ id }}/{{base_url}}/{{  token  }}')).toEqual([
      'base_url',
      'id',
      'token',
    ])
  })
})

describe('TC-C-01…03：变量解析与优先级链', () => {
  it('TC-C-01: URL {{base_url}}/users + Environment base_url → 解析为环境值', async () => {
    const resolved = await resolveRequest(req({ url: '{{base_url}}/users' }), {
      environment: env([
        { key: 'base_url', currentValue: 'https://api.example.com', secret: false, enabled: true },
      ]),
    })
    expect(resolved.url).toBe('https://api.example.com/users')
    expect(resolved.secretValueTraces).toEqual([])
  })

  it('TC-C-02: 同名变量三层共存 → Local > Environment > Collection', async () => {
    const collectionVariables: CollectionVariable[] = [{ key: 'host', value: 'collection', enabled: true }]
    const environment = env([{ key: 'host', currentValue: 'environment', secret: false, enabled: true }])

    const fromLocal = await resolveRequest(req({ url: 'https://{{host}}/x' }), {
      local: { host: 'local' },
      environment,
      collectionVariables,
    })
    expect(fromLocal.url).toBe('https://local/x')

    const fromEnvironment = await resolveRequest(req({ url: 'https://{{host}}/x' }), {
      environment,
      collectionVariables,
    })
    expect(fromEnvironment.url).toBe('https://environment/x')

    const fromCollection = await resolveRequest(req({ url: 'https://{{host}}/x' }), {
      collectionVariables,
    })
    expect(fromCollection.url).toBe('https://collection/x')
  })

  it('TC-C-02 补充: disabled 变量不参与解析，落到下一层', async () => {
    const resolved = await resolveRequest(req({ url: 'https://{{host}}/x' }), {
      environment: env([{ key: 'host', currentValue: 'environment', secret: false, enabled: false }]),
      collectionVariables: [{ key: 'host', value: 'collection', enabled: true }],
    })
    expect(resolved.url).toBe('https://collection/x')
  })

  it('TC-C-03: 引用未定义变量 → 显式报错并列出变量名，不静默置空', async () => {
    const failure = await resolveRequest(
      req({
        url: '{{base_url}}/users',
        headers: [{ key: 'X-Token', value: '{{missing_token}}', enabled: true }],
      }),
      {},
    ).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(UnresolvedVariablesError)
    const unresolved = failure as UnresolvedVariablesError
    expect(unresolved.variables).toEqual(expect.arrayContaining(['base_url', 'missing_token']))
    expect(unresolved.message).toContain('base_url')
    expect(unresolved.message).toContain('missing_token')
  })

  it('TC-C-03 补充: secret 变量解析来源记入 secretValueTraces（location/key/secretRef）', async () => {
    const ref = createSecretRef('secret-id-1')
    const resolved = await resolveRequest(
      req({ headers: [{ key: 'X-Api-Key', value: '{{api_key}}', enabled: true }] }),
      {
        environment: env([{ key: 'api_key', currentValue: ref, secret: true, enabled: true }]),
        resolveSecret: (r) => `resolved:${r.$ref}`,
      },
    )
    expect(resolved.headers.find((h) => h.key === 'X-Api-Key')?.value).toBe('resolved:secret-id-1')
    expect(resolved.secretValueTraces).toEqual([{ location: 'header', key: 'X-Api-Key', secretRef: 'secret-id-1' }])
  })
})

describe('TC-C-04/05（variables 角度）：params 随解析进 URL 的边界语义', () => {
  it('TC-C-04: 重复 key 全保留、空值保留 k=、特殊字符百分号编码、disabled 不进 URL', async () => {
    const resolved = await resolveRequest(
      req({
        url: 'https://api.example.com/search',
        params: [
          { key: 'tag', value: 'a', enabled: true },
          { key: 'tag', value: 'b', enabled: true },
          { key: 'empty', value: '', enabled: true },
          { key: 'weird', value: 'a b&c=100%', enabled: true },
          { key: 'off', value: 'x', enabled: false },
          { key: 'templated', value: '{{v}}', enabled: true },
        ],
      }),
      { local: { v: 'ok' } },
    )
    const query = resolved.url.split('?')[1]
    expect(query).toBe('tag=a&tag=b&empty=&weird=a%20b%26c%3D100%25&templated=ok')
    expect(resolved.url).not.toContain('off=')
  })

  it('TC-C-05: URL ↔ Params 双向同步互逆（经 urlToParams/paramsToUrl）', async () => {
    const { urlToParams, paramsToUrl } = await import('@dsh-api-client/core')
    const url = 'https://api.example.com/s?tag=a&tag=b&empty=&q=%E4%B8%AD#frag'
    const params = urlToParams(url)
    expect(params).toEqual([
      { key: 'tag', value: 'a', enabled: true },
      { key: 'tag', value: 'b', enabled: true },
      { key: 'empty', value: '', enabled: true },
      { key: 'q', value: '中', enabled: true },
    ])
    // 表格 → URL 互逆（含 hash 保留）
    expect(paramsToUrl(url, params)).toBe(url)
    // URL → 表格 → URL 再 → 表格：双向均互逆
    expect(urlToParams(paramsToUrl(url, params))).toEqual(params)
  })
})
