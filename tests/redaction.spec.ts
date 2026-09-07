// @vitest-environment node
/**
 * TC-R-01…12：全链路 Redaction（§6.2，§24.2/§24.6，AC-28/29/30/31/42）。
 * TC-R-10 需要真实执行，故本文件整体在 node 环境运行。
 */
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ApiRequest, HttpExecutionResult, NetworkPolicy, Variable } from '@dsh-api-client/shared'
import { createSecretRef, formatSecretRef, parseSecretRefDisplay } from '@dsh-api-client/shared'
import type { ImportAdapter } from '@dsh-api-client/core'
import {
  DEFAULT_NETWORK_POLICY,
  DEFAULT_SENSITIVE_HEADERS,
  ExecutorError,
  createCollection,
  executeRequest,
  isSensitiveHeader,
  projectEnvironment,
  redactAuthConfig,
  redactBodyText,
  redactHeaders,
  redactOutboundText,
  redactRequestSnapshot,
  redactResponseSnapshot,
  redactText,
  redactUrl,
  runImportPipeline,
  sanitizeErrorMessage,
} from '@dsh-api-client/core'

describe('TC-R-01: §24.6 五个默认敏感头（大小写混合）→ 全部 <redacted>', () => {
  it('Authorization/Cookie/Set-Cookie/X-API-Key/Proxy-Authorization 大小写不敏感', () => {
    expect(DEFAULT_SENSITIVE_HEADERS).toHaveLength(5)
    const out = redactHeaders([
      { key: 'Authorization', value: 'Bearer abc', enabled: true },
      { key: 'AUTHORIZATION', value: 'Bearer abc', enabled: true },
      { key: 'cookie', value: 'sid=1', enabled: true },
      { key: 'Set-Cookie', value: 'sid=2; Path=/', enabled: true },
      { key: 'X-Api-Key', value: 'k-9', enabled: true },
      { key: 'proxy-authorization', value: 'Basic zzz', enabled: true },
      { key: 'X-Normal', value: 'keep-me', enabled: true },
    ])
    for (const h of out.filter((h) => isSensitiveHeader(h.key))) {
      expect(h.value).toBe('<redacted>')
    }
    expect(out.find((h) => h.key === 'X-Normal')?.value).toBe('keep-me')
  })

  it('调用方追加敏感头同样生效', () => {
    const out = redactHeaders([{ key: 'X-Custom-Secret', value: 'v', enabled: true }], {
      extraSensitiveHeaders: ['x-custom-secret'],
    })
    expect(out[0]?.value).toBe('<redacted>')
  })
})

describe('TC-R-02/03: auth config 投影只留 type', () => {
  it('TC-R-02: bearer token（含 SecretRef）→ 投影只剩 {type:bearer}', () => {
    const projection = redactAuthConfig({ type: 'bearer', token: createSecretRef('bearer-ref-id') })
    expect(projection).toEqual({ type: 'bearer' })
    const serialized = JSON.stringify(projection)
    expect(serialized).not.toContain('bearer-ref-id')
    expect(serialized).not.toContain('token')

    const plainProjection = redactAuthConfig({ type: 'bearer', token: 'plain-token-value' })
    expect(JSON.stringify(plainProjection)).not.toContain('plain-token-value')
  })

  it('TC-R-03: basic credentials → 不落任何快照', () => {
    const projection = redactAuthConfig({ type: 'basic', username: 'alice', password: 'wonderland' })
    expect(projection).toEqual({ type: 'basic' })
    const snapshot = redactRequestSnapshot(
      { method: 'GET', url: 'https://a.example/x', headers: [], secretValueTraces: [] },
      undefined,
      { auth: { type: 'basic', username: 'alice', password: 'wonderland' } },
    )
    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toContain('alice')
    expect(serialized).not.toContain('wonderland')
  })
})

describe('TC-R-04/05: URL 中的 secret 脱敏', () => {
  it('TC-R-04: apikey in query → 该参数值 <redacted>，其余 query 保留', () => {
    const out = redactUrl('https://a.example/x?api_key=sekret-1&keep=1&other=two', undefined, {
      auth: { type: 'apikey', key: 'api_key', value: 'sekret-1', in: 'query' },
    })
    expect(out).toBe('https://a.example/x?api_key=<redacted>&keep=1&other=two')
  })

  it('TC-R-05: URL userinfo / path 中 secret trace 值 → <redacted>（含编码形态）', () => {
    const secretValues = new Map([
      ['ref-pass', 'p@ss'],
      ['ref-path', 'secret-value-xyz'],
    ])
    const out = redactUrl('https://user:p%40ss@api.example.com/p/secret-value-xyz?q=1', { secretValues })
    expect(out).toBe('https://user:<redacted>@api.example.com/p/<redacted>?q=1')
    expect(out).not.toContain('p%40ss')
    expect(out).not.toContain('secret-value-xyz')
  })
})

describe('TC-R-06: JSON / form body 中 secret 解析值 → <redacted>（含嵌套 JSON 路径）', () => {
  it('嵌套 JSON 与 form 序列化文本中的 secret 值均被替换', () => {
    const secretValues = new Map([['ref-1', 'secret-deep-1']])
    expect(redactBodyText('{"outer":{"inner":{"token":"secret-deep-1"}},"ok":1}', { secretValues })).toBe(
      '{"outer":{"inner":{"token":"<redacted>"}},"ok":1}',
    )
    expect(redactBodyText('k=secret-deep-1&x=1', { secretValues })).toBe('k=<redacted>&x=1')
  })
})

describe('TC-R-07: response 用户声明敏感字段 / 整体敏感', () => {
  const result: HttpExecutionResult = {
    status: 200,
    statusText: 'OK',
    headers: [],
    cookies: [],
    bodyText: '{"token":"abc","keep":1,"nested":{"token":"xyz"}}',
    bodyKind: 'json',
    size: 44,
    durationMs: 5,
    redirected: false,
    finalUrl: 'https://a.example/x',
  }

  it('声明字段（含嵌套）→ <redacted>，其余保留', () => {
    const snapshot = redactResponseSnapshot(result, undefined, { sensitiveFields: ['token'] })
    const body = JSON.parse(snapshot.bodyPreview ?? '{}') as Record<string, unknown>
    expect(body['token']).toBe('<redacted>')
    expect(body['keep']).toBe(1)
    expect((body['nested'] as Record<string, unknown>)['token']).toBe('<redacted>')
  })

  it('整体声明敏感 → bodyPreview 省略', () => {
    const snapshot = redactResponseSnapshot(result, undefined, { wholeBodySensitive: true })
    expect(snapshot.bodyPreview).toBeUndefined()
    expect('bodyPreview' in snapshot).toBe(false)
    expect(snapshot.status).toBe(200)
  })
})

describe('TC-R-08: SecretRef 投影一律 <secret-ref:envKey>，不解析', () => {
  it('environment 投影中 secret 变量只展示 <secret-ref:key>', () => {
    const ref = createSecretRef('opaque-uuid-1')
    const secretVariable: Variable = { key: 'api_key', currentValue: ref, secret: true, enabled: true }
    const projected = projectEnvironment({ id: 'e1', name: 'prod', variables: [secretVariable] })
    expect(projected.variables[0]?.currentValue).toBe('<secret-ref:api_key>')
    const serialized = JSON.stringify(projected)
    expect(serialized).not.toContain('opaque-uuid-1')
    expect(serialized).not.toContain('$ref')
    expect(formatSecretRef('prod.api_key')).toBe('<secret-ref:prod.api_key>')
    expect(parseSecretRefDisplay('<secret-ref:prod.api_key>')).toBe('prod.api_key')
    expect(parseSecretRefDisplay('plain')).toBeNull()
  })
})

describe('TC-R-09: executor 抛错 → error.message 经 redactor，不含 secret 值', () => {
  function req(url: string): ApiRequest {
    return {
      id: 'r1',
      name: 'r',
      method: 'GET',
      url,
      params: [],
      headers: [{ key: 'X-Secret', value: '{{s}}', enabled: true }],
      auth: { type: 'none' },
      body: { type: 'none' },
      collectionId: 'c1',
      createdAt: 0,
      updatedAt: 0,
    }
  }

  const secretValue = 'error-leak-secret-6e5'

  function secretCtx() {
    return {
      environment: {
        id: 'e1',
        name: 'dev',
        variables: [{ key: 's', currentValue: createSecretRef('err-ref'), secret: true, enabled: true }],
      },
      resolveSecret: () => secretValue,
    }
  }

  it('底层错误 message 嵌入 secret（URL/headers 泄漏形态）→ 出场前被抹除', async () => {
    const failure = await executeRequest(req('https://public.example/x'), {
      ...secretCtx(),
      transport: (wire) => {
        // 模拟底层传输错误把 URL/headers 写进 message（最坏泄漏形态）
        throw new Error(`connect failed: ${wire.url} ${JSON.stringify(wire.headers)}`)
      },
    }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).not.toContain(secretValue)
    expect((failure as Error).message).toContain('<redacted>')
  })

  it('network-policy 拒绝 → ExecutorError 且 message 无 secret；sanitizeErrorMessage 独立可用', async () => {
    const failure = await executeRequest(req('http://127.0.0.1:9/x'), {
      ...secretCtx(),
      policy: DEFAULT_NETWORK_POLICY, // fail-closed：localhost 拒
    }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(ExecutorError)
    expect((failure as ExecutorError).kind).toBe('network-policy-denied')
    expect((failure as Error).message).not.toContain(secretValue)

    expect(sanitizeErrorMessage(`dial failed for ${secretValue}`, { secretValues: [secretValue] })).toBe(
      'dial failed for <redacted>',
    )
  })
})

describe('TC-R-10: 完整执行 → 落盘 history.jsonl 全文无已解析 secret 值', () => {
  const SECRET_HEADER = 'r10-header-secret-a11'
  const SECRET_QUERY = 'r10-query-secret-b22'
  const SECRET_BODY = 'r10-body-secret-c33'

  let server: Server
  let baseUrl: string

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        res.writeHead(200, {
          'content-type': 'application/json',
          'set-cookie': `session=${SECRET_HEADER}; Path=/; HttpOnly`,
        })
        res.end(JSON.stringify({ echo: Buffer.concat(chunks).toString('utf8'), url: req.url }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  it('header/query/body 三处 secret + Set-Cookie → history JSONL 行 grep 不到任何明文', async () => {
    const policy: NetworkPolicy = { ...DEFAULT_NETWORK_POLICY, allowLocalhost: true }
    const jsonlLines: string[] = []
    const { result, history } = await executeRequest(
      {
        id: 'r10',
        name: 'r10',
        method: 'POST',
        url: `${baseUrl}/echo`,
        params: [],
        headers: [{ key: 'X-Auth', value: '{{h}}', enabled: true }],
        auth: { type: 'apikey', key: 'api_key', value: createSecretRef('ref-q'), in: 'query' },
        body: { type: 'json', json: `{"credential":"{{b}}","nested":{"deep":"{{b}}"}}` },
        collectionId: 'c1',
        createdAt: 0,
        updatedAt: 0,
      },
      {
        policy,
        environment: {
          id: 'e1',
          name: 'prod',
          variables: [
            { key: 'h', currentValue: createSecretRef('ref-h'), secret: true, enabled: true },
            { key: 'b', currentValue: createSecretRef('ref-b'), secret: true, enabled: true },
          ],
        },
        resolveSecret: (ref) => {
          const values: Record<string, string> = {
            'ref-h': SECRET_HEADER,
            'ref-q': SECRET_QUERY,
            'ref-b': SECRET_BODY,
          }
          return values[ref.$ref] ?? ''
        },
        historyContext: { profileId: 'p1', source: 'agent' },
        recordHistory: (entry) => {
          // 模拟 host history-service 的 JSONL append 形态
          jsonlLines.push(`${JSON.stringify(entry)}\n`)
        },
      },
    )

    expect(result.status).toBe(200)
    expect(history).toBeDefined()
    expect(jsonlLines).toHaveLength(1)
    const jsonl = jsonlLines[0] ?? ''
    expect(jsonl).not.toContain(SECRET_HEADER)
    expect(jsonl).not.toContain(SECRET_QUERY)
    expect(jsonl).not.toContain(SECRET_BODY)
    expect(jsonl).not.toContain(encodeURIComponent(SECRET_BODY))
    // 脱敏占位确实落在各位置
    expect(history?.requestSnapshot.headers.find((h) => h.key === 'X-Auth')?.value).toBe('<redacted>')
    expect(history?.displayUrl).toContain('api_key=<redacted>')
    expect(history?.requestSnapshot.bodyPreview).toContain('<redacted>')
    expect(history?.responseSnapshot.headers.find((h) => h.key === 'set-cookie')?.value).toBe('<redacted>')
    expect(history?.source).toBe('agent')
  })
})

describe('TC-R-11: Import Report findings 文本经 redactor', () => {
  it('adapter 产出的 finding 含 secret 文本 → 报告中已 <redacted>', () => {
    const leaked = 'import-finding-secret-d44'
    const adapter: ImportAdapter = {
      format: 'postman-v2.1',
      detect: () => true,
      parse: (input) => input,
      scan: () => [
        {
          itemPath: 'Folder/Request',
          level: 'warn',
          kind: 'script-not-executed',
          message: `pre-request script references ${leaked}`,
        },
      ],
      normalize: () => ({
        collection: createCollection({ name: 'imported' }),
        items: [
          {
            itemPath: 'Folder/Request',
            compatibility: 'partial',
            findings: [
              {
                itemPath: 'Folder/Request',
                level: 'info',
                kind: 'field-dropped',
                message: `dropped field with value ${leaked}`,
              },
            ],
          },
        ],
      }),
    }
    const { report } = runImportPipeline(adapter, { info: {} }, {
      sourceName: 'sample.json',
      redactText: (text) => redactText(text, { secretValues: [leaked] }),
    })
    expect(report.findings).toHaveLength(2)
    for (const finding of report.findings) {
      expect(finding.message).not.toContain(leaked)
      expect(finding.message).toContain('<redacted>')
    }
    expect(report.partial).toBe(1)
  })
})

describe('TC-R-12: 出域字符串统一出口（logs / debug dump 钩子）', () => {
  it('redactOutboundText 覆盖 dump 与 log 形态；与 error/snapshot 同一 redactor 实现', () => {
    const secretValues = ['unified-exit-secret-e55']
    const debugDump = JSON.stringify({
      probe: 'session-bridge',
      detail: { header: `X-Auth: ${secretValues[0]}`, ok: true },
    })
    const logLine = `execute failed for url containing ${secretValues[0]}`
    expect(redactOutboundText(debugDump, { secretValues })).not.toContain(secretValues[0] ?? '')
    expect(redactOutboundText(logLine, { secretValues })).toBe('execute failed for url containing <redacted>')
    // 同一出口语义：redactText 与 sanitizeErrorMessage 结果一致
    expect(sanitizeErrorMessage(logLine, { secretValues })).toBe(redactText(logLine, { secretValues }))
  })
})
