// @vitest-environment node
/**
 * TC-T-01…10（§6.6）：Agent Tools（WP5）。
 *
 * 形态：tmp 存储根 + createHostServices（与 src/host/index.ts 同一组装点）+
 * FakeToolRegistry（结构模拟 WP0 实测的 ctx.tools.register 注册表形态）+
 * 本地 echo server（network policy 经 settings 放行 localhost，同 TC-API-04 注记）。
 * Approval 挂接经 registerApiClientTools 的 approvalHook 注入面 mock 断言（TC-T-07）。
 */
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { CollectionSummary } from '@dsh-api-client/shared'
import { API_CLIENT_TOOL_NAMES, API_CLIENT_TOOL_NAMESPACE_PATTERN, profileLayout, resolveStorageLayout } from '@dsh-api-client/shared'
import type { HostServices } from '../src/host/index.ts'
import { createHostServices } from '../src/host/index.ts'
import { ProfileService } from '../src/host/services/profile-service.ts'
import { ExecutionService } from '../src/host/services/execution-service.ts'
import { createSilentHostLog } from '../src/host/host-log.ts'
import type { AgentPermissionGate, ApiClientToolsDeps, ApprovalRequest, ToolExecutionResult } from '../src/host/tools/register.ts'
import {
  createAgentPermissionGate,
  evaluateAgentPermission,
  registerApiClientTools,
  TOOL_RISK_LEVELS,
} from '../src/host/tools/register.ts'
import type { LastResponseProjection } from '../src/host/tools/api-client-get-last-response.ts'
import type { RequestSummary } from '../src/host/tools/api-client-list-requests.ts'
import { ANNOUNCEMENT_SECTION_NAME, attachApiClientAnnouncement } from '../src/host/tools/announcement.ts'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SECRET_VALUE = 'super-secret-value-TC-T-04'
const INLINE_TOKEN = 'inline-bearer-token-TC-T-08'
const PROFILE_ID = 'tools-test'

/** 结构模拟 ctx.tools 注册表（register 返回精确注销 disposer，WP0 实测形态）。 */
class FakeToolRegistry {
  private readonly defs = new Map<string, ToolDefinition>()

  register(definition: ToolDefinition): () => void {
    this.defs.set(definition.name, definition)
    return () => {
      this.defs.delete(definition.name)
    }
  }

  get(name: string): ToolDefinition | undefined {
    return this.defs.get(name)
  }

  names(): string[] {
    return [...this.defs.keys()]
  }
}

type CapturedPreExecute = (exec: { name: string; arguments: unknown }, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>

function createFakeCtx(registry: FakeToolRegistry): { ctx: Context; preExecuteListeners: CapturedPreExecute[] } {
  const preExecuteListeners: CapturedPreExecute[] = []
  const ctx = {
    tools: registry,
    systemPrompt: { section: () => () => {} },
    on: (event: string, listener: CapturedPreExecute) => {
      if (event === 'tools/pre-execute') preExecuteListeners.push(listener)
      return () => {}
    },
  }
  return { ctx: ctx as unknown as Context, preExecuteListeners }
}

let tmpHome: string
let services: HostServices
let deps: ApiClientToolsDeps
let echoServer: Server
let echoBase: string
let registry: FakeToolRegistry
let preExecuteListeners: CapturedPreExecute[]
let registration: ReturnType<typeof registerApiClientTools>
const log = () => createSilentHostLog()

let collectionId: string
let runMeId: string
let postMeId: string
let inlineAuthReqId: string
let secretRefAuthReqId: string

async function executeTool(name: string, args: unknown): Promise<unknown> {
  const definition = registry.get(name)
  if (definition === undefined) throw new Error(`tool not registered: ${name}`)
  return definition.execute(args, {} as never)
}

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'dsh-api-client-tools-'))
  const profile = ProfileService.detect({ env: { DSH_PROFILE: PROFILE_ID }, home: tmpHome })
  services = createHostServices({ dshHome: tmpHome, profile })
  services.settings.patch({ networkPolicy: { allowLocalhost: true } })

  echoServer = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString('utf8'), headers: req.headers }))
    })
  })
  await new Promise<void>((resolve) => echoServer.listen(0, '127.0.0.1', resolve))
  echoBase = `http://127.0.0.1:${(echoServer.address() as AddressInfo).port}`

  // 环境：普通变量 base + secret 变量 TOKEN（SecretRef 链路）
  const environment = services.environments.create('agent-env')
  services.environments.patch(environment.id, { variables: [{ key: 'base', value: echoBase }] })
  services.environments.writeSecret(environment.id, 'TOKEN', SECRET_VALUE)

  // Collection 夹具：执行用 2 个 + auth 投影用 2 个
  const collection = services.collections.create('tc-tools')
  collectionId = collection.id
  runMeId = services.collections.addRequest(collectionId, {
    name: 'run-me',
    method: 'GET',
    url: '{{base}}/echo-run?x=1',
    headers: [{ key: 'x-token', value: '{{TOKEN}}', enabled: true }],
  }).id
  postMeId = services.collections.addRequest(collectionId, { name: 'post-me', method: 'POST', url: '{{base}}/echo-post' }).id
  inlineAuthReqId = services.collections.addRequest(collectionId, {
    name: 'with-inline-auth',
    method: 'GET',
    url: '{{base}}/inline',
    auth: { type: 'bearer', token: INLINE_TOKEN },
  }).id
  const secretRef = services.secrets.writeSecret(SECRET_VALUE)
  secretRefAuthReqId = services.collections.addRequest(collectionId, {
    name: 'with-secretref-auth',
    method: 'GET',
    url: '{{base}}/ref',
    auth: { type: 'bearer', token: secretRef },
  }).id

  deps = {
    execution: services.execution,
    collections: services.collections,
    history: services.history,
    redaction: services.redaction,
    settings: services.settings,
  }
  registry = new FakeToolRegistry()
  const fake = createFakeCtx(registry)
  preExecuteListeners = fake.preExecuteListeners
  registration = registerApiClientTools(fake.ctx, deps, log())
})

afterAll(async () => {
  registration.dispose()
  await new Promise<void>((resolve) => echoServer.close(() => resolve()))
  rmSync(tmpHome, { recursive: true, force: true })
})

describe('TC-T-01: api_client_request 与 Human Send 共用同一 execution-service/core executor（AC-20）', () => {
  it('工具 execute 委托 ExecutionService.prototype.execute（source=agent），human 通道同一方法', async () => {
    const spy = vi.spyOn(ExecutionService.prototype, 'execute')
    try {
      await executeTool('api_client_request', { method: 'GET', url: `${echoBase}/tc-t-01-agent` })
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.calls[0]![0]).toMatchObject({ source: 'agent' })
      // Human Send 的 service 调用（execute 端点的薄适配层之下）走同一 prototype 方法
      await services.execution.execute({ request: { method: 'GET', url: `${echoBase}/tc-t-01-human` }, source: 'human' })
      expect(spy).toHaveBeenCalledTimes(2)
      expect(spy.mock.calls[1]![0]).toMatchObject({ source: 'human' })
    } finally {
      spy.mockRestore()
    }
  })

  it('模块级断言：tools/ 无双套 HTTP client；execute 端点与 tools 同一 ExecutionService 模块', () => {
    const toolsDir = join(REPO_ROOT, 'src/host/tools')
    for (const file of readdirSync(toolsDir)) {
      const source = readFileSync(join(toolsDir, file), 'utf8')
      expect(source).not.toMatch(/executor\/http-client|executeHttp|undici|node:https?\b|\bfetch\s*\(/)
    }
    const executeRoute = readFileSync(join(REPO_ROOT, 'src/host/api/execute.ts'), 'utf8')
    expect(executeRoute).toContain('services/execution-service.ts')
  })
})

describe('TC-T-02: api_client_run_request（requestId + per-call environment）→ 脱敏结果（AC-21）', () => {
  it('执行保存请求，变量与 secret 解析成功，返回脱敏投影', async () => {
    const result = (await executeTool('api_client_run_request', { requestId: runMeId, environment: 'agent-env' })) as ToolExecutionResult
    expect(result.status).toBe(200)
    expect(typeof result.historyId).toBe('string')
    expect(result.bodyPreview).toContain('/echo-run') // {{base}} 已解析
    const text = JSON.stringify(result)
    expect(text).not.toContain(SECRET_VALUE)
    expect(text).toContain('<redacted>') // echo 回显的 x-token 头值被定点脱敏
  })

  it('{collection, request} 名字形态同样可执行', async () => {
    const result = (await executeTool('api_client_run_request', {
      collection: 'tc-tools',
      request: 'run-me',
      environment: 'agent-env',
    })) as ToolExecutionResult
    expect(result.status).toBe(200)
    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE)
  })
})

describe('TC-T-03: 注册表全部工具名 ^api_client_ 且无 http_request 冲突（AC-22）', () => {
  it('注册表即定稿 6 个，全部匹配命名空间', () => {
    const names = registry.names()
    expect([...names].sort()).toEqual([...API_CLIENT_TOOL_NAMES].sort())
    for (const name of names) {
      expect(name).toMatch(API_CLIENT_TOOL_NAMESPACE_PATTERN)
      expect(name).not.toBe('http_request')
    }
  })
})

describe('TC-T-04: 各工具返回体 grep 不到已解析 secret 值（AC-28/31）', () => {
  it('6 个工具返回体序列化后均无 secret 明文', async () => {
    const outputs: unknown[] = []
    outputs.push(
      await executeTool('api_client_request', {
        method: 'GET',
        url: '{{base}}/tc-t-04',
        headers: { 'x-token': '{{TOKEN}}' },
        environment: 'agent-env',
      }),
    )
    outputs.push(await executeTool('api_client_run_request', { requestId: runMeId, environment: 'agent-env' }))
    outputs.push(await executeTool('api_client_list_collections', {}))
    outputs.push(await executeTool('api_client_list_requests', { collectionId }))
    outputs.push(await executeTool('api_client_get_request', { requestId: secretRefAuthReqId }))
    outputs.push(await executeTool('api_client_get_last_response', {}))
    expect(outputs).toHaveLength(6)
    for (const output of outputs) {
      expect(JSON.stringify(output)).not.toContain(SECRET_VALUE)
    }
  })
})

describe('TC-T-05: api_client_get_last_response 脱敏投影 + schema 无明文开关（AC-31）', () => {
  it('schema 仅 {historyId?}，无任何明文开关参数', () => {
    const definition = registry.get('api_client_get_last_response')!
    const parameters = definition.parameters as { properties?: Record<string, unknown>; required?: string[] }
    expect(Object.keys(parameters.properties ?? {})).toEqual(['historyId'])
    expect(parameters.required ?? []).toEqual([])
    expect(JSON.stringify(definition.parameters)).not.toMatch(/reveal|plain|unredact|rawSecret|showSecret/i)
  })

  it('缺省取最后一条；指定 historyId 取对应条目；均为脱敏快照', async () => {
    const executed = (await executeTool('api_client_run_request', { requestId: runMeId, environment: 'agent-env' })) as ToolExecutionResult
    const last = (await executeTool('api_client_get_last_response', {})) as LastResponseProjection
    expect(last.historyId).toBe(executed.historyId)
    expect(last.source).toBe('agent')
    expect(last.responseSnapshot.status).toBe(200)
    expect(last.requestSnapshot.auth).toEqual({ type: 'none' })
    expect(JSON.stringify(last)).not.toContain(SECRET_VALUE)

    const byId = (await executeTool('api_client_get_last_response', { historyId: executed.historyId })) as LastResponseProjection
    expect(byId.historyId).toBe(executed.historyId)
    expect(JSON.stringify(byId)).not.toContain(SECRET_VALUE)
  })
})

describe('TC-T-06: 注册表不存在 api_client_switch_environment（AC-22，D-D1 回归锁）', () => {
  it('注册表与定稿清单均无该工具', () => {
    expect(registry.names()).not.toContain('api_client_switch_environment')
    expect(API_CLIENT_TOOL_NAMES).not.toContain('api_client_switch_environment')
    expect(registry.get('api_client_switch_environment')).toBeUndefined()
  })
})

describe('TC-T-07: 高风险方法触发 Approval 挂接（AC-35）', () => {
  function allowNext() {
    return vi.fn(async (): Promise<PreToolDecision> => ({ kind: 'allow' }))
  }

  it('POST/PUT/PATCH/DELETE → approval hook 被调；GET 不触发', async () => {
    const hookRegistry = new FakeToolRegistry()
    const fake = createFakeCtx(hookRegistry)
    const hook = vi.fn(async (_request: ApprovalRequest) => true)
    const reg = registerApiClientTools(fake.ctx, deps, log(), { approvalHook: hook })
    const gate = fake.preExecuteListeners[0]!
    try {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const next = allowNext()
        const decision = await gate({ name: 'api_client_request', arguments: { method, url: 'https://api.example.com/x' } }, next)
        expect(decision).toEqual({ kind: 'allow' })
        expect(next).toHaveBeenCalledTimes(1)
      }
      expect(hook).toHaveBeenCalledTimes(4)
      expect(hook.mock.calls[0]![0]).toMatchObject({ tool: 'api_client_request', method: 'POST', host: 'api.example.com' })

      for (const method of ['GET', 'HEAD', 'OPTIONS']) {
        const next = allowNext()
        await gate({ name: 'api_client_request', arguments: { method, url: 'https://api.example.com/x' } }, next)
        expect(next).toHaveBeenCalledTimes(1)
      }
      expect(hook).toHaveBeenCalledTimes(4) // GET/HEAD/OPTIONS 不触发
    } finally {
      reg.dispose()
    }
  })

  it('run_request 由目标请求 method 决定；hook 拒绝 → deny', async () => {
    const hookRegistry = new FakeToolRegistry()
    const fake = createFakeCtx(hookRegistry)
    const hook = vi.fn(async (_request: ApprovalRequest) => true)
    const reg = registerApiClientTools(fake.ctx, deps, log(), { approvalHook: hook })
    const gate = fake.preExecuteListeners[0]!
    try {
      await gate({ name: 'api_client_run_request', arguments: { requestId: postMeId } }, allowNext())
      expect(hook).toHaveBeenCalledTimes(1)
      expect(hook.mock.calls[0]![0]).toMatchObject({ tool: 'api_client_run_request', method: 'POST' })

      hook.mockResolvedValueOnce(false)
      const denied = await gate({ name: 'api_client_request', arguments: { method: 'DELETE', url: 'https://api.example.com/x' } }, allowNext())
      expect(denied.kind).toBe('deny')
      expect((denied as { reason: string }).reason).toContain('approval denied')
    } finally {
      reg.dispose()
    }
  })

  it('未注入 hook 时 ask 交 DSH 原生 Approval 通道（registration 默认形态）', async () => {
    const gate = preExecuteListeners[0]!
    const decision = await gate({ name: 'api_client_request', arguments: { method: 'POST', url: 'https://api.example.com/x' } }, allowNext())
    expect(decision.kind).toBe('ask')
    // 非 api_client_ 命名空间一律透传
    const next = allowNext()
    await gate({ name: 'http_request', arguments: { method: 'POST' } }, next)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('策略表：hostRules allow/approval/deny 与 highRiskMethodsRequireApproval 开关', () => {
    const base = { highRiskMethodsRequireApproval: true, hostRules: [] }
    expect(evaluateAgentPermission(base, { method: 'POST', host: 'api.example.com' }).action).toBe('ask')
    expect(evaluateAgentPermission(base, { method: 'GET', host: 'api.example.com' }).action).toBe('allow')
    expect(evaluateAgentPermission({ ...base, highRiskMethodsRequireApproval: false }, { method: 'POST', host: 'api.example.com' }).action).toBe('allow')

    const rules = (action: 'allow' | 'approval' | 'deny') => ({ ...base, hostRules: [{ host: 'api.example.com', action }] })
    expect(evaluateAgentPermission(rules('deny'), { method: 'GET', host: 'api.example.com' }).action).toBe('deny')
    expect(evaluateAgentPermission(rules('approval'), { method: 'GET', host: 'api.example.com' }).action).toBe('ask')
    expect(evaluateAgentPermission(rules('allow'), { method: 'POST', host: 'api.example.com' }).action).toBe('allow') // 显式 allow 覆盖高风险默认
    expect(evaluateAgentPermission(rules('deny'), { method: 'GET', host: 'other.example.com' }).action).toBe('allow')

    const wildcard = { ...base, hostRules: [{ host: '*.example.com', action: 'deny' as const }] }
    expect(evaluateAgentPermission(wildcard, { method: 'GET', host: 'a.b.example.com' }).action).toBe('deny')
    expect(evaluateAgentPermission(wildcard, { method: 'GET', host: 'example.com' }).action).toBe('deny')
  })

  it('settings patch 即时生效（policy 每次调用现取）', async () => {
    const gate = createAgentPermissionGate({
      policy: () => services.settings.get().agentPermission,
      resolveTarget: () => ({ method: 'POST', host: 'api.example.com' }),
    })
    services.settings.patch({ agentPermission: { highRiskMethodsRequireApproval: false } })
    try {
      const next = allowNext()
      await gate({ name: 'api_client_request', arguments: {} }, next)
      expect(next).toHaveBeenCalledTimes(1)
    } finally {
      services.settings.patch({ agentPermission: { highRiskMethodsRequireApproval: true } })
    }
  })
})

describe('TC-T-08: list/get 投影正确且 auth 材料脱敏（AC-22）', () => {
  it('list_collections / list_requests 摘要投影', async () => {
    const collections = (await executeTool('api_client_list_collections', {})) as CollectionSummary[]
    const collection = collections.find((c) => c.id === collectionId)
    expect(collection).toMatchObject({ name: 'tc-tools', requestCount: 4 })

    const requests = (await executeTool('api_client_list_requests', { collectionId })) as RequestSummary[]
    expect(requests.map((r) => r.name).sort()).toEqual(['post-me', 'run-me', 'with-inline-auth', 'with-secretref-auth'].sort())
    const runMe = requests.find((r) => r.name === 'run-me')!
    expect(runMe).toMatchObject({ id: runMeId, method: 'GET' })
    expect(runMe.displayUrl).toBe('{{base}}/echo-run?x=1')
  })

  it('get_request：inline auth 材料 → <redacted>；SecretRef 材料保留不透明 $ref', async () => {
    const inline = (await executeTool('api_client_get_request', { requestId: inlineAuthReqId })) as { auth: { type: string; token: unknown } }
    expect(inline.auth).toEqual({ type: 'bearer', token: '<redacted>' })
    expect(JSON.stringify(inline)).not.toContain(INLINE_TOKEN)

    const withRef = (await executeTool('api_client_get_request', { requestId: secretRefAuthReqId })) as {
      auth: { type: string; token: { $ref: string } }
    }
    expect(withRef.auth.type).toBe('bearer')
    expect(typeof withRef.auth.token.$ref).toBe('string')
    expect(JSON.stringify(withRef)).not.toContain(SECRET_VALUE)
  })
})

describe('TC-T-09: agent 执行 history source=agent 且与 human 同一存储体系（AC-19）', () => {
  it('agent/human 条目同库同文件，audit 同步落 source', async () => {
    const before = services.history.list({ limit: 500 }).length
    const agentResult = (await executeTool('api_client_run_request', { requestId: runMeId, environment: 'agent-env' })) as ToolExecutionResult
    const humanResult = await services.execution.execute({ request: { method: 'GET', url: `${echoBase}/tc-t-09-human` }, source: 'human' })

    const all = services.history.list({ limit: 500 })
    expect(all.length).toBe(before + 2)
    const agentEntry = all.find((e) => e.id === agentResult.historyId)
    expect(agentEntry?.source).toBe('agent')
    const humanEntry = all.find((e) => e.id === humanResult.historyId)
    expect(humanEntry?.source).toBe('human')

    // 同一存储文件（profile scope history.jsonl）落盘两源条目
    const historyFile = profileLayout(resolveStorageLayout(tmpHome), PROFILE_ID).historyFile
    const raw = readFileSync(historyFile, 'utf8')
    expect(raw).toContain(agentResult.historyId)
    expect(raw).toContain(humanResult.historyId)
    expect(raw).not.toContain(SECRET_VALUE)

    const audits = services.audit.list()
    expect(audits.some((a) => a.source === 'agent' && a.historyId === agentResult.historyId)).toBe(true)
    expect(audits.some((a) => a.source === 'human' && a.historyId === humanResult.historyId)).toBe(true)
  })
})

describe('TC-T-10: dispose 后工具注册表为空（AC-23）', () => {
  it('注销全部工具且幂等；pre-execute listener 一并摘除', async () => {
    const freshRegistry = new FakeToolRegistry()
    const fake = createFakeCtx(freshRegistry)
    let preExecuteOff = false
    const ctx = {
      tools: freshRegistry,
      on: () => () => {
        preExecuteOff = true
      },
    }
    const reg = registerApiClientTools(ctx as unknown as Context, deps, log())
    expect(freshRegistry.names()).toHaveLength(6)
    reg.dispose()
    expect(freshRegistry.names()).toEqual([])
    expect(preExecuteOff).toBe(true)
    reg.dispose() // 幂等
    expect(freshRegistry.names()).toEqual([])
    void fake
  })
})

describe('announcement（§3.4；由 M0 announcement-probe 演进）', () => {
  it('section 注册/注销；文本告知命名空间、per-call environment、无全局切换工具', () => {
    const registered: Array<{ name: string; order: number; text: string }> = []
    let disposed = false
    const ctx = {
      systemPrompt: {
        section: (options: { name: string; order: number; text: string }) => {
          registered.push(options)
          return () => {
            disposed = true
          }
        },
      },
    }
    const reg = attachApiClientAnnouncement(ctx as unknown as Context, log())
    expect(reg.status).toBe('registered')
    expect(registered).toHaveLength(1)
    expect(registered[0]!.name).toBe(ANNOUNCEMENT_SECTION_NAME)
    expect(registered[0]!.text).toContain('api_client_')
    expect(registered[0]!.text).toContain('environment')
    expect(registered[0]!.text).toContain('api_client_switch_environment') // 明确告知不存在
    reg.dispose()
    expect(disposed).toBe(true)
  })
})

describe('风险等级表（§5.2/§3.4）', () => {
  it('执行类 per-method；list/get 类 low', () => {
    expect(TOOL_RISK_LEVELS.api_client_request).toBe('per-method')
    expect(TOOL_RISK_LEVELS.api_client_run_request).toBe('per-method')
    expect(TOOL_RISK_LEVELS.api_client_list_collections).toBe('low')
    expect(TOOL_RISK_LEVELS.api_client_list_requests).toBe('low')
    expect(TOOL_RISK_LEVELS.api_client_get_request).toBe('low')
    expect(TOOL_RISK_LEVELS.api_client_get_last_response).toBe('low')
  })
})
