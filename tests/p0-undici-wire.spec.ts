// @vitest-environment node
/**
 * P0 WP2：undici wire consistency + runtime capability（实施设计 §8.1.1/§8.1.2、§0.6；
 * UX §6.3/§6.4）。测试内启动本地 node:http echo server（随机端口、afterAll 关闭），
 * 用真实 executeRequest → undici@8.x 链路固化实际 wire 行为——不新增任何代理/抓包依赖。
 *
 * §8.1.1 必验项：
 * - user Content-Type > body Content-Type；
 * - user Authorization > Auth contribution；
 * - suppressed Accept 不发送；
 * - suppressed Body Content-Type 不发送；
 * - Query API Key 被用户同名 query 覆盖；
 * - 重复用户 Header 的实际 undici 行为；
 * - multipart boundary == body 实际使用的 boundary。
 *
 * §8.1.2 runtime capability（Host / Content-Length / Accept-Encoding 的真实探测，
 * 结论固化进 plan.ts 的 RUNTIME_HEADER_CATALOG——禁止因「通常 HTTP 会这样」硬编码）：
 * - host：每个请求实际发送；用户同名 Header 被真实采用（可覆盖）；
 * - content-length：有 body 时自动计算；用户同名值一致时被采用、不一致时
 *   undici 抛 UND_ERR_REQ_CONTENT_LENGTH_MISMATCH（发送前清晰错误，符合 UX §6.3）；
 *   无 body 时不发送（用户提供的值也被丢弃）；
 * - accept-encoding：undici request() 默认不添加 → 不进 runtime catalog；
 * - connection: keep-alive 每次实际发送（记录在案；不在 §8.1.2 点名范围，P0 不收录 catalog）。
 *
 * preview 与 resolved/wire 对比规则（§8.1.1）：普通值逐项一致；secret 值先按
 * redaction 归一化再比较——不得拿 `••••••••` 与 wire 明文直接判「不一致」。
 */
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ApiRequest, NetworkPolicy } from '@dsh-api-client/shared'
import { createSecretRef } from '@dsh-api-client/shared'
import {
  buildRequestPlan,
  DEFAULT_NETWORK_POLICY,
  ExecutorError,
  executeRequest,
  redactHeaders,
  RUNTIME_VALUE_PREVIEW,
  SECRET_VALUE_PREVIEW,
} from '@dsh-api-client/core'

let server: Server
let baseUrl: string
let port: number
let lastRequest: {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  rawHeaders: string[]
  body: string
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      lastRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        rawHeaders: req.rawHeaders,
        body: Buffer.concat(chunks).toString('utf8'),
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  port = (server.address() as AddressInfo).port
  baseUrl = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
})

const LOCAL_POLICY: NetworkPolicy = { ...DEFAULT_NETWORK_POLICY, allowLocalhost: true }

function req(partial: Partial<ApiRequest>): ApiRequest {
  return {
    id: 'wire-r',
    name: 'wire-r',
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

/** rawHeaders（[name, value, name, value, …]，wire 拼写与顺序）→ 对列表。 */
function rawPairs(): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (let i = 0; i + 1 < lastRequest.rawHeaders.length; i += 2) {
    out.push([lastRequest.rawHeaders[i]!, lastRequest.rawHeaders[i + 1]!])
  }
  return out
}

function rawCount(name: string): number {
  const lower = name.toLowerCase()
  return rawPairs().filter(([n]) => n.toLowerCase() === lower).length
}

function rawValues(name: string): string[] {
  const lower = name.toLowerCase()
  return rawPairs().filter(([n]) => n.toLowerCase() === lower).map(([, v]) => v)
}

const WIRE_SECRET = 'wire-bearer-secret-9x2'

describe('§8.1.1：user Content-Type > body Content-Type', () => {
  it('用户小写拼写 content-type 覆盖 json body 推导值：wire 只有一条且为用户值', async () => {
    await executeRequest(
      req({
        method: 'POST',
        url: `${baseUrl}/echo`,
        headers: [{ key: 'content-type', value: 'application/vnd.custom+json', enabled: true }],
        body: { type: 'json', json: '{"a":1}' },
      }),
      { policy: LOCAL_POLICY },
    )
    expect(rawCount('content-type')).toBe(1)
    expect(lastRequest.headers['content-type']).toBe('application/vnd.custom+json')
    expect(lastRequest.body).toBe('{"a":1}') // body 数据不受 Header 覆盖影响
  })
})

describe('§8.1.1：user Authorization > Auth contribution', () => {
  it('用户 enabled Authorization 时 Auth 不追加第二条，secret token 绝不上 wire', async () => {
    const resolveSecret = vi.fn(() => WIRE_SECRET)
    await executeRequest(
      req({
        url: `${baseUrl}/echo`,
        headers: [{ key: 'Authorization', value: 'Bearer user-wins', enabled: true }],
        auth: { type: 'bearer', token: createSecretRef('wire-bearer-ref') },
      }),
      { policy: LOCAL_POLICY, resolveSecret },
    )
    expect(rawCount('authorization')).toBe(1)
    expect(lastRequest.headers['authorization']).toBe('Bearer user-wins')
    // server 侧全量记录（headers/rawHeaders/url/body）无任何 secret 明文
    expect(JSON.stringify(lastRequest)).not.toContain(WIRE_SECRET)
  })

  it('无用户 Authorization 时 Auth 贡献真实上 wire（单条 Bearer）', async () => {
    await executeRequest(
      req({
        url: `${baseUrl}/echo`,
        auth: { type: 'bearer', token: createSecretRef('wire-bearer-ref') },
      }),
      { policy: LOCAL_POLICY, resolveSecret: () => WIRE_SECRET },
    )
    expect(rawCount('authorization')).toBe(1)
    expect(lastRequest.headers['authorization']).toBe(`Bearer ${WIRE_SECRET}`)
  })
})

describe('§8.1.1：suppression 真实不发送', () => {
  it('suppressed Accept 不发送（undici 也不会自动补）', async () => {
    await executeRequest(
      req({
        url: `${baseUrl}/echo`,
        suppressedGeneratedHeaders: [{ name: 'accept', source: 'client-default' }],
      }),
      { policy: LOCAL_POLICY },
    )
    expect(rawCount('accept')).toBe(0)
  })

  it('suppressed Body Content-Type 不发送，body 数据照常', async () => {
    await executeRequest(
      req({
        method: 'POST',
        url: `${baseUrl}/echo`,
        body: { type: 'json', json: '{"a":1}' },
        suppressedGeneratedHeaders: [{ name: 'content-type', source: 'body' }],
      }),
      { policy: LOCAL_POLICY },
    )
    expect(rawCount('content-type')).toBe(0)
    expect(lastRequest.body).toBe('{"a":1}')
  })
})

describe('§8.1.1：Query API Key 被用户同名 query 覆盖', () => {
  const auth = { type: 'apikey', key: 'api_key', value: 'wire-query-secret-1', in: 'query' } as const

  it('用户 enabled 同名参数 → wire URL 只有用户值', async () => {
    await executeRequest(
      req({
        url: `${baseUrl}/echo`,
        params: [{ key: 'api_key', value: 'user-val', enabled: true }],
        auth,
      }),
      { policy: LOCAL_POLICY },
    )
    expect(lastRequest.url).toBe('/echo?api_key=user-val')
    expect(JSON.stringify(lastRequest)).not.toContain('wire-query-secret-1')
  })

  it('无同名用户参数 → auth query 真实追加', async () => {
    await executeRequest(req({ url: `${baseUrl}/echo`, auth }), { policy: LOCAL_POLICY })
    expect(lastRequest.url).toBe('/echo?api_key=wire-query-secret-1')
  })
})

describe('§8.1.1/§5.4：重复用户 Header 的实际 undici 行为（集成固化，不承诺协议不允许的语义）', () => {
  it('两个 enabled 同名（大小写不同拼写）行 → 聚合为单一 wire key（第一行拼写），按用户顺序发两行', async () => {
    await executeRequest(
      req({
        url: `${baseUrl}/echo`,
        headers: [
          { key: 'X-Foo', value: 'a', enabled: true },
          { key: 'x-foo', value: 'b', enabled: true },
        ],
      }),
      { policy: LOCAL_POLICY },
    )
    const pairs = rawPairs().filter(([n]) => n.toLowerCase() === 'x-foo')
    // undici 实际行为：重复 Header 以两条独立行发送，拼写=用户第一行，顺序=用户顺序
    expect(pairs).toEqual([
      ['X-Foo', 'a'],
      ['X-Foo', 'b'],
    ])
    // node http server 对可重复 Header 的合并形态（', ' 连接）——固化观测事实，非本项目承诺
    expect(lastRequest.headers['x-foo']).toBe('a, b')
  })
})

describe('§8.1.1：multipart boundary == body 实际使用的 boundary', () => {
  it('Send 路径随机 boundary：Content-Type 声明值与 body 分隔符一致（同一次 encoder 生成）', async () => {
    await executeRequest(
      req({
        method: 'POST',
        url: `${baseUrl}/echo`,
        body: {
          type: 'form-data',
          fields: [
            { key: 'field1', value: 'value1', enabled: true },
            { key: 'field2', value: 'v2', enabled: true },
          ],
        },
      }),
      { policy: LOCAL_POLICY },
    )
    const ct = String(lastRequest.headers['content-type'] ?? '')
    const declared = /^multipart\/form-data; boundary=(.+)$/.exec(ct)?.[1]
    expect(declared, `wire Content-Type 应声明 boundary：${ct}`).toBeTruthy()
    expect(lastRequest.body).toContain(`--${declared}\r\n`)
    expect(lastRequest.body).toContain(`--${declared}--\r\n`)
    expect(lastRequest.body).toContain('name="field1"')
  })
})

describe('§8.1.2：runtime Header capability 探测（catalog 收录依据，undici@8.x + executeHop 调用方式）', () => {
  it('GET 无 body：实际发送 host + connection；不发送 content-length、不发送 accept-encoding', async () => {
    await executeRequest(req({ url: `${baseUrl}/echo` }), { policy: LOCAL_POLICY })
    expect(lastRequest.headers['host']).toBe(`127.0.0.1:${port}`)
    expect(lastRequest.headers['connection']).toBe('keep-alive') // 观测记录；不进 P0 catalog（设计只点名三项）
    expect(rawCount('content-length')).toBe(0)
    // accept-encoding：undici request() 默认不添加 → RUNTIME_HEADER_CATALOG 不收录（不伪造展示）
    expect(rawCount('accept-encoding')).toBe(0)
  })

  it('POST 有 body：content-length 由 undici 自动计算发送', async () => {
    await executeRequest(
      req({ method: 'POST', url: `${baseUrl}/echo`, body: { type: 'json', json: '{"a":1}' } }),
      { policy: LOCAL_POLICY },
    )
    expect(lastRequest.headers['content-length']).toBe(String(Buffer.byteLength('{"a":1}')))
  })

  it('用户 Host Header 被 undici 真实采用（→ catalog userOverridable=true）', async () => {
    await executeRequest(
      req({ url: `${baseUrl}/echo`, headers: [{ key: 'Host', value: 'custom.example', enabled: true }] }),
      { policy: LOCAL_POLICY },
    )
    expect(rawCount('host')).toBe(1)
    expect(lastRequest.headers['host']).toBe('custom.example')
  })

  it('用户 Content-Length 与 body 一致 → 被采用（单条）；→ catalog userOverridable=true', async () => {
    await executeRequest(
      req({
        method: 'POST',
        url: `${baseUrl}/echo`,
        headers: [{ key: 'content-length', value: '7', enabled: true }],
        body: { type: 'json', json: '{"a":1}' },
      }),
      { policy: LOCAL_POLICY },
    )
    expect(rawCount('content-length')).toBe(1)
    expect(lastRequest.headers['content-length']).toBe('7')
  })

  it('用户 Content-Length 与 body 不一致 → undici 发送前清晰报错（UX §6.3 允许的「报清晰错误」路径）', async () => {
    const failure = await executeRequest(
      req({
        method: 'POST',
        url: `${baseUrl}/echo`,
        headers: [{ key: 'content-length', value: '3', enabled: true }],
        body: { type: 'json', json: '{"a":1}' },
      }),
      { policy: LOCAL_POLICY },
    ).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(ExecutorError)
    expect((failure as ExecutorError).kind).toBe('network')
    expect((failure as Error).message.toLowerCase()).toContain('content-length')
  })

  it('无 body 时用户 content-length 被 undici 丢弃（观测记录：appliesWhen=has-body 的依据）', async () => {
    await executeRequest(
      req({ url: `${baseUrl}/echo`, headers: [{ key: 'content-length', value: '0', enabled: true }] }),
      { policy: LOCAL_POLICY },
    )
    expect(rawCount('content-length')).toBe(0)
  })
})

describe('§8.1.1：preview 与 resolved/wire 三方对比（普通值逐项一致；secret 先 redaction 归一化再比较）', () => {
  it('同一请求：preview 安全投影 ↔ resolved plan ↔ echo server 实收', async () => {
    const request = req({
      method: 'POST',
      url: `${baseUrl}/echo?fixed=1`,
      params: [{ key: 'page', value: '2', enabled: true }],
      headers: [{ key: 'X-Trace', value: 'v1', enabled: true }],
      auth: { type: 'bearer', token: createSecretRef('cmp-bearer-ref') },
      body: { type: 'json', json: '{"a":1}' },
      suppressedGeneratedHeaders: [{ name: 'accept', source: 'client-default' }],
    })

    // preview：resolveSecret 绝不触发（红线 3）
    const previewSpy = vi.fn(() => WIRE_SECRET)
    const previewPlan = await buildRequestPlan(request, { mode: 'preview', resolveSecret: previewSpy })
    expect(previewSpy).not.toHaveBeenCalled()

    // 真实执行（tracking resolveSecret 供 redaction 归一化）
    const secretValues = new Map<string, string>()
    await executeRequest(request, {
      policy: LOCAL_POLICY,
      resolveSecret: (ref) => {
        secretValues.set(ref.$ref, WIRE_SECRET)
        return WIRE_SECRET
      },
    })

    // resolved plan（与执行同一 primitive、同一输入；json body 无随机成分 → 可逐项对比）
    const resolvedPlan = await buildRequestPlan(request, { mode: 'resolved', resolveSecret: () => WIRE_SECRET })
    expect(resolvedPlan.preview.headers).toEqual(previewPlan.preview.headers)
    expect(resolvedPlan.preview.query).toEqual(previewPlan.preview.query)

    // URL：resolved plan 与 wire 实收一致
    expect(new URL(resolvedPlan.resolved.url).pathname + new URL(resolvedPlan.resolved.url).search).toBe(
      lastRequest.url,
    )

    for (const previewItem of previewPlan.preview.headers) {
      const observed = rawValues(previewItem.name)
      if (previewItem.source === 'runtime') {
        // §0.6：runtime 项 preview 恒「发送时计算」，绝不与 wire 值做字面比较；
        // 只断言 transport 真实行为存在性（host/content-length 确实由 undici 发送）。
        expect(previewItem.valuePreview).toBe(RUNTIME_VALUE_PREVIEW)
        expect(previewItem.status).toBe('runtime-pending')
        expect(observed.length, `${previewItem.name} 应真实由 undici 发送`).toBe(1)
        continue
      }
      if (previewItem.status === 'suppressed' || previewItem.status === 'overridden') {
        // 被停用/被覆盖的 Generated 项绝不以生成值上 wire
        expect(observed.some((v) => v === previewItem.valuePreview && previewItem.valuePreview !== SECRET_VALUE_PREVIEW)).toBe(false)
        continue
      }
      // status === 'active'
      if (previewItem.sensitive) {
        // secret 值先按 redaction 归一化再比较：wire 是明文（发送所需），
        // preview 是遮罩占位——两个脱敏出口互不等值，但都不得含明文。
        expect(observed).toEqual([`Bearer ${WIRE_SECRET}`])
        expect(previewItem.valuePreview).toBe(SECRET_VALUE_PREVIEW)
        const normalized = redactHeaders([{ key: previewItem.name, value: observed[0]!, enabled: true }], {
          secretValues,
        })
        expect(normalized[0]?.value).toBe('<redacted>')
        expect(JSON.stringify(previewPlan)).not.toContain(WIRE_SECRET)
      } else {
        // 普通值逐项一致：preview 值 === wire 实收值（唯一例外 form-data boundary
        // 占位符，属 §5.7 设计内差异，本请求用 json body 不涉及）
        expect(observed, `${previewItem.name} 普通值应与 preview 一致`).toEqual([previewItem.valuePreview])
      }
    }

    // suppressed Accept 与用户 X-Trace 的 wire 事实
    expect(rawCount('accept')).toBe(0)
    expect(lastRequest.headers['x-trace']).toBe('v1')
  })
})
