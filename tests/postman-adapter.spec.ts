// @vitest-environment node
/**
 * TC-P-01…14：Postman Collection v2.1 Import（§6.3，AC-25/26/27）。
 * 适配器：packages/postman-adapter（实现 core ImportAdapter 接口，注入 runImportPipeline）。
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import type { Collection, ImportReport } from '@dsh-api-client/shared'
import { resolveStorageLayout } from '@dsh-api-client/shared'
import { ImportPipelineError, runImportPipeline } from '@dsh-api-client/core'
import { PostmanV21Adapter, SCRIPTS_WARNING, summarizeImportReport } from '@dsh-api-client/postman-adapter'
import { FileStore } from '../src/host/services/storage/file-store.ts'
import { CollectionService } from '../src/host/services/collection-service.ts'
import { RedactionService } from '../src/host/services/redaction-service.ts'
import { ImportService } from '../src/host/services/import-service.ts'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const FIXTURES = join(REPO_ROOT, 'fixtures', 'postman')

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))
}

function importDoc(input: unknown, options?: { redactText?: (text: string) => string }): {
  report: ImportReport
  collection: Collection
} {
  return runImportPipeline(new PostmanV21Adapter(), input, {
    sourceName: 'tc-p',
    ...(options?.redactText !== undefined ? { redactText: options.redactText } : {}),
  })
}

/** 构造最小 v2.1 文档骨架，item 由调用方给。 */
function doc(items: unknown[], extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    info: {
      name: 'inline-doc',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: items,
    ...(extra ?? {}),
  }
}

describe('TC-P-01: minimal v2.1 collection → 导入成功，报告 full=1', () => {
  it('minimal.json 全量兼容', () => {
    const { report, collection } = importDoc(loadFixture('minimal.json'))
    expect(report.format).toBe('postman-v2.1')
    expect(report.totals).toEqual({ requests: 1, folders: 0 })
    expect(report.full).toBe(1)
    expect(report.partial).toBe(0)
    expect(report.unsupported).toBe(0)
    expect(report.findings).toEqual([])
    expect(collection.name).toBe('minimal-collection')
    expect(collection.requests).toHaveLength(1)
    const request = collection.requests[0]!
    expect(request.method).toBe('GET')
    expect(request.url).toBe('https://api.example.com/status')
    expect(request.headers).toEqual([{ key: 'Accept', value: 'application/json', enabled: true }])
    expect(request.auth).toEqual({ type: 'none' })
    expect(request.body).toEqual({ type: 'none' })
  })
})

describe('TC-P-02: 三层嵌套 folder → 内部树结构一致', () => {
  it('nested-folders.json 层级/归属一致', () => {
    const { report, collection } = importDoc(loadFixture('nested-folders.json'))
    expect(report.totals).toEqual({ requests: 3, folders: 3 })
    expect(report.full).toBe(3)

    expect(collection.requests.map((r) => r.name)).toEqual(['ping'])
    expect(collection.folders).toHaveLength(1)
    const levelOne = collection.folders[0]!
    expect(levelOne.name).toBe('level-one')
    expect(levelOne.requests.map((r) => r.name)).toEqual(['l1-request'])
    expect(levelOne.folders).toHaveLength(1)
    const levelTwo = levelOne.folders[0]!
    expect(levelTwo.name).toBe('level-two')
    expect(levelTwo.requests).toHaveLength(0)
    expect(levelTwo.folders).toHaveLength(1)
    const levelThree = levelTwo.folders[0]!
    expect(levelThree.name).toBe('level-three')
    expect(levelThree.requests.map((r) => r.name)).toEqual(['deep-request'])
    expect(levelThree.requests[0]!.method).toBe('POST')
    expect(levelThree.requests[0]!.body).toEqual({ type: 'json', json: '{"ok":true}' })
    // 树内请求归属本 collection
    expect(levelThree.requests[0]!.collectionId).toBe(collection.id)
  })
})

describe('TC-P-03: 七种方法样本 → method 全部保真', () => {
  it('all-auth.json 七方法逐一保真', () => {
    const { report, collection } = importDoc(loadFixture('all-auth.json'))
    expect(report.totals.requests).toBe(7)
    expect(report.full).toBe(7)
    expect(collection.requests.map((r) => r.method)).toEqual([
      'GET',
      'POST',
      'PUT',
      'PATCH',
      'DELETE',
      'HEAD',
      'OPTIONS',
    ])
  })
})

describe('TC-P-04: URL 四形态（raw / host+path / query / :pathVar）→ 正确归一化', () => {
  it('字符串 raw / url.raw / host+path 组装 / :pathVar → {{var}}', () => {
    const { collection } = importDoc(
      doc([
        {
          name: 'string-url-pathvar',
          request: { method: 'GET', url: 'https://api.example.com/users/:id' },
        },
        {
          name: 'raw-with-query',
          request: {
            method: 'GET',
            url: {
              raw: 'https://api.example.com/users?page=1',
              query: [
                { key: 'page', value: '1' },
                { key: 'debug', value: 'true', disabled: true },
              ],
            },
          },
        },
        {
          name: 'host-path-parts',
          request: {
            method: 'GET',
            url: {
              protocol: 'https',
              host: ['api', 'example', 'com'],
              path: ['users', ':uid', 'posts'],
            },
          },
        },
        {
          name: 'host-path-strings',
          request: { method: 'GET', url: { host: 'api.example.com', path: 'plain' } },
        },
      ]),
    )
    const [stringUrl, rawQuery, hostPath, hostPathStr] = collection.requests
    // 形态一：url 为字符串，:pathVar 归一化
    expect(stringUrl!.url).toBe('https://api.example.com/users/{{id}}')
    expect(stringUrl!.params).toEqual([])
    // 形态二：url.raw 保留原文（含查询串），query 数组 → params，disabled 保留
    expect(rawQuery!.url).toBe('https://api.example.com/users?page=1')
    expect(rawQuery!.params).toEqual([
      { key: 'page', value: '1', enabled: true },
      { key: 'debug', value: 'true', enabled: false },
    ])
    // 形态三：protocol + host[] + path[] 组装，path 段内 :pathVar 归一化
    expect(hostPath!.url).toBe('https://api.example.com/users/{{uid}}/posts')
    // 形态四：host/path 为字符串（无 protocol 不加 scheme）
    expect(hostPathStr!.url).toBe('api.example.com/plain')
  })
})

describe('TC-P-05: 含 disabled header 的样本 → enabled=false 保留', () => {
  it('disabled header/query 均以 enabled=false 进入内部模型', () => {
    const { collection } = importDoc(
      doc([
        {
          name: 'disabled-headers',
          request: {
            method: 'GET',
            url: { raw: 'https://api.example.com/h', query: [{ key: 'q', value: '1', disabled: true }] },
            header: [
              { key: 'X-Active', value: 'yes' },
              { key: 'X-Legacy', value: 'off', disabled: true },
            ],
          },
        },
      ]),
    )
    const request = collection.requests[0]!
    expect(request.headers).toEqual([
      { key: 'X-Active', value: 'yes', enabled: true },
      { key: 'X-Legacy', value: 'off', enabled: false },
    ])
    expect(request.params).toEqual([{ key: 'q', value: '1', enabled: false }])
  })
})

describe('TC-P-06: raw / JSON body → body 配置正确', () => {
  it('raw 文本与 json language 分别落 raw/json', () => {
    const { collection } = importDoc(
      doc([
        {
          name: 'raw-text',
          request: {
            method: 'POST',
            url: 'https://api.example.com/text',
            body: { mode: 'raw', raw: 'plain text body' },
          },
        },
        {
          name: 'raw-json',
          request: {
            method: 'POST',
            url: 'https://api.example.com/json',
            body: { mode: 'raw', raw: '{"a":1}', options: { raw: { language: 'json' } } },
          },
        },
      ]),
    )
    expect(collection.requests[0]!.body).toEqual({ type: 'raw', raw: 'plain text body' })
    expect(collection.requests[1]!.body).toEqual({ type: 'json', json: '{"a":1}' })
  })
})

describe('TC-P-07: basic / bearer / apikey auth → 对应 AuthConfig', () => {
  it('all-auth.json 三类 auth 材料保真', () => {
    const { collection } = importDoc(loadFixture('all-auth.json'))
    const byName = new Map(collection.requests.map((r) => [r.name, r]))
    expect(byName.get('get-basic')!.auth).toEqual({ type: 'basic', username: 'alice', password: 's3cret' })
    expect(byName.get('post-bearer')!.auth).toEqual({ type: 'bearer', token: 'tok_abc123' })
    expect(byName.get('put-apikey-header')!.auth).toEqual({
      type: 'apikey',
      key: 'X-API-Key',
      value: 'key-xyz',
      in: 'header',
    })
    expect(byName.get('patch-apikey-query')!.auth).toEqual({
      type: 'apikey',
      key: 'api_key',
      value: 'key-xyz',
      in: 'query',
    })
    expect(byName.get('delete-plain')!.auth).toEqual({ type: 'none' })
  })
})

describe('TC-P-08: collection variable → CollectionVariable', () => {
  it('变量含 disabled 保留，归属 collection.variables', () => {
    const { collection } = importDoc(
      doc([], {
        variable: [
          { key: 'baseUrl', value: 'https://api.example.com' },
          { key: 'legacyToken', value: 'old', disabled: true },
        ],
      }),
    )
    expect(collection.variables).toEqual([
      { key: 'baseUrl', value: 'https://api.example.com', enabled: true },
      { key: 'legacyToken', value: 'old', enabled: false },
    ])
  })
})

describe('TC-P-09: 含 pre-request/tests 脚本 → ScriptConfig 保留原文 + 标准警告，无任何执行', () => {
  it('scripts.json 原文保留、警告标准、partial 标记', () => {
    const { report, collection } = importDoc(loadFixture('scripts.json'))
    expect(report.partial).toBe(1)
    expect(report.full).toBe(0)
    const request = collection.requests[0]!
    expect(request.scripts).toBeDefined()
    expect(request.scripts!.source).toBe('postman')
    expect(request.scripts!.warning).toBe(SCRIPTS_WARNING)
    // exec 数组按行拼接，原文逐字保留（含探针行）
    expect(request.scripts!.preRequest).toContain('pm.environment.set("request_timestamp", timestamp);')
    expect(request.scripts!.preRequest).toContain('globalThis.__pm_script_executed')
    expect(request.scripts!.tests).toContain('pm.test("status is 200", function () {')
    expect(request.scripts!.tests).toContain('globalThis.__pm_test_executed')
    const scriptFindings = report.findings.filter((f) => f.kind === 'script-not-executed')
    expect(scriptFindings).toHaveLength(2)
    expect(scriptFindings.map((f) => f.level)).toEqual(['warn', 'warn'])
    expect(scriptFindings[0]!.message).toContain('prerequest script preserved but not executed')
    expect(scriptFindings[1]!.message).toContain('test script preserved but not executed')
    // §15.4 报告含发现脚本清单
    const summary = summarizeImportReport(report)
    expect(summary.scripts).toHaveLength(2)
    expect(summary.lines.join('\n')).toContain('发现：2 个 Postman Script')
  })

  it('静态断言：packages/postman-adapter 与 packages/core 源码无动态代码执行', () => {
    const offenders: string[] = []
    const patterns = [/\beval\s*\(/, /\bnew\s+Function\s*\(/]
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry.startsWith('.')) continue
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) {
          walk(full)
        } else if (/\.ts$/.test(entry) && !entry.endsWith('.d.ts')) {
          const source = readFileSync(full, 'utf8')
          if (patterns.some((pattern) => pattern.test(source))) offenders.push(full)
        }
      }
    }
    walk(join(REPO_ROOT, 'packages', 'postman-adapter'))
    walk(join(REPO_ROOT, 'packages', 'core'))
    expect(offenders).toEqual([])
  })

  it('运行探针：导入 scripts.json 全过程无任何脚本执行副作用', () => {
    const probe = globalThis as Record<string, unknown>
    delete probe.__pm_script_executed
    delete probe.__pm_test_executed
    // 探针行若被以任何方式求值/执行，globalThis 上会留下计数
    importDoc(loadFixture('scripts.json'))
    expect(probe.__pm_script_executed).toBeUndefined()
    expect(probe.__pm_test_executed).toBeUndefined()
  })
})

describe('TC-P-10: oauth2 / digest auth → 降级 No Auth + auth-downgraded finding，标记 partial', () => {
  it('oauth2.json 两项降级且 findings 经 redactor 出口', () => {
    const redactText = (text: string): string => `[redacted]${text}`
    const { report, collection } = importDoc(loadFixture('oauth2.json'), { redactText })
    expect(report.full).toBe(0)
    expect(report.partial).toBe(2)
    expect(report.unsupported).toBe(0)
    expect(collection.requests.map((r) => r.auth)).toEqual([{ type: 'none' }, { type: 'none' }])
    const downgrades = report.findings.filter((f) => f.kind === 'auth-downgraded')
    expect(downgrades).toHaveLength(2)
    // findings message 出场前经 redactor（TC-R-11 机制在适配器链路上生效）
    for (const finding of report.findings) expect(finding.message.startsWith('[redacted]')).toBe(true)
    expect(downgrades[0]!.message).toContain('auth type "oauth2" not supported')
    expect(downgrades[0]!.message).toContain('downgraded to No Auth')
    expect(downgrades[1]!.message).toContain('auth type "digest" not supported')
    expect(downgrades.map((f) => f.itemPath)).toEqual(['oauth2-request', 'digest-request'])
  })
})

describe('TC-P-11: {{$guid}} 等 dynamic variables → dynamic-variable finding，不预解析', () => {
  it('dynamic-vars.json 原值逐字保留 + info finding', () => {
    const { report, collection } = importDoc(loadFixture('dynamic-vars.json'))
    const dynFindings = report.findings.filter((f) => f.kind === 'dynamic-variable')
    expect(dynFindings.length).toBeGreaterThan(0)
    expect(dynFindings[0]!.level).toBe('info')
    expect(dynFindings[0]!.message).toContain('{{$guid}}')
    expect(dynFindings[0]!.message).toContain('not pre-resolved')
    const request = collection.requests[0]!
    // 不预解析：所有 {{$...}} 原样保留
    expect(request.url).toBe('https://api.example.com/users/{{$guid}}')
    expect(request.headers).toEqual([
      { key: 'X-Request-Id', value: '{{$guid}}', enabled: true },
      { key: 'X-Sent-At', value: '{{$timestamp}}', enabled: true },
    ])
    expect(request.body).toEqual({
      type: 'json',
      json: '{"email":"{{$randomEmail}}","age":{{$randomInt}}}',
    })
  })
})

describe('TC-P-12: 一个 item 无法转换 + 其余正常 → 其余照常导入，unsupported=1，不整体失败', () => {
  it('未知 method 的 item 标记 unsupported，其余照常', () => {
    const { report, collection } = importDoc(
      doc([
        { name: 'good-one', request: { method: 'GET', url: 'https://api.example.com/1' } },
        { name: 'bad-method', request: { method: 'QUERY', url: 'https://api.example.com/2' } },
        { name: 'good-two', request: { method: 'POST', url: 'https://api.example.com/3' } },
      ]),
    )
    expect(report.unsupported).toBe(1)
    expect(report.full).toBe(2)
    expect(report.totals.requests).toBe(2)
    expect(collection.requests.map((r) => r.name)).toEqual(['good-one', 'good-two'])
    const failure = report.findings.find((f) => f.itemPath === 'bad-method')
    expect(failure).toBeDefined()
    expect(failure!.level).toBe('warn')
    expect(failure!.message).toContain('item could not be converted')
    expect(failure!.message).toContain('unsupported method: QUERY')
  })
})

describe('TC-P-13: 非 v2.1 / 非法 JSON → 显式错误，零落库', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-api-client-import-'))
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  function makeService(): { service: ImportService; store: FileStore } {
    const store = new FileStore(resolveStorageLayout(home))
    store.initLayout()
    return { service: new ImportService(store, new CollectionService(store), new RedactionService()), store }
  }

  it('管线级：v2.0 schema → detect 阶段显式错误；结构破损 → parse 阶段显式错误；非 JSON 字符串同', () => {
    const adapter = new PostmanV21Adapter()
    expect(() => importDoc(loadFixture('invalid-schema.json'))).toThrowError(ImportPipelineError)
    try {
      importDoc(loadFixture('invalid-schema.json'))
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ImportPipelineError)
      expect((error as ImportPipelineError).stage).toBe('detect')
    }
    // 结构破损（schema 合法但 item 缺失）→ parse 阶段
    try {
      importDoc({ info: { name: 'x', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' } })
      expect.unreachable()
    } catch (error) {
      expect((error as ImportPipelineError).stage).toBe('parse')
    }
    // 非法 JSON 字符串
    expect(adapter.detect('{not json')).toBe(false)
    expect(() => importDoc('{not json')).toThrowError(ImportPipelineError)
  })

  it('服务级：非法输入 → 显式错误且 collections.json 零变化', () => {
    const { service, store } = makeService()
    // 先导入一份合法 collection 建立基线
    const good = service.importPostman(loadFixture('minimal.json'), 'baseline')
    expect(good.createdCollectionId).toBeDefined()
    expect(existsSync(store.layout.collectionsFile)).toBe(true)
    const before = readFileSync(store.layout.collectionsFile, 'utf8')
    const reportsBefore = readdirSync(store.layout.importsDir).length

    for (const bad of [loadFixture('invalid-schema.json'), { hello: 'world' }, '{not json']) {
      expect(() => service.importPostman(bad)).toThrowError(ImportPipelineError)
    }
    // 零落库：collections.json 逐字节不变，imports/ 无新报告
    expect(readFileSync(store.layout.collectionsFile, 'utf8')).toBe(before)
    expect(readdirSync(store.layout.importsDir).length).toBe(reportsBefore)
  })
})

describe('TC-P-14: urlencoded / formdata body → 字段映射正确', () => {
  it('urlencoded 全字段（disabled 保留）；formdata 文本字段保留、file 字段丢弃+警告', () => {
    const { report, collection } = importDoc(
      doc([
        {
          name: 'urlencoded-body',
          request: {
            method: 'POST',
            url: 'https://api.example.com/form',
            body: {
              mode: 'urlencoded',
              urlencoded: [
                { key: 'username', value: 'alice' },
                { key: 'legacy', value: 'off', disabled: true },
              ],
            },
          },
        },
        {
          name: 'formdata-body',
          request: {
            method: 'POST',
            url: 'https://api.example.com/upload',
            body: {
              mode: 'formdata',
              formdata: [
                { key: 'note', value: 'hello' },
                { key: 'attachment', type: 'file', value: '/tmp/secret-path.png' },
              ],
            },
          },
        },
      ]),
    )
    expect(collection.requests[0]!.body).toEqual({
      type: 'urlencoded',
      fields: [
        { key: 'username', value: 'alice', enabled: true },
        { key: 'legacy', value: 'off', enabled: false },
      ],
    })
    const formdata = collection.requests[1]!
    expect(formdata.body).toEqual({
      type: 'form-data',
      fields: [{ key: 'note', value: 'hello', enabled: true }],
    })
    // file 字段不可转 → field-dropped 警告 + partial，但不阻塞导入
    const dropped = report.findings.filter((f) => f.kind === 'field-dropped')
    expect(dropped).toHaveLength(1)
    expect(dropped[0]!.message).toContain('form-data file field(s) dropped: attachment')
    expect(report.partial).toBe(1)
    expect(report.totals.requests).toBe(2)
  })
})
