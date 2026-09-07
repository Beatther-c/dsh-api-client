// @vitest-environment node
/**
 * TC-API-01…12（§6.5）：Host API router + services 集成测试。
 *
 * 形态：真实 node http server（127.0.0.1  ephemeral port）→ router.handle，
 * 鉴权中间件走真实 socket/headers；存储根为 tmp 目录注入（createHostServices
 * 与 src/host/index.ts 同一组装点）；非 loopback / trusted-proxy 分支直接驱动
 * authenticateRequest（无法在本机伪造非 loopback socket）。
 */
import { createServer } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ApiRouter } from '../src/host/api/router.ts'
import { ApiError } from '../src/host/api/router.ts'
import { authenticateRequest } from '../src/host/api/auth.ts'
import type { HostServices } from '../src/host/index.ts'
import { createHostApiRouter, createHostServices } from '../src/host/index.ts'
import { ProfileService } from '../src/host/services/profile-service.ts'

const PLUGIN_TOKEN = 'test-plugin-token'
const TRUSTED_PROXY_TOKEN = 'test-proxy-token'
const CSRF = { 'x-dsh-api-client-request': '1' }
const SECRET_VALUE = 'super-secret-value-TC-API-03'

let tmpHome: string
let services: HostServices
let api: ApiRouter
let server: Server
let baseUrl: string

// 本地回显 server（execute 用；network policy 经 settings 放行 localhost）
let echoServer: Server
let echoBase: string

async function apiFetch(
  path: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string>; token?: string | null } = {},
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) }
  if (options.token !== null) headers.authorization = `Bearer ${options.token ?? PLUGIN_TOKEN}`
  const init: RequestInit = { method: options.method ?? 'GET', headers }
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
    init.body = JSON.stringify(options.body)
  }
  const res = await fetch(`${baseUrl}${path}`, init)
  const text = await res.text()
  let body: unknown = undefined
  if (text !== '') {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  return { status: res.status, body }
}

/** mutation 便捷形态（带 CSRF 头）。 */
function mutate(
  path: string,
  method: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  return apiFetch(path, { method, body, headers: { ...CSRF, ...(headers ?? {}) } })
}

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'dsh-api-client-host-api-'))
  const profile = ProfileService.detect({ env: { DSH_PROFILE: 'test-profile' }, home: tmpHome })
  services = createHostServices({ dshHome: tmpHome, profile })
  // 测试配置：network policy 放行 localhost（§6.5 TC-API-04 注记；默认 fail-closed 拒 localhost）。
  services.settings.patch({ networkPolicy: { allowLocalhost: true } })
  api = createHostApiRouter(services, { pluginToken: PLUGIN_TOKEN, trustedProxyToken: TRUSTED_PROXY_TOKEN })
  server = createServer((req, res) => {
    void api.handle(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  echoServer = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          method: req.method,
          url: req.url,
          body: Buffer.concat(chunks).toString('utf8'),
          headers: req.headers,
        }),
      )
    })
  })
  await new Promise<void>((resolve) => echoServer.listen(0, '127.0.0.1', resolve))
  echoBase = `http://127.0.0.1:${(echoServer.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await new Promise<void>((resolve) => echoServer.close(() => resolve()))
  rmSync(tmpHome, { recursive: true, force: true })
})

describe('TC-API-01: GET capabilities → 200，含 version/profileId', () => {
  it('返回版本、profileId 与特性开关', async () => {
    const { status, body } = await apiFetch('/api-client/capabilities')
    expect(status).toBe(200)
    const caps = body as { version: string; dshVersion: string; profileId: string; features: Record<string, unknown> }
    expect(typeof caps.version).toBe('string')
    expect(caps.profileId).toBe('test-profile')
    expect(typeof caps.dshVersion).toBe('string')
    expect(caps.features).toMatchObject({ collections: true, execute: true })
  })

  it('未匹配 API 路径返回 JSON 404（不漏进 SPA fallback）', async () => {
    const { status, body } = await apiFetch('/api-client/no-such-route')
    expect(status).toBe(404)
    expect((body as { error: { code: string } }).error.code).toBe('not-found')
  })
})

describe('TC-API-02: collection CRUD + reorder + duplicate 全端点', () => {
  let collectionId: string
  let requestIdA: string
  let requestIdB: string

  it('POST /collections 新建', async () => {
    const { status, body } = await mutate('/api-client/collections', 'POST', { name: 'tc-api-02' })
    expect(status).toBe(200)
    const collection = body as { id: string; name: string }
    expect(collection.name).toBe('tc-api-02')
    collectionId = collection.id
  })

  it('GET /collections 列表包含新 collection', async () => {
    const { status, body } = await apiFetch('/api-client/collections')
    expect(status).toBe(200)
    expect((body as Array<{ id: string }>).some((c) => c.id === collectionId)).toBe(true)
  })

  it('POST /collections/:id/requests 保存两个请求', async () => {
    const a = await mutate(`/api-client/collections/${collectionId}/requests`, 'POST', {
      name: 'req-a',
      method: 'GET',
      url: 'https://example.com/a',
    })
    expect(a.status).toBe(200)
    requestIdA = (a.body as { id: string }).id
    const b = await mutate(`/api-client/collections/${collectionId}/requests`, 'POST', {
      name: 'req-b',
      method: 'POST',
      url: 'https://example.com/b',
    })
    expect(b.status).toBe(200)
    requestIdB = (b.body as { id: string }).id
  })

  it('GET /collections/:id 返回完整树', async () => {
    const { status, body } = await apiFetch(`/api-client/collections/${collectionId}`)
    expect(status).toBe(200)
    const collection = body as { requests: Array<{ id: string }> }
    expect(collection.requests.map((r) => r.id)).toEqual([requestIdA, requestIdB])
  })

  it('POST /collections/:id/reorder 重排', async () => {
    const { status, body } = await mutate(`/api-client/collections/${collectionId}/reorder`, 'POST', {
      itemIds: [requestIdB, requestIdA],
    })
    expect(status).toBe(200)
    expect((body as { requests: Array<{ id: string }> }).requests.map((r) => r.id)).toEqual([requestIdB, requestIdA])
  })

  it('PATCH /collections/:id 重命名', async () => {
    const { status, body } = await mutate(`/api-client/collections/${collectionId}`, 'PATCH', { name: 'tc-api-02-renamed' })
    expect(status).toBe(200)
    expect((body as { name: string }).name).toBe('tc-api-02-renamed')
  })

  it('request 端点：GET/PATCH/duplicate/move/DELETE', async () => {
    const got = await apiFetch(`/api-client/requests/${requestIdA}`)
    expect(got.status).toBe(200)
    expect((got.body as { name: string }).name).toBe('req-a')

    const patched = await mutate(`/api-client/requests/${requestIdA}`, 'PATCH', { name: 'req-a2' })
    expect(patched.status).toBe(200)
    expect((patched.body as { name: string }).name).toBe('req-a2')

    const dup = await mutate(`/api-client/requests/${requestIdA}/duplicate`, 'POST')
    expect(dup.status).toBe(200)
    const dupId = (dup.body as { id: string }).id
    expect(dupId).not.toBe(requestIdA)

    const move = await mutate(`/api-client/requests/${dupId}/move`, 'POST', {})
    expect(move.status).toBe(200)

    const del = await mutate(`/api-client/requests/${dupId}`, 'DELETE')
    expect(del.status).toBe(204)
  })

  it('POST /collections/:id/duplicate 深拷贝新 id', async () => {
    const { status, body } = await mutate(`/api-client/collections/${collectionId}/duplicate`, 'POST')
    expect(status).toBe(200)
    const copy = body as { id: string; name: string; requests: Array<{ id: string }> }
    expect(copy.id).not.toBe(collectionId)
    expect(copy.name).toContain('(copy)')
    expect(copy.requests.every((r) => r.id !== requestIdA && r.id !== requestIdB)).toBe(true)
  })

  it('DELETE /collections/:id → 204，再 GET → 404', async () => {
    const del = await mutate(`/api-client/collections/${collectionId}`, 'DELETE')
    expect(del.status).toBe(204)
    const { status } = await apiFetch(`/api-client/collections/${collectionId}`)
    expect(status).toBe(404)
  })
})

describe('TC-API-03: 写 secret 后全端点无明文出口', () => {
  let environmentId: string

  it('POST /environments + PUT secret → 响应只给 secretRef 展示形态', async () => {
    const created = await mutate('/api-client/environments', 'POST', { name: 'tc-api-03-env' })
    expect(created.status).toBe(200)
    environmentId = (created.body as { id: string }).id

    const written = await mutate(`/api-client/environments/${environmentId}/secrets/api_key`, 'PUT', {
      value: SECRET_VALUE,
    })
    expect(written.status).toBe(200)
    expect(written.body).toEqual({ secretRef: '<secret-ref:api_key>' })
    expect(JSON.stringify(written.body)).not.toContain(SECRET_VALUE)
  })

  it('GET /environments 只含 <secret-ref:key> 投影', async () => {
    const { status, body } = await apiFetch('/api-client/environments')
    expect(status).toBe(200)
    const text = JSON.stringify(body)
    expect(text).toContain('<secret-ref:api_key>')
    expect(text).not.toContain(SECRET_VALUE)
  })

  it('全端点扫描无 secret value 出口', async () => {
    for (const path of [
      '/api-client/capabilities',
      '/api-client/collections',
      '/api-client/environments',
      '/api-client/history',
      '/api-client/settings',
    ]) {
      const { status, body } = await apiFetch(path)
      expect(status).toBe(200)
      expect(JSON.stringify(body)).not.toContain(SECRET_VALUE)
    }
    // 落盘侧同步断言：environments.json 不含明文（§4.2 写入纪律的正向验证）。
    const environmentsJson = readFileSync(join(tmpHome, 'api-client', 'shared', 'environments.json'), 'utf8')
    expect(environmentsJson).not.toContain(SECRET_VALUE)
    expect(environmentsJson).toContain('$ref')
    // at-rest 权限基线顺带核验（TC-S-06 同机制）：secret 文件 0600。
    const secretsDir = join(tmpHome, 'api-client', 'shared', 'secrets')
    expect(statSync(secretsDir).mode & 0o777).toBe(0o700)
  })

  it('DELETE secret → 204 且变量移除', async () => {
    const del = await mutate(`/api-client/environments/${environmentId}/secrets/api_key`, 'DELETE')
    expect(del.status).toBe(204)
    const { body } = await apiFetch('/api-client/environments')
    expect(JSON.stringify(body)).not.toContain('api_key')
  })
})

describe('TC-API-04: POST execute（临时 GET，本地 server）', () => {
  it('返回 result + historyId + requestEcho（脱敏）', async () => {
    const { status, body } = await mutate('/api-client/execute', 'POST', {
      request: { method: 'GET', url: `${echoBase}/echo?x=1` },
    })
    expect(status).toBe(200)
    const out = body as {
      result: { status: number; durationMs: number; bodyKind: string }
      historyId: string
      requestEcho: { method: string; displayUrl: string }
    }
    expect(out.result.status).toBe(200)
    expect(out.result.durationMs).toBeGreaterThan(0)
    expect(out.result.bodyKind).toBe('json')
    expect(typeof out.historyId).toBe('string')
    expect(out.requestEcho.method).toBe('GET')
    expect(out.requestEcho.displayUrl).toContain('/echo?x=1')
  })
})

describe('TC-API-05: POST execute（requestId + per-call environment）', () => {
  it('用指定环境解析执行', async () => {
    const env = await mutate('/api-client/environments', 'POST', { name: 'tc-api-05-env' })
    const envId = (env.body as { id: string }).id
    const patched = await mutate(`/api-client/environments/${envId}`, 'PATCH', {
      variables: [{ key: 'base_url', value: echoBase }],
    })
    expect(patched.status).toBe(200)

    const col = await mutate('/api-client/collections', 'POST', { name: 'tc-api-05' })
    const colId = (col.body as { id: string }).id
    const req = await mutate(`/api-client/collections/${colId}/requests`, 'POST', {
      name: 'env-request',
      method: 'GET',
      url: '{{base_url}}/echo',
    })
    const requestId = (req.body as { id: string }).id

    const { status, body } = await mutate('/api-client/execute', 'POST', { requestId, environment: envId })
    expect(status).toBe(200)
    const out = body as { result: { status: number; bodyText: string } }
    expect(out.result.status).toBe(200)
    expect(JSON.parse(out.result.bodyText) as { url: string }).toMatchObject({ url: '/echo' })
  })
})

describe('TC-API-06: history list/get/clear → 全部脱敏快照；clear 后为空', () => {
  it('list → get → clear', async () => {
    const list = await apiFetch('/api-client/history')
    expect(list.status).toBe(200)
    const entries = list.body as Array<{ id: string; source: string; requestSnapshot: unknown }>
    expect(entries.length).toBeGreaterThanOrEqual(2)
    for (const entry of entries) {
      expect(entry).toHaveProperty('requestSnapshot')
      expect(entry).toHaveProperty('responseSnapshot')
    }

    const single = await apiFetch(`/api-client/history/${entries[0]!.id}`)
    expect(single.status).toBe(200)
    expect((single.body as { id: string }).id).toBe(entries[0]!.id)

    const cleared = await mutate('/api-client/history', 'DELETE')
    expect(cleared.status).toBe(204)
    const after = await apiFetch('/api-client/history')
    expect(after.body).toEqual([])
  })
})

describe('TC-API-07: POST import/postman → ImportReport + collectionId', () => {
  it('导入成功且 collection 可读、报告可回读', async () => {
    const postman = {
      info: {
        name: 'pm-sample',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      item: [
        {
          name: 'get-users',
          request: {
            method: 'GET',
            url: { raw: 'https://api.example.com/users?page=1', query: [{ key: 'page', value: '1' }] },
            header: [{ key: 'Accept', value: 'application/json' }],
          },
        },
      ],
    }
    const { status, body } = await mutate('/api-client/import/postman', 'POST', { collection: postman })
    expect(status).toBe(200)
    const report = body as {
      id: string
      format: string
      totals: { requests: number }
      full: number
      createdCollectionId: string
    }
    expect(report.format).toBe('postman-v2.1')
    expect(report.totals.requests).toBe(1)
    expect(report.full).toBe(1)
    expect(typeof report.createdCollectionId).toBe('string')

    const collection = await apiFetch(`/api-client/collections/${report.createdCollectionId}`)
    expect(collection.status).toBe(200)
    const tree = collection.body as { name: string; requests: Array<{ name: string; url: string }> }
    expect(tree.name).toBe('pm-sample')
    expect(tree.requests[0]).toMatchObject({ name: 'get-users', url: 'https://api.example.com/users?page=1' })

    const reread = await apiFetch(`/api-client/import/reports/${report.id}`)
    expect(reread.status).toBe(200)
    expect((reread.body as { id: string }).id).toBe(report.id)
  })

  it('非法输入 → 400 且零落库', async () => {
    const before = (await apiFetch('/api-client/collections')).body as unknown[]
    const { status, body } = await mutate('/api-client/import/postman', 'POST', { collection: { hello: 'world' } })
    expect(status).toBe(400)
    expect((body as { error: { code: string } }).error.code).toBe('import-failed')
    const after = (await apiFetch('/api-client/collections')).body as unknown[]
    expect(after.length).toBe(before.length)
  })
})

describe('TC-API-08: 无 token 请求任意端点 → 401/403', () => {
  it('GET 无 token → 401；错误 token → 401', async () => {
    const noToken = await apiFetch('/api-client/capabilities', { token: null })
    expect(noToken.status).toBe(401)
    expect((noToken.body as { error: { code: string } }).error.code).toBe('missing-token')

    const wrongToken = await apiFetch('/api-client/capabilities', { token: 'wrong-token' })
    expect(wrongToken.status).toBe(401)
    expect((wrongToken.body as { error: { code: string } }).error.code).toBe('invalid-token')
  })

  it('mutation 无 token → 401', async () => {
    const { status } = await apiFetch('/api-client/collections', {
      method: 'POST',
      body: { name: 'x' },
      headers: CSRF,
      token: null,
    })
    expect(status).toBe(401)
  })
})

describe('TC-API-09: 非 loopback 无 trusted-proxy token → 拒；伪造 origin → 拒', () => {
  function stubRequest(overrides: {
    remoteAddress?: string
    headers?: Record<string, string>
    method?: string
  }): IncomingMessage {
    return {
      method: overrides.method ?? 'GET',
      headers: {
        authorization: `Bearer ${PLUGIN_TOKEN}`,
        host: '127.0.0.1:3080',
        ...(overrides.headers ?? {}),
      },
      socket: { remoteAddress: overrides.remoteAddress ?? '127.0.0.1' },
    } as unknown as IncomingMessage
  }

  it('非 loopback 无 trusted-proxy token → 403', () => {
    expect(() =>
      authenticateRequest(stubRequest({ remoteAddress: '10.0.0.5' }), { pluginToken: PLUGIN_TOKEN, trustedProxyToken: TRUSTED_PROXY_TOKEN }),
    ).toThrowError(expect.objectContaining({ status: 403, code: 'untrusted-proxy' }) as Error)
  })

  it('非 loopback + trusted-proxy token → 放行（viaProxy=true）', () => {
    const ctx = authenticateRequest(
      stubRequest({ remoteAddress: '10.0.0.5', headers: { 'x-dsh-api-client-proxy-token': TRUSTED_PROXY_TOKEN } }),
      { pluginToken: PLUGIN_TOKEN, trustedProxyToken: TRUSTED_PROXY_TOKEN },
    )
    expect(ctx.viaProxy).toBe(true)
  })

  it('伪造 origin（与 host 不一致）→ 403', async () => {
    const { status, body } = await apiFetch('/api-client/capabilities', {
      headers: { origin: 'http://evil.example.com' },
    })
    expect(status).toBe(403)
    expect((body as { error: { code: string } }).error.code).toBe('origin-mismatch')
  })

  it('Sec-Fetch-Site: cross-site → 403（loopback 也不放行）', async () => {
    const { status } = await apiFetch('/api-client/capabilities', { headers: { 'sec-fetch-site': 'cross-site' } })
    expect(status).toBe(403)
  })

  it('一致 origin 不误拒（浏览器同源形态）', async () => {
    const { status } = await apiFetch('/api-client/capabilities', {
      headers: { origin: baseUrl, 'sec-fetch-site': 'same-origin' },
    })
    expect(status).toBe(200)
  })
})

describe('TC-API-10: mutation 缺 X-Dsh-Api-Client-Request: 1 → 403', () => {
  it('POST 缺 CSRF 头 → 403；带头 → 200', async () => {
    const missing = await apiFetch('/api-client/collections', { method: 'POST', body: { name: 'csrf-test' } })
    expect(missing.status).toBe(403)
    expect((missing.body as { error: { code: string } }).error.code).toBe('missing-csrf-header')

    const present = await mutate('/api-client/collections', 'POST', { name: 'csrf-test' })
    expect(present.status).toBe(200)
  })
})

describe('TC-API-11: human/agent source identity + audit.jsonl', () => {
  it('execute 缺省 source=human；agent 通道 source=agent，audit 有对应记录', async () => {
    const human = await mutate('/api-client/execute', 'POST', {
      request: { method: 'GET', url: `${echoBase}/echo?src=human` },
    })
    expect(human.status).toBe(200)
    const humanHistoryId = (human.body as { historyId: string }).historyId

    const agent = await mutate(
      '/api-client/execute',
      'POST',
      { request: { method: 'GET', url: `${echoBase}/echo?src=agent` } },
      { 'x-dsh-api-client-source': 'agent' },
    )
    expect(agent.status).toBe(200)
    const agentHistoryId = (agent.body as { historyId: string }).historyId

    const humanEntry = await apiFetch(`/api-client/history/${humanHistoryId}`)
    expect((humanEntry.body as { source: string }).source).toBe('human')
    const agentEntry = await apiFetch(`/api-client/history/${agentHistoryId}`)
    expect((agentEntry.body as { source: string }).source).toBe('agent')

    const audit = services.audit.list()
    const humanAudit = audit.find((e) => e.historyId === humanHistoryId)
    const agentAudit = audit.find((e) => e.historyId === agentHistoryId)
    expect(humanAudit).toMatchObject({ source: 'human', outcome: 'success', host: '127.0.0.1' })
    expect(agentAudit).toMatchObject({ source: 'agent', outcome: 'success', host: '127.0.0.1' })
    expect(typeof agentAudit!.timestamp).toBe('number')
  })
})

describe('TC-API-12: settings patch 非法值 → 400 + 校验消息', () => {
  it('负数 timeout → 400 invalid-settings', async () => {
    const { status, body } = await mutate('/api-client/settings', 'PATCH', { defaultTimeoutMs: -5 })
    expect(status).toBe(400)
    const error = (body as { error: { code: string; message: string } }).error
    expect(error.code).toBe('invalid-settings')
    expect(error.message).toContain('defaultTimeoutMs')
  })

  it('非法枚举 / 未知键 → 400', async () => {
    const badEnum = await mutate('/api-client/settings', 'PATCH', { postmanCompatibility: 'loose' })
    expect(badEnum.status).toBe(400)
    const unknownKey = await mutate('/api-client/settings', 'PATCH', { noSuchSetting: 1 })
    expect(unknownKey.status).toBe(400)
  })

  it('合法 patch → 200 且深合并（networkPolicy 不被部分 patch 破坏）', async () => {
    const { status, body } = await mutate('/api-client/settings', 'PATCH', {
      defaultTimeoutMs: 5000,
      networkPolicy: { allowPrivateNetwork: true },
    })
    expect(status).toBe(200)
    const settings = body as { defaultTimeoutMs: number; networkPolicy: { allowLocalhost: boolean; allowPrivateNetwork: boolean; blockedPorts: number[] } }
    expect(settings.defaultTimeoutMs).toBe(5000)
    expect(settings.networkPolicy.allowPrivateNetwork).toBe(true)
    expect(settings.networkPolicy.allowLocalhost).toBe(true) // beforeAll 的设置仍在
    expect(Array.isArray(settings.networkPolicy.blockedPorts)).toBe(true)
  })
})

describe('探针处置回归（§3.5）', () => {
  it('探针全部退役：probes/ 目录已删除，probe-log 移至 tools/spike（internal dev tool）', () => {
    const probesDir = fileURLToPath(new URL('../src/host/probes', import.meta.url))
    expect(existsSync(probesDir)).toBe(false)
    expect(existsSync(fileURLToPath(new URL('../tools/spike/probe-log.ts', import.meta.url)))).toBe(true)
  })

  it('profile-service 保留四级探测 + fail-closed（unresolved 时 profile-scoped 写显式报错）', () => {
    const unresolved = ProfileService.detect({ env: {}, home: join(tmpHome, 'no-such-home'), config: {} })
    expect(unresolved.resolved).toBe(false)
    expect(unresolved.profileId).toBe('unresolved')
    expect(() => unresolved.assertResolved('history')).toThrowError(/profile unresolved/)
    // loader-metadata 命中路径（WP0 实测形态）：唯一 profile manifest 携带本包。
    const home = mkdtempSync(join(tmpdir(), 'dsh-api-client-profile-'))
    try {
      const profileDir = join(home, 'profiles', 'web')
      mkdirSync(profileDir, { recursive: true })
      writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dependencies: { 'dsh-api-client': 'link:..' } }))
      const detected = ProfileService.detect({ env: {}, home, config: {} })
      expect(detected.profileId).toBe('web')
      expect(detected.source).toBe('loader-metadata')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
