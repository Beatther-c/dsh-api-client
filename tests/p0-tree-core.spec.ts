/**
 * WP1：P0 树 core 纯函数（实施设计 §4.4–§4.6、§7.1、§8.1 #8 copy_and_cut_semantics 的 core 部分；
 * UX spec §4.6/§4.7 冻结语义）。
 * 断言覆盖：全部结构 ID 重建且互不相同、collectionId/folderId 重写正确、after-request 插入位置、
 * 副本命名序列（副本/副本 2/副本 3）、入参对象未被突变（structuredClone 深比较）、
 * descendant 统计递归正确、版本谓词严格相等。
 * Cut 的版本过期 409 / token 不消费属 Host 侧，见 tests/p0-host-tree-api.spec.ts（WP3）。
 */
import { describe, expect, it } from 'vitest'
import type { ApiRequest, Collection, Folder } from '@dsh-api-client/shared'
import { createSecretRef } from '@dsh-api-client/shared'
import {
  collectionVersionMatches,
  copyCollectionTree,
  copyFolderTree,
  copyRequestSnapshot,
  countCollectionRequests,
  countFolderDescendants,
  findFolder,
  findRequest,
  insertRequestAt,
  listAllRequests,
  moveRequestAcrossCollections,
  nextCopyName,
  requestVersionMatches,
} from '@dsh-api-client/core'

// ---- 夹具 ----

/**
 * 源 Collection：c-src{ 顶层 r1；f1「users」{ r2「get-user」（富字段：SecretRef/脚本/
 * suppressedGeneratedHeaders/{{variable}}）；f2「admin」{ r3「deep」} } }
 */
function sourceFixture(): Collection {
  return {
    id: 'c-src',
    name: '源集合',
    auth: { type: 'bearer', token: 'collection-token' },
    variables: [{ key: 'host', value: 'https://api.example.com', enabled: true }],
    folders: [
      {
        id: 'f1',
        name: 'users',
        folders: [
          {
            id: 'f2',
            name: 'admin',
            folders: [],
            requests: [
              {
                id: 'r3',
                name: 'deep',
                method: 'DELETE',
                url: 'https://{{host}}/admin/1',
                params: [],
                headers: [],
                auth: { type: 'inherit' },
                body: { type: 'none' },
                collectionId: 'c-src',
                folderId: 'f2',
                createdAt: 101,
                updatedAt: 201,
              },
            ],
          },
        ],
        requests: [
          {
            id: 'r2',
            name: 'get-user',
            method: 'POST',
            url: 'https://{{host}}/users/1?q={{keyword}}',
            params: [{ key: 'q', value: '{{keyword}}', description: '查询词', enabled: true }],
            headers: [{ key: 'X-Token', value: '{{token}}', enabled: true }],
            auth: { type: 'basic', username: 'user', password: createSecretRef() },
            body: { type: 'json', json: '{"keyword":"{{keyword}}"}' },
            suppressedGeneratedHeaders: [{ name: 'accept', source: 'client-default' }],
            scripts: { preRequest: 'console.log("hi")', source: 'manual', warning: 'V0.1 不执行脚本' },
            collectionId: 'c-src',
            folderId: 'f1',
            createdAt: 100,
            updatedAt: 200,
          },
        ],
      },
    ],
    requests: [
      {
        id: 'r1',
        name: 'list',
        method: 'GET',
        url: 'https://{{host}}/users',
        params: [],
        headers: [],
        auth: { type: 'none' },
        body: { type: 'none' },
        collectionId: 'c-src',
        createdAt: 99,
        updatedAt: 199,
      },
    ],
    createdAt: 1000,
    updatedAt: 2000,
  }
}

/** 目标 Collection：c-dst{ 顶层 t1/t2；g1「target-folder」{ t3 } } */
function targetFixture(): Collection {
  const req = (id: string, name: string, folderId?: string): ApiRequest => ({
    id,
    name,
    method: 'GET',
    url: `https://dst/${id}`,
    params: [],
    headers: [],
    auth: { type: 'none' },
    body: { type: 'none' },
    collectionId: 'c-dst',
    ...(folderId !== undefined ? { folderId } : {}),
    createdAt: 50,
    updatedAt: 60,
  })
  return {
    id: 'c-dst',
    name: '目标集合',
    variables: [],
    folders: [{ id: 'g1', name: 'target-folder', folders: [], requests: [req('t3', 'in-folder', 'g1')] }],
    requests: [req('t1', 't-one'), req('t2', 't-two')],
    createdAt: 3000,
    updatedAt: 5000,
  }
}

/** Collection 全部结构节点 id（collection + folders + requests，递归）。 */
function collectNodeIds(collection: Collection): string[] {
  const ids: string[] = [collection.id]
  const walk = (folders: Folder[]): void => {
    for (const f of folders) {
      ids.push(f.id)
      walk(f.folders)
    }
  }
  walk(collection.folders)
  for (const r of listAllRequests(collection)) ids.push(r.id)
  return ids
}

/** Folder 子树全部结构节点 id（folder 自身 + 后代 folders + requests，递归）。 */
function collectFolderIds(folder: Folder): string[] {
  const ids: string[] = [folder.id]
  for (const child of folder.folders) ids.push(...collectFolderIds(child))
  for (const r of folder.requests) ids.push(r.id)
  return ids
}

// ---- §8.1 #8：copy_and_cut_semantics（core 纯函数部分）----

describe('copy_and_cut_semantics — core 纯函数（实施设计 §8.1 #8）', () => {
  it('copyRequestSnapshot：完整快照新 id、目标容器重写，持久化字段与 {{variable}}/SecretRef 原样复制', () => {
    const src = sourceFixture()
    const srcBefore = structuredClone(src)
    const original = findRequest(src, 'r2')!.request
    const originalBefore = structuredClone(original)

    const copy = copyRequestSnapshot(original, 'c-dst', 'g1', 9000)

    // 新 id + 目标重写（UX §4.6：结构 ID 重建、collectionId/folderId 按新目标重写）
    expect(copy.id).not.toBe(original.id)
    expect(copy.collectionId).toBe('c-dst')
    expect(copy.folderId).toBe('g1')
    expect(copy.createdAt).toBe(9000)
    expect(copy.updatedAt).toBe(9000)
    // 完整快照：当前持久化全部字段逐一复制
    expect(copy.name).toBe('get-user')
    expect(copy.method).toBe('POST')
    expect(copy.url).toBe('https://{{host}}/users/1?q={{keyword}}') // {{variable}} 引用文本原样
    expect(copy.params).toEqual(original.params)
    expect(copy.params[0]?.value).toBe('{{keyword}}')
    expect(copy.headers).toEqual(original.headers)
    expect(copy.headers[0]?.value).toBe('{{token}}')
    expect(copy.auth).toEqual(original.auth) // SecretRef 结构原样
    const copyRef = (copy.auth as { type: 'basic'; password: { $ref: string } }).password.$ref
    const originalRef = (original.auth as { type: 'basic'; password: { $ref: string } }).password.$ref
    expect(copyRef).toBe(originalRef)
    expect(copy.body).toEqual({ type: 'json', json: '{"keyword":"{{keyword}}"}' })
    expect(copy.suppressedGeneratedHeaders).toEqual([{ name: 'accept', source: 'client-default' }])
    expect(copy.scripts).toEqual(original.scripts)
    // 深拷贝：不与原件共享嵌套引用
    expect(copy.headers).not.toBe(original.headers)
    expect(copy.params).not.toBe(original.params)
    expect(copy.auth).not.toBe(original.auth)
    copy.headers[0]!.key = 'mutated'
    expect(original.headers[0]?.key).toBe('X-Token')
    // 顶层目标：folderId 被删除（而非保留旧值）
    const topCopy = copyRequestSnapshot(original, 'c-dst', undefined, 9000)
    expect('folderId' in topCopy).toBe(false)
    // now 缺省：createdAt === updatedAt（取 Date.now()）
    const autoCopy = copyRequestSnapshot(original, 'c-dst')
    expect(autoCopy.createdAt).toBe(autoCopy.updatedAt)
    // 入参未被突变（深比较）
    expect(original).toEqual(originalBefore)
    expect(src).toEqual(srcBefore)
  })

  it('copyFolderTree：子树全部新 id 互不相同，request 的 collectionId/folderId 按新结构重写', () => {
    const src = sourceFixture()
    const srcBefore = structuredClone(src)
    const folder = findFolder(src, 'f1')!

    const copied = copyFolderTree(folder, 'c-dst', 9000)

    // 全部结构 ID 重建且互不相同
    const originalIds = collectFolderIds(folder)
    const copiedIds = collectFolderIds(copied)
    expect(copiedIds).toHaveLength(originalIds.length)
    expect(new Set(copiedIds).size).toBe(copiedIds.length)
    for (const id of copiedIds) expect(originalIds).not.toContain(id)
    // 结构与名称原样（命名/插入位置由调用方决定，§4.5/§4.6）
    expect(copied.name).toBe('users')
    expect(copied.folders.map((f) => f.name)).toEqual(['admin'])
    // request 归属重写：collectionId → 目标；folderId → 新结构中对应新 Folder id
    const directCopy = copied.requests.find((r) => r.name === 'get-user')!
    expect(directCopy.collectionId).toBe('c-dst')
    expect(directCopy.folderId).toBe(copied.id)
    expect(directCopy.createdAt).toBe(9000)
    expect(directCopy.updatedAt).toBe(9000)
    const nestedCopy = copied.folders[0]!.requests.find((r) => r.name === 'deep')!
    expect(nestedCopy.collectionId).toBe('c-dst')
    expect(nestedCopy.folderId).toBe(copied.folders[0]!.id)
    // 快照内容原样（{{variable}} 文本）
    expect(directCopy.url).toBe('https://{{host}}/users/1?q={{keyword}}')
    expect(nestedCopy.url).toBe('https://{{host}}/admin/1')
    expect(directCopy.body).toEqual(folder.requests[0]!.body)
    // 入参未被突变
    expect(src).toEqual(srcBefore)
  })

  it('copyCollectionTree：全子树 id 重建互不相同，request 指向新 Collection，名称保留供调用方按 §4.6 命名', () => {
    const src = sourceFixture()
    const srcBefore = structuredClone(src)

    const copied = copyCollectionTree(src, 9000)

    const originalIds = collectNodeIds(src)
    const copiedIds = collectNodeIds(copied)
    expect(copiedIds).toHaveLength(originalIds.length)
    expect(new Set(copiedIds).size).toBe(copiedIds.length)
    for (const id of copiedIds) expect(originalIds).not.toContain(id)
    // 与兼容 duplicateCollection 的区别：不加 "(copy)"，命名走调用方 nextCopyName
    expect(copied.name).toBe('源集合')
    expect(copied.createdAt).toBe(9000)
    expect(copied.updatedAt).toBe(9000)
    // 全部 request 的 collectionId 指向新 Collection；folderId 按新结构重写
    for (const r of listAllRequests(copied)) expect(r.collectionId).toBe(copied.id)
    const nested = copied.folders[0]!.folders[0]!.requests[0]!
    expect(nested.folderId).toBe(copied.folders[0]!.folders[0]!.id)
    const direct = copied.folders[0]!.requests[0]!
    expect(direct.folderId).toBe(copied.folders[0]!.id)
    expect('folderId' in copied.requests[0]!).toBe(false) // 顶层 request 无 folderId
    // variables/auth 深拷贝且不共享引用
    expect(copied.variables).toEqual(src.variables)
    expect(copied.variables).not.toBe(src.variables)
    expect(copied.auth).toEqual(src.auth)
    expect(copied.auth).not.toBe(src.auth)
    // 入参未被突变
    expect(src).toEqual(srcBefore)
  })

  it('版本谓词：updatedAt 严格相等（§4.3 乐观锁 / §3.1.1 409 判定）', () => {
    const src = sourceFixture()
    expect(collectionVersionMatches(src, 2000)).toBe(true)
    expect(collectionVersionMatches(src, 2001)).toBe(false)
    expect(collectionVersionMatches(src, 1999)).toBe(false)
    const r2 = findRequest(src, 'r2')!.request
    expect(requestVersionMatches(r2, 200)).toBe(true)
    expect(requestVersionMatches(r2, 201)).toBe(false)
    expect(requestVersionMatches(r2, 199)).toBe(false)
  })
})

// ---- §4.6 副本命名 ----

describe('nextCopyName：稳定副本命名（实施设计 §4.6）', () => {
  it('序列：名称 副本 → 名称 副本 2 → 名称 副本 3，取第一个空位', () => {
    expect(nextCopyName('users', [])).toBe('users 副本')
    // 冲突范围仅同容器同类型 sibling：原名/他名不参与冲突
    expect(nextCopyName('users', ['users', 'admins'])).toBe('users 副本')
    expect(nextCopyName('users', ['users 副本'])).toBe('users 副本 2')
    expect(nextCopyName('users', ['users 副本', 'users 副本 2'])).toBe('users 副本 3')
    expect(nextCopyName('users', ['users 副本', 'users 副本 3'])).toBe('users 副本 2')
  })

  it('连续粘贴模拟：同容器 sibling 增长时依次产出 副本/副本 2/副本 3', () => {
    const siblings: string[] = ['报表']
    const produced: string[] = []
    for (let i = 0; i < 3; i += 1) {
      const name = nextCopyName('报表', siblings)
      produced.push(name)
      siblings.push(name)
    }
    expect(produced).toEqual(['报表 副本', '报表 副本 2', '报表 副本 3'])
  })

  it('不突变入参数组', () => {
    const siblings = ['users 副本']
    const before = [...siblings]
    nextCopyName('users', siblings)
    expect(siblings).toEqual(before)
  })
})

// ---- §4.4 跨 Collection 移动（Cut paste 的 core 计算）----

describe('moveRequestAcrossCollections：跨 Collection 原子移动（实施设计 §4.4）', () => {
  it('到 collection 顶层：源移除、目标顶层末尾追加，collectionId 重写、folderId 删除', () => {
    const src = sourceFixture()
    const dst = targetFixture()
    const srcBefore = structuredClone(src)
    const dstBefore = structuredClone(dst)

    const { nextSource, nextTarget } = moveRequestAcrossCollections(
      src,
      dst,
      'r2',
      { kind: 'collection-top' },
      9000,
    )

    // 源：移除 r2，其余不动，updatedAt=now
    expect(listAllRequests(nextSource).map((r) => r.id).sort()).toEqual(['r1', 'r3'])
    expect(nextSource.updatedAt).toBe(9000)
    expect(nextSource.name).toBe('源集合')
    // 目标：追加顶层 requests 末尾
    expect(nextTarget.requests.map((r) => r.id)).toEqual(['t1', 't2', 'r2'])
    const moved = nextTarget.requests[2]!
    expect(moved.id).toBe('r2') // Cut/move 不重建 id
    expect(moved.name).toBe('get-user') // Cut 保留原名（§4.6）
    expect(moved.collectionId).toBe('c-dst')
    expect('folderId' in moved).toBe(false)
    expect(moved.updatedAt).toBe(9000)
    // 快照内容完整迁移（{{variable}}/SecretRef 原样）
    expect(moved.url).toBe('https://{{host}}/users/1?q={{keyword}}')
    expect(moved.auth).toEqual(findRequest(src, 'r2')!.request.auth)
    expect(nextTarget.updatedAt).toBe(9000)
    expect(nextTarget.folders[0]!.requests.map((r) => r.id)).toEqual(['t3']) // 其余容器不受影响
    // 返回全新对象；入参未被突变
    expect(nextSource).not.toBe(src)
    expect(nextTarget).not.toBe(dst)
    expect(src).toEqual(srcBefore)
    expect(dst).toEqual(dstBefore)
  })

  it('到 Folder：追加目标 folder.requests 末尾并写 folderId', () => {
    const src = sourceFixture()
    const dst = targetFixture()
    const { nextSource, nextTarget } = moveRequestAcrossCollections(
      src,
      dst,
      'r1',
      { kind: 'folder', folderId: 'g1' },
      9000,
    )
    expect(nextTarget.folders[0]!.requests.map((r) => r.id)).toEqual(['t3', 'r1'])
    const moved = nextTarget.folders[0]!.requests[1]!
    expect(moved.folderId).toBe('g1')
    expect(moved.collectionId).toBe('c-dst')
    expect(nextTarget.requests.map((r) => r.id)).toEqual(['t1', 't2']) // 顶层不受影响
    expect(listAllRequests(nextSource).map((r) => r.id)).toEqual(['r2', 'r3'])
  })

  it('after-request：紧跟锚点之后插入并继承锚点所在容器（Folder 内 / 顶层）', () => {
    // 锚点 t3 在 Folder g1 内：移动到其后，folderId 继承 g1
    const a = moveRequestAcrossCollections(
      sourceFixture(),
      targetFixture(),
      'r3',
      { kind: 'after-request', requestId: 't3' },
      9000,
    )
    expect(a.nextTarget.folders[0]!.requests.map((r) => r.id)).toEqual(['t3', 'r3'])
    expect(a.nextTarget.folders[0]!.requests[1]!.folderId).toBe('g1')
    expect(a.nextTarget.requests.map((r) => r.id)).toEqual(['t1', 't2'])

    // 锚点 t1 在顶层：插入 t1/t2 之间，folderId 被清除
    const b = moveRequestAcrossCollections(
      sourceFixture(),
      targetFixture(),
      'r3',
      { kind: 'after-request', requestId: 't1' },
      9000,
    )
    expect(b.nextTarget.requests.map((r) => r.id)).toEqual(['t1', 'r3', 't2'])
    expect('folderId' in b.nextTarget.requests[1]!).toBe(false)
    expect(b.nextTarget.folders[0]!.requests.map((r) => r.id)).toEqual(['t3'])
  })

  it('同 Collection 移动：返回同一新对象的两个引用（nextSource === nextTarget），调用方只写盘一次', () => {
    const src = sourceFixture()
    const srcBefore = structuredClone(src)

    const { nextSource, nextTarget } = moveRequestAcrossCollections(
      src,
      src,
      'r2',
      { kind: 'after-request', requestId: 'r1' },
      9000,
    )

    expect(nextSource).toBe(nextTarget) // 同一对象引用（§4.4 单次 writeJson 的特判依据）
    expect(nextSource).not.toBe(src)
    expect(nextSource.requests.map((r) => r.id)).toEqual(['r1', 'r2'])
    expect(nextSource.folders[0]!.requests).toEqual([]) // 已从原容器移除
    const moved = nextSource.requests[1]!
    expect(moved.collectionId).toBe('c-src')
    expect('folderId' in moved).toBe(false)
    expect(moved.updatedAt).toBe(9000)
    expect(nextSource.updatedAt).toBe(9000)
    expect(src).toEqual(srcBefore)
  })

  it('错误路径：源缺 request / 目标缺 Folder / 目标缺锚点 / 锚点为被移动自身 → 抛错且入参不变', () => {
    const src = sourceFixture()
    const dst = targetFixture()
    const srcBefore = structuredClone(src)
    const dstBefore = structuredClone(dst)

    expect(() => moveRequestAcrossCollections(src, dst, 'nope', { kind: 'collection-top' })).toThrow(
      /request not found/,
    )
    expect(() => moveRequestAcrossCollections(src, dst, 'r2', { kind: 'folder', folderId: 'nope' })).toThrow(
      /folder not found/,
    )
    // 锚点 r1 在源而不在目标：跨 Collection 时锚点必须存在于目标
    expect(() =>
      moveRequestAcrossCollections(src, dst, 'r2', { kind: 'after-request', requestId: 'r1' }),
    ).toThrow(/request not found/)
    // 锚点为被移动自身：先移除后找不到锚点 →「移动到自身之后」为非法目标（§4.5 矩阵无此行）
    expect(() =>
      moveRequestAcrossCollections(src, src, 'r2', { kind: 'after-request', requestId: 'r2' }),
    ).toThrow(/request not found/)
    // 抛错不留下半成品：入参未被突变
    expect(src).toEqual(srcBefore)
    expect(dst).toEqual(dstBefore)
  })
})

// ---- Copy 粘贴插入辅助 ----

describe('insertRequestAt：Copy 粘贴插入辅助（实施设计 §4.5 Request 行）', () => {
  it('深拷贝后按目标位置插入，重写容器归属，不改 id/name/时间戳，入参不变', () => {
    const src = sourceFixture()
    const dst = targetFixture()
    const dstBefore = structuredClone(dst)
    const snapshot = copyRequestSnapshot(findRequest(src, 'r2')!.request, 'c-dst', undefined, 9000)
    const snapshotBefore = structuredClone(snapshot)

    const inserted = insertRequestAt(dst, snapshot, { kind: 'after-request', requestId: 't3' }, 9500)

    expect(inserted.folders[0]!.requests.map((r) => r.id)).toEqual(['t3', snapshot.id])
    const placed = inserted.folders[0]!.requests[1]!
    expect(placed.folderId).toBe('g1') // 按锚点容器重写
    expect(placed.name).toBe(snapshot.name) // 不改名（副本命名是 nextCopyName 的职责）
    expect(placed.createdAt).toBe(9000)
    expect(placed.updatedAt).toBe(9000)
    expect(inserted.updatedAt).toBe(9500)
    expect(placed).not.toBe(snapshot) // 不与入参共享引用
    // 入参未被突变
    expect(dst).toEqual(dstBefore)
    expect(snapshot).toEqual(snapshotBefore)
    expect('folderId' in snapshot).toBe(false)

    // 顶层目标：folderId 删除
    const top = insertRequestAt(dst, snapshot, { kind: 'collection-top' }, 9500)
    expect(top.requests.map((r) => r.id)).toEqual(['t1', 't2', snapshot.id])
    expect('folderId' in top.requests[2]!).toBe(false)
  })
})

// ---- §7.1 删除统计 ----

describe('descendant 统计（实施设计 §7.1 / UX §4.7）', () => {
  /** A{ x1,x2; B{ y1; C{ z1,z2 } }; D(空) } */
  function statsFolder(): Folder {
    const req = (id: string): ApiRequest => ({
      id,
      name: id,
      method: 'GET',
      url: `https://s/${id}`,
      params: [],
      headers: [],
      auth: { type: 'none' },
      body: { type: 'none' },
      collectionId: 'c-stats',
      createdAt: 1,
      updatedAt: 1,
    })
    return {
      id: 'fA',
      name: 'A',
      folders: [
        {
          id: 'fB',
          name: 'B',
          folders: [{ id: 'fC', name: 'C', folders: [], requests: [req('z1'), req('z2')] }],
          requests: [req('y1')],
        },
        { id: 'fD', name: 'D（空）', folders: [], requests: [] },
      ],
      requests: [req('x1'), req('x2')],
    }
  }

  it('countFolderDescendants：目标自身不计入 folderCount，requestCount 含全部嵌套', () => {
    expect(countFolderDescendants(statsFolder())).toEqual({ folderCount: 3, requestCount: 5 })
    expect(countFolderDescendants({ id: 'e', name: '空', folders: [], requests: [] })).toEqual({
      folderCount: 0,
      requestCount: 0,
    })
  })

  it('countCollectionRequests：递归 Collection 全部 Request 数（权威版）', () => {
    expect(countCollectionRequests(sourceFixture())).toBe(3)
    expect(
      countCollectionRequests({
        id: 'c-empty',
        name: '空',
        variables: [],
        folders: [],
        requests: [],
        createdAt: 1,
        updatedAt: 1,
      }),
    ).toBe(0)
  })
})
