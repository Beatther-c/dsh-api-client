// @vitest-environment node
/**
 * TC-C-11…17：executor 对本地 node http 回显 server（§6.1，AC-11/12/13/34）。
 * 策略：allowLocalhost=true（默认 fail-closed 策略会拒 localhost，见 TC-SEC-01…07/WP8）。
 */
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ApiRequest, NetworkPolicy } from '@dsh-api-client/shared'
import { createSecretRef } from '@dsh-api-client/shared'
import { DEFAULT_NETWORK_POLICY, ExecutorError, executeRequest, prettyBody } from '@dsh-api-client/core'
import type { PolicyTarget } from '@dsh-api-client/core'

let server: Server
let baseUrl: string
let lastRequest: { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string }

const LARGE_BODY = 'x'.repeat(256 * 1024)

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      lastRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }
      const path = (req.url ?? '').split('?')[0]
      switch (path) {
        case '/echo':
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ method: lastRequest.method, url: lastRequest.url, body: lastRequest.body }))
          return
        case '/head':
          res.writeHead(200, { 'content-type': 'text/plain' })
          res.end()
          return
        case '/slow':
          setTimeout(() => {
            res.writeHead(200, { 'content-type': 'text/plain' })
            res.end('slow-ok')
          }, 300)
          return
        case '/large':
          res.writeHead(200, { 'content-type': 'text/plain' })
          res.end(LARGE_BODY)
          return
        case '/redirect':
          res.writeHead(302, { location: '/final' })
          res.end()
          return
        case '/final':
          res.writeHead(200, { 'content-type': 'text/plain' })
          res.end('final-ok')
          return
        case '/json':
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{"a":1,"b":[2,3]}')
          return
        case '/text':
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('hello text')
          return
        case '/html':
          res.writeHead(200, { 'content-type': 'text/html' })
          res.end('<!DOCTYPE html><html><body>hi</body></html>')
          return
        case '/xml':
          res.writeHead(200, { 'content-type': 'application/xml' })
          res.end('<?xml version="1.0"?><root><a>1</a></root>')
          return
        default:
          res.writeHead(404, { 'content-type': 'text/plain' })
          res.end('not found')
      }
    })
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
})

const LOCAL_POLICY: NetworkPolicy = {
  ...DEFAULT_NETWORK_POLICY,
  allowLocalhost: true,
}

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

describe('TC-C-11/12/13：基本方法与 body', () => {
  it('TC-C-11: GET 执行 → 200、durationMs>0、bodyKind 正确', async () => {
    const { result } = await executeRequest(req({ url: `${baseUrl}/echo` }), { policy: LOCAL_POLICY })
    expect(result.status).toBe(200)
    expect(result.durationMs).toBeGreaterThan(0)
    expect(result.bodyKind).toBe('json')
    expect(result.redirected).toBe(false)
    expect(result.finalUrl).toBe(`${baseUrl}/echo`)
  })

  it('TC-C-12: POST JSON → server 收到的 body 与 Content-Type 正确', async () => {
    const json = '{"name":"dsh","n":1}'
    const { result } = await executeRequest(
      req({ method: 'POST', url: `${baseUrl}/echo`, body: { type: 'json', json } }),
      { policy: LOCAL_POLICY },
    )
    expect(result.status).toBe(200)
    expect(lastRequest.method).toBe('POST')
    expect(lastRequest.body).toBe(json)
    expect(lastRequest.headers['content-type']).toBe('application/json')
  })

  it('TC-C-13: HEAD / OPTIONS 可配置并执行；HEAD 无 body 解析不挂', async () => {
    const head = await executeRequest(req({ method: 'HEAD', url: `${baseUrl}/head` }), { policy: LOCAL_POLICY })
    expect(lastRequest.method).toBe('HEAD')
    expect(head.result.status).toBe(200)
    expect(head.result.bodyText).toBe('')

    const options = await executeRequest(req({ method: 'OPTIONS', url: `${baseUrl}/echo` }), {
      policy: LOCAL_POLICY,
    })
    expect(lastRequest.method).toBe('OPTIONS')
    expect(options.result.status).toBe(200)
  })
})

describe('TC-C-14/15/16：timeout / maxResponseBytes / redirect 边界', () => {
  it('TC-C-14: server 延迟 > timeoutMs → 超时错误，消息无明文 secret', async () => {
    const secretValue = 'timeout-secret-value-9f3'
    const ref = createSecretRef('timeout-secret')
    const failure = await executeRequest(
      req({
        url: `${baseUrl}/slow`,
        headers: [{ key: 'X-Secret', value: '{{s}}', enabled: true }],
      }),
      {
        policy: { ...LOCAL_POLICY, timeoutMs: 50 },
        environment: {
          id: 'e1',
          name: 'dev',
          variables: [{ key: 's', currentValue: ref, secret: true, enabled: true }],
        },
        resolveSecret: () => secretValue,
      },
    ).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(ExecutorError)
    const timeoutError = failure as ExecutorError
    expect(timeoutError.kind).toBe('timeout')
    expect(timeoutError.message).not.toContain(secretValue)
  }, 10_000)

  it('TC-C-15: 响应体 > maxResponseBytes → 报错并记录 size', async () => {
    const failure = await executeRequest(req({ url: `${baseUrl}/large` }), {
      policy: { ...LOCAL_POLICY, maxResponseBytes: 1024 },
    }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(ExecutorError)
    const tooLarge = failure as ExecutorError
    expect(tooLarge.kind).toBe('response-too-large')
    expect(tooLarge.details?.['limit']).toBe(1024)
    expect(Number(tooLarge.details?.['received'])).toBeGreaterThan(1024)
    expect(tooLarge.message).toContain('1024')
  })

  it('TC-C-16: redirectPolicy=none 遇 302 → 不跟随；follow 时 200 且每跳重新过 network policy', async () => {
    const noFollow = await executeRequest(req({ url: `${baseUrl}/redirect` }), {
      policy: { ...LOCAL_POLICY, redirectPolicy: 'none' },
    })
    expect(noFollow.result.status).toBe(302)
    expect(noFollow.result.redirected).toBe(false)

    // 用主机名 + 注入 resolver 走真实 DNS 固定路径（IP 字面量不会触发 connect.lookup）
    const localhostUrl = baseUrl.replace('127.0.0.1', 'localhost')
    const evaluations: PolicyTarget[] = []
    const followed = await executeRequest(req({ url: `${localhostUrl}/redirect` }), {
      policy: { ...LOCAL_POLICY, redirectPolicy: 'follow' },
      resolveHost: (hostname) => {
        expect(hostname).toBe('localhost')
        return Promise.resolve([{ address: '127.0.0.1', family: 4 }])
      },
      evaluatePolicy: (target) => {
        evaluations.push(target)
        return { allowed: true }
      },
    })
    expect(followed.result.status).toBe(200)
    expect(followed.result.redirected).toBe(true)
    expect(followed.result.finalUrl).toBe(`${localhostUrl}/final`)
    expect(followed.result.bodyText).toBe('final-ok')
    // executor 预检 + 每跳（/redirect、/final）连接前重评估 + DNS 固定点复检：至少 3 次
    expect(evaluations.length).toBeGreaterThanOrEqual(3)
    expect(evaluations.every((t) => t.host === 'localhost')).toBe(true)
    // DNS rebinding 防护执行点：每跳解析一次并固定 IP，按解析 IP 复检（两跳 → 两次）
    const pinnedChecks = evaluations.filter((t) => t.resolvedIp === '127.0.0.1')
    expect(pinnedChecks.length).toBe(2)
  })
})

describe('TC-C-17：响应 bodyKind 与 pretty', () => {
  it('JSON/Text/HTML/XML → bodyKind 分别正确，pretty 输出合法', async () => {
    const cases = [
      { path: '/json', kind: 'json' },
      { path: '/text', kind: 'text' },
      { path: '/html', kind: 'html' },
      { path: '/xml', kind: 'xml' },
    ] as const
    for (const { path, kind } of cases) {
      const { result } = await executeRequest(req({ url: `${baseUrl}${path}` }), { policy: LOCAL_POLICY })
      expect(result.bodyKind).toBe(kind)
    }
    const { result } = await executeRequest(req({ url: `${baseUrl}/json` }), { policy: LOCAL_POLICY })
    const pretty = prettyBody(result.bodyKind, result.bodyText)
    expect(pretty).toContain('\n')
    expect(JSON.parse(pretty)).toEqual({ a: 1, b: [2, 3] })
  })
})

describe('executor 编排配套：十二步挂接点', () => {
  it('permission check 在连接前执行；event 流按序触发；history 注入收到脱敏记录', async () => {
    const events: string[] = []
    let permissionChecked = false
    const histories: unknown[] = []
    const secretValue = 'orchestration-secret-51'
    const ref = createSecretRef('orch-secret')
    const { result, history } = await executeRequest(
      req({
        url: `${baseUrl}/echo`,
        headers: [{ key: 'X-Secret', value: '{{s}}', enabled: true }],
      }),
      {
        policy: LOCAL_POLICY,
        environment: {
          id: 'e1',
          name: 'dev',
          variables: [{ key: 's', currentValue: ref, secret: true, enabled: true }],
        },
        resolveSecret: () => secretValue,
        permissionCheck: () => {
          permissionChecked = true
        },
        historyContext: { profileId: 'p1', source: 'human' },
        recordHistory: (entry) => {
          histories.push(entry)
        },
        onEvent: (e) => events.push(e.type),
      },
    )
    expect(result.status).toBe(200)
    expect(lastRequest.headers['x-secret']).toBe(secretValue)
    expect(permissionChecked).toBe(true)
    expect(events).toEqual([
      'resolved',
      'auth-applied',
      'built',
      'permission-passed',
      'policy-passed',
      'executing',
      'history-recorded',
      'finished',
    ])
    expect(histories).toHaveLength(1)
    expect(history).toBeDefined()
    // 落盘候选记录中 secret 已脱敏
    expect(JSON.stringify(history)).not.toContain(secretValue)
  })

  it('默认策略 fail-closed：localhost 未显式放行时被拒', async () => {
    const failure = await executeRequest(req({ url: `${baseUrl}/echo` })).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(ExecutorError)
    expect((failure as ExecutorError).kind).toBe('network-policy-denied')
  })
})
