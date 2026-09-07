// @vitest-environment node
/**
 * TC-SEC-01…10（§6.7，WP8 Security 收尾）。
 *
 * 三层形态：
 * - 策略/执行层（01…07）：createHostServices（与 src/host/index.ts 同一组装点，各用例
 *   独立 tmp 存储根，默认 fail-closed 策略）→ services.execution.execute（Human/Agent
 *   共用执行入口）；DNS rebinding / redirect 防护点（05/06）直驱 core executeRequest
 *   （mock resolver 挂点只在 core 暴露）。
 * - 终态装配层（08/10）：createHostServices + createHostApiRouter + 真实 node http
 *   server——与 src/host/index.ts apply 完全同一装配（TC-API-08/09/10 在终态复跑）。
 * - tools gate 层（09）：registerApiClientTools + fake ctx（捕获 tools/pre-execute
 *   listener）+ approvalHook 注入面。
 */
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ApiRequest, NetworkPolicy } from '@dsh-api-client/shared'
import { profileLayout, resolveStorageLayout } from '@dsh-api-client/shared'
import type { PolicyTarget } from '@dsh-api-client/core'
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_NETWORK_POLICY,
  DEFAULT_TIMEOUT_MS,
  evaluateNetworkPolicy,
  executeRequest,
  ExecutorError,
} from '@dsh-api-client/core'
import type { HostServices } from '../src/host/index.ts'
import { createHostApiRouter, createHostServices } from '../src/host/index.ts'
import { ProfileService } from '../src/host/services/profile-service.ts'
import { createSilentHostLog } from '../src/host/host-log.ts'
import { registerApiClientTools } from '../src/host/tools/register.ts'
import type { ApprovalRequest } from '../src/host/tools/register.ts'

const PLUGIN_TOKEN = 'sec-plugin-token'
const CSRF = { 'x-dsh-api-client-request': '1' }
const SECRET_VALUE = 'super-secret-SEC-ECHO-01'

// ---- 共享靶场 server ----

let echoServer: Server
let echoBase: string
let echoPort: number
let redirectServer: Server
let redirectPort: number
let jumpHits: number

const tmpHomes: string[] = []

function makeServices(profileId: string): { services: HostServices; home: string } {
  const home = mkdtempSync(join(tmpdir(), `dsh-api-client-sec-${profileId}-`))
  tmpHomes.push(home)
  const profile = ProfileService.detect({ env: { DSH_PROFILE: profileId }, home })
  return { services: createHostServices({ dshHome: home, profile }), home }
}

/** 执行入口调用：成功 → undefined，失败 → error（不断言的统一收口）。 */
async function executeOutcome(services: HostServices, url: string): Promise<unknown> {
  return services.execution.execute({ request: { method: 'GET', url }, source: 'human' }).then(
    () => undefined,
    (error: unknown) => error,
  )
}

function expectPolicyDenied(failure: unknown, messagePart: string): void {
  expect(failure).toBeInstanceOf(ExecutorError)
  const error = failure as ExecutorError
  expect(error.kind).toBe('network-policy-denied')
  expect(error.message).toContain('network policy denied')
  expect(error.message).toContain(messagePart)
}

function coreReq(partial: Partial<ApiRequest>): ApiRequest {
  return {
    id: 'sec-core',
    name: 'sec-core',
    method: 'GET',
    url: '',
    params: [],
    headers: [],
    auth: { type: 'none' },
    body: { type: 'none' },
    collectionId: '',
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  }
}

beforeAll(async () => {
  echoServer = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]
    if (path === '/large') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('x'.repeat(2048))
      return
    }
    if (path === '/slow') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('slow-ok')
      }, 600)
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers }))
  })
  await new Promise<void>((resolve) => echoServer.listen(0, '127.0.0.1', resolve))
  echoPort = (echoServer.address() as AddressInfo).port
  echoBase = `http://127.0.0.1:${echoPort}`

  redirectServer = createServer((req, res) => {
    if ((req.url ?? '').startsWith('/jump')) {
      jumpHits += 1
      res.writeHead(302, { location: 'http://192.168.1.1/private' })
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
  })
  await new Promise<void>((resolve) => redirectServer.listen(0, '127.0.0.1', resolve))
  redirectPort = (redirectServer.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => echoServer.close(() => resolve()))
  await new Promise<void>((resolve) => redirectServer.close(() => resolve()))
  for (const home of tmpHomes) rmSync(home, { recursive: true, force: true })
})

// ---- TC-SEC-01…04：默认 fail-closed 策略（§24.3 / AC-34）----

describe('TC-SEC-01: 默认策略 localhost/127.0.0.1 → 拒，错误消息指明 policy', () => {
  it('localhost 与 127.0.0.1 在执行入口层被 network-policy 拒绝', async () => {
    const { services } = makeServices('sec01')
    for (const url of [`http://localhost:${echoPort}/echo`, `${echoBase}/echo`]) {
      expectPolicyDenied(await executeOutcome(services, url), 'allowLocalhost=false')
    }
  })
})

describe('TC-SEC-02: 私网段默认拒；allowPrivateNetwork=true 放行', () => {
  const PRIVATE_IPS = ['10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.10.1']

  it('10/8、172.16/12、192.168/16、169.254/16 默认全拒', async () => {
    const { services } = makeServices('sec02')
    for (const ip of PRIVATE_IPS) {
      expectPolicyDenied(await executeOutcome(services, `http://${ip}/`), 'allowPrivateNetwork=false')
    }
  })

  it('settings patch allowPrivateNetwork=true 后策略放行；localhost 仍拒（独立开关）', async () => {
    const { services } = makeServices('sec02b')
    services.settings.patch({ networkPolicy: { allowPrivateNetwork: true } })
    for (const ip of PRIVATE_IPS) {
      expect(services.networkPolicy.evaluate({ host: ip, port: 80 }).allowed).toBe(true)
    }
    expect(services.networkPolicy.evaluate({ host: '127.0.0.1', port: 80 }).allowed).toBe(false)
  })
})

describe('TC-SEC-03: blockedHosts（含通配）命中即拒；allowedHosts 白名单外全拒', () => {
  it('blockedHosts 含 *.example.com 通配：子域与精确名命中即拒', async () => {
    const { services } = makeServices('sec03')
    services.settings.patch({ networkPolicy: { blockedHosts: ['*.example.com', 'exact.bad'] } })
    for (const host of ['api.example.com', 'deep.sub.example.com', 'exact.bad']) {
      expectPolicyDenied(await executeOutcome(services, `http://${host}/`), 'blockedHosts')
    }
    // 裸 example.com 不被 *. 通配命中（通配只覆盖子域）
    expect(services.networkPolicy.evaluate({ host: 'example.com', port: 80 }).allowed).toBe(true)
  })

  it('allowedHosts 非空 = 白名单模式：白名单外全拒', async () => {
    const { services } = makeServices('sec03b')
    services.settings.patch({ networkPolicy: { allowedHosts: ['only.this'] } })
    expectPolicyDenied(await executeOutcome(services, 'http://other.example.org/'), 'not in allowedHosts')
    expect(services.networkPolicy.evaluate({ host: 'only.this', port: 80 }).allowed).toBe(true)
  })
})

describe('TC-SEC-04: blockedPorts 基线（22/6379）命中拒', () => {
  it('22 与 6379 端口在执行入口层被拒；同 host 常规端口不受影响', async () => {
    const { services } = makeServices('sec04')
    for (const port of [22, 6379]) {
      expectPolicyDenied(await executeOutcome(services, `http://public.example.com:${port}/`), 'blockedPorts')
    }
    expect(services.networkPolicy.evaluate({ host: 'public.example.com', port: 80 }).allowed).toBe(true)
  })
})

// ---- TC-SEC-05/06：executor 强制执行点（core http-client，mock resolver）----

describe('TC-SEC-05: DNS rebinding —— 解析一次并固定 IP 的防护点真实有效', () => {
  it('按名 preflight 放行后，连接前按解析 IP 再评估：重绑定 127.0.0.1 被拒', async () => {
    const evaluations: PolicyTarget[] = []
    let resolveCalls = 0
    const policy: NetworkPolicy = { ...DEFAULT_NETWORK_POLICY }
    const failure = await executeRequest(coreReq({ url: 'http://rebind.test/' }), {
      policy,
      evaluatePolicy: (target) => {
        evaluations.push(target)
        return evaluateNetworkPolicy(policy, target)
      },
      resolveHost: (hostname) => {
        resolveCalls += 1
        expect(hostname).toBe('rebind.test')
        return Promise.resolve([{ address: '127.0.0.1', family: 4 }])
      },
    }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(ExecutorError)
    const message = (failure as ExecutorError).message
    expect(message).toContain('network policy denied')
    expect(message).toContain('127.0.0.1')
    // 评估轨迹：preflight 按 host 名（公名 → 放行）→ 连接前按 resolvedIp 再评估（拒绝）。
    expect(evaluations[0]).toEqual({ host: 'rebind.test', port: 80 })
    expect(evaluations.some((t) => t.resolvedIp === '127.0.0.1')).toBe(true)
    // 解析只发生一次——TOCTOU 窗口被固定 IP 关闭。
    expect(resolveCalls).toBe(1)
  })

  it('固定 IP 精确落到 TCP：解析到 127.0.0.1 的公名命中本地 server（Host 头不变）', async () => {
    let resolveCalls = 0
    const { result } = await executeRequest(coreReq({ url: `http://pin.test:${echoPort}/echo` }), {
      policy: { ...DEFAULT_NETWORK_POLICY, allowLocalhost: true },
      resolveHost: () => {
        resolveCalls += 1
        return Promise.resolve([{ address: '127.0.0.1', family: 4 }])
      },
    })
    expect(result.status).toBe(200)
    expect(resolveCalls).toBe(1)
    // pin.test 系统 DNS 不可解析——能拿到 200 即证明连接走的是固定 IP。
    const echoed = JSON.parse(result.bodyText) as { headers: Record<string, string> }
    expect(echoed.headers.host).toBe(`pin.test:${echoPort}`)
  })
})

describe('TC-SEC-06: 公网 URL 302 跳私网 → 跳转目标再评估被拒', () => {
  it('redirect 每跳重评估：首跳执行，302 目标（私网 IP）连接前被拒', async () => {
    jumpHits = 0
    const evaluations: PolicyTarget[] = []
    const policy: NetworkPolicy = { ...DEFAULT_NETWORK_POLICY, allowLocalhost: true, allowPrivateNetwork: false }
    const failure = await executeRequest(coreReq({ url: `http://public.test:${redirectPort}/jump` }), {
      policy,
      evaluatePolicy: (target) => {
        evaluations.push(target)
        return evaluateNetworkPolicy(policy, target)
      },
      resolveHost: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
    }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(ExecutorError)
    expect((failure as ExecutorError).kind).toBe('network-policy-denied')
    expect((failure as ExecutorError).message).toContain('private network target')
    // 首跳真实执行（redirect server 击中一次），次跳目标进入评估轨迹。
    expect(jumpHits).toBe(1)
    expect(evaluations.some((t) => t.host === 'public.test')).toBe(true)
    expect(evaluations.some((t) => t.host === '192.168.1.1')).toBe(true)
  })
})

// ---- TC-SEC-07：settings → network-policy-service → execution-service 链路 ----

describe('TC-SEC-07: maxResponseBytes / timeoutMs 经 settings 修改后真实生效', () => {
  it('基线默认值 → patch 后 getPolicy 合成 → 执行层超限/超时真实触发', async () => {
    const { services } = makeServices('sec07')
    expect(services.networkPolicy.getPolicy().maxResponseBytes).toBe(DEFAULT_MAX_RESPONSE_BYTES)
    expect(services.networkPolicy.getPolicy().timeoutMs).toBe(DEFAULT_TIMEOUT_MS)

    services.settings.patch({ networkPolicy: { allowLocalhost: true }, maxResponseBytes: 1024, defaultTimeoutMs: 200 })
    const policy = services.networkPolicy.getPolicy()
    expect(policy.maxResponseBytes).toBe(1024)
    expect(policy.timeoutMs).toBe(200)

    const tooLarge = await executeOutcome(services, `${echoBase}/large`)
    expect(tooLarge).toBeInstanceOf(ExecutorError)
    expect((tooLarge as ExecutorError).kind).toBe('response-too-large')

    const timeout = await executeOutcome(services, `${echoBase}/slow`)
    expect(timeout).toBeInstanceOf(ExecutorError)
    expect((timeout as ExecutorError).kind).toBe('timeout')
  }, 10_000)
})

// ---- TC-SEC-08/10：终态装配（createHostServices + createHostApiRouter + 真实 server）----

interface SecAssembly {
  services: HostServices
  server: Server
  baseUrl: string
  home: string
}

async function assembleHost(profileId: string): Promise<SecAssembly> {
  const { services, home } = makeServices(profileId)
  const api = createHostApiRouter(services, { pluginToken: PLUGIN_TOKEN })
  const server = createServer((req, res) => {
    void api.handle(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { services, server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, home }
}

async function apiFetch(
  baseUrl: string,
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
  return { status: res.status, body: text === '' ? undefined : (JSON.parse(text) as unknown) }
}

describe('TC-SEC-08: /execute 三向拒（TC-API-08/09/10 终态装配复跑）', () => {
  let assembly: SecAssembly

  beforeAll(async () => {
    assembly = await assembleHost('sec08')
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => assembly.server.close(() => resolve()))
  })

  it('匿名（无 token / 错误 token）→ 401', async () => {
    const noToken = await apiFetch(assembly.baseUrl, '/api-client/execute', {
      method: 'POST',
      body: { request: { method: 'GET', url: 'http://example.com/' } },
      headers: CSRF,
      token: null,
    })
    expect(noToken.status).toBe(401)
    expect((noToken.body as { error: { code: string } }).error.code).toBe('missing-token')

    const wrongToken = await apiFetch(assembly.baseUrl, '/api-client/execute', {
      method: 'POST',
      body: { request: { method: 'GET', url: 'http://example.com/' } },
      headers: CSRF,
      token: 'wrong-token',
    })
    expect(wrongToken.status).toBe(401)
    expect((wrongToken.body as { error: { code: string } }).error.code).toBe('invalid-token')
  })

  it('跨源（Sec-Fetch-Site: cross-site / 伪造 Origin）→ 403', async () => {
    const crossSite = await apiFetch(assembly.baseUrl, '/api-client/execute', {
      method: 'POST',
      body: { request: { method: 'GET', url: 'http://example.com/' } },
      headers: { ...CSRF, 'sec-fetch-site': 'cross-site' },
    })
    expect(crossSite.status).toBe(403)
    expect((crossSite.body as { error: { code: string } }).error.code).toBe('cross-site-refused')

    const forgedOrigin = await apiFetch(assembly.baseUrl, '/api-client/execute', {
      method: 'POST',
      body: { request: { method: 'GET', url: 'http://example.com/' } },
      headers: { ...CSRF, origin: 'http://evil.example.com' },
    })
    expect(forgedOrigin.status).toBe(403)
    expect((forgedOrigin.body as { error: { code: string } }).error.code).toBe('origin-mismatch')
  })

  it('缺 CSRF 头 → 403 missing-csrf-header', async () => {
    const missing = await apiFetch(assembly.baseUrl, '/api-client/execute', {
      method: 'POST',
      body: { request: { method: 'GET', url: 'http://example.com/' } },
    })
    expect(missing.status).toBe(403)
    expect((missing.body as { error: { code: string } }).error.code).toBe('missing-csrf-header')
  })

  it('对照组：token + CSRF + 同源 → 穿过鉴权到达策略层（403 为 network-policy-denied 而非鉴权码）', async () => {
    const valid = await apiFetch(assembly.baseUrl, '/api-client/execute', {
      method: 'POST',
      body: { request: { method: 'GET', url: `${echoBase}/echo` } },
      headers: CSRF,
    })
    // 终态默认策略 fail-closed：鉴权全过、策略层拒 localhost——错误码证明请求穿过了 auth。
    expect(valid.status).toBe(403)
    expect((valid.body as { error: { code: string } }).error.code).toBe('network-policy-denied')
  })
})

// ---- TC-SEC-09：hostRules（tools gate 层，§24.5 / AC-35）----

class FakeToolRegistry {
  private readonly defs = new Map<string, ToolDefinition>()

  register(definition: ToolDefinition): () => void {
    this.defs.set(definition.name, definition)
    return () => {
      this.defs.delete(definition.name)
    }
  }
}

type CapturedPreExecute = (exec: { name: string; arguments: unknown }, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>

describe('TC-SEC-09: hostRules host=approval → GET 也挂 approval；host=deny → 全拒', () => {
  it('tools/pre-execute gate 按 settings.agentPermission.hostRules 裁决', async () => {
    const { services } = makeServices('sec09')
    services.settings.patch({
      agentPermission: {
        hostRules: [
          { host: 'ask.example.com', action: 'approval' },
          { host: 'deny.example.com', action: 'deny' },
        ],
      },
    })

    const registry = new FakeToolRegistry()
    const preExecuteListeners: CapturedPreExecute[] = []
    const ctx = {
      tools: registry,
      on: (event: string, listener: CapturedPreExecute) => {
        if (event === 'tools/pre-execute') preExecuteListeners.push(listener)
        return () => {}
      },
    }
    const approvals: ApprovalRequest[] = []
    registerApiClientTools(
      ctx as unknown as Context,
      {
        execution: services.execution,
        collections: services.collections,
        history: services.history,
        redaction: services.redaction,
        settings: services.settings,
      },
      createSilentHostLog(),
      {
        approvalHook: (request) => {
          approvals.push(request)
          return true
        },
      },
    )
    expect(preExecuteListeners).toHaveLength(1)
    const gate = preExecuteListeners[0]!
    const next = vi.fn(() => Promise.resolve({ kind: 'allow' }) as Promise<PreToolDecision>)

    // approval host + GET（中风险方法，无 hostRules 时本不触发 approval）→ approval 挂接真实调用
    await gate({ name: 'api_client_request', arguments: { method: 'GET', url: 'http://ask.example.com/' } }, next)
    expect(approvals).toHaveLength(1)
    expect(approvals[0]).toMatchObject({ tool: 'api_client_request', method: 'GET', host: 'ask.example.com' })
    expect(approvals[0]!.reason).toContain('host rule requires approval')
    expect(next).toHaveBeenCalledTimes(1) // hook 批准 → 放行给工具

    // deny host：GET 与 POST 全拒，且不进入 approval 挂接
    for (const method of ['GET', 'POST']) {
      const decision = await gate({ name: 'api_client_request', arguments: { method, url: 'http://deny.example.com/' } }, next)
      expect(decision).toEqual({ kind: 'deny', reason: expect.stringContaining('host rule denied') })
    }
    expect(approvals).toHaveLength(1)
    expect(next).toHaveBeenCalledTimes(1)
  })
})

// ---- TC-SEC-10：audit.jsonl（§24.4 / AC-19，终态装配 + 落盘原文断言）----

describe('TC-SEC-10: human + agent 各执行一次 → audit.jsonl 四要素齐全', () => {
  it('audit.jsonl 含 source identity / 时间 / 目标 host / 结论', async () => {
    const assembly = await assembleHost('sec10')
    try {
      assembly.services.settings.patch({ networkPolicy: { allowLocalhost: true } })

      const human = await apiFetch(assembly.baseUrl, '/api-client/execute', {
        method: 'POST',
        body: { request: { method: 'GET', url: `${echoBase}/echo?src=human` } },
        headers: CSRF,
      })
      expect(human.status).toBe(200)

      const agent = await apiFetch(assembly.baseUrl, '/api-client/execute', {
        method: 'POST',
        body: { request: { method: 'GET', url: `${echoBase}/echo?src=agent` } },
        headers: { ...CSRF, 'x-dsh-api-client-source': 'agent' },
      })
      expect(agent.status).toBe(200)

      // 落盘原文（不经 service 读口）——profiles/sec10/audit.jsonl。
      const auditFile = profileLayout(resolveStorageLayout(assembly.home), 'sec10').auditFile
      const lines = readFileSync(auditFile, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)

      const humanEntry = lines.find((e) => e['source'] === 'human')
      const agentEntry = lines.find((e) => e['source'] === 'agent')
      expect(humanEntry).toMatchObject({ source: 'human', method: 'GET', host: '127.0.0.1', outcome: 'success' })
      expect(agentEntry).toMatchObject({ source: 'agent', method: 'GET', host: '127.0.0.1', outcome: 'success' })
      expect(typeof humanEntry!['timestamp']).toBe('number')
      expect(typeof agentEntry!['timestamp']).toBe('number')
      expect(typeof agentEntry!['historyId']).toBe('string')
    } finally {
      await new Promise<void>((resolve) => assembly.server.close(() => resolve()))
    }
  })
})

// ---- 端点 21 响应契约（WP8 小修 C-1）：responseEcho 为 host 跟踪脱敏快照 ----

describe('端点 21 responseEcho 契约（WP8 C-1）：response body 回显 secret 的残余面消除', () => {
  it('result.bodyText 如实回显 secret；responseEcho/requestEcho 定点脱敏不含明文', async () => {
    const { services } = makeServices('sec-echo')
    services.settings.patch({ networkPolicy: { allowLocalhost: true } })
    const environment = services.environments.create('sec-echo-env')
    services.environments.writeSecret(environment.id, 'token', SECRET_VALUE)

    const output = await services.execution.execute({
      request: {
        method: 'GET',
        url: `${echoBase}/echo`,
        headers: [{ key: 'Authorization', value: 'Bearer {{token}}', enabled: true }],
      },
      environment: environment.id,
      source: 'human',
    })

    // echo server 把请求头（含已解析 secret）回显进 body——契约上 result.bodyText 原样返回。
    expect(output.result.bodyText).toContain(SECRET_VALUE)
    // responseEcho 带执行期 secretValues 跟踪：回显进 body 的 secret 被定点替换。
    expect(output.responseEcho.bodyPreview).toContain('<redacted>')
    expect(JSON.stringify(output.responseEcho)).not.toContain(SECRET_VALUE)
    expect(JSON.stringify(output.requestEcho)).not.toContain(SECRET_VALUE)
    // history 快照同出口（脱敏一致性）。
    expect(output.historyId).toBeDefined()
    const history = services.history.get(output.historyId!)
    expect(JSON.stringify(history)).not.toContain(SECRET_VALUE)
  })
})
