/**
 * TC-C-06…09：Auth 应用（§7.5，AC-15）。
 * bearer/basic/apikey 材料可为 SecretRef——执行期注入 resolveSecret 解析，core 不碰存储。
 */
import { describe, expect, it } from 'vitest'
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
