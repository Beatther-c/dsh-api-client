// @vitest-environment node
/**
 * WP7 Context Bridge：buildSafeApiDebugContext / renderSafeApiDebugContextMarkdown 纯函数单测
 *（V01 §4.1/§5.3，DESIGN §14.1–14.4，AC-24/AC-30 支撑）。
 *
 * 覆盖任务书要求的六个面：
 * 1. secret 投影不被解析（`<secret-ref:key>` 恒展示形态、SecretRef 材料不落结构）；
 * 2. 敏感头恒 `<redacted>`（request draft 与 response 两侧）；
 * 3. redactionSummary 内容正确（§14.4 弹窗 ✓/✗ 清单数据源，动态生成）；
 * 4. 敏感 response body 默认排除 / 勾选纳入两态（§14.4）；
 * 5. requestEcho（host 脱敏快照）优先于 draft 本地重建；
 * 6. 注入文本渲染 grep 无 secret 值（TC-UI-17 的自动化半壁）。
 */
import { describe, expect, it } from 'vitest'
import type { HttpExecutionResult, RedactedRequestSnapshot, RedactedResponseSnapshot } from '@dsh-api-client/shared'
import { createSecretRef } from '@dsh-api-client/shared'
import type { BuildSafeApiDebugContextInput } from '@dsh-api-client/core'
import { buildSafeApiDebugContext, renderSafeApiDebugContextMarkdown } from '@dsh-api-client/core'

const SECRET_HEADER_VALUE = 'super-secret-token-123'
const SECRET_QUERY_VALUE = 'query-secret-456'
const SECRET_REF_ID = 'ref-uuid-789'

function baseInput(): BuildSafeApiDebugContextInput {
  return {
    requestName: 'List Users',
    draft: {
      method: 'GET',
      url: `https://api.example.com/users?api_key=${SECRET_QUERY_VALUE}&page=1`,
      headers: [
        { key: 'Authorization', value: `Bearer ${SECRET_HEADER_VALUE}`, enabled: true },
        { key: 'X-Custom', value: '<secret-ref:prod.custom>', enabled: true },
        { key: 'Accept', value: 'application/json', enabled: true },
      ],
      body: { type: 'json', json: '{"filter":"active"}' },
      auth: { type: 'apikey', key: 'api_key', value: createSecretRef(SECRET_REF_ID), in: 'query' },
    },
  }
}

function sampleResponse(): HttpExecutionResult {
  return {
    status: 200,
    statusText: 'OK',
    headers: [
      { key: 'Content-Type', value: 'application/json', enabled: true },
      { key: 'Set-Cookie', value: 'sid=cookie-secret-000; Path=/', enabled: true },
    ],
    cookies: [{ key: 'sid', value: 'cookie-secret-000', enabled: true }],
    bodyText: '{"users":[],"token":"server-echo-value"}',
    bodyKind: 'json',
    size: 42,
    durationMs: 123,
    redirected: false,
    finalUrl: 'https://api.example.com/users',
  }
}

describe('buildSafeApiDebugContext：request 侧脱敏（draft 本地重建路径）', () => {
  it('敏感头恒 <redacted>；apikey in query 恒 <redacted> 且其余 query 保留', () => {
    const safe = buildSafeApiDebugContext(baseInput())
    const auth = safe.request.headers.find((h) => h.key === 'Authorization')
    expect(auth?.value).toBe('<redacted>')
    expect(safe.request.displayUrl).toBe('https://api.example.com/users?api_key=<redacted>&page=1')
    expect(safe.request.headers.find((h) => h.key === 'Accept')?.value).toBe('application/json')
  })

  it('auth 材料不落结构（只留 type；SecretRef $ref 不出现）', () => {
    const safe = buildSafeApiDebugContext(baseInput())
    expect(safe.request.auth).toEqual({ type: 'apikey' })
    const serialized = JSON.stringify(safe)
    expect(serialized).not.toContain(SECRET_REF_ID)
    expect(serialized).not.toContain(SECRET_HEADER_VALUE)
    expect(serialized).not.toContain(SECRET_QUERY_VALUE)
  })

  it('SecretRef 展示形态恒 <secret-ref:key>，绝不解析', () => {
    const safe = buildSafeApiDebugContext(baseInput())
    expect(safe.request.headers.find((h) => h.key === 'X-Custom')?.value).toBe('<secret-ref:prod.custom>')
  })

  it('request body 预览纳入（draft json 原文；无 secret 可泄）', () => {
    const safe = buildSafeApiDebugContext(baseInput())
    expect(safe.request.bodyPreview).toBe('{"filter":"active"}')
  })
})

describe('buildSafeApiDebugContext：requestEcho 优先（host 脱敏快照）', () => {
  it('有 echo 时 displayUrl/headers/auth 全部取 echo，不取 draft', () => {
    const echo: RedactedRequestSnapshot = {
      method: 'POST',
      displayUrl: 'https://api.example.com/echoed?token=<redacted>',
      headers: [{ key: 'Authorization', value: '<redacted>', enabled: true }],
      bodyPreview: '{"ok":true}',
      auth: { type: 'bearer' },
    }
    const input = baseInput()
    const safe = buildSafeApiDebugContext({ ...input, requestEcho: echo })
    expect(safe.request.displayUrl).toBe('https://api.example.com/echoed?token=<redacted>')
    expect(safe.request.method).toBe('POST')
    expect(safe.request.auth).toEqual({ type: 'bearer' })
    expect(safe.request.name).toBe('List Users')
  })
})

describe('buildSafeApiDebugContext：responseEcho 优先（WP8 C-1，host 跟踪脱敏快照）', () => {
  /** 模拟 host /execute 的 responseEcho：body 中回显的 secret 已被 secretValues 定点替换。 */
  function sampleResponseEcho(): RedactedResponseSnapshot {
    return {
      status: 200,
      statusText: 'OK',
      headers: [{ key: 'Content-Type', value: 'application/json', enabled: true }],
      bodyPreview: `{"echoedAuth":"Bearer <redacted>"}`,
      size: 42,
      durationMs: 123,
    }
  }

  it('勾选纳入 body 时取 echo 的 bodyPreview——原始 response body 中回显的 secret 不出域', () => {
    // 关键残余面：echo server 把请求头（含已解析 secret）回显进 response body；
    // client 本地脱敏没有 secretValues 跟踪，只有 host echo 能定点消除。
    const rawResponse: HttpExecutionResult = {
      ...sampleResponse(),
      bodyText: `{"echoedAuth":"Bearer ${SECRET_HEADER_VALUE}"}`,
    }
    const safe = buildSafeApiDebugContext({
      ...baseInput(),
      response: rawResponse,
      responseEcho: sampleResponseEcho(),
      includeResponseBody: true,
    })
    expect(safe.response?.bodyPreview).toBe('{"echoedAuth":"Bearer <redacted>"}')
    const rendered = renderSafeApiDebugContextMarkdown(safe)
    expect(rendered).not.toContain(SECRET_HEADER_VALUE)
    expect(rendered).toContain('Bearer <redacted>')
  })

  it('responseEcho 与 response 同时在场时 echo 全胜（status/headers/duration 也取 echo）', () => {
    const echo = { ...sampleResponseEcho(), status: 201, durationMs: 7 }
    const safe = buildSafeApiDebugContext({ ...baseInput(), response: sampleResponse(), responseEcho: echo })
    expect(safe.response?.status).toBe(201)
    expect(safe.response?.durationMs).toBe(7)
    // 原始 response 的 Set-Cookie 等原始头不进结构（echo 只有 Content-Type）
    expect(safe.response?.headers.some((h) => h.key === 'Set-Cookie')).toBe(false)
  })

  it('未勾选 body：echo 的 bodyPreview 同样省略（§14.4 默认不注入语义不变）', () => {
    const safe = buildSafeApiDebugContext({ ...baseInput(), responseEcho: sampleResponseEcho() })
    expect(safe.response?.bodyPreview).toBeUndefined()
    expect(safe.response?.status).toBe(200)
    expect(safe.redactionSummary.some((line) => line.startsWith('✗ Response body'))).toBe(true)
  })

  it('echo bodyPreview 为空：勾选也无 bodyPreview（无可注入内容）', () => {
    const echo = sampleResponseEcho()
    delete echo.bodyPreview
    const safe = buildSafeApiDebugContext({ ...baseInput(), responseEcho: echo, includeResponseBody: true })
    expect(safe.response?.bodyPreview).toBeUndefined()
  })
})

describe('buildSafeApiDebugContext：response 侧与 §14.4 敏感 body 两态', () => {
  it('response 敏感头（Set-Cookie）恒 <redacted>', () => {
    const safe = buildSafeApiDebugContext({ ...baseInput(), response: sampleResponse() })
    expect(safe.response?.headers.find((h) => h.key === 'Set-Cookie')?.value).toBe('<redacted>')
    expect(safe.response?.headers.find((h) => h.key === 'Content-Type')?.value).toBe('application/json')
  })

  it('敏感 response body 默认排除：bodyPreview 省略，清单标 ✗', () => {
    const safe = buildSafeApiDebugContext({ ...baseInput(), response: sampleResponse() })
    expect(safe.response?.bodyPreview).toBeUndefined()
    expect(JSON.stringify(safe)).not.toContain('server-echo-value')
    expect(safe.redactionSummary.some((line) => line.startsWith('✗ Response body'))).toBe(true)
  })

  it('用户勾选后纳入：bodyPreview 出现（脱敏投影），清单翻 ✓', () => {
    const safe = buildSafeApiDebugContext({ ...baseInput(), response: sampleResponse(), includeResponseBody: true })
    expect(safe.response?.bodyPreview).toBe('{"users":[],"token":"server-echo-value"}')
    expect(safe.redactionSummary.some((line) => line.startsWith('✓ Response body'))).toBe(true)
    expect(safe.redactionSummary.some((line) => line.startsWith('✗ Response body'))).toBe(false)
  })

  it('空 body 响应：勾选也无 bodyPreview（无可注入内容）', () => {
    const response = { ...sampleResponse(), bodyText: '' }
    const safe = buildSafeApiDebugContext({ ...baseInput(), response, includeResponseBody: true })
    expect(safe.response?.bodyPreview).toBeUndefined()
  })
})

describe('buildSafeApiDebugContext：redactionSummary 与元数据', () => {
  it('§14.4 四要素动态生成：✓ Request / ✓ Environment 名称 / ✗ Secret 明文', () => {
    const safe = buildSafeApiDebugContext({
      ...baseInput(),
      environmentName: 'production',
      execution: { historyId: 'h_1', durationMs: 123, source: 'human' },
    })
    const summary = safe.redactionSummary.join('\n')
    expect(summary).toContain('✓ Request metadata')
    expect(summary).toContain('✓ Environment 名称：production')
    expect(summary).toContain('✓ Execution metadata')
    expect(summary).toContain('✗ Secret 明文')
    expect(summary).toContain('✓ Auth 类型：apikey')
  })

  it('无环境/无执行：对应 ✓ 行缺席（清单反映真实出域内容）', () => {
    const safe = buildSafeApiDebugContext(baseInput())
    const summary = safe.redactionSummary.join('\n')
    expect(summary).not.toContain('Environment 名称')
    expect(summary).not.toContain('Execution metadata')
    expect(summary).not.toContain('Response')
    expect(safe.response).toBeUndefined()
    expect(safe.environmentName).toBeUndefined()
  })

  it('无执行时允许仅发请求上下文（§5.3）', () => {
    const safe = buildSafeApiDebugContext(baseInput())
    expect(safe.request.method).toBe('GET')
    expect(safe.response).toBeUndefined()
    expect(safe.redactionSummary.length).toBeGreaterThan(0)
  })
})

describe('renderSafeApiDebugContextMarkdown：注入文本渲染', () => {
  it('grep 无 secret 值：header 材料 / query 材料 / SecretRef id / 默认排除的 body', () => {
    const safe = buildSafeApiDebugContext({
      ...baseInput(),
      response: sampleResponse(),
      environmentName: 'production',
      execution: { historyId: 'h_1', durationMs: 123, source: 'human' },
    })
    const text = renderSafeApiDebugContextMarkdown(safe)
    expect(text).not.toContain(SECRET_HEADER_VALUE)
    expect(text).not.toContain(SECRET_QUERY_VALUE)
    expect(text).not.toContain(SECRET_REF_ID)
    expect(text).not.toContain('cookie-secret-000')
    expect(text).not.toContain('server-echo-value')
    // 脱敏标记在场（TC-UI-17 注入内容可读性）
    expect(text).toContain('<redacted>')
    expect(text).toContain('<secret-ref:prod.custom>')
    expect(text).toContain('production')
    expect(text).toContain('✗ Secret 明文')
    expect(text).toContain('historyId=h_1')
  })

  it('勾选纳入 body 后渲染含 body 文本（用户显式授权的出域）', () => {
    const safe = buildSafeApiDebugContext({ ...baseInput(), response: sampleResponse(), includeResponseBody: true })
    const text = renderSafeApiDebugContextMarkdown(safe)
    expect(text).toContain('server-echo-value')
    expect(text).toContain('✓ Response body')
  })

  it('默认排除 body 时渲染显式标注「未包含」（降级可见，不静默）', () => {
    const safe = buildSafeApiDebugContext({ ...baseInput(), response: sampleResponse() })
    const text = renderSafeApiDebugContextMarkdown(safe)
    expect(text).toContain('未包含')
  })
})
