/**
 * TC-C-06…09：Auth 应用（§7.5，AC-15）。
 * bearer/basic/apikey 材料可为 SecretRef——执行期注入 resolveSecret 解析，core 不碰存储。
 */
import { describe, expect, it, vi } from 'vitest'
import type { ApiRequest, Collection, ResolvedRequest } from '@dsh-api-client/shared'
import { createSecretRef } from '@dsh-api-client/shared'
import { applyAuth, resolveInheritedAuth } from '@dsh-api-client/core'

function baseResolved(): ResolvedRequest {
  return {
    method: 'GET',
    url: 'https://api.example.com/users',
    headers: [],
    secretValueTraces: [],
  }
}

function req(auth: ApiRequest['auth']): ApiRequest {
  return {
    id: 'r1',
    name: 'r',
    method: 'GET',
    url: 'https://api.example.com/users',
    params: [],
    headers: [],
    auth,
    body: { type: 'none' },
    collectionId: 'c1',
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('TC-C-06: Bearer auth', () => {
  it('明文 token → Authorization: Bearer <token>，无 trace', async () => {
    const out = await applyAuth({ type: 'bearer', token: 'tok-123' }, baseResolved())
    expect(out.headers).toContainEqual({ key: 'Authorization', value: 'Bearer tok-123', enabled: true })
    expect(out.secretValueTraces).toEqual([])
  })

  it('SecretRef token → 执行期解析 + trace 记录来源（location/key/secretRef）', async () => {
    const ref = createSecretRef('bearer-secret-id')
    const out = await applyAuth(
      { type: 'bearer', token: ref },
      baseResolved(),
      { resolveSecret: () => 's3cr3t-bearer-token' },
    )
    expect(out.headers).toContainEqual({
      key: 'Authorization',
      value: 'Bearer s3cr3t-bearer-token',
      enabled: true,
    })
    expect(out.secretValueTraces).toEqual([{ location: 'auth', key: 'token', secretRef: 'bearer-secret-id' }])
  })
})

describe('TC-C-07: Basic auth', () => {
  it('Authorization: Basic base64(user:pass)', async () => {
    const out = await applyAuth({ type: 'basic', username: 'alice', password: 'wonderland' }, baseResolved())
    const expected = `Basic ${Buffer.from('alice:wonderland', 'utf8').toString('base64')}`
    expect(out.headers).toContainEqual({ key: 'Authorization', value: expected, enabled: true })
  })

  it('SecretRef password → 执行期解析参与 base64 + trace', async () => {
    const ref = createSecretRef('basic-secret-id')
    const out = await applyAuth(
      { type: 'basic', username: 'bob', password: ref },
      baseResolved(),
      { resolveSecret: () => 'p@ss' },
    )
    const expected = `Basic ${Buffer.from('bob:p@ss', 'utf8').toString('base64')}`
    expect(out.headers).toContainEqual({ key: 'Authorization', value: expected, enabled: true })
    expect(out.secretValueTraces).toEqual([{ location: 'auth', key: 'password', secretRef: 'basic-secret-id' }])
  })
})

describe('TC-C-08: API Key auth', () => {
  it('in header → 落到指定 header', async () => {
    const out = await applyAuth({ type: 'apikey', key: 'X-API-Key', value: 'k-1', in: 'header' }, baseResolved())
    expect(out.headers).toContainEqual({ key: 'X-API-Key', value: 'k-1', enabled: true })
    expect(out.url).toBe('https://api.example.com/users')
  })

  it('in query → 落到 URL query（编码正确），header 不变', async () => {
    const out = await applyAuth(
      { type: 'apikey', key: 'api_key', value: 'k 2', in: 'query' },
      baseResolved(),
    )
    expect(out.url).toBe('https://api.example.com/users?api_key=k%202')
    expect(out.headers).toEqual([])
  })

  it('SecretRef value → 执行期解析 + trace', async () => {
    const ref = createSecretRef('apikey-secret-id')
    const out = await applyAuth(
      { type: 'apikey', key: 'X-API-Key', value: ref, in: 'header' },
      baseResolved(),
      { resolveSecret: () => 'resolved-api-key' },
    )
    expect(out.headers).toContainEqual({ key: 'X-API-Key', value: 'resolved-api-key', enabled: true })
    expect(out.secretValueTraces).toEqual([{ location: 'auth', key: 'X-API-Key', secretRef: 'apikey-secret-id' }])
  })
})

describe('TC-C-09: Inherit Auth From Parent', () => {
  const collection: Collection = {
    id: 'c1',
    name: 'c',
    auth: { type: 'bearer', token: 'collection-token' },
    variables: [],
    folders: [{ id: 'f1', name: 'folder', folders: [], requests: [] }],
    requests: [],
    createdAt: 0,
    updatedAt: 0,
  }

  it('folder 无 auth、collection 有 bearer → 应用 collection 的 bearer', async () => {
    const request = req({ type: 'inherit' })
    request.folderId = 'f1'
    const effective = resolveInheritedAuth(request, collection)
    expect(effective).toEqual({ type: 'bearer', token: 'collection-token' })
    const out = await applyAuth(effective, baseResolved())
    expect(out.headers).toContainEqual({
      key: 'Authorization',
      value: 'Bearer collection-token',
      enabled: true,
    })
  })

  it('collection 也无 auth → 退化为 none；非 inherit 原样返回', () => {
    const noAuth: Collection = { ...collection, auth: undefined }
    expect(resolveInheritedAuth(req({ type: 'inherit' }), noAuth)).toEqual({ type: 'none' })
    expect(resolveInheritedAuth(req({ type: 'bearer', token: 't' }), collection)).toEqual({
      type: 'bearer',
      token: 't',
    })
  })
})

describe('R-03 追加（orchestrator 授权）：applyAuth 惰性 materialize——被覆盖路径零解析、零 trace', () => {
  it('enabled 用户同名 Header/Query → resolveSecret 零调用；失效 SecretRef 不再反向阻断', async () => {
    const failing = vi.fn((): string => {
      throw new Error('dangling secret ref (must never be resolved)')
    })
    // Header 位：用户 enabled authorization（大小写不同拼写）覆盖 Bearer 贡献
    const headerOut = await applyAuth(
      { type: 'bearer', token: createSecretRef('apply-r03-dead') },
      {
        method: 'GET',
        url: 'https://api.example.com/users',
        headers: [{ key: 'authorization', value: 'Bearer user-wins', enabled: true }],
        secretValueTraces: [],
      },
      { resolveSecret: failing },
    )
    expect(failing).not.toHaveBeenCalled()
    expect(headerOut.headers.filter((h) => h.key.toLowerCase() === 'authorization')).toEqual([
      { key: 'authorization', value: 'Bearer user-wins', enabled: true },
    ])
    expect(headerOut.secretValueTraces).toEqual([])

    // Query 位：URL 已有 enabled 同名 api_key 参数覆盖 apikey-in-query 贡献
    const queryOut = await applyAuth(
      { type: 'apikey', key: 'api_key', value: createSecretRef('apply-r03-q-dead'), in: 'query' },
      {
        method: 'GET',
        url: 'https://api.example.com/users?api_key=inline',
        headers: [],
        secretValueTraces: [],
      },
      { resolveSecret: failing },
    )
    expect(failing).not.toHaveBeenCalled()
    expect(queryOut.url).toBe('https://api.example.com/users?api_key=inline')
    expect(queryOut.secretValueTraces).toEqual([])
  })

  it('disabled 用户行 → 不构成覆盖，SecretRef 正常解析并记 trace', async () => {
    const resolveSecret = vi.fn(() => 'lazy-bearer-token')
    const out = await applyAuth(
      { type: 'bearer', token: createSecretRef('apply-r03-live') },
      {
        method: 'GET',
        url: 'https://api.example.com/users',
        headers: [{ key: 'Authorization', value: 'Bearer off', enabled: false }],
        secretValueTraces: [],
      },
      { resolveSecret },
    )
    expect(resolveSecret).toHaveBeenCalledTimes(1)
    expect(out.headers).toContainEqual({ key: 'Authorization', value: 'Bearer lazy-bearer-token', enabled: true })
    expect(out.secretValueTraces).toEqual([{ location: 'auth', key: 'token', secretRef: 'apply-r03-live' }])
  })
})
