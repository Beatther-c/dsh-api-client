/**
 * TC-C-04/05/10：request/build 与 request/body（§7.3/§7.6，AC-11/AC-12）
 * + JSON Editor 纯函数（validate / format / compact）。
 */
import { describe, expect, it } from 'vitest'
import type { ApiRequest } from '@dsh-api-client/shared'
import {
  buildHeaders,
  buildUrl,
  collapseMirroredQuery,
  jsonCompact,
  jsonFormat,
  jsonValidate,
  paramsToUrl,
  resolveRequest,
  serializeBody,
  urlToParams,
} from '@dsh-api-client/core'

describe('TC-C-04: params 边界（buildUrl）', () => {
  it('重复 key 全保留、空值保留 k=、特殊字符百分号编码、disabled 不进 URL', () => {
    const url = buildUrl('https://api.example.com/s?fixed=1', [
      { key: 'tag', value: 'a', enabled: true },
      { key: 'tag', value: 'b', enabled: true },
      { key: 'empty', value: '', enabled: true },
      { key: 'weird', value: 'a b&c=d%', enabled: true },
      { key: 'off', value: 'x', enabled: false },
      { key: '', value: 'no-key', enabled: true },
    ])
    expect(url).toBe('https://api.example.com/s?fixed=1&tag=a&tag=b&empty=&weird=a%20b%26c%3Dd%25')
  })

  it('URL 无 query 时直接挂 query；hash 保持在末尾', () => {
    expect(buildUrl('https://a.example/x#frag', [{ key: 'k', value: 'v', enabled: true }])).toBe(
      'https://a.example/x?k=v#frag',
    )
    expect(buildUrl('https://a.example/x', [])).toBe('https://a.example/x')
  })
})

describe('TC-C-05: URL ↔ Params 双向同步互逆', () => {
  it('URL → 表格 → URL 还原（重复 key / 空值 / 编码 / hash）', () => {
    const url = 'https://a.example/s?tag=a&tag=b&empty=&q=%E4%B8%AD%20wen#f'
    const params = urlToParams(url)
    expect(paramsToUrl(url, params)).toBe(url)
  })

  it('表格 → URL → 表格还原', () => {
    const params = [
      { key: 'tag', value: 'a', enabled: true },
      { key: 'tag', value: 'b', enabled: true },
      { key: 'empty', value: '', enabled: true },
      { key: 'q', value: '中 wen', enabled: true },
      { key: 'off', value: 'x', enabled: false },
    ]
    const url = paramsToUrl('https://a.example/s', params)
    expect(url).toBe('https://a.example/s?tag=a&tag=b&empty=&q=%E4%B8%AD%20wen')
    expect(urlToParams(url)).toEqual([
      { key: 'tag', value: 'a', enabled: true },
      { key: 'tag', value: 'b', enabled: true },
      { key: 'empty', value: '', enabled: true },
      { key: 'q', value: '中 wen', enabled: true },
    ])
  })
})

describe('URL/Params 同步幂等（sweep 遗留 #3，collapseMirroredQuery）', () => {
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

  it('镜像数据（URL bar 与表格同步态）→ 剥离 URL query，执行合并后单份（不再 ?x=1&x=1）', async () => {
    // 同步不变量：url.query ≡ serialize(enabled params)（ApiClientView 两个 handler 维持）。
    const url = 'https://a.example/s?x=1&tag=a&tag=b'
    const params = urlToParams(url) // handleUrlChange 的同步结果：表格即镜像
    const collapsed = collapseMirroredQuery(url, params)
    expect(collapsed).toBe('https://a.example/s')
    // 执行路径（resolveRequest 的 buildUrl 合并语义不变）：同一份 query 只出现一次
    const resolved = await resolveRequest(req({ url: collapsed, params }), {})
    expect(resolved.url).toBe('https://a.example/s?x=1&tag=a&tag=b')
  })

  it('表格内合法重复 key 能力不受影响（TC-C-04）：镜像剥离后重复 key 全保留', () => {
    const url = 'https://a.example/s?x=1&x=1'
    const params = [
      { key: 'x', value: '1', enabled: true },
      { key: 'x', value: '1', enabled: true },
    ]
    const collapsed = collapseMirroredQuery(url, params)
    expect(collapsed).toBe('https://a.example/s')
    expect(buildUrl(collapsed, params)).toBe('https://a.example/s?x=1&x=1')
  })

  it('非镜像（手写 url query + 独立 params）→ 原样返回，TC-C-04 合并语义不变', () => {
    const url = 'https://a.example/s?fixed=1'
    const params = [{ key: 'tag', value: 'a', enabled: true }]
    expect(collapseMirroredQuery(url, params)).toBe(url)
    expect(buildUrl(collapseMirroredQuery(url, params), params)).toBe('https://a.example/s?fixed=1&tag=a')
  })

  it('disabled 行不进 URL；hash 在剥离与重建中原位保留', () => {
    const url = 'https://a.example/s?x=1#frag'
    const params = [
      { key: 'x', value: '1', enabled: true },
      { key: 'off', value: 'y', enabled: false },
    ]
    const collapsed = collapseMirroredQuery(url, params)
    expect(collapsed).toBe('https://a.example/s#frag')
    expect(buildUrl(collapsed, params)).toBe('https://a.example/s?x=1#frag')
  })

  it('params 为空时 url query 原样保留（agent 工具/手写数据路径不回退）', () => {
    const url = 'https://a.example/s?fixed=1'
    expect(collapseMirroredQuery(url, [])).toBe(url)
    expect(buildUrl(collapseMirroredQuery(url, []), [])).toBe(url)
  })

  it('规范形 ⇄ 显示形互逆：paramsToUrl(collapseMirroredQuery(u, p), p) === u（openRequest 还原）', () => {
    const url = 'https://a.example/s?x=1&tag=a#f'
    const params = urlToParams(url)
    expect(paramsToUrl(collapseMirroredQuery(url, params), params)).toBe(url)
  })
})

describe('TC-C-10: 六种 body 序列化', () => {
  it('none → 无 body 无 contentType', () => {
    expect(serializeBody({ type: 'none' })).toEqual({})
  })

  it('raw（Text）→ 原文 + text/plain', () => {
    expect(serializeBody({ type: 'raw', raw: 'hello' })).toEqual({ data: 'hello', contentType: 'text/plain' })
  })

  it('json → 原文发送 + 自动 Content-Type: application/json', () => {
    const out = serializeBody({ type: 'json', json: '{"a":1}' })
    expect(out).toEqual({ data: '{"a":1}', contentType: 'application/json' })
    const headers = buildHeaders([], out.contentType)
    expect(headers).toContainEqual({ key: 'Content-Type', value: 'application/json', enabled: true })
  })

  it('urlencoded → 正确编码 + application/x-www-form-urlencoded；disabled 不序列化', () => {
    const out = serializeBody({
      type: 'urlencoded',
      fields: [
        { key: 'a b', value: 'x&y=', enabled: true },
        { key: 'empty', value: '', enabled: true },
        { key: 'off', value: 'x', enabled: false },
      ],
    })
    expect(out.contentType).toBe('application/x-www-form-urlencoded')
    expect(out.data).toBe('a%20b=x%26y%3D&empty=')
  })

  it('form-data → boundary 正确，part 边界与首尾结构正确', () => {
    const boundary = '----test-boundary-123'
    const out = serializeBody(
      {
        type: 'form-data',
        fields: [
          { key: 'field1', value: 'value1', enabled: true },
          { key: 'field2', value: '多行\n值', enabled: true },
        ],
      },
      { boundary },
    )
    expect(out.contentType).toBe(`multipart/form-data; boundary=${boundary}`)
    const data = String(out.data)
    expect(data).toBe(
      `--${boundary}\r\nContent-Disposition: form-data; name="field1"\r\n\r\nvalue1\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="field2"\r\n\r\n多行\n值\r\n` +
        `--${boundary}--\r\n`,
    )
    // Content-Type 声明的 boundary 与 body 实际使用的一致
    const declared = /boundary=(.+)$/.exec(out.contentType ?? '')?.[1]
    expect(declared).toBe(boundary)
    expect(data.split(`--${boundary}`).length - 1).toBe(3) // 2 parts + 收尾
  })

  it('buildHeaders: 用户已显式设置 Content-Type 时不覆盖；自动补 Accept', () => {
    const headers = buildHeaders(
      [{ key: 'content-type', value: 'application/vnd.custom+json', enabled: true }],
      'application/json',
    )
    expect(headers.filter((h) => h.key.toLowerCase() === 'content-type')).toHaveLength(1)
    expect(headers).toContainEqual({ key: 'Accept', value: '*/*', enabled: true })
  })
})

describe('JSON Editor 纯函数', () => {
  it('jsonValidate: 合法 → ok；非法 → message + 行列', () => {
    expect(jsonValidate('{"a":1}')).toEqual({ ok: true })
    const bad = jsonValidate('{\n  "a": 1,\n  bad\n}')
    expect(bad.ok).toBe(false)
    if (!bad.ok) {
      expect(bad.message).toBeTruthy()
      expect(bad.line).toBe(3)
    }
  })

  it('jsonFormat: 缩进重排；jsonCompact: 压成单行', () => {
    expect(jsonFormat('{"a":1,"b":[2]}')).toBe('{\n  "a": 1,\n  "b": [\n    2\n  ]\n}')
    expect(jsonCompact('{ "a": 1, "b": [ 2 ] }')).toBe('{"a":1,"b":[2]}')
    expect(() => jsonFormat('not json')).toThrow()
    expect(() => jsonCompact('not json')).toThrow()
  })
})
