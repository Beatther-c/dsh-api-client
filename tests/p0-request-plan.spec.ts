// @vitest-environment node
/**
 * P0 WP2：canonical buildRequestPlan 契约（实施设计 §5.1–§5.10、§3.3、§0.6；
 * UX §6.3/§6.4；8.1 表 #12/#13 的 plan 半边——wire 半边在 p0-undici-wire.spec.ts）。
 *
 * 覆盖：
 * - preview/resolved 双模式共享贡献来源/优先级/suppression/名称比较/Query 冲突/
 *   Body→Content-Type/Auth→Header|Query/default Accept/runtime catalog（§5.1）；
 * - 冻结优先级九步算法与 disabled 行语义（§5.3）；
 * - 同名多用户 Header 与 wire 分组 primitive（§5.4）；
 * - Auth 不再无条件 append（§5.5）；
 * - Query API Key 独立冲突规则（§5.6）；
 * - Body→Content-Type 映射与 form-data boundary 不伪造（§5.7）；
 * - suppression 读取/规范化纯函数（§5.8 + §3.3）；
 * - runtime catalog 只收录探测固化条目、永不预造最终值（§0.6 + §8.1.2）；
 * - preview 安全边界：敏感项恒遮罩、绝不调用 resolveSecret（红线 3）；
 * - Copy URL / 安全 cURL（§5.10）。
 */
import { describe, expect, it, vi } from 'vitest'
import type { ApiRequest, Environment, SuppressedGeneratedHeader, Variable } from '@dsh-api-client/shared'
import { createSecretRef } from '@dsh-api-client/shared'
import {
  applyAuth,
  buildCopyUrl,
  buildCurlCommand,
  buildRequestPlan,
  DEFAULT_ACCEPT,
  groupHeadersByLowerName,
  MULTIPART_BOUNDARY_PLACEHOLDER,
  normalizeSuppressedGeneratedHeaders,
  posixShellQuote,
  resolveInheritedAuth,
  resolveRequest,
  RUNTIME_HEADER_CATALOG,
  RUNTIME_VALUE_PREVIEW,
  sanitizeSuppressedGeneratedHeaders,
  SECRET_VALUE_PREVIEW,
  SuppressedGeneratedHeadersValidationError,
  UnresolvedVariablesError,
} from '@dsh-api-client/core'
import type { GeneratedHeaderPreview } from '@dsh-api-client/shared'

function req(partial: Partial<ApiRequest>): ApiRequest {
  return {
    id: 'r1',
    name: 'r',
    method: 'GET',
    url: 'https://api.example.com/x',
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

function env(variables: Variable[]): Environment {
  return { id: 'e1', name: 'dev', variables }
}

function item(plan: { preview: { headers: GeneratedHeaderPreview[] } }, name: string): GeneratedHeaderPreview {
  const hit = plan.preview.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())
  expect(hit, `preview 应包含 ${name} 条目`).toBeDefined()
  return hit!
}

const BEARER_SECRET = 'plan-bearer-secret-t0k'
const QUERY_SECRET = 'plan-query-secret-k3y'

describe('§5.3/§5.9：preview 基础投影（来源/状态/计数）', () => {
  it('GET 无 body：Content-Type 无贡献；Accept 客户端默认值；runtime 仅 Host', async () => {
    const plan = await buildRequestPlan(req({}), { mode: 'preview' })
    expect(plan.mode).toBe('preview')
    expect(plan.authType).toBe('none')
    expect(plan.preview.headers).toEqual([
      {
        name: 'Accept',
        valuePreview: DEFAULT_ACCEPT,
        source: 'client-default',
        status: 'active',
        sensitive: false,
        suppressible: true,
      },
      { name: 'Host', valuePreview: RUNTIME_VALUE_PREVIEW, source: 'runtime', status: 'runtime-pending', sensitive: false, suppressible: false },
    ])
    expect(plan.preview.query).toEqual([])
    expect(plan.preview.preSendHeaderCount).toBe(1)
    expect(plan.preview.runtimeHeaderCount).toBe(1)
  })

  it('POST json：Content-Type(来自 Body) → Accept → Host + Content-Length(运行时)；「发送前 2 项 · 运行时 2 项」', async () => {
    const plan = await buildRequestPlan(req({ method: 'POST', body: { type: 'json', json: '{"a":1}' } }), {
      mode: 'preview',
    })
    expect(plan.preview.headers.map((h) => `${h.name}:${h.source}:${h.status}`)).toEqual([
      'Content-Type:body:active',
      'Accept:client-default:active',
      'Host:runtime:runtime-pending',
      'Content-Length:runtime:runtime-pending',
    ])
    expect(item(plan, 'Content-Type').valuePreview).toBe('application/json')
    expect(plan.preview.preSendHeaderCount).toBe(2)
    expect(plan.preview.runtimeHeaderCount).toBe(2)
  })

  it('runtime 项 valuePreview 恒「发送时计算」，即使存在用户同名 Header 也不伪造最终值（§0.6）', async () => {
    const plan = await buildRequestPlan(
      req({ method: 'POST', body: { type: 'json', json: '{}' }, headers: [{ key: 'host', value: 'custom.example', enabled: true }] }),
      { mode: 'preview' },
    )
    const host = item(plan, 'Host')
    expect(host.status).toBe('overridden') // 探测固化：undici 真实采用用户 Host（p0-undici-wire）
    expect(host.valuePreview).toBe(RUNTIME_VALUE_PREVIEW)
    expect(item(plan, 'Content-Length').status).toBe('runtime-pending')
  })
})

describe('红线 3：preview 绝不返回可恢复 secret 材料', () => {
  it('bearer SecretRef 且未注入 resolveSecret → 不抛错、Authorization 恒遮罩、输出无任何材料', async () => {
    const plan = await buildRequestPlan(
      req({ auth: { type: 'bearer', token: createSecretRef('plan-bearer-ref') } }),
      { mode: 'preview' },
    )
    const authorization = item(plan, 'Authorization')
    expect(authorization).toMatchObject({
      valuePreview: SECRET_VALUE_PREVIEW,
      source: 'auth',
      status: 'active',
      sensitive: true,
      suppressible: false, // §5.8：Auth 生成行不提供 checkbox
    })
    const serialized = JSON.stringify(plan)
    expect(serialized).not.toContain('plan-bearer-ref')
    expect(serialized).not.toContain(BEARER_SECRET)
  })

  it('preview 模式即使注入 resolveSecret 也绝不调用（SecretRef 与 secret 环境变量均不解析）', async () => {
    const resolveSecret = vi.fn(() => BEARER_SECRET)
    const plan = await buildRequestPlan(
      req({
        auth: { type: 'bearer', token: createSecretRef('plan-bearer-ref') },
        headers: [{ key: 'X-Token', value: '{{s}}', enabled: true }],
      }),
      {
        mode: 'preview',
        environment: env([{ key: 's', currentValue: createSecretRef('env-ref'), secret: true, enabled: true }]),
        resolveSecret,
      },
    )
    expect(resolveSecret).not.toHaveBeenCalled()
    expect(item(plan, 'Authorization').valuePreview).toBe(SECRET_VALUE_PREVIEW)
    expect(JSON.stringify(plan)).not.toContain(BEARER_SECRET)
  })

  it('basic / apikey-header / apikey-query 的 preview 全部恒遮罩', async () => {
    const basic = await buildRequestPlan(
      req({ auth: { type: 'basic', username: 'alice', password: createSecretRef('basic-ref') } }),
      { mode: 'preview' },
    )
    expect(item(basic, 'Authorization').valuePreview).toBe(SECRET_VALUE_PREVIEW)
    expect(JSON.stringify(basic)).not.toContain('alice')

    const headerKey = await buildRequestPlan(
      req({ auth: { type: 'apikey', key: 'X-API-Key', value: createSecretRef('hk-ref'), in: 'header' } }),
      { mode: 'preview' },
    )
    expect(item(headerKey, 'X-API-Key')).toMatchObject({ valuePreview: SECRET_VALUE_PREVIEW, source: 'auth', sensitive: true })

    const queryKey = await buildRequestPlan(
      req({ auth: { type: 'apikey', key: 'api_key', value: createSecretRef('qk-ref'), in: 'query' } }),
      { mode: 'preview' },
    )
    expect(queryKey.preview.query).toEqual([
      { name: 'api_key', valuePreview: SECRET_VALUE_PREVIEW, source: 'auth', status: 'active', sensitive: true },
    ])
  })

  it('preview 不因未定义变量失败（UX §9：预览失败不阻断编辑）；resolved 模式才显式报错（TC-C-03）', async () => {
    const request = req({ url: 'https://{{missing_host}}/x' })
    const preview = await buildRequestPlan(request, { mode: 'preview' })
    expect(preview.preview.headers.length).toBeGreaterThan(0)
    const failure = await buildRequestPlan(request, { mode: 'resolved' }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(UnresolvedVariablesError)
    expect((failure as UnresolvedVariablesError).variables).toContain('missing_host')
  })
})

describe('§5.3：冻结优先级——启用用户 Header > Auth/Body 生成值 > 客户端默认值 > 运行时', () => {
  it('用户 enabled 同名 Header（大小写不同拼写）→ Generated status=overridden，wire 只有用户行', async () => {
    const plan = await buildRequestPlan(
      req({
        method: 'POST',
        body: { type: 'json', json: '{"a":1}' },
        headers: [{ key: 'content-type', value: 'application/vnd.custom+json', enabled: true }],
      }),
      { mode: 'resolved' },
    )
    expect(item(plan, 'Content-Type').status).toBe('overridden')
    const wireCt = plan.resolved.headers.filter((h) => h.key.toLowerCase() === 'content-type')
    expect(wireCt).toEqual([{ key: 'content-type', value: 'application/vnd.custom+json', enabled: true }])
    // Accept 不受影响仍 active
    expect(item(plan, 'Accept').status).toBe('active')
    expect(plan.resolved.headers).toContainEqual({ key: 'Accept', value: DEFAULT_ACCEPT, enabled: true })
  })

  it('disabled 用户行不参与覆盖、也不阻止生成，且不进 wire（§5.3/UX §6.3）', async () => {
    const plan = await buildRequestPlan(
      req({
        method: 'POST',
        body: { type: 'json', json: '{}' },
        headers: [
          { key: 'Content-Type', value: 'application/xml', enabled: false },
          { key: 'Accept', value: 'text/html', enabled: false },
        ],
      }),
      { mode: 'resolved' },
    )
    expect(item(plan, 'Content-Type').status).toBe('active')
    expect(item(plan, 'Accept').status).toBe('active')
    expect(plan.resolved.headers).toContainEqual({ key: 'Content-Type', value: 'application/json', enabled: true })
    expect(plan.resolved.headers).toContainEqual({ key: 'Accept', value: DEFAULT_ACCEPT, enabled: true })
    expect(plan.resolved.headers.some((h) => h.value === 'application/xml')).toBe(false)
    expect(plan.resolved.headers.some((h) => h.value === 'text/html')).toBe(false)
  })

  it('resolved wire 顺序冻结：用户行（原顺序）→ Body Content-Type → Auth → Accept；Generated 不落 request.headers', async () => {
    const request = req({
      method: 'POST',
      url: 'https://api.example.com/x',
      body: { type: 'json', json: '{"a":1}' },
      auth: { type: 'bearer', token: 'plain-token' },
      headers: [{ key: 'X-First', value: '1', enabled: true }],
    })
    const before = JSON.stringify(request)
    const plan = await buildRequestPlan(request, { mode: 'resolved' })
    expect(plan.resolved.headers).toEqual([
      { key: 'X-First', value: '1', enabled: true },
      { key: 'Content-Type', value: 'application/json', enabled: true },
      { key: 'Authorization', value: 'Bearer plain-token', enabled: true },
      { key: 'Accept', value: '*/*', enabled: true },
    ])
    // Generated 只是发送计划投影，绝不写回 ApiRequest.headers（UX §6.2/§6.3）
    expect(JSON.stringify(request)).toBe(before)
  })
})

describe('§5.4：同名多用户 Header（大小写不同拼写）', () => {
  it('两个 enabled 同名行都进 transport；同名 Auth 贡献被覆盖；分组 primitive 保留第一行拼写与用户顺序', async () => {
    const plan = await buildRequestPlan(
      req({
        auth: { type: 'apikey', key: 'X-FOO', value: 'auth-should-not-appear', in: 'header' },
        headers: [
          { key: 'X-Foo', value: 'a', enabled: true },
          { key: 'x-foo', value: 'b', enabled: true },
        ],
      }),
      { mode: 'resolved' },
    )
    expect(item(plan, 'X-FOO').status).toBe('overridden')
    expect(plan.resolved.headers.filter((h) => h.key.toLowerCase() === 'x-foo')).toEqual([
      { key: 'X-Foo', value: 'a', enabled: true },
      { key: 'x-foo', value: 'b', enabled: true },
    ])
    expect(plan.resolved.headers.some((h) => h.value === 'auth-should-not-appear')).toBe(false)

    const groups = groupHeadersByLowerName(plan.resolved.headers.filter((h) => h.key.toLowerCase() === 'x-foo'))
    expect(groups).toEqual([{ name: 'X-Foo', values: ['a', 'b'] }])
  })
})

describe('§5.5：Auth 修复——不再无条件 append', () => {
  it('用户已有 enabled Authorization → Auth Generated status=overridden 且不追加第二条', async () => {
    const plan = await buildRequestPlan(
      req({
        auth: { type: 'bearer', token: BEARER_SECRET },
        headers: [{ key: 'authorization', value: 'Bearer user-wins', enabled: true }],
      }),
      { mode: 'resolved' },
    )
    expect(item(plan, 'Authorization').status).toBe('overridden')
    const authorizationRows = plan.resolved.headers.filter((h) => h.key.toLowerCase() === 'authorization')
    expect(authorizationRows).toEqual([{ key: 'authorization', value: 'Bearer user-wins', enabled: true }])
    expect(JSON.stringify(plan.resolved.headers)).not.toContain(BEARER_SECRET)
  })

  it('用户 Authorization disabled → 不阻止 Auth 生成（active 并进 wire）', async () => {
    const plan = await buildRequestPlan(
      req({
        auth: { type: 'bearer', token: 'tok-active' },
        headers: [{ key: 'Authorization', value: 'Bearer off', enabled: false }],
      }),
      { mode: 'resolved' },
    )
    expect(item(plan, 'Authorization').status).toBe('active')
    expect(plan.resolved.headers).toContainEqual({ key: 'Authorization', value: 'Bearer tok-active', enabled: true })
  })

  it('resolved 模式 SecretRef 材料解析 + trace（location auth）；inherit 链经 collection 消解', async () => {
    const collection = {
      id: 'c1',
      name: 'c',
      auth: { type: 'bearer', token: createSecretRef('inh-ref') } as ApiRequest['auth'],
      variables: [],
      folders: [],
      requests: [],
      createdAt: 0,
      updatedAt: 0,
    }
    const plan = await buildRequestPlan(req({ auth: { type: 'inherit' } }), {
      mode: 'resolved',
      collection,
      resolveSecret: () => BEARER_SECRET,
    })
    expect(plan.authType).toBe('bearer')
    expect(plan.effectiveAuth).toEqual({ type: 'bearer', token: createSecretRef('inh-ref') })
    expect(plan.resolved.headers).toContainEqual({ key: 'Authorization', value: `Bearer ${BEARER_SECRET}`, enabled: true })
    expect(plan.resolved.secretValueTraces).toEqual([{ location: 'auth', key: 'token', secretRef: 'inh-ref' }])
  })
})

describe('R-03 回归（GPT review P0-blocker）：Auth materialize 不得先于覆盖判定', () => {
  it('enabled 用户 Authorization 覆盖 → resolveSecret 零调用、零 trace（低优先级 Auth 不反向阻断高优先级用户配置）', async () => {
    const resolveSecret = vi.fn(() => BEARER_SECRET)
    const plan = await buildRequestPlan(
      req({
        auth: { type: 'bearer', token: createSecretRef('r03-ref') },
        headers: [{ key: 'Authorization', value: 'Bearer user-wins', enabled: true }],
      }),
      { mode: 'resolved', resolveSecret },
    )
    expect(resolveSecret).not.toHaveBeenCalled()
    expect(item(plan, 'Authorization').status).toBe('overridden')
    expect(plan.resolved.secretValueTraces).toEqual([])
    expect(plan.resolved.headers.filter((h) => h.key.toLowerCase() === 'authorization')).toEqual([
      { key: 'Authorization', value: 'Bearer user-wins', enabled: true },
    ])
  })

  it('失效 SecretRef（resolveSecret 必抛）+ enabled 用户覆盖 → 构建仍成功，wire 只有用户值', async () => {
    const failing = vi.fn((): string => {
      throw new Error('dangling secret ref: r03-dead-ref')
    })
    const plan = await buildRequestPlan(
      req({
        auth: { type: 'bearer', token: createSecretRef('r03-dead-ref') },
        headers: [{ key: 'authorization', value: 'Bearer user-wins', enabled: true }],
      }),
      { mode: 'resolved', resolveSecret: failing },
    )
    expect(failing).not.toHaveBeenCalled()
    expect(plan.resolved.headers.filter((h) => h.key.toLowerCase() === 'authorization')).toEqual([
      { key: 'authorization', value: 'Bearer user-wins', enabled: true },
    ])
  })

  it('disabled 用户行 → 不构成覆盖，SecretRef 正常解析（调用次数=1 + trace 记录）', async () => {
    const resolveSecret = vi.fn(() => BEARER_SECRET)
    const plan = await buildRequestPlan(
      req({
        auth: { type: 'bearer', token: createSecretRef('r03-active-ref') },
        headers: [{ key: 'Authorization', value: 'Bearer off', enabled: false }],
      }),
      { mode: 'resolved', resolveSecret },
    )
    expect(resolveSecret).toHaveBeenCalledTimes(1)
    expect(item(plan, 'Authorization').status).toBe('active')
    expect(plan.resolved.headers).toContainEqual({
      key: 'Authorization',
      value: `Bearer ${BEARER_SECRET}`,
      enabled: true,
    })
    expect(plan.resolved.secretValueTraces).toEqual([{ location: 'auth', key: 'token', secretRef: 'r03-active-ref' }])
  })

  it('Query API Key 同理：enabled 同名用户参数 → 零解析零 trace，失效 SecretRef 不阻断构建', async () => {
    const failing = vi.fn((): string => {
      throw new Error('dangling secret ref: r03-query-dead')
    })
    const plan = await buildRequestPlan(
      req({
        auth: { type: 'apikey', key: 'api_key', value: createSecretRef('r03-query-dead'), in: 'query' },
        params: [{ key: 'api_key', value: 'user-val', enabled: true }],
      }),
      { mode: 'resolved', resolveSecret: failing },
    )
    expect(failing).not.toHaveBeenCalled()
    expect(plan.preview.query[0]?.status).toBe('overridden')
    expect(plan.resolved.url).toBe('https://api.example.com/x?api_key=user-val')
    expect(plan.resolved.secretValueTraces).toEqual([])
  })

  it('apikey in header：enabled 用户同名（大小写不同拼写）→ 零解析；disabled → 正常解析', async () => {
    const resolveSecret = vi.fn(() => QUERY_SECRET)
    const overriddenPlan = await buildRequestPlan(
      req({
        auth: { type: 'apikey', key: 'X-API-Key', value: createSecretRef('r03-hk-ref'), in: 'header' },
        headers: [{ key: 'x-api-key', value: 'user-key', enabled: true }],
      }),
      { mode: 'resolved', resolveSecret },
    )
    expect(resolveSecret).not.toHaveBeenCalled()
    expect(item(overriddenPlan, 'X-API-Key').status).toBe('overridden')
    expect(overriddenPlan.resolved.secretValueTraces).toEqual([])

    const activePlan = await buildRequestPlan(
      req({
        auth: { type: 'apikey', key: 'X-API-Key', value: createSecretRef('r03-hk-ref'), in: 'header' },
        headers: [{ key: 'x-api-key', value: 'off', enabled: false }],
      }),
      { mode: 'resolved', resolveSecret },
    )
    expect(resolveSecret).toHaveBeenCalledTimes(1)
    expect(activePlan.resolved.headers).toContainEqual({ key: 'X-API-Key', value: QUERY_SECRET, enabled: true })
    expect(activePlan.resolved.secretValueTraces).toEqual([{ location: 'auth', key: 'X-API-Key', secretRef: 'r03-hk-ref' }])
  })
})

describe('§5.6：Query API Key——独立于 Header 的冲突规则', () => {
  const auth = { type: 'apikey', key: 'api_key', value: QUERY_SECRET, in: 'query' } as const

  it('无同名用户参数 → active 并追加进 resolved URL；preview 值恒遮罩且不计入 header 数', async () => {
    const preview = await buildRequestPlan(req({ auth, params: [{ key: 'page', value: '2', enabled: true }] }), {
      mode: 'preview',
    })
    expect(preview.preview.query).toEqual([
      { name: 'api_key', valuePreview: SECRET_VALUE_PREVIEW, source: 'auth', status: 'active', sensitive: true },
    ])
    expect(preview.preview.headers.some((h) => h.name === 'api_key')).toBe(false)
    const before = preview.preview.preSendHeaderCount

    const resolved = await buildRequestPlan(req({ auth, params: [{ key: 'page', value: '2', enabled: true }] }), {
      mode: 'resolved',
    })
    expect(resolved.resolved.url).toBe(`https://api.example.com/x?page=2&api_key=${QUERY_SECRET}`)
    expect(resolved.preview.preSendHeaderCount).toBe(before)
    // 字面量材料无 SecretRef → 无 trace（trace 只记录 SecretRef 解析来源）
    expect(resolved.resolved.secretValueTraces).toEqual([])
  })

  it('SecretRef 材料 → resolved 记 trace（location auth, key=参数名），preview 无 trace 且遮罩', async () => {
    const secretAuth = { type: 'apikey', key: 'api_key', value: createSecretRef('qk-trace-ref'), in: 'query' } as const
    const resolved = await buildRequestPlan(req({ auth: secretAuth }), { mode: 'resolved', resolveSecret: () => QUERY_SECRET })
    expect(resolved.resolved.secretValueTraces).toEqual([{ location: 'auth', key: 'api_key', secretRef: 'qk-trace-ref' }])
    expect(resolved.resolved.url).toBe(`https://api.example.com/x?api_key=${QUERY_SECRET}`)
  })

  it('Params 表存在 enabled 同名用户参数 → overridden、不追加', async () => {
    const plan = await buildRequestPlan(
      req({ auth, params: [{ key: 'api_key', value: 'user-val', enabled: true }] }),
      { mode: 'resolved' },
    )
    expect(plan.preview.query[0]?.status).toBe('overridden')
    expect(plan.resolved.url).toBe('https://api.example.com/x?api_key=user-val')
    expect(plan.resolved.url).not.toContain(QUERY_SECRET)
  })

  it('URL 文本已有同名 query → overridden；只有 disabled 同名行 → 仍生成', async () => {
    const fromUrl = await buildRequestPlan(req({ auth, url: 'https://api.example.com/x?api_key=inline' }), {
      mode: 'resolved',
    })
    expect(fromUrl.preview.query[0]?.status).toBe('overridden')
    expect(fromUrl.resolved.url).toBe('https://api.example.com/x?api_key=inline')

    const disabledOnly = await buildRequestPlan(
      req({ auth, params: [{ key: 'api_key', value: 'off', enabled: false }] }),
      { mode: 'resolved' },
    )
    expect(disabledOnly.preview.query[0]?.status).toBe('active')
    expect(disabledOnly.resolved.url).toBe(`https://api.example.com/x?api_key=${QUERY_SECRET}`)
  })

  it('query 名不主动 case-fold（URI 标准未赋予 query 参数名类似 Header 的 case-insensitive 语义）：API_KEY 不覆盖 api_key', async () => {
    const plan = await buildRequestPlan(
      req({ auth, params: [{ key: 'API_KEY', value: 'upper', enabled: true }] }),
      { mode: 'resolved' },
    )
    expect(plan.preview.query[0]?.status).toBe('active')
    expect(plan.resolved.url).toBe(`https://api.example.com/x?API_KEY=upper&api_key=${QUERY_SECRET}`)
  })
})

describe('§5.7：Body → Content-Type 冻结映射与 boundary 一致性', () => {
  const cases: Array<[ApiRequest['body'], string | undefined]> = [
    [{ type: 'none' }, undefined],
    [{ type: 'raw', raw: 'hello' }, 'text/plain'],
    [{ type: 'json', json: '{}' }, 'application/json'],
    [{ type: 'urlencoded', fields: [] }, 'application/x-www-form-urlencoded'],
    [{ type: 'form-data', fields: [] }, `multipart/form-data; boundary=${MULTIPART_BOUNDARY_PLACEHOLDER}`],
  ]

  it.each(cases)('preview 映射 %#', async (body, expected) => {
    const plan = await buildRequestPlan(req({ body }), { mode: 'preview' })
    const ct = plan.preview.headers.find((h) => h.name === 'Content-Type')
    if (expected === undefined) {
      expect(ct).toBeUndefined()
    } else {
      expect(ct?.valuePreview).toBe(expected)
    }
  })

  it('form-data preview 显示占位符「<发送时生成>」，不伪造随机 boundary', async () => {
    const plan = await buildRequestPlan(
      req({ body: { type: 'form-data', fields: [{ key: 'a', value: '1', enabled: true }] } }),
      { mode: 'preview' },
    )
    expect(item(plan, 'Content-Type').valuePreview).toBe(`multipart/form-data; boundary=${MULTIPART_BOUNDARY_PLACEHOLDER}`)
    expect(item(plan, 'Content-Type').valuePreview).not.toMatch(/boundary=----/)
  })

  it('resolved：同一次 encoder 的 boundary 同时写入 body 与 Content-Type（注入 boundary 确定性验证）', async () => {
    const boundary = '----plan-test-boundary-1'
    const plan = await buildRequestPlan(
      req({
        method: 'POST',
        body: { type: 'form-data', fields: [{ key: 'a', value: '1', enabled: true }] },
      }),
      { mode: 'resolved', boundary },
    )
    expect(item(plan, 'Content-Type').valuePreview).toBe(`multipart/form-data; boundary=${boundary}`)
    const body = String(plan.resolved.body)
    expect(body).toContain(`--${boundary}`)
    const declared = /boundary=(.+)$/.exec(item(plan, 'Content-Type').valuePreview)?.[1]
    expect(declared).toBe(boundary)
    expect(plan.resolved.headers).toContainEqual({
      key: 'Content-Type',
      value: `multipart/form-data; boundary=${boundary}`,
      enabled: true,
    })
  })

  it('resolved 未注入 boundary → 随机生成且 Content-Type 与 body 内一致', async () => {
    const plan = await buildRequestPlan(
      req({ method: 'POST', body: { type: 'form-data', fields: [{ key: 'a', value: '1', enabled: true }] } }),
      { mode: 'resolved' },
    )
    const ct = plan.resolved.headers.find((h) => h.key === 'Content-Type')?.value ?? ''
    const declared = /boundary=(.+)$/.exec(ct)?.[1]
    expect(declared).toBeTruthy()
    expect(String(plan.resolved.body)).toContain(`--${declared}--`)
  })
})

describe('§5.8 + §3.3：suppression', () => {
  const jsonPost = { method: 'POST', body: { type: 'json', json: '{"a":1}' } } as const

  it('body Content-Type 与 client-default Accept 可停用；停用项不进 wire，但 body 数据照常序列化', async () => {
    const plan = await buildRequestPlan(
      req({
        ...jsonPost,
        suppressedGeneratedHeaders: [
          { name: 'content-type', source: 'body' },
          { name: 'accept', source: 'client-default' },
        ],
      }),
      { mode: 'resolved' },
    )
    expect(item(plan, 'Content-Type').status).toBe('suppressed')
    expect(item(plan, 'Accept').status).toBe('suppressed')
    expect(plan.resolved.headers.some((h) => h.key.toLowerCase() === 'content-type')).toBe(false)
    expect(plan.resolved.headers.some((h) => h.key.toLowerCase() === 'accept')).toBe(false)
    expect(plan.resolved.body).toBe('{"a":1}')
  })

  it('同名不同来源互不误伤：{accept, body} 不停用 client-default Accept；{content-type, client-default} 不停用 Body CT', async () => {
    const plan = await buildRequestPlan(
      req({
        ...jsonPost,
        suppressedGeneratedHeaders: [
          { name: 'accept', source: 'body' },
          { name: 'content-type', source: 'client-default' },
        ],
      }),
      { mode: 'resolved' },
    )
    expect(item(plan, 'Content-Type').status).toBe('active')
    expect(item(plan, 'Accept').status).toBe('active')
  })

  it('同名用户 Header 出现：用户行仍最高优先级；suppression 记录不删除且状态显示 suppressed（§5.3 步骤次序）', async () => {
    const suppressed: SuppressedGeneratedHeader[] = [{ name: 'content-type', source: 'body' }]
    const plan = await buildRequestPlan(
      req({
        ...jsonPost,
        headers: [{ key: 'Content-Type', value: 'text/css', enabled: true }],
        suppressedGeneratedHeaders: suppressed,
      }),
      { mode: 'resolved' },
    )
    expect(item(plan, 'Content-Type').status).toBe('suppressed')
    expect(plan.resolved.headers.filter((h) => h.key.toLowerCase() === 'content-type')).toEqual([
      { key: 'Content-Type', value: 'text/css', enabled: true },
    ])
    // 用户 Header 删除后旧 suppression 继续生效（记录未被合并过程改写）
    const afterUserRemoved = await buildRequestPlan(req({ ...jsonPost, suppressedGeneratedHeaders: suppressed }), {
      mode: 'resolved',
    })
    expect(item(afterUserRemoved, 'Content-Type').status).toBe('suppressed')
    expect(suppressed).toEqual([{ name: 'content-type', source: 'body' }])
  })

  it('读取语义 `?? []`：缺省字段等价空数组；脏数据宽容丢弃（preview 不阻断编辑）', async () => {
    const without = await buildRequestPlan(req({ ...jsonPost }), { mode: 'preview' })
    expect(item(without, 'Content-Type').status).toBe('active')

    const dirty = await buildRequestPlan(
      req({
        ...jsonPost,
        suppressedGeneratedHeaders: [
          { name: 'CONTENT-TYPE', source: 'body' }, // 大小写/规范化 → 生效
          { name: 'authorization', source: 'auth' } as unknown as SuppressedGeneratedHeader, // 非法 source → 丢弃
          { name: '  ', source: 'client-default' }, // 空 name → 丢弃
          null as unknown as SuppressedGeneratedHeader, // 非对象 → 丢弃
        ],
      }),
      { mode: 'preview' },
    )
    expect(item(dirty, 'Content-Type').status).toBe('suppressed')
    expect(dirty.preview.headers.some((h) => h.name === 'authorization')).toBe(false) // auth 项不存在（无 auth 配置）
    expect(item(dirty, 'Accept').status).toBe('active')
  })

  it('sanitizeSuppressedGeneratedHeaders：trim+lowercase、(name,source) 去重、非法记录静默丢弃', () => {
    expect(
      sanitizeSuppressedGeneratedHeaders([
        { name: ' Content-Type ', source: 'body' },
        { name: 'content-type', source: 'body' },
        { name: 'accept', source: 'client-default' },
        { name: 'accept', source: 'body' }, // 同名不同 source 保留（互不误伤）
        { name: 'host', source: 'runtime' },
        { name: 'x', source: 'cookie-jar' },
        { name: 42, source: 'body' },
        { name: '', source: 'body' },
        'not-an-object',
      ] as unknown[]),
    ).toEqual([
      { name: 'content-type', source: 'body' },
      { name: 'accept', source: 'client-default' },
      { name: 'accept', source: 'body' },
    ])
    expect(sanitizeSuppressedGeneratedHeaders(undefined)).toEqual([])
  })

  it('normalizeSuppressedGeneratedHeaders（Host 写入侧复用，§3.3）：拒绝 auth/runtime source、空 name、非字符串 name、未知 source、非数组；合法输入规范化+去重', () => {
    expect(normalizeSuppressedGeneratedHeaders([{ name: ' Accept ', source: 'client-default' }, { name: 'accept', source: 'client-default' }])).toEqual([
      { name: 'accept', source: 'client-default' },
    ])
    expect(normalizeSuppressedGeneratedHeaders([])).toEqual([])
    const invalidInputs: unknown[] = [
      'not-an-array',
      [{ name: 'accept', source: 'auth' }],
      [{ name: 'host', source: 'runtime' }],
      [{ name: 'accept', source: 'cookie-jar' }],
      [{ name: '   ', source: 'body' }],
      [{ name: 42, source: 'body' }],
      [{ name: 'accept' }],
      [null],
    ]
    for (const input of invalidInputs) {
      expect(() => normalizeSuppressedGeneratedHeaders(input), JSON.stringify(input)).toThrow(
        SuppressedGeneratedHeadersValidationError,
      )
    }
  })
})

describe('§0.6 + §8.1.2：runtime catalog 只收录探测固化条目', () => {
  it('catalog 冻结为 Host(always, 可覆盖) + Content-Length(has-body, 可覆盖)；Accept-Encoding 不收录（undici 探测：默认不发送）', () => {
    expect(RUNTIME_HEADER_CATALOG).toEqual([
      { name: 'Host', appliesWhen: 'always', userOverridable: true },
      { name: 'Content-Length', appliesWhen: 'has-body', userOverridable: true },
    ])
    expect(RUNTIME_HEADER_CATALOG.some((spec) => spec.name.toLowerCase() === 'accept-encoding')).toBe(false)
  })

  it('runtime 项永不进 resolved wire（不预造最终值，由 transport 发送时计算）', async () => {
    const plan = await buildRequestPlan(req({ method: 'POST', body: { type: 'json', json: '{}' } }), {
      mode: 'resolved',
    })
    expect(plan.resolved.headers.some((h) => h.key.toLowerCase() === 'host')).toBe(false)
    expect(plan.resolved.headers.some((h) => h.key.toLowerCase() === 'content-length')).toBe(false)
    expect(plan.preview.runtimeHeaderCount).toBe(2)
  })
})

describe('§5.2：兼容 wrapper 与 canonical primitive 同源（不允许第二套优先级算法）', () => {
  it('applyAuth：用户已有 enabled 同名 Header 时不追加第二条（旧「无条件 append」已修复）', async () => {
    const out = await applyAuth(
      { type: 'bearer', token: BEARER_SECRET },
      {
        method: 'GET',
        url: 'https://api.example.com/x',
        headers: [{ key: 'AUTHORIZATION', value: 'Bearer user-wins', enabled: true }],
        secretValueTraces: [],
      },
    )
    expect(out.headers.filter((h) => h.key.toLowerCase() === 'authorization')).toEqual([
      { key: 'AUTHORIZATION', value: 'Bearer user-wins', enabled: true },
    ])
    expect(JSON.stringify(out.headers)).not.toContain(BEARER_SECRET)
  })

  it('applyAuth：apikey in query 遇 URL 已有同名 enabled 参数 → 不追加（§5.6 同源规则）', async () => {
    const out = await applyAuth(
      { type: 'apikey', key: 'api_key', value: QUERY_SECRET, in: 'query' },
      { method: 'GET', url: 'https://api.example.com/x?api_key=inline', headers: [], secretValueTraces: [] },
    )
    expect(out.url).toBe('https://api.example.com/x?api_key=inline')
  })

  it('resolveRequest 不应用 auth（历史契约）；resolveRequest + applyAuth 组合 == buildRequestPlan resolved（同一 primitive）', async () => {
    const request = req({
      method: 'POST',
      url: 'https://api.example.com/x?a=1',
      headers: [{ key: 'X-T', value: '1', enabled: true }],
      auth: { type: 'bearer', token: 'compose-token' },
      body: { type: 'json', json: '{"k":1}' },
    })
    const viaPlan = await buildRequestPlan(request, { mode: 'resolved' })
    const legacyResolved = await resolveRequest(request, {})
    expect(legacyResolved.headers.some((h) => h.key === 'Authorization')).toBe(false)
    const legacy = await applyAuth(resolveInheritedAuth(request, undefined), legacyResolved)

    expect(viaPlan.resolved.url).toBe(legacy.url)
    expect(viaPlan.resolved.body).toBe(legacy.body)
    // Header 集合逐项一致（wire 顺序对语义无影响：组合路径的 Auth 行在尾部，plan 的在 Accept 前）
    const toRecord = (headers: typeof legacy.headers): Record<string, string> =>
      Object.fromEntries(headers.map((h) => [h.key.toLowerCase(), h.value]))
    expect(toRecord(viaPlan.resolved.headers)).toEqual(toRecord(legacy.headers))
    expect(viaPlan.resolved.secretValueTraces).toEqual(legacy.secretValueTraces)
  })
})

describe('§8.1.1：preview 与 resolved 投影一致性（secret 先归一化再比较）', () => {
  it('同一请求两模式：status/计数/query 逐项一致；普通值一致；敏感项两模式均遮罩', async () => {
    const request = req({
      method: 'POST',
      url: 'https://api.example.com/x',
      params: [{ key: 'page', value: '2', enabled: true }],
      headers: [{ key: 'X-Trace', value: 'v1', enabled: true }, { key: 'accept', value: 'application/json', enabled: true }],
      auth: { type: 'apikey', key: 'api_key', value: createSecretRef('cmp-ref'), in: 'query' },
      body: { type: 'json', json: '{"a":1}' },
      suppressedGeneratedHeaders: [{ name: 'accept', source: 'client-default' }],
    })
    const preview = await buildRequestPlan(request, { mode: 'preview' })
    const resolved = await buildRequestPlan(request, {
      mode: 'resolved',
      resolveSecret: () => QUERY_SECRET,
    })
    // 逐项：名称/来源/状态/敏感标志/遮罩值完全一致
    expect(resolved.preview.headers).toEqual(preview.preview.headers)
    expect(resolved.preview.query).toEqual(preview.preview.query)
    expect(resolved.preview.preSendHeaderCount).toBe(preview.preview.preSendHeaderCount)
    expect(resolved.preview.runtimeHeaderCount).toBe(preview.preview.runtimeHeaderCount)
    // 普通值与 wire 一致：Content-Type active 项即 wire 值
    expect(item(resolved, 'Content-Type').valuePreview).toBe('application/json')
    expect(resolved.resolved.headers).toContainEqual({ key: 'Content-Type', value: 'application/json', enabled: true })
    // 用户 Accept 覆盖 + suppression 并存（用户 Header 仍最高优先级发送）
    expect(resolved.resolved.headers).toContainEqual({ key: 'accept', value: 'application/json', enabled: true })
    // Query：preview 遮罩，wire 为真实值——先按 redaction 归一化再比较，不得拿遮罩与明文直接判不一致
    expect(preview.preview.query[0]?.valuePreview).toBe(SECRET_VALUE_PREVIEW)
    expect(resolved.resolved.url).toContain(`api_key=${QUERY_SECRET}`)
    expect(resolved.resolved.url.replace(QUERY_SECRET, SECRET_VALUE_PREVIEW)).toContain(`api_key=${SECRET_VALUE_PREVIEW}`)
  })
})

describe('§5.10：Copy URL', () => {
  it('普通未解析变量保留 {{name}}；secret 环境变量 → <redacted>；hash 保留', async () => {
    const environment = env([
      { key: 'tenant', currentValue: 'acme', secret: false, enabled: true },
      { key: 'tok', currentValue: createSecretRef('tok-ref'), secret: true, enabled: true },
    ])
    const url = buildCopyUrl(
      req({ url: 'https://{{tenant}}.example.com/p/{{tok}}?fixed=1#frag', params: [{ key: 'tag', value: '{{tenant}}', enabled: true }] }),
      { environment },
    )
    expect(url).toBe('https://{{tenant}}.example.com/p/<redacted>?fixed=1&tag={{tenant}}#frag')
  })

  it('Auth Query 派生值 → api_key=<redacted> 原始形态（与 redactUrl displayUrl 约定一致，不百分号编码）', () => {
    const url = buildCopyUrl(
      req({
        url: 'https://api.example.com/x',
        auth: { type: 'apikey', key: 'api_key', value: createSecretRef('k-ref'), in: 'query' },
      }),
    )
    expect(url).toBe('https://api.example.com/x?api_key=<redacted>')
    expect(url).not.toContain('%3Credacted%3E')
  })

  it('用户 enabled 同名参数存在 → 不追加 Auth Query（§5.6 同源）；镜像 query 先 collapse', () => {
    const overridden = buildCopyUrl(
      req({
        url: 'https://api.example.com/x?api_key=mine',
        auth: { type: 'apikey', key: 'api_key', value: 'sec', in: 'query' },
      }),
    )
    expect(overridden).toBe('https://api.example.com/x?api_key=mine')

    const mirrored = buildCopyUrl(req({ url: 'https://a.example/s?x=1&tag=a', params: [
      { key: 'x', value: '1', enabled: true },
      { key: 'tag', value: 'a', enabled: true },
    ] }))
    expect(mirrored).toBe('https://a.example/s?x=1&tag=a')
  })

  it('params 值中的空格百分号编码，{{模板}} 原样保留（copy 投影专用编码）', () => {
    const url = buildCopyUrl(req({ url: 'https://a.example/s', params: [{ key: 'q', value: 'a b {{t}}', enabled: true }] }))
    expect(url).toBe('https://a.example/s?q=a%20b%20{{t}}')
  })
})

describe('§5.10：安全 cURL', () => {
  it("posixShellQuote：POSIX 单引号转义 'abc'\\''def'", () => {
    expect(posixShellQuote('abc')).toBe(`'abc'`)
    expect(posixShellQuote(`abc'def`)).toBe(`'abc'\\''def'`)
  })

  it('包含 method/URL/enabled 用户 Header/Body/active 安全自动项；disabled 行不进；Auth 派生项以 <redacted> 结构输出（R-06）', () => {
    const curl = buildCurlCommand(
      req({
        method: 'POST',
        url: 'https://api.example.com/x',
        headers: [
          { key: 'X-A', value: '1', enabled: true },
          { key: 'X-Off', value: 'no', enabled: false },
        ],
        auth: { type: 'bearer', token: BEARER_SECRET },
        body: { type: 'json', json: '{"a":1}' },
      }),
    )
    expect(curl.startsWith(`curl -X POST 'https://api.example.com/x'`)).toBe(true)
    expect(curl).toContain(`-H 'X-A: 1'`)
    expect(curl).not.toContain('X-Off')
    expect(curl).toContain(`--data-raw '{"a":1}'`)
    expect(curl).toContain(`-H 'Content-Type: application/json'`)
    expect(curl).toContain(`-H 'Accept: */*'`)
    // R-06（GPT review 裁决 c）：§5.10「必须 redacted」= 值替换为 <redacted>，不是删除结构——
    // 与 Query API Key 的 api_key=<redacted> 形态对称；P0 仍不提供复制已解析 secret 的 cURL。
    expect(curl).toContain(`-H 'Authorization: <redacted>'`)
    expect(curl).not.toContain(BEARER_SECRET)
  })

  it('敏感 Header 名下用户字面量 → <redacted>；secret 环境变量引用（URL/Header/Body）→ <redacted>；普通变量保留', () => {
    const environment = env([
      { key: 's', currentValue: createSecretRef('s-ref'), secret: true, enabled: true },
      { key: 'o', currentValue: 'normal', secret: false, enabled: true },
    ])
    const curl = buildCurlCommand(
      req({
        method: 'POST',
        url: 'https://api.example.com/{{o}}/{{s}}',
        headers: [
          { key: 'Cookie', value: 'sid=plain-literal', enabled: true },
          { key: 'X-Mix', value: '{{o}}:{{s}}', enabled: true },
        ],
        body: { type: 'json', json: '{"credential":"{{s}}","normal":"{{o}}"}' },
      }),
      { environment },
    )
    expect(curl).toContain(`'https://api.example.com/{{o}}/<redacted>'`)
    expect(curl).toContain(`-H 'Cookie: <redacted>'`)
    expect(curl).not.toContain('sid=plain-literal')
    expect(curl).toContain(`-H 'X-Mix: {{o}}:<redacted>'`)
    expect(curl).toContain(`--data-raw '{"credential":"<redacted>","normal":"{{o}}"}'`)
  })

  it('自动项状态与 §5.3 同源：用户覆盖/suppression 时不进 cURL', () => {
    const curl = buildCurlCommand(
      req({
        method: 'POST',
        headers: [{ key: 'content-type', value: 'text/css', enabled: true }],
        body: { type: 'json', json: '{}' },
        suppressedGeneratedHeaders: [{ name: 'accept', source: 'client-default' }],
      }),
    )
    expect(curl).toContain(`-H 'content-type: text/css'`)
    expect(curl.toLowerCase().match(/-h 'content-type/g)).toHaveLength(1) // 自动 CT 被覆盖不重复
    expect(curl).not.toContain('Accept') // 被 suppression
  })

  it('form-data → --form-string 行（curl 发送时自己生成 boundary）：不复制占位 boundary、无 multipart Content-Type', () => {
    const curl = buildCurlCommand(
      req({
        method: 'POST',
        body: {
          type: 'form-data',
          fields: [
            { key: 'a', value: '1', enabled: true },
            { key: 'off', value: 'x', enabled: false },
            { key: 'b', value: "q'2", enabled: true },
          ],
        },
      }),
    )
    expect(curl).toContain(`--form-string 'a=1'`)
    expect(curl).toContain(`--form-string 'b=q'\\''2'`)
    expect(curl).not.toContain('off=x')
    expect(curl).not.toContain('multipart/form-data')
    expect(curl).not.toContain(MULTIPART_BOUNDARY_PLACEHOLDER)
    expect(curl).not.toContain('boundary')
  })

  it('urlencoded → --data-raw 编码对（模板保留）；raw → 字面量', () => {
    const environment = env([{ key: 's', currentValue: createSecretRef('s-ref'), secret: true, enabled: true }])
    const urlencoded = buildCurlCommand(
      req({
        method: 'POST',
        body: { type: 'urlencoded', fields: [{ key: 'k', value: 'a b {{s}}', enabled: true }] },
      }),
      { environment },
    )
    expect(urlencoded).toContain(`--data-raw 'k=a%20b%20<redacted>'`)
    const raw = buildCurlCommand(req({ method: 'POST', body: { type: 'raw', raw: 'plain text' } }))
    expect(raw).toContain(`--data-raw 'plain text'`)
    expect(raw).toContain(`-H 'Content-Type: text/plain'`)
  })
})

describe('R-06 回归（GPT review 裁决 c）：cURL Auth 派生项保留结构、值恒 <redacted>', () => {
  it('apikey in header → -H \'<API-Key-Name（用户拼写）>: <redacted>\'；全程零 SecretRef 解析、输出无 ref/材料/preview 遮罩', () => {
    const curl = buildCurlCommand(
      req({ auth: { type: 'apikey', key: 'X-API-Key', value: createSecretRef('r06-ref'), in: 'header' } }),
    )
    expect(curl).toContain(`-H 'X-API-Key: <redacted>'`)
    expect(curl).not.toContain('r06-ref')
    // cURL 的 secret 占位统一 <redacted>（§5.10），不使用 preview 遮罩形态
    expect(curl).not.toContain(SECRET_VALUE_PREVIEW)
  })

  it('basic → Authorization 结构保留、值 <redacted>；username 不进 cURL', () => {
    const curl = buildCurlCommand(
      req({ auth: { type: 'basic', username: 'alice', password: createSecretRef('r06-basic') } }),
    )
    expect(curl).toContain(`-H 'Authorization: <redacted>'`)
    expect(curl).not.toContain('alice')
    expect(curl).not.toContain('r06-basic')
  })

  it('被用户 Header 覆盖时只输出用户行的安全版本：Authorization 恰出现一次且为 <redacted>', () => {
    const curl = buildCurlCommand(
      req({
        auth: { type: 'bearer', token: BEARER_SECRET },
        headers: [{ key: 'Authorization', value: `Bearer ${BEARER_SECRET}`, enabled: true }],
      }),
    )
    expect(curl.match(/Authorization/g)).toHaveLength(1)
    expect(curl).toContain(`-H 'Authorization: <redacted>'`)
    expect(curl).not.toContain(BEARER_SECRET)
  })

  it('apikey in query → Header 区无 Auth 条目，URL 保留 api_key=<redacted> 结构（与 Header 形态对称）', () => {
    const curl = buildCurlCommand(
      req({ auth: { type: 'apikey', key: 'api_key', value: createSecretRef('r06-q-ref'), in: 'query' } }),
    )
    expect(curl).toContain(`'https://api.example.com/x?api_key=<redacted>'`)
    expect(curl).not.toContain(`-H 'api_key`)
    expect(curl).not.toContain('r06-q-ref')
  })

  it('auth none → 无 Auth 条目；inherit → 经 collection 链得出目标名后同样 <redacted>', () => {
    const none = buildCurlCommand(req({}))
    expect(none).not.toContain('Authorization')
    const inherited = buildCurlCommand(
      req({ auth: { type: 'inherit' } }),
      {
        collection: {
          id: 'c1',
          name: 'c',
          auth: { type: 'bearer', token: createSecretRef('r06-inh-ref') },
          variables: [],
          folders: [],
          requests: [],
          createdAt: 0,
          updatedAt: 0,
        },
      },
    )
    expect(inherited).toContain(`-H 'Authorization: <redacted>'`)
    expect(inherited).not.toContain('r06-inh-ref')
  })
})
