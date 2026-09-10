// @vitest-environment node
/**
 * WP3：P0 Host Tree Mutation & Clipboard API（实施设计 §3.1/§3.1.1/§3.3、§4.2–§4.6、
 * §13.1–§13.2；UX spec §4.6/§8.3/§9 冻结语义）。
 *
 * 形态：沿用 tests/host-api.spec.ts 的 fake harness——真实 node http server
 * （127.0.0.1 ephemeral port）→ router.handle；tmp 目录注入存储根
 * （createHostServices/createHostApiRouter 与 src/host/index.ts 同一组装点）。
 * core 纯函数断言在 tests/p0-tree-core.spec.ts（WP1），本文件只测 Host/API 合同：
 *
 * - Folder 三端点 happy/400/404/409（409 响应体逐字 = §3.1.1）；
 * - copy/cut/paste/clear 全矩阵（§6.5 合法组合逐条 + 非法组合 400 invalid-paste-target）；
 * - Copy 快照独立性（§4.5：copy 后改源/删源仍可 paste，内容 = 快照时点）；
 * - Cut 版本过期 409 且源未动、token 未消费（AC-18）；Cut 成功 consumed=true、token 复用 404；
 * - 跨 Collection 原子写：collections 文件恰好一次 writeJson（AC-20，spy FileStore）；
 *   写盘失败 → 内存不替换、token 不消费（§4.4）；
 * - TTL 30 分钟过期（fake timers）→ clipboard-not-found(404)；token 绑定 profileId；
 * - 响应体不含 snapshot：Descriptor 恰好四字段、PasteResult 恰好三字段，name/URL/auth 材料零出口；
 * - suppressedGeneratedHeaders 校验全分支 + trim/lowercase/去重（§3.3）；PATCH name 非空校验；
 * - 单调 updatedAt（§4.3：冻结时钟下连续 mutation 严格递增）。
 */
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ApiRouter } from '../src/host/api/router.ts'
import type { HostServices } from '../src/host/index.ts'
import { createHostApiRouter, createHostServices } from '../src/host/index.ts'
import { ProfileService } from '../src/host/services/profile-service.ts'
import { CLIPBOARD_TTL_MS, TreeClipboardService } from '../src/host/services/tree-clipboard-service.ts'

const PLUGIN_TOKEN = 'test-plugin-token-wp3'
const CSRF = { 'x-dsh-api-client-request': '1' }
/** §3.1.1 逐字冻结的 409 响应体（用户可见中文文案，PROJECT.md 红线 6）。 */
const VERSION_CONFLICT_BODY = {
  error: { code: 'version-conflict', message: '数据已被其他操作修改，请刷新后重试' },
}
const NAME_MARKER = 'WP3-快照标记-名称'
const URL_MARKER = 'https://wp3.example.com/快照标记'
const BODY_MARKER = '{"marker":"WP3-BODY-MARKER"}'
const AUTH_MARKER = 'WP3-BEARER-MARKER-TOKEN'

let tmpHome: string
let services: HostServices
let api: ApiRouter
let server: Server
let baseUrl: string

// ---- 响应形态（断言专用最小投影）----

interface RequestShape {
  id: string
  name: string
  url: string
  body?: { type: string; json?: string }
  collectionId: string
  folderId?: string
  updatedAt: number
  suppressedGeneratedHeaders?: Array<{ name: string; source: string }>
}
interface FolderShape {
  id: string
  name: string
  folders: FolderShape[]
  requests: RequestShape[]
}
interface CollectionShape {
  id: string
  name: string
  folders: FolderShape[]
  requests: RequestShape[]
  createdAt: number
  updatedAt: number
}
interface DescriptorShape {
  token: string
  operation: 'copy' | 'cut'
  kind: 'collection' | 'folder' | 'request'
  expiresAt: number
}
interface PasteResultShape {
  operation: 'copy' | 'cut'
  kind: 'collection' | 'folder' | 'request'
  consumed: boolean
}
interface ErrorShape {
  error: { code: string; message: string }
}

// ---- fake harness（与 tests/host-api.spec.ts 同模式）----

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
function mutate(path: string, method: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  return apiFetch(path, { method, body, headers: { ...CSRF } })
}

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'dsh-api-client-wp3-tree-'))
  const profile = ProfileService.detect({ env: { DSH_PROFILE: 'test-profile' }, home: tmpHome })
  services = createHostServices({ dshHome: tmpHome, profile })
  api = createHostApiRouter(services, { pluginToken: PLUGIN_TOKEN })
  server = createServer((req, res) => {
    void api.handle(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(tmpHome, { recursive: true, force: true })
})

// ---- 便捷构造 ----

async function createCollection(name: string): Promise<string> {
  const { status, body } = await mutate('/api-client/collections', 'POST', { name })
  expect(status).toBe(200)
  return (body as { id: string }).id
}

async function getCollection(id: string): Promise<CollectionShape> {
  const { status, body } = await apiFetch(`/api-client/collections/${id}`)
  expect(status).toBe(200)
  return body as CollectionShape
}

async function listCollections(): Promise<Array<{ id: string; name: string }>> {
  const { status, body } = await apiFetch('/api-client/collections')
  expect(status).toBe(200)
  return body as Array<{ id: string; name: string }>
}

/** 走冻结合同建 folder（自动携带当前 expectedCollectionUpdatedAt）。 */
async function createFolderIn(collectionId: string, name: string, parentFolderId?: string): Promise<{ id: string; name: string }> {
  const version = (await getCollection(collectionId)).updatedAt
  const { status, body } = await mutate(`/api-client/collections/${collectionId}/folders`, 'POST', {
    name,
    expectedCollectionUpdatedAt: version,
    ...(parentFolderId !== undefined ? { parentFolderId } : {}),
  })
  expect(status).toBe(200)
  return body as { id: string; name: string }
}

/** 建请求便捷形态：入参放宽为 Record 以覆盖 §3.3 校验负例（非法字段类型也要能发出去）。 */
async function addRequestTo(collectionId: string, input: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  return mutate(`/api-client/collections/${collectionId}/requests`, 'POST', input)
}

function findFolderShape(collection: CollectionShape, folderId: string): FolderShape | undefined {
  const walk = (folders: FolderShape[]): FolderShape | undefined => {
    for (const folder of folders) {
      if (folder.id === folderId) return folder
      const hit = walk(folder.folders)
      if (hit) return hit
    }
    return undefined
  }
  return walk(collection.folders)
}

function findRequestShape(collection: CollectionShape, requestId: string): RequestShape | undefined {
  const walk = (folders: FolderShape[]): RequestShape | undefined => {
    for (const folder of folders) {
      const hit = folder.requests.find((r) => r.id === requestId)
      if (hit) return hit
      const nested = walk(folder.folders)
      if (nested) return nested
    }
    return undefined
  }
  return collection.requests.find((r) => r.id === requestId) ?? walk(collection.folders)
}

async function copyNode(body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  return mutate('/api-client/tree/clipboard/copy', 'POST', body)
}

async function cutNode(body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  return mutate('/api-client/tree/clipboard/cut', 'POST', body)
}

/**
 * paste 便捷形态：非 root 目标缺省自动读取权威当前版本（expectedOverride 显式给值/
 * null=整体省略字段，用于 400/409 负例）；versionOf 指定读哪个 collection 的版本。
 */
async function pasteToken(
  token: string,
  target: { targetKind: 'root' | 'collection' | 'folder' | 'request'; targetId?: string; targetCollectionId?: string },
  options: { versionOf?: string; expectedOverride?: number | string | null } = {},
): Promise<{ status: number; body: unknown }> {
  const body: Record<string, unknown> = { ...target }
  if (target.targetKind !== 'root') {
    if (options.expectedOverride === null) {
      // 整体省略 expectedTargetCollectionUpdatedAt
    } else if (options.expectedOverride !== undefined) {
      body.expectedTargetCollectionUpdatedAt = options.expectedOverride
    } else {
      const versionSource = options.versionOf ?? (target.targetKind === 'collection' ? target.targetId! : target.targetCollectionId!)
      body.expectedTargetCollectionUpdatedAt = (await getCollection(versionSource)).updatedAt
    }
  }
  return mutate(`/api-client/tree/clipboard/${token}/paste`, 'POST', body)
}

/** collections.json 落盘内容直读（原子写证据断言用）。 */
function readCollectionsFile(): CollectionShape[] {
  return JSON.parse(readFileSync(services.store.layout.collectionsFile, 'utf8')) as CollectionShape[]
}

/** writeJson spy：只统计 collections 文件的写次数。 */
function spyCollectionsWrites() {
  const spy = vi.spyOn(services.store, 'writeJson')
  return {
    spy,
    count(): number {
      return spy.mock.calls.filter((call) => call[0] === services.store.layout.collectionsFile).length
    },
    payload(index = 0): unknown {
      return spy.mock.calls.filter((call) => call[0] === services.store.layout.collectionsFile)[index]?.[1]
    },
    restore(): void {
      spy.mockRestore()
    },
  }
}

/** 矩阵夹具：源 S{顶层 s-top；s-folder{ s-sub{ s-deep }, s-req }}，目标 T{顶层 t1,t2；t-folder{ t-req }}。 */
async function buildMatrixFixture(tag: string): Promise<{
  sourceId: string
  targetId: string
  sTop: RequestShape
  sFolder: { id: string; name: string }
  sSub: { id: string; name: string }
  sReq: RequestShape
  t1: RequestShape
  t2: RequestShape
  tFolder: { id: string; name: string }
  tReq: RequestShape
}> {
  const sourceId = await createCollection(`${tag}-源集合`)
  const targetId = await createCollection(`${tag}-目标集合`)
  const sFolder = await createFolderIn(sourceId, `${tag}-源夹`)
  const sSub = await createFolderIn(sourceId, `${tag}-子夹`, sFolder.id)
  const sTopRes = await addRequestTo(sourceId, { name: `${tag}-s-top`, url: `https://wp3/${tag}/s-top` })
  const sReqRes = await addRequestTo(sourceId, { name: `${tag}-s-req`, url: `https://wp3/${tag}/s-req`, folderId: sFolder.id })
  await addRequestTo(sourceId, { name: `${tag}-s-deep`, url: `https://wp3/${tag}/s-deep`, folderId: sSub.id })
  const tFolder = await createFolderIn(targetId, `${tag}-目标夹`)
  const t1Res = await addRequestTo(targetId, { name: `${tag}-t1`, url: `https://wp3/${tag}/t1` })
  const t2Res = await addRequestTo(targetId, { name: `${tag}-t2`, url: `https://wp3/${tag}/t2` })
  const tReqRes = await addRequestTo(targetId, { name: `${tag}-t-req`, url: `https://wp3/${tag}/t-req`, folderId: tFolder.id })
  return {
    sourceId,
    targetId,
    sTop: sTopRes.body as RequestShape,
    sFolder,
    sSub,
    sReq: sReqRes.body as RequestShape,
    t1: t1Res.body as RequestShape,
    t2: t2Res.body as RequestShape,
    tFolder,
    tReq: tReqRes.body as RequestShape,
  }
}

// ===========================================================================
// 1. Folder 三端点（§3.1 冻结合同）
// ===========================================================================

describe('Folder 端点：POST/PATCH/DELETE（实施设计 §3.1）', () => {
  it('POST 顶层 Folder → 200 FolderDescriptor 恰好 {id,name}；树中出现且 updatedAt 严格递增', async () => {
    const collectionId = await createCollection('wp3-folder-create')
    const before = await getCollection(collectionId)
    const { status, body } = await mutate(`/api-client/collections/${collectionId}/folders`, 'POST', {
      name: '顶层夹',
      expectedCollectionUpdatedAt: before.updatedAt,
    })
    expect(status).toBe(200)
    expect(Object.keys(body as object).sort()).toEqual(['id', 'name'])
    const descriptor = body as { id: string; name: string }
    expect(descriptor.name).toBe('顶层夹')
    const after = await getCollection(collectionId)
    expect(after.folders.map((f) => f.id)).toContain(descriptor.id)
    expect(after.updatedAt).toBeGreaterThan(before.updatedAt)
  })

  it('POST 子 Folder（parentFolderId）→ 嵌套在 parent.folders 末尾', async () => {
    const collectionId = await createCollection('wp3-folder-nested')
    const parent = await createFolderIn(collectionId, '父夹')
    const version = (await getCollection(collectionId)).updatedAt
    const { status, body } = await mutate(`/api-client/collections/${collectionId}/folders`, 'POST', {
      name: '子夹',
      parentFolderId: parent.id,
      expectedCollectionUpdatedAt: version,
    })
    expect(status).toBe(200)
    const tree = await getCollection(collectionId)
    const parentShape = findFolderShape(tree, parent.id)!
    expect(parentShape.folders.map((f) => f.id)).toEqual([(body as { id: string }).id])
  })

  it('POST 400 invalid-input：name 缺失/空串/纯空白/expectedCollectionUpdatedAt 缺失/非数字/parentFolderId 非字符串', async () => {
    const collectionId = await createCollection('wp3-folder-400')
    const version = (await getCollection(collectionId)).updatedAt
    const cases: unknown[] = [
      { expectedCollectionUpdatedAt: version },
      { name: '', expectedCollectionUpdatedAt: version },
      { name: '   ', expectedCollectionUpdatedAt: version },
      { name: '夹' },
      { name: '夹', expectedCollectionUpdatedAt: 'not-a-number' },
      { name: '夹', expectedCollectionUpdatedAt: version, parentFolderId: 42 },
      'not-an-object',
    ]
    for (const body of cases) {
      const res = await mutate(`/api-client/collections/${collectionId}/folders`, 'POST', body)
      expect(res.status).toBe(400)
      expect((res.body as ErrorShape).error.code).toBe('invalid-input')
    }
    const tree = await getCollection(collectionId)
    expect(tree.folders).toEqual([])
  })

  it('POST 404：未知 collection → collection-not-found；未知 parentFolderId → folder-not-found', async () => {
    const collectionId = await createCollection('wp3-folder-404')
    const version = (await getCollection(collectionId)).updatedAt
    const noCollection = await mutate('/api-client/collections/no-such-id/folders', 'POST', {
      name: '夹',
      expectedCollectionUpdatedAt: version,
    })
    expect(noCollection.status).toBe(404)
    expect((noCollection.body as ErrorShape).error.code).toBe('collection-not-found')

    const noParent = await mutate(`/api-client/collections/${collectionId}/folders`, 'POST', {
      name: '夹',
      parentFolderId: 'no-such-folder',
      expectedCollectionUpdatedAt: version,
    })
    expect(noParent.status).toBe(404)
    expect((noParent.body as ErrorShape).error.code).toBe('folder-not-found')
  })

  it('POST 409：版本过期 → 响应体逐字等于 §3.1.1 且零写盘、folder 未创建', async () => {
    const collectionId = await createCollection('wp3-folder-409')
    const stale = (await getCollection(collectionId)).updatedAt
    await createFolderIn(collectionId, '占位夹') // 推高版本，stale 过期
    const writes = spyCollectionsWrites()
    const { status, body } = await mutate(`/api-client/collections/${collectionId}/folders`, 'POST', {
      name: '冲突夹',
      expectedCollectionUpdatedAt: stale,
    })
    expect(status).toBe(409)
    expect(body).toEqual(VERSION_CONFLICT_BODY)
    expect(writes.count()).toBe(0)
    writes.restore()
    const tree = await getCollection(collectionId)
    expect(tree.folders.map((f) => f.name)).toEqual(['占位夹'])
  })

  it('PATCH 重命名 → 200 FolderDescriptor 新名；树中生效', async () => {
    const collectionId = await createCollection('wp3-folder-rename')
    const folder = await createFolderIn(collectionId, '旧名')
    const version = (await getCollection(collectionId)).updatedAt
    const { status, body } = await mutate(`/api-client/collections/${collectionId}/folders/${folder.id}`, 'PATCH', {
      name: '新名',
      expectedCollectionUpdatedAt: version,
    })
    expect(status).toBe(200)
    expect(body).toEqual({ id: folder.id, name: '新名' })
    expect((await getCollection(collectionId)).folders[0]!.name).toBe('新名')
  })

  it('PATCH 400/404/409：空名、未知 folder、未知 collection、过期版本（逐字文案且名未变）', async () => {
    const collectionId = await createCollection('wp3-folder-patch-neg')
    const folder = await createFolderIn(collectionId, '保持名')
    const version = (await getCollection(collectionId)).updatedAt

    const empty = await mutate(`/api-client/collections/${collectionId}/folders/${folder.id}`, 'PATCH', {
      name: '  ',
      expectedCollectionUpdatedAt: version,
    })
    expect(empty.status).toBe(400)
    expect((empty.body as ErrorShape).error.code).toBe('invalid-input')

    const noFolder = await mutate(`/api-client/collections/${collectionId}/folders/no-such-folder`, 'PATCH', {
      name: 'x',
      expectedCollectionUpdatedAt: version,
    })
    expect(noFolder.status).toBe(404)
    expect((noFolder.body as ErrorShape).error.code).toBe('folder-not-found')

    const noCollection = await mutate(`/api-client/collections/no-such/folders/${folder.id}`, 'PATCH', {
      name: 'x',
      expectedCollectionUpdatedAt: version,
    })
    expect(noCollection.status).toBe(404)
    expect((noCollection.body as ErrorShape).error.code).toBe('collection-not-found')

    const conflict = await mutate(`/api-client/collections/${collectionId}/folders/${folder.id}`, 'PATCH', {
      name: '冲突名',
      expectedCollectionUpdatedAt: version - 1,
    })
    expect(conflict.status).toBe(409)
    expect(conflict.body).toEqual(VERSION_CONFLICT_BODY)
    expect((await getCollection(collectionId)).folders[0]!.name).toBe('保持名')
  })

  it('DELETE 带 JSON body → 204；递归删除子 Folder 与其中全部 Request', async () => {
    const collectionId = await createCollection('wp3-folder-delete')
    const folder = await createFolderIn(collectionId, '待删夹')
    const sub = await createFolderIn(collectionId, '子夹', folder.id)
    await addRequestTo(collectionId, { name: '夹内请求', folderId: folder.id })
    await addRequestTo(collectionId, { name: '子夹内请求', folderId: sub.id })
    const survivor = await addRequestTo(collectionId, { name: '顶层幸存' })
    const before = await getCollection(collectionId)

    const { status } = await mutate(`/api-client/collections/${collectionId}/folders/${folder.id}`, 'DELETE', {
      expectedCollectionUpdatedAt: before.updatedAt,
    })
    expect(status).toBe(204)
    const after = await getCollection(collectionId)
    expect(after.folders).toEqual([])
    expect(after.requests.map((r) => r.id)).toEqual([(survivor.body as RequestShape).id])
    expect(after.updatedAt).toBeGreaterThan(before.updatedAt)
  })

  it('DELETE 400（body 缺失/版本缺失）与 404 与 409（过期 → folder 仍在）', async () => {
    const collectionId = await createCollection('wp3-folder-delete-neg')
    const folder = await createFolderIn(collectionId, '删除目标')
    const version = (await getCollection(collectionId)).updatedAt

    const noBody = await mutate(`/api-client/collections/${collectionId}/folders/${folder.id}`, 'DELETE')
    expect(noBody.status).toBe(400)
    expect((noBody.body as ErrorShape).error.code).toBe('invalid-input')

    const noVersion = await mutate(`/api-client/collections/${collectionId}/folders/${folder.id}`, 'DELETE', {})
    expect(noVersion.status).toBe(400)

    const noFolder = await mutate(`/api-client/collections/${collectionId}/folders/no-such`, 'DELETE', {
      expectedCollectionUpdatedAt: version,
    })
    expect(noFolder.status).toBe(404)
    expect((noFolder.body as ErrorShape).error.code).toBe('folder-not-found')

    const conflict = await mutate(`/api-client/collections/${collectionId}/folders/${folder.id}`, 'DELETE', {
      expectedCollectionUpdatedAt: version - 1,
    })
    expect(conflict.status).toBe(409)
    expect(conflict.body).toEqual(VERSION_CONFLICT_BODY)
    expect((await getCollection(collectionId)).folders.map((f) => f.id)).toEqual([folder.id])
  })
})

// ===========================================================================
// 2. clipboard copy/cut 受理（§3.1 + §4.2：Descriptor 形态与快照零出口）
// ===========================================================================

describe('clipboard copy/cut 受理（实施设计 §3.1/§4.2）', () => {
  it('copy collection/folder/request → 200 Descriptor 恰好四字段，expiresAt ∈ (now, now+30min]', async () => {
    const fx = await buildMatrixFixture('copy-受理')
    const before = Date.now()
    for (const body of [
      { kind: 'collection', collectionId: fx.sourceId },
      { kind: 'folder', collectionId: fx.sourceId, nodeId: fx.sFolder.id },
      { kind: 'request', collectionId: fx.sourceId, nodeId: fx.sTop.id },
    ]) {
      const { status, body: res } = await copyNode(body)
      expect(status).toBe(200)
      const descriptor = res as DescriptorShape
      expect(Object.keys(descriptor).sort()).toEqual(['expiresAt', 'kind', 'operation', 'token'])
      expect(descriptor.operation).toBe('copy')
      expect(descriptor.kind).toBe(body.kind)
      expect(typeof descriptor.token).toBe('string')
      expect(descriptor.token.length).toBeGreaterThan(0)
      expect(descriptor.expiresAt).toBeGreaterThan(before)
      expect(descriptor.expiresAt).toBeLessThanOrEqual(Date.now() + CLIPBOARD_TTL_MS)
    }
  })

  it('两次 copy 的 token 互不相同（随机不可猜）', async () => {
    const collectionId = await createCollection('copy-token-随机')
    const a = await copyNode({ kind: 'collection', collectionId })
    const b = await copyNode({ kind: 'collection', collectionId })
    expect((a.body as DescriptorShape).token).not.toBe((b.body as DescriptorShape).token)
  })

  it('Descriptor/paste 响应绝不含 snapshot：name/URL/Body/Auth 材料标记零出口', async () => {
    const collectionId = await createCollection('copy-零出口')
    const folder = await createFolderIn(collectionId, NAME_MARKER)
    const created = await addRequestTo(collectionId, {
      name: NAME_MARKER,
      url: URL_MARKER,
      folderId: folder.id,
      body: { type: 'json', json: BODY_MARKER },
      auth: { type: 'bearer', token: AUTH_MARKER },
    })
    expect(created.status).toBe(200)
    const requestId = (created.body as RequestShape).id

    const targets = [
      { kind: 'collection', collectionId },
      { kind: 'folder', collectionId, nodeId: folder.id },
      { kind: 'request', collectionId, nodeId: requestId },
    ]
    for (const body of targets) {
      const { body: res } = await copyNode(body)
      const text = JSON.stringify(res)
      expect(text).not.toContain(NAME_MARKER)
      expect(text).not.toContain(URL_MARKER)
      expect(text).not.toContain(BODY_MARKER)
      expect(text).not.toContain(AUTH_MARKER)
      expect(text).not.toContain(requestId)
      expect(text).not.toContain(folder.id)
    }

    // paste 结果同样只有三字段（consumed/kind/operation），零节点内容。
    const descriptor = (await copyNode({ kind: 'request', collectionId, nodeId: requestId })).body as DescriptorShape
    const targetId = await createCollection('copy-零出口-目标')
    const pasted = await pasteToken(descriptor.token, { targetKind: 'collection', targetId })
    expect(pasted.status).toBe(200)
    expect(Object.keys(pasted.body as object).sort()).toEqual(['consumed', 'kind', 'operation'])
    const pasteText = JSON.stringify(pasted.body)
    expect(pasteText).not.toContain(NAME_MARKER)
    expect(pasteText).not.toContain(URL_MARKER)
    expect(pasteText).not.toContain(AUTH_MARKER)
  })

  it('copy 400 invalid-input：kind 非法/缺失、collectionId 缺失、folder|request 缺 nodeId', async () => {
    const collectionId = await createCollection('copy-400')
    const cases: unknown[] = [
      {},
      { kind: 'banana', collectionId },
      { kind: 'collection' },
      { kind: 'folder', collectionId },
      { kind: 'request', collectionId, nodeId: '' },
      'not-an-object',
    ]
    for (const body of cases) {
      const res = await copyNode(body as Record<string, unknown>)
      expect(res.status).toBe(400)
      expect((res.body as ErrorShape).error.code).toBe('invalid-input')
    }
  })

  it('copy 404：未知 collection/folder/request → 对应 not-found 码', async () => {
    const collectionId = await createCollection('copy-404')
    const noCollection = await copyNode({ kind: 'collection', collectionId: 'no-such' })
    expect(noCollection.status).toBe(404)
    expect((noCollection.body as ErrorShape).error.code).toBe('collection-not-found')

    const noFolder = await copyNode({ kind: 'folder', collectionId, nodeId: 'no-such' })
    expect(noFolder.status).toBe(404)
    expect((noFolder.body as ErrorShape).error.code).toBe('folder-not-found')

    const noRequest = await copyNode({ kind: 'request', collectionId, nodeId: 'no-such' })
    expect(noRequest.status).toBe(404)
    expect((noRequest.body as ErrorShape).error.code).toBe('request-not-found')
  })

  it('cut → 200 Descriptor(operation=cut,kind=request)，且不移动任何数据（树与版本零变化）', async () => {
    const fx = await buildMatrixFixture('cut-受理')
    const sourceBefore = await getCollection(fx.sourceId)
    const { status, body } = await cutNode({
      requestId: fx.sTop.id,
      requestUpdatedAt: fx.sTop.updatedAt,
      sourceCollectionUpdatedAt: sourceBefore.updatedAt,
    })
    expect(status).toBe(200)
    const descriptor = body as DescriptorShape
    expect(Object.keys(descriptor).sort()).toEqual(['expiresAt', 'kind', 'operation', 'token'])
    expect(descriptor.operation).toBe('cut')
    expect(descriptor.kind).toBe('request')
    // §13.2：Cut 阶段 Host 不移动任何数据。
    const sourceAfter = await getCollection(fx.sourceId)
    expect(sourceAfter).toEqual(sourceBefore)
  })

  it('cut 400：invalid-input（字段缺失/非数字）与 cut-only-request（kind≠request）', async () => {
    const fx = await buildMatrixFixture('cut-400')
    const version = (await getCollection(fx.sourceId)).updatedAt
    const cases: Array<{ body: Record<string, unknown>; code: string }> = [
      { body: { requestUpdatedAt: fx.sTop.updatedAt, sourceCollectionUpdatedAt: version }, code: 'invalid-input' },
      { body: { requestId: fx.sTop.id, sourceCollectionUpdatedAt: version }, code: 'invalid-input' },
      { body: { requestId: fx.sTop.id, requestUpdatedAt: 'x', sourceCollectionUpdatedAt: version }, code: 'invalid-input' },
      { body: { requestId: fx.sTop.id, requestUpdatedAt: fx.sTop.updatedAt }, code: 'invalid-input' },
      {
        body: { kind: 'folder', requestId: fx.sTop.id, requestUpdatedAt: fx.sTop.updatedAt, sourceCollectionUpdatedAt: version },
        code: 'cut-only-request',
      },
      {
        body: { kind: 'collection', requestId: fx.sTop.id, requestUpdatedAt: fx.sTop.updatedAt, sourceCollectionUpdatedAt: version },
        code: 'cut-only-request',
      },
    ]
    for (const { body, code } of cases) {
      const res = await cutNode(body)
      expect(res.status).toBe(400)
      expect((res.body as ErrorShape).error.code).toBe(code)
    }
  })

  it('cut 404 request-not-found；409（requestUpdatedAt/sourceCollectionUpdatedAt 过期）→ 逐字文案', async () => {
    const fx = await buildMatrixFixture('cut-404-409')
    const version = (await getCollection(fx.sourceId)).updatedAt

    const notFound = await cutNode({ requestId: 'no-such', requestUpdatedAt: 1, sourceCollectionUpdatedAt: version })
    expect(notFound.status).toBe(404)
    expect((notFound.body as ErrorShape).error.code).toBe('request-not-found')

    const staleRequest = await cutNode({ requestId: fx.sTop.id, requestUpdatedAt: fx.sTop.updatedAt - 1, sourceCollectionUpdatedAt: version })
    expect(staleRequest.status).toBe(409)
    expect(staleRequest.body).toEqual(VERSION_CONFLICT_BODY)

    const staleCollection = await cutNode({ requestId: fx.sTop.id, requestUpdatedAt: fx.sTop.updatedAt, sourceCollectionUpdatedAt: version - 1 })
    expect(staleCollection.status).toBe(409)
    expect(staleCollection.body).toEqual(VERSION_CONFLICT_BODY)
  })
})

// ===========================================================================
// 3. paste 合法矩阵（§6.5/UX §4.6 冻结）+ 非法组合 400
// ===========================================================================

describe('paste 合法矩阵（实施设计 §4.5/§6.5；UX §4.6 冻结）', () => {
  it('Copy Collection → root：追加根末尾、consumed=false、全子树新 ID、名称=「副本」、token 可重复用（副本 2）', async () => {
    const fx = await buildMatrixFixture('矩阵-c-root')
    const descriptor = (await copyNode({ kind: 'collection', collectionId: fx.sourceId })).body as DescriptorShape

    const first = await pasteToken(descriptor.token, { targetKind: 'root' })
    expect(first.status).toBe(200)
    expect(first.body).toEqual({ operation: 'copy', kind: 'collection', consumed: false })
    let roots = await listCollections()
    expect(roots[roots.length - 1]!.name).toBe('矩阵-c-root-源集合 副本')
    const copy1 = (await getCollection(roots[roots.length - 1]!.id)) as CollectionShape
    // 全子树 ID 全新且归属重写。
    expect(copy1.id).not.toBe(fx.sourceId)
    expect(copy1.folders[0]!.id).not.toBe(fx.sFolder.id)
    expect(copy1.folders[0]!.requests[0]!.id).not.toBe(fx.sReq.id)
    expect(copy1.folders[0]!.requests[0]!.collectionId).toBe(copy1.id)
    expect(copy1.folders[0]!.requests[0]!.folderId).toBe(copy1.folders[0]!.id)
    expect(copy1.requests[0]!.collectionId).toBe(copy1.id)
    expect(copy1.requests[0]!.folderId).toBeUndefined()

    // token 可重复使用（Copy 不消费），第二次命名「副本 2」。
    const second = await pasteToken(descriptor.token, { targetKind: 'root' })
    expect(second.status).toBe(200)
    expect((second.body as PasteResultShape).consumed).toBe(false)
    roots = await listCollections()
    expect(roots[roots.length - 1]!.name).toBe('矩阵-c-root-源集合 副本 2')
  })

  it('Copy Collection → collection：作为新根级 Collection 插在目标之后；目标自身不被修改', async () => {
    const fx = await buildMatrixFixture('矩阵-c-c')
    const third = await createCollection('矩阵-c-c-第三者')
    const targetBefore = await getCollection(fx.targetId)
    const descriptor = (await copyNode({ kind: 'collection', collectionId: fx.sourceId })).body as DescriptorShape

    const res = await pasteToken(descriptor.token, { targetKind: 'collection', targetId: fx.targetId })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ operation: 'copy', kind: 'collection', consumed: false })

    const roots = await listCollections()
    const targetIndex = roots.findIndex((c) => c.id === fx.targetId)
    expect(roots[targetIndex + 1]!.name).toBe('矩阵-c-c-源集合 副本')
    expect(roots.findIndex((c) => c.id === third)).toBeGreaterThan(targetIndex + 1)
    // 目标 Collection 对象本身未变（插入发生在根列表，不 touch 目标）。
    expect(await getCollection(fx.targetId)).toEqual(targetBefore)
  })

  it('Copy Folder → collection：追加 folders 末尾；→ folder：追加子 folders 末尾且子树 ID/collectionId/folderId 全部重写', async () => {
    const fx = await buildMatrixFixture('矩阵-f')
    const descriptor = (await copyNode({ kind: 'folder', collectionId: fx.sourceId, nodeId: fx.sFolder.id })).body as DescriptorShape

    // → collection：追加 T.folders 末尾（tFolder 之后）。
    const toCollection = await pasteToken(descriptor.token, { targetKind: 'collection', targetId: fx.targetId })
    expect(toCollection.status).toBe(200)
    expect(toCollection.body).toEqual({ operation: 'copy', kind: 'folder', consumed: false })
    let target = await getCollection(fx.targetId)
    expect(target.folders.map((f) => f.name)).toEqual(['矩阵-f-目标夹', '矩阵-f-源夹 副本'])
    const copied = target.folders[1]!
    expect(copied.id).not.toBe(fx.sFolder.id)
    // 嵌套子夹与请求全部新 ID、归属重写到目标 Collection/新 Folder。
    expect(copied.folders[0]!.id).not.toBe(fx.sSub.id)
    expect(copied.folders[0]!.name).toBe('矩阵-f-子夹')
    expect(copied.requests[0]!.id).not.toBe(fx.sReq.id)
    expect(copied.requests[0]!.collectionId).toBe(fx.targetId)
    expect(copied.requests[0]!.folderId).toBe(copied.id)
    expect(copied.folders[0]!.requests[0]!.folderId).toBe(copied.folders[0]!.id)

    // → folder：追加 tFolder.folders 末尾（子 Folder）。
    const toFolder = await pasteToken(descriptor.token, {
      targetKind: 'folder',
      targetId: fx.tFolder.id,
      targetCollectionId: fx.targetId,
    })
    expect(toFolder.status).toBe(200)
    target = await getCollection(fx.targetId)
    const tFolderShape = findFolderShape(target, fx.tFolder.id)!
    expect(tFolderShape.folders.map((f) => f.name)).toEqual(['矩阵-f-源夹 副本'])
    expect(tFolderShape.folders[0]!.requests[0]!.folderId).toBe(tFolderShape.folders[0]!.id)
  })

  it('Copy Request → collection 顶层末尾 / folder 末尾 / 锚点 request 之后；命名「副本」「副本 2」按目标容器独立', async () => {
    const fx = await buildMatrixFixture('矩阵-r')
    const descriptor = (await copyNode({ kind: 'request', collectionId: fx.sourceId, nodeId: fx.sTop.id })).body as DescriptorShape

    // → collection：追加 T.requests 末尾（t1,t2 之后）。
    const toCollection = await pasteToken(descriptor.token, { targetKind: 'collection', targetId: fx.targetId })
    expect(toCollection.status).toBe(200)
    expect(toCollection.body).toEqual({ operation: 'copy', kind: 'request', consumed: false })
    let target = await getCollection(fx.targetId)
    expect(target.requests.map((r) => r.name)).toEqual(['矩阵-r-t1', '矩阵-r-t2', '矩阵-r-s-top 副本'])
    const copy1 = target.requests[2]!
    expect(copy1.id).not.toBe(fx.sTop.id)
    expect(copy1.collectionId).toBe(fx.targetId)
    expect(copy1.folderId).toBeUndefined()
    expect(copy1.url).toBe(fx.sTop.url)

    // → folder：追加 tFolder.requests 末尾（t-req 之后）。
    const toFolder = await pasteToken(descriptor.token, {
      targetKind: 'folder',
      targetId: fx.tFolder.id,
      targetCollectionId: fx.targetId,
    })
    expect(toFolder.status).toBe(200)
    target = await getCollection(fx.targetId)
    const tFolderShape = findFolderShape(target, fx.tFolder.id)!
    expect(tFolderShape.requests.map((r) => r.name)).toEqual(['矩阵-r-t-req', '矩阵-r-s-top 副本'])
    expect(tFolderShape.requests[1]!.folderId).toBe(fx.tFolder.id)

    // → request 锚点：插在 t1 之后（t1, 副本, t2, …）。
    const toRequest = await pasteToken(descriptor.token, {
      targetKind: 'request',
      targetId: fx.t1.id,
      targetCollectionId: fx.targetId,
    })
    expect(toRequest.status).toBe(200)
    target = await getCollection(fx.targetId)
    expect(target.requests.slice(0, 3).map((r) => r.name)).toEqual(['矩阵-r-t1', '矩阵-r-s-top 副本 2', '矩阵-r-t2'])

    // 再粘一次到同一容器 → 副本 3（同目标容器同类型 sibling 冲突域，§4.6）。
    await pasteToken(descriptor.token, { targetKind: 'collection', targetId: fx.targetId })
    target = await getCollection(fx.targetId)
    expect(target.requests[target.requests.length - 1]!.name).toBe('矩阵-r-s-top 副本 3')
  })

  it('Cut Request → collection/folder/锚点 request：移动语义（源消失、原名保留、允许目标同名）、consumed=true', async () => {
    const fx = await buildMatrixFixture('矩阵-cut')
    // 目标顶层预置同名请求：Cut 保留原名且允许同名（§4.6）。
    await addRequestTo(fx.targetId, { name: '矩阵-cut-s-req' })
    const sourceBefore = await getCollection(fx.sourceId)
    const descriptor = (await cutNode({
      requestId: fx.sReq.id,
      requestUpdatedAt: fx.sReq.updatedAt,
      sourceCollectionUpdatedAt: sourceBefore.updatedAt,
    })).body as DescriptorShape

    // → collection 顶层末尾（跨 Collection 移动）。
    const res = await pasteToken(descriptor.token, { targetKind: 'collection', targetId: fx.targetId })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ operation: 'cut', kind: 'request', consumed: true })
    const source = await getCollection(fx.sourceId)
    expect(findRequestShape(source, fx.sReq.id)).toBeUndefined()
    const target = await getCollection(fx.targetId)
    const moved = target.requests[target.requests.length - 1]!
    expect(moved.id).toBe(fx.sReq.id) // Cut 保留原 id
    expect(moved.name).toBe('矩阵-cut-s-req') // 原名，不走副本命名
    expect(moved.collectionId).toBe(fx.targetId)
    expect(moved.folderId).toBeUndefined()
    expect(moved.url).toBe(fx.sReq.url)

    // token 已消费：复用 → 404 clipboard-not-found；DELETE 幂等 204。
    const reuse = await pasteToken(descriptor.token, { targetKind: 'collection', targetId: fx.targetId })
    expect(reuse.status).toBe(404)
    expect((reuse.body as ErrorShape).error.code).toBe('clipboard-not-found')
    const clear = await mutate(`/api-client/tree/clipboard/${descriptor.token}`, 'DELETE')
    expect(clear.status).toBe(204)

    // → folder：再 cut 顶层同名请求，移入 tFolder 末尾。
    const second = await getCollection(fx.targetId)
    const topSameName = second.requests.find((r) => r.id !== moved.id && r.name === '矩阵-cut-s-req')!
    const cut2 = (await cutNode({
      requestId: topSameName.id,
      requestUpdatedAt: topSameName.updatedAt,
      sourceCollectionUpdatedAt: second.updatedAt,
    })).body as DescriptorShape
    const toFolder = await pasteToken(cut2.token, { targetKind: 'folder', targetId: fx.tFolder.id, targetCollectionId: fx.targetId })
    expect(toFolder.status).toBe(200)
    expect((toFolder.body as PasteResultShape).consumed).toBe(true)
    const after2 = await getCollection(fx.targetId)
    const tFolderShape = findFolderShape(after2, fx.tFolder.id)!
    expect(tFolderShape.requests[tFolderShape.requests.length - 1]!.id).toBe(topSameName.id)
    expect(tFolderShape.requests[tFolderShape.requests.length - 1]!.folderId).toBe(fx.tFolder.id)
    expect(after2.requests.some((r) => r.id === topSameName.id)).toBe(false)

    // → request 锚点：cut t1，粘贴到 t2 之后。
    const third = await getCollection(fx.targetId)
    const cut3 = (await cutNode({
      requestId: fx.t1.id,
      requestUpdatedAt: third.requests.find((r) => r.id === fx.t1.id)!.updatedAt,
      sourceCollectionUpdatedAt: third.updatedAt,
    })).body as DescriptorShape
    const toRequest = await pasteToken(cut3.token, { targetKind: 'request', targetId: fx.t2.id, targetCollectionId: fx.targetId })
    expect(toRequest.status).toBe(200)
    const after3 = await getCollection(fx.targetId)
    const t2Index = after3.requests.findIndex((r) => r.id === fx.t2.id)
    expect(after3.requests[t2Index + 1]!.id).toBe(fx.t1.id)
  })

  it('Cut Request → 同 Collection 内移动（folder → 顶层 / 顶层 → folder）合法', async () => {
    const fx = await buildMatrixFixture('矩阵-cut-同集合')
    const source = await getCollection(fx.sourceId)
    const descriptor = (await cutNode({
      requestId: fx.sReq.id,
      requestUpdatedAt: fx.sReq.updatedAt,
      sourceCollectionUpdatedAt: source.updatedAt,
    })).body as DescriptorShape

    // s-folder → 同 Collection 顶层末尾。
    const toTop = await pasteToken(descriptor.token, { targetKind: 'collection', targetId: fx.sourceId })
    expect(toTop.status).toBe(200)
    expect((toTop.body as PasteResultShape).consumed).toBe(true)
    let tree = await getCollection(fx.sourceId)
    expect(tree.requests[tree.requests.length - 1]!.id).toBe(fx.sReq.id)
    expect(findFolderShape(tree, fx.sFolder.id)!.requests.some((r) => r.id === fx.sReq.id)).toBe(false)

    // 再 cut → 移入子夹 sSub。
    const cut2 = (await cutNode({
      requestId: fx.sReq.id,
      requestUpdatedAt: tree.requests[tree.requests.length - 1]!.updatedAt,
      sourceCollectionUpdatedAt: tree.updatedAt,
    })).body as DescriptorShape
    const toSub = await pasteToken(cut2.token, { targetKind: 'folder', targetId: fx.sSub.id, targetCollectionId: fx.sourceId })
    expect(toSub.status).toBe(200)
    tree = await getCollection(fx.sourceId)
    const subRequests = findFolderShape(tree, fx.sSub.id)!.requests
    // sSub 原有 s-deep；移入的 sReq 追加其末尾，且顶层不再有 sReq。
    expect(subRequests[subRequests.length - 1]!.id).toBe(fx.sReq.id)
    expect(tree.requests.some((r) => r.id === fx.sReq.id)).toBe(false)
  })

  it('矩阵外组合一律 400 invalid-paste-target（Copy Collection→folder/request；Copy Folder→root/request；Copy Request→root；Cut→root）', async () => {
    const fx = await buildMatrixFixture('矩阵-非法')
    const copyCollection = (await copyNode({ kind: 'collection', collectionId: fx.sourceId })).body as DescriptorShape
    const copyFolder = (await copyNode({ kind: 'folder', collectionId: fx.sourceId, nodeId: fx.sFolder.id })).body as DescriptorShape
    const copyRequest = (await copyNode({ kind: 'request', collectionId: fx.sourceId, nodeId: fx.sTop.id })).body as DescriptorShape
    const source = await getCollection(fx.sourceId)
    const cutRequest = (await cutNode({
      requestId: fx.sTop.id,
      requestUpdatedAt: fx.sTop.updatedAt,
      sourceCollectionUpdatedAt: source.updatedAt,
    })).body as DescriptorShape

    const cases: Array<{ token: string; target: Parameters<typeof pasteToken>[1] }> = [
      { token: copyCollection.token, target: { targetKind: 'folder', targetId: fx.tFolder.id, targetCollectionId: fx.targetId } },
      { token: copyCollection.token, target: { targetKind: 'request', targetId: fx.t1.id, targetCollectionId: fx.targetId } },
      { token: copyFolder.token, target: { targetKind: 'root' } },
      { token: copyFolder.token, target: { targetKind: 'request', targetId: fx.t1.id, targetCollectionId: fx.targetId } },
      { token: copyRequest.token, target: { targetKind: 'root' } },
      { token: cutRequest.token, target: { targetKind: 'root' } },
    ]
    for (const { token, target } of cases) {
      const res = await pasteToken(token, target)
      expect(res.status).toBe(400)
      expect((res.body as ErrorShape).error.code).toBe('invalid-paste-target')
    }
    // 非法尝试不消费 cut token：合法粘贴仍成功。
    const legal = await pasteToken(cutRequest.token, { targetKind: 'collection', targetId: fx.targetId })
    expect(legal.status).toBe(200)
    expect((legal.body as PasteResultShape).consumed).toBe(true)
  })

  it('省略 targetCollectionId 时由 Host 跨 collection 权威定位（§3.1 optional 字段；folder 与 request 锚点均可）', async () => {
    const fx = await buildMatrixFixture('矩阵-省略容器')
    const copyDescriptor = (await copyNode({ kind: 'request', collectionId: fx.sourceId, nodeId: fx.sTop.id })).body as DescriptorShape
    const res = await pasteToken(copyDescriptor.token, { targetKind: 'folder', targetId: fx.tFolder.id }, { versionOf: fx.targetId })
    expect(res.status).toBe(200)
    expect((res.body as PasteResultShape).consumed).toBe(false)
    let target = await getCollection(fx.targetId)
    expect(findFolderShape(target, fx.tFolder.id)!.requests.some((r) => r.name === '矩阵-省略容器-s-top 副本')).toBe(true)

    // cut → request 锚点，同样省略 targetCollectionId。
    const source = await getCollection(fx.sourceId)
    const cutDescriptor = (await cutNode({
      requestId: fx.sReq.id,
      requestUpdatedAt: fx.sReq.updatedAt,
      sourceCollectionUpdatedAt: source.updatedAt,
    })).body as DescriptorShape
    const res2 = await pasteToken(cutDescriptor.token, { targetKind: 'request', targetId: fx.t1.id }, { versionOf: fx.targetId })
    expect(res2.status).toBe(200)
    expect((res2.body as PasteResultShape).consumed).toBe(true)
    target = await getCollection(fx.targetId)
    const t1Index = target.requests.findIndex((r) => r.id === fx.t1.id)
    expect(target.requests[t1Index + 1]!.id).toBe(fx.sReq.id)
  })

  it('paste 400：targetKind 非法 / 非 root 缺 expectedTargetCollectionUpdatedAt / 缺 targetId / 类型非法', async () => {
    const fx = await buildMatrixFixture('矩阵-400')
    const descriptor = (await copyNode({ kind: 'request', collectionId: fx.sourceId, nodeId: fx.sTop.id })).body as DescriptorShape

    const badKind = await mutate(`/api-client/tree/clipboard/${descriptor.token}/paste`, 'POST', { targetKind: 'banana' })
    expect(badKind.status).toBe(400)
    expect((badKind.body as ErrorShape).error.code).toBe('invalid-paste-target')

    const missingVersion = await pasteToken(descriptor.token, { targetKind: 'collection', targetId: fx.targetId }, { expectedOverride: null })
    expect(missingVersion.status).toBe(400)
    expect((missingVersion.body as ErrorShape).error.code).toBe('invalid-paste-target')

    const badVersionType = await pasteToken(descriptor.token, { targetKind: 'collection', targetId: fx.targetId }, { expectedOverride: 'abc' })
    expect(badVersionType.status).toBe(400)
    expect((badVersionType.body as ErrorShape).error.code).toBe('invalid-paste-target')

    const missingTargetId = await mutate(`/api-client/tree/clipboard/${descriptor.token}/paste`, 'POST', {
      targetKind: 'collection',
      expectedTargetCollectionUpdatedAt: (await getCollection(fx.targetId)).updatedAt,
    })
    expect(missingTargetId.status).toBe(400)
    expect((missingTargetId.body as ErrorShape).error.code).toBe('invalid-paste-target')

    const badTargetIdType = await mutate(`/api-client/tree/clipboard/${descriptor.token}/paste`, 'POST', {
      targetKind: 'folder',
      targetId: 42,
      expectedTargetCollectionUpdatedAt: 1,
    })
    expect(badTargetIdType.status).toBe(400)
    expect((badTargetIdType.body as ErrorShape).error.code).toBe('invalid-paste-target')
  })

  it('paste 404：未知 token → clipboard-not-found；目标 collection/folder/request 不存在 → 对应 404', async () => {
    const fx = await buildMatrixFixture('矩阵-404')
    const unknownToken = await mutate('/api-client/tree/clipboard/no-such-token/paste', 'POST', { targetKind: 'root' })
    expect(unknownToken.status).toBe(404)
    expect((unknownToken.body as ErrorShape).error.code).toBe('clipboard-not-found')

    const descriptor = (await copyNode({ kind: 'request', collectionId: fx.sourceId, nodeId: fx.sTop.id })).body as DescriptorShape
    // 目标 collection 不存在：显式给 expected 值，避免版本预读打到不存在的 collection。
    const noCollection = await pasteToken(descriptor.token, { targetKind: 'collection', targetId: 'no-such' }, { expectedOverride: 1 })
    expect(noCollection.status).toBe(404)
    expect((noCollection.body as ErrorShape).error.code).toBe('collection-not-found')

    const noFolder = await pasteToken(descriptor.token, { targetKind: 'folder', targetId: 'no-such', targetCollectionId: fx.targetId })
    expect(noFolder.status).toBe(404)
    expect((noFolder.body as ErrorShape).error.code).toBe('folder-not-found')

    // folder 不在指定容器 collection 内 → 同样 404 folder-not-found。
    const wrongContainer = await pasteToken(descriptor.token, {
      targetKind: 'folder',
      targetId: fx.sFolder.id,
      targetCollectionId: fx.targetId,
    })
    expect(wrongContainer.status).toBe(404)
    expect((wrongContainer.body as ErrorShape).error.code).toBe('folder-not-found')

    const noRequest = await pasteToken(descriptor.token, { targetKind: 'request', targetId: 'no-such', targetCollectionId: fx.targetId })
    expect(noRequest.status).toBe(404)
    expect((noRequest.body as ErrorShape).error.code).toBe('request-not-found')
  })

  it('clear：DELETE 未知 token 仍幂等 204；DELETE 后原 token paste → 404', async () => {
    const collectionId = await createCollection('clear-幂等')
    const unknown = await mutate('/api-client/tree/clipboard/never-existed', 'DELETE')
    expect(unknown.status).toBe(204)

    const descriptor = (await copyNode({ kind: 'collection', collectionId })).body as DescriptorShape
    const cleared = await mutate(`/api-client/tree/clipboard/${descriptor.token}`, 'DELETE')
    expect(cleared.status).toBe(204)
    const afterClear = await pasteToken(descriptor.token, { targetKind: 'root' })
    expect(afterClear.status).toBe(404)
    expect((afterClear.body as ErrorShape).error.code).toBe('clipboard-not-found')
    // 再次 DELETE 同一 token 仍 204。
    expect((await mutate(`/api-client/tree/clipboard/${descriptor.token}`, 'DELETE')).status).toBe(204)
  })
})

// ===========================================================================
// 4. Copy 快照独立性（§4.5：copy 后源被改/删不影响 paste）
// ===========================================================================

describe('Copy 快照独立性（实施设计 §4.5）', () => {
  it('copy Request 后改源（重命名+改 URL）→ paste 内容 = 快照时点', async () => {
    const fx = await buildMatrixFixture('快照-改源')
    const descriptor = (await copyNode({ kind: 'request', collectionId: fx.sourceId, nodeId: fx.sReq.id })).body as DescriptorShape

    const renamed = await mutate(`/api-client/requests/${fx.sReq.id}`, 'PATCH', { name: '改过的名字', url: 'https://wp3/changed' })
    expect(renamed.status).toBe(200)

    const res = await pasteToken(descriptor.token, { targetKind: 'collection', targetId: fx.targetId })
    expect(res.status).toBe(200)
    const target = await getCollection(fx.targetId)
    const pasted = target.requests[target.requests.length - 1]!
    expect(pasted.id).not.toBe(fx.sReq.id)
    // 名称 = 快照原名 + 副本后缀，URL = 快照时点值。
    expect(pasted.name).toBe('快照-改源-s-req 副本')
    expect(pasted.url).toBe(fx.sReq.url)
  })

  it('copy Request 后删源 → paste 到源 Collection 本身仍成功且内容 = 快照时点', async () => {
    const collectionId = await createCollection('快照-删请求')
    const created = await addRequestTo(collectionId, {
      name: NAME_MARKER,
      url: URL_MARKER,
      body: { type: 'json', json: BODY_MARKER },
    })
    const requestId = (created.body as RequestShape).id
    const descriptor = (await copyNode({ kind: 'request', collectionId, nodeId: requestId })).body as DescriptorShape

    const del = await mutate(`/api-client/requests/${requestId}`, 'DELETE')
    expect(del.status).toBe(204)
    expect(findRequestShape(await getCollection(collectionId), requestId)).toBeUndefined()

    const res = await pasteToken(descriptor.token, { targetKind: 'collection', targetId: collectionId })
    expect(res.status).toBe(200)
    const tree = await getCollection(collectionId)
    const pasted = tree.requests[tree.requests.length - 1]!
    expect(pasted.name).toBe(`${NAME_MARKER} 副本`)
    expect(pasted.url).toBe(URL_MARKER)
    expect(pasted.body).toEqual({ type: 'json', json: BODY_MARKER })
  })

  it('copy Folder 后递归删源 folder → paste 完整子树（嵌套 folder + 请求内容 = 快照时点）', async () => {
    const fx = await buildMatrixFixture('快照-删夹')
    const deep = findFolderShape(await getCollection(fx.sourceId), fx.sSub.id)!.requests[0]!
    const descriptor = (await copyNode({ kind: 'folder', collectionId: fx.sourceId, nodeId: fx.sFolder.id })).body as DescriptorShape

    const version = (await getCollection(fx.sourceId)).updatedAt
    const del = await mutate(`/api-client/collections/${fx.sourceId}/folders/${fx.sFolder.id}`, 'DELETE', {
      expectedCollectionUpdatedAt: version,
    })
    expect(del.status).toBe(204)

    const res = await pasteToken(descriptor.token, { targetKind: 'collection', targetId: fx.targetId })
    expect(res.status).toBe(200)
    const target = await getCollection(fx.targetId)
    const pasted = target.folders[target.folders.length - 1]!
    expect(pasted.name).toBe('快照-删夹-源夹 副本')
    expect(pasted.folders[0]!.name).toBe('快照-删夹-子夹')
    expect(pasted.folders[0]!.requests[0]!.url).toBe(deep.url)
    expect(pasted.requests[0]!.url).toBe(fx.sReq.url)
    expect(pasted.requests[0]!.collectionId).toBe(fx.targetId)
  })

  it('copy Collection 后删源 Collection → paste 到 root 仍成功（全子树 = 快照时点）', async () => {
    const fx = await buildMatrixFixture('快照-删集合')
    const descriptor = (await copyNode({ kind: 'collection', collectionId: fx.sourceId })).body as DescriptorShape

    const del = await mutate(`/api-client/collections/${fx.sourceId}`, 'DELETE')
    expect(del.status).toBe(204)
    expect((await apiFetch(`/api-client/collections/${fx.sourceId}`)).status).toBe(404)

    const res = await pasteToken(descriptor.token, { targetKind: 'root' })
    expect(res.status).toBe(200)
    const roots = await listCollections()
    const pasted = await getCollection(roots[roots.length - 1]!.id)
    expect(pasted.name).toBe('快照-删集合-源集合 副本')
    expect(pasted.folders[0]!.requests[0]!.url).toBe(fx.sReq.url)
    expect(pasted.requests[0]!.url).toBe(fx.sTop.url)
  })
})

// ===========================================================================
// 5. Cut 版本守护与 token 生命周期（§3.1.1/§4.4/AC-18）
// ===========================================================================

describe('Cut 版本守护（实施设计 §3.1.1/§4.4；AC-18）', () => {
  it('Cut 后修改 Request → paste 409 逐字文案；源未动、零写盘；token 未消费（再次 paste 仍 409 而非 404）', async () => {
    const fx = await buildMatrixFixture('守护-改请求')
    const sourceBefore = await getCollection(fx.sourceId)
    const descriptor = (await cutNode({
      requestId: fx.sTop.id,
      requestUpdatedAt: fx.sTop.updatedAt,
      sourceCollectionUpdatedAt: sourceBefore.updatedAt,
    })).body as DescriptorShape

    // 剪切后修改源 Request（request.updatedAt 与 sourceCollection.updatedAt 同时前移）。
    const renamed = await mutate(`/api-client/requests/${fx.sTop.id}`, 'PATCH', { name: '剪切后被改名' })
    expect(renamed.status).toBe(200)

    const writes = spyCollectionsWrites()
    const first = await pasteToken(descriptor.token, { targetKind: 'collection', targetId: fx.targetId })
    expect(first.status).toBe(409)
    expect(first.body).toEqual(VERSION_CONFLICT_BODY)
    expect(writes.count()).toBe(0) // 不写文件
    writes.restore()

    // 不移动 Cut Request：仍在源 Collection 顶层。
    const source = await getCollection(fx.sourceId)
    expect(source.requests.some((r) => r.id === fx.sTop.id)).toBe(true)
    const target = await getCollection(fx.targetId)
    expect(target.requests.some((r) => r.id === fx.sTop.id)).toBe(false)

    // token 未被消费：再次 paste 仍是 409（版本仍不符）而非 404 clipboard-not-found。
    const second = await pasteToken(descriptor.token, { targetKind: 'collection', targetId: fx.targetId })
    expect(second.status).toBe(409)
    expect(second.body).toEqual(VERSION_CONFLICT_BODY)
  })

  it('Cut 后目标 Collection 变化 → 过期 expected 409；换新 expected 后同一 token 成功（409 不消费 token）', async () => {
    const fx = await buildMatrixFixture('守护-改目标')
    const sourceBefore = await getCollection(fx.sourceId)
    const targetBefore = await getCollection(fx.targetId)
    const descriptor = (await cutNode({
      requestId: fx.sTop.id,
      requestUpdatedAt: fx.sTop.updatedAt,
      sourceCollectionUpdatedAt: sourceBefore.updatedAt,
    })).body as DescriptorShape

    // 目标 Collection 被其他操作修改（新增请求 → updatedAt 前移）。
    await addRequestTo(fx.targetId, { name: '目标新请求' })

    const stale = await pasteToken(descriptor.token, { targetKind: 'collection', targetId: fx.targetId }, { expectedOverride: targetBefore.updatedAt })
    expect(stale.status).toBe(409)
    expect(stale.body).toEqual(VERSION_CONFLICT_BODY)
    // 源未动。
    expect(findRequestShape(await getCollection(fx.sourceId), fx.sTop.id)).toBeDefined()

    // 同一 token 换新版本 → 成功（证明 409 未消费 token）。
    const fresh = await pasteToken(descriptor.token, { targetKind: 'collection', targetId: fx.targetId })
    expect(fresh.status).toBe(200)
    expect(fresh.body).toEqual({ operation: 'cut', kind: 'request', consumed: true })
    expect(findRequestShape(await getCollection(fx.sourceId), fx.sTop.id)).toBeUndefined()
  })

  it('Cut 后源 Collection 被重命名 → paste 409（sourceCollectionUpdatedAt 不符），源 Request 仍在', async () => {
    const fx = await buildMatrixFixture('守护-改源集合')
    const sourceBefore = await getCollection(fx.sourceId)
    const descriptor = (await cutNode({
      requestId: fx.sTop.id,
      requestUpdatedAt: fx.sTop.updatedAt,
      sourceCollectionUpdatedAt: sourceBefore.updatedAt,
    })).body as DescriptorShape

    const renamed = await mutate(`/api-client/collections/${fx.sourceId}`, 'PATCH', { name: '源集合新名' })
    expect(renamed.status).toBe(200)

    const res = await pasteToken(descriptor.token, { targetKind: 'collection', targetId: fx.targetId })
    expect(res.status).toBe(409)
    expect(res.body).toEqual(VERSION_CONFLICT_BODY)
    expect(findRequestShape(await getCollection(fx.sourceId), fx.sTop.id)).toBeDefined()
  })

  it('Cut 后源 Request 被外部删除 → paste 404 request-not-found；源 Collection 被删 → 404 collection-not-found', async () => {
    const fx = await buildMatrixFixture('守护-删源')
    const sourceBefore = await getCollection(fx.sourceId)
    const descriptor = (await cutNode({
      requestId: fx.sTop.id,
      requestUpdatedAt: fx.sTop.updatedAt,
      sourceCollectionUpdatedAt: sourceBefore.updatedAt,
    })).body as DescriptorShape
    expect((await mutate(`/api-client/requests/${fx.sTop.id}`, 'DELETE')).status).toBe(204)
    const res = await pasteToken(descriptor.token, { targetKind: 'collection', targetId: fx.targetId })
    expect(res.status).toBe(404)
    expect((res.body as ErrorShape).error.code).toBe('request-not-found')

    const fx2 = await buildMatrixFixture('守护-删源集合')
    const source2 = await getCollection(fx2.sourceId)
    const descriptor2 = (await cutNode({
      requestId: fx2.sTop.id,
      requestUpdatedAt: fx2.sTop.updatedAt,
      sourceCollectionUpdatedAt: source2.updatedAt,
    })).body as DescriptorShape
    expect((await mutate(`/api-client/collections/${fx2.sourceId}`, 'DELETE')).status).toBe(204)
    const res2 = await pasteToken(descriptor2.token, { targetKind: 'collection', targetId: fx2.targetId })
    expect(res2.status).toBe(404)
    expect((res2.body as ErrorShape).error.code).toBe('collection-not-found')
  })

  it('Cut 粘贴到被移动请求自身之后 → 400 invalid-paste-target（WP1 注记②），token 未消费', async () => {
    const fx = await buildMatrixFixture('守护-自身锚点')
    const source = await getCollection(fx.sourceId)
    const descriptor = (await cutNode({
      requestId: fx.sTop.id,
      requestUpdatedAt: fx.sTop.updatedAt,
      sourceCollectionUpdatedAt: source.updatedAt,
    })).body as DescriptorShape

    const res = await pasteToken(descriptor.token, { targetKind: 'request', targetId: fx.sTop.id, targetCollectionId: fx.sourceId })
    expect(res.status).toBe(400)
    expect((res.body as ErrorShape).error.code).toBe('invalid-paste-target')

    // token 未消费：合法目标仍可粘贴。
    const legal = await pasteToken(descriptor.token, { targetKind: 'collection', targetId: fx.targetId })
    expect(legal.status).toBe(200)
    expect((legal.body as PasteResultShape).consumed).toBe(true)
  })
})

// ===========================================================================
// 6. 原子写（§4.4/AC-20：一次动作恰好一次 collections.json 写入）
// ===========================================================================

describe('原子写与写盘失败守护（实施设计 §4.4；AC-20）', () => {
  it('跨 Collection Cut paste：collections 文件恰好一次 writeJson，载荷为完整 nextCollections[]', async () => {
    const fx = await buildMatrixFixture('原子-跨集合')
    const source = await getCollection(fx.sourceId)
    const descriptor = (await cutNode({
      requestId: fx.sReq.id,
      requestUpdatedAt: fx.sReq.updatedAt,
      sourceCollectionUpdatedAt: source.updatedAt,
    })).body as DescriptorShape

    const writes = spyCollectionsWrites()
    const res = await pasteToken(descriptor.token, { targetKind: 'collection', targetId: fx.targetId })
    expect(res.status).toBe(200)
    expect(writes.count()).toBe(1)
    // 步骤 4 证据：单次写盘载荷是完整列表，源已移除、目标已插入（不存在半移动状态）。
    const payload = writes.payload() as CollectionShape[]
    const payloadSource = payload.find((c) => c.id === fx.sourceId)!
    const payloadTarget = payload.find((c) => c.id === fx.targetId)!
    expect(findRequestShape(payloadSource, fx.sReq.id)).toBeUndefined()
    expect(payloadTarget.requests.some((r) => r.id === fx.sReq.id)).toBe(true)
    writes.restore()
  })

  it('同 Collection Cut paste 与 Copy paste 与 Folder 创建：各恰好一次 writeJson', async () => {
    const fx = await buildMatrixFixture('原子-单次')
    // 同 Collection cut（nextSource === nextTarget，只计一次）。
    const source = await getCollection(fx.sourceId)
    const cutDescriptor = (await cutNode({
      requestId: fx.sReq.id,
      requestUpdatedAt: fx.sReq.updatedAt,
      sourceCollectionUpdatedAt: source.updatedAt,
    })).body as DescriptorShape
    const writes = spyCollectionsWrites()
    expect((await pasteToken(cutDescriptor.token, { targetKind: 'collection', targetId: fx.sourceId })).status).toBe(200)
    expect(writes.count()).toBe(1)
    writes.restore()

    // Copy request → folder。
    const copyDescriptor = (await copyNode({ kind: 'request', collectionId: fx.sourceId, nodeId: fx.sTop.id })).body as DescriptorShape
    const writes2 = spyCollectionsWrites()
    expect((await pasteToken(copyDescriptor.token, { targetKind: 'folder', targetId: fx.tFolder.id, targetCollectionId: fx.targetId })).status).toBe(200)
    expect(writes2.count()).toBe(1)
    writes2.restore()

    // Copy collection → root（整列表追加也是一次写）。
    const collectionCopy = (await copyNode({ kind: 'collection', collectionId: fx.sourceId })).body as DescriptorShape
    const writes3 = spyCollectionsWrites()
    expect((await pasteToken(collectionCopy.token, { targetKind: 'root' })).status).toBe(200)
    expect(writes3.count()).toBe(1)
    writes3.restore()

    // Folder 创建端点同样单次写。
    const writes4 = spyCollectionsWrites()
    await createFolderIn(fx.targetId, '原子夹')
    expect(writes4.count()).toBe(1)
    writes4.restore()
  })

  it('写盘失败：内存权威态不替换、token 不消费、磁盘保持原状；恢复后同版本 paste 成功', async () => {
    const fx = await buildMatrixFixture('原子-写失败')
    const source = await getCollection(fx.sourceId)
    const target = await getCollection(fx.targetId)
    const descriptor = (await cutNode({
      requestId: fx.sTop.id,
      requestUpdatedAt: fx.sTop.updatedAt,
      sourceCollectionUpdatedAt: source.updatedAt,
    })).body as DescriptorShape
    const fileBefore = readCollectionsFile()

    const spy = vi.spyOn(services.store, 'writeJson').mockImplementationOnce(() => {
      throw new Error('wp3 模拟磁盘写失败')
    })
    const failed = await pasteToken(descriptor.token, { targetKind: 'collection', targetId: fx.targetId }, { expectedOverride: target.updatedAt })
    expect(failed.status).toBe(500)
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()

    // 磁盘保持原状（未写半截）。
    expect(readCollectionsFile()).toEqual(fileBefore)
    // 内存权威态未替换：request 仍在源 Collection，版本未变。
    expect(findRequestShape(await getCollection(fx.sourceId), fx.sTop.id)).toBeDefined()
    expect((await getCollection(fx.sourceId)).updatedAt).toBe(source.updatedAt)
    expect((await getCollection(fx.targetId)).updatedAt).toBe(target.updatedAt)

    // token 未消费：恢复写盘后用同一 token、同一组版本 → 成功。
    const retry = await pasteToken(descriptor.token, { targetKind: 'collection', targetId: fx.targetId }, { expectedOverride: target.updatedAt })
    expect(retry.status).toBe(200)
    expect(retry.body).toEqual({ operation: 'cut', kind: 'request', consumed: true })
    expect(findRequestShape(await getCollection(fx.sourceId), fx.sTop.id)).toBeUndefined()
  })
})

// ===========================================================================
// 7. TTL / profile 绑定 / 单调时间（§4.2/§4.3；服务层 + fake timers）
// ===========================================================================

describe('clipboard TTL 与 profile 绑定（实施设计 §4.2；服务层）', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('30 分钟内可 paste；恰好 30 分钟起过期 → clipboard-not-found(404)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-10T00:00:00Z'))
    const collection = services.collections.create('wp3-ttl')
    const clipboard = new TreeClipboardService(services.collections, services.profile)
    const descriptor = clipboard.copy({ kind: 'collection', collectionId: collection.id })
    expect(descriptor.expiresAt).toBe(Date.now() + CLIPBOARD_TTL_MS)

    // 29 分 59 秒：仍有效。
    vi.advanceTimersByTime(CLIPBOARD_TTL_MS - 1000)
    expect(clipboard.paste(descriptor.token, { targetKind: 'root' })).toEqual({
      operation: 'copy',
      kind: 'collection',
      consumed: false,
    })

    // 恰好 30 分钟：过期（expiresAt <= now），惰性清理后按不存在处理。
    vi.advanceTimersByTime(1000)
    expect(() => clipboard.paste(descriptor.token, { targetKind: 'root' })).toThrowError(
      expect.objectContaining({ code: 'clipboard-not-found', httpStatus: 404 }) as Error,
    )
    // 过期 token 的主动清空仍幂等。
    clipboard.clear(descriptor.token)
  })

  it('cut 条目同样受 TTL 约束：过期后 paste → clipboard-not-found', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-10T02:00:00Z'))
    const collection = services.collections.create('wp3-ttl-cut')
    const request = services.collections.addRequest(collection.id, { name: 'ttl-req' })
    const clipboard = new TreeClipboardService(services.collections, services.profile)
    const descriptor = clipboard.cut({
      requestId: request.id,
      requestUpdatedAt: request.updatedAt,
      sourceCollectionUpdatedAt: services.collections.require(collection.id).updatedAt,
    })
    vi.advanceTimersByTime(CLIPBOARD_TTL_MS + 1)
    expect(() =>
      clipboard.paste(descriptor.token, {
        targetKind: 'collection',
        targetId: collection.id,
        expectedTargetCollectionUpdatedAt: services.collections.require(collection.id).updatedAt,
      }),
    ).toThrowError(expect.objectContaining({ code: 'clipboard-not-found' }) as Error)
  })

  it('token 绑定 profileId：跨 profile 使用 → clipboard-not-found（双向）', () => {
    const otherProfile = ProfileService.detect({ env: { DSH_PROFILE: 'wp3-other-profile' }, home: tmpHome })
    expect(otherProfile.profileId).not.toBe(services.profile.profileId)
    const other = new TreeClipboardService(services.collections, otherProfile)
    const collection = services.collections.create('wp3-profile-绑定')

    const descriptor = services.treeClipboard.copy({ kind: 'collection', collectionId: collection.id })
    expect(() => other.paste(descriptor.token, { targetKind: 'root' })).toThrowError(
      expect.objectContaining({ code: 'clipboard-not-found', httpStatus: 404 }) as Error,
    )

    const reversed = other.copy({ kind: 'collection', collectionId: collection.id })
    expect(() => services.treeClipboard.paste(reversed.token, { targetKind: 'root' })).toThrowError(
      expect.objectContaining({ code: 'clipboard-not-found', httpStatus: 404 }) as Error,
    )
  })
})

describe('单调 updatedAt（实施设计 §4.3；冻结时钟下连续 mutation 严格递增）', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('同一毫秒内连续写：collection/request 的 updatedAt 均严格递增', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-10T01:00:00Z'))
    const frozen = Date.now()
    const collection = services.collections.create('wp3-单调')

    const c0 = services.collections.require(collection.id)
    const folder = services.collections.createFolder(collection.id, 'f1', c0.updatedAt)
    const c1 = services.collections.require(collection.id)
    expect(c1.updatedAt).toBeGreaterThan(c0.updatedAt)

    services.collections.renameFolder(collection.id, folder.id, 'f1b', c1.updatedAt)
    const c2 = services.collections.require(collection.id)
    expect(c2.updatedAt).toBeGreaterThan(c1.updatedAt)

    const request = services.collections.addRequest(collection.id, { name: 'r1' })
    const c3 = services.collections.require(collection.id)
    expect(c3.updatedAt).toBeGreaterThan(c2.updatedAt)

    const patched1 = services.collections.patchRequest(request.id, { name: 'r2' })
    expect(patched1.updatedAt).toBeGreaterThan(request.updatedAt)
    const patched2 = services.collections.patchRequest(request.id, { name: 'r3' })
    expect(patched2.updatedAt).toBeGreaterThan(patched1.updatedAt)
    const c4 = services.collections.require(collection.id)
    expect(c4.updatedAt).toBeGreaterThan(c3.updatedAt)

    // deleteFolder 也走单调时间。
    services.collections.deleteFolder(collection.id, folder.id, c4.updatedAt)
    expect(services.collections.require(collection.id).updatedAt).toBeGreaterThan(c4.updatedAt)

    // 时钟全程冻结：递增全部来自 nextTimestamp 的 +1 规则。
    expect(Date.now()).toBe(frozen)
  })
})

// ===========================================================================
// 8. suppressedGeneratedHeaders（§3.3 校验 + 规范化去重）与 PATCH name 校验
// ===========================================================================

describe('suppressedGeneratedHeaders 与 PATCH name 校验（实施设计 §3.2/§3.3）', () => {
  it('POST 规范化：trim + lowercase + (name,source) 去重（保留首个）', async () => {
    const collectionId = await createCollection('wp3-抑制-规范化')
    const { status, body } = await addRequestTo(collectionId, {
      name: '抑制请求',
      suppressedGeneratedHeaders: [
        { name: ' Content-Type ', source: 'body' },
        { name: 'content-type', source: 'body' },
        { name: 'CONTENT-TYPE', source: 'body' },
        { name: 'Accept', source: 'client-default' },
        { name: 'content-type', source: 'client-default' },
      ],
    })
    expect(status).toBe(200)
    expect((body as RequestShape).suppressedGeneratedHeaders).toEqual([
      { name: 'content-type', source: 'body' },
      { name: 'accept', source: 'client-default' },
      { name: 'content-type', source: 'client-default' },
    ])
    // 落盘同样为规范化形态。
    const stored = readCollectionsFile().find((c) => c.id === collectionId)!
    expect(stored.requests[0]!.suppressedGeneratedHeaders).toEqual([
      { name: 'content-type', source: 'body' },
      { name: 'accept', source: 'client-default' },
      { name: 'content-type', source: 'client-default' },
    ])
  })

  it('POST 缺省 → 持久化空数组 []（§3.2 默认值 / §4.1.1 新建写出规范化数组）', async () => {
    const collectionId = await createCollection('wp3-抑制-缺省')
    const { status, body } = await addRequestTo(collectionId, { name: '无抑制' })
    expect(status).toBe(200)
    expect((body as RequestShape).suppressedGeneratedHeaders).toEqual([])
  })

  it('POST 拒绝全分支：非数组/项非对象/name 空/纯空白/非字符串/source auth/runtime/未知 source → 400 invalid-input 且零落库', async () => {
    const collectionId = await createCollection('wp3-抑制-400')
    const cases: unknown[] = [
      { name: 'x', suppressedGeneratedHeaders: 'not-an-array' },
      { name: 'x', suppressedGeneratedHeaders: { name: 'accept', source: 'body' } },
      { name: 'x', suppressedGeneratedHeaders: ['accept'] },
      { name: 'x', suppressedGeneratedHeaders: [{ name: '', source: 'body' }] },
      { name: 'x', suppressedGeneratedHeaders: [{ name: '   ', source: 'body' }] },
      { name: 'x', suppressedGeneratedHeaders: [{ name: 42, source: 'body' }] },
      { name: 'x', suppressedGeneratedHeaders: [{ name: 'authorization', source: 'auth' }] },
      { name: 'x', suppressedGeneratedHeaders: [{ name: 'host', source: 'runtime' }] },
      { name: 'x', suppressedGeneratedHeaders: [{ name: 'accept', source: 'server' }] },
      { name: 'x', suppressedGeneratedHeaders: [{ name: 'accept' }] },
    ]
    for (const body of cases) {
      const res = await addRequestTo(collectionId, body as Record<string, unknown>)
      expect(res.status).toBe(400)
      expect((res.body as ErrorShape).error.code).toBe('invalid-input')
    }
    expect((await getCollection(collectionId)).requests).toEqual([])
  })

  it('PATCH：name 空串/纯空白/非字符串 → 400 invalid-input；合法重命名不受影响', async () => {
    const collectionId = await createCollection('wp3-patch-name')
    const created = await addRequestTo(collectionId, { name: '原名' })
    const requestId = (created.body as RequestShape).id

    for (const name of ['', '   ', 42, null]) {
      const res = await mutate(`/api-client/requests/${requestId}`, 'PATCH', { name })
      expect(res.status).toBe(400)
      expect((res.body as ErrorShape).error.code).toBe('invalid-input')
    }
    const ok = await mutate(`/api-client/requests/${requestId}`, 'PATCH', { name: '新名' })
    expect(ok.status).toBe(200)
    expect((ok.body as RequestShape).name).toBe('新名')
  })

  it('PATCH suppressedGeneratedHeaders：规范化去重生效；source auth → 400；未携带时保持既有值', async () => {
    const collectionId = await createCollection('wp3-patch-抑制')
    const created = await addRequestTo(collectionId, {
      name: '待补抑制',
      suppressedGeneratedHeaders: [{ name: 'accept', source: 'client-default' }],
    })
    const requestId = (created.body as RequestShape).id

    const patched = await mutate(`/api-client/requests/${requestId}`, 'PATCH', {
      suppressedGeneratedHeaders: [{ name: ' Content-Type ', source: 'body' }, { name: 'content-type', source: 'body' }],
    })
    expect(patched.status).toBe(200)
    expect((patched.body as RequestShape).suppressedGeneratedHeaders).toEqual([{ name: 'content-type', source: 'body' }])

    const rejected = await mutate(`/api-client/requests/${requestId}`, 'PATCH', {
      suppressedGeneratedHeaders: [{ name: 'authorization', source: 'auth' }],
    })
    expect(rejected.status).toBe(400)
    expect((rejected.body as ErrorShape).error.code).toBe('invalid-input')

    const rejectedNonArray = await mutate(`/api-client/requests/${requestId}`, 'PATCH', { suppressedGeneratedHeaders: 'x' })
    expect(rejectedNonArray.status).toBe(400)

    // 未携带字段 → 既有值保持不变。
    const untouched = await mutate(`/api-client/requests/${requestId}`, 'PATCH', { url: 'https://wp3/untouched' })
    expect(untouched.status).toBe(200)
    expect((untouched.body as RequestShape).suppressedGeneratedHeaders).toEqual([{ name: 'content-type', source: 'body' }])
  })
})
