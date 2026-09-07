/**
 * TC-C-18/19：Collection 树操作与 Environment 操作（§6.1，AC-16/AC-17）。
 */
import { describe, expect, it } from 'vitest'
import type { Collection, Environment } from '@dsh-api-client/shared'
import { isSecretRef, createSecretRef } from '@dsh-api-client/shared'
import {
  addEnvironment,
  addFolder,
  addRequest,
  bindSecret,
  createCollection,
  createEnvironment,
  createRequest,
  createVariable,
  deleteEnvironment,
  deleteFolder,
  deleteRequest,
  duplicateCollection,
  duplicateFolder,
  duplicateRequest,
  listAllRequests,
  moveRequest,
  renameCollection,
  renameEnvironment,
  renameRequest,
  reorderRequests,
  searchRequests,
  setVariableEnabled,
  unbindSecret,
  upsertVariable,
  assertEnvironmentInvariant,
} from '@dsh-api-client/core'

describe('TC-C-18: Collection/Folder/Request CRUD + 重命名 + 排序 + 搜索 + Duplicate', () => {
  function fixture(): { collection: Collection; folderId: string; nestedFolderId: string } {
    let collection = createCollection({ name: 'API', now: 1000 })
    const f1 = addFolder(collection, 'users')
    collection = f1.collection
    const f2 = addFolder(collection, 'admin', f1.folder.id)
    collection = f2.collection
    return { collection, folderId: f1.folder.id, nestedFolderId: f2.folder.id }
  }

  it('树结构符合 §6 层级（任意嵌套），CRUD/重命名/移动生效', () => {
    const { collection, folderId, nestedFolderId } = fixture()
    let next = addRequest(
      collection,
      createRequest({ name: 'list', url: 'https://a/u', collectionId: collection.id }),
    )
    next = addRequest(
      next,
      createRequest({ name: 'get', url: 'https://a/u/1', collectionId: next.id, folderId }),
    )
    next = addRequest(
      next,
      createRequest({ name: 'deep', url: 'https://a/deep', collectionId: next.id, folderId: nestedFolderId }),
    )
    expect(next.requests).toHaveLength(1)
    expect(next.folders[0]?.requests.map((r) => r.name)).toEqual(['get'])
    expect(next.folders[0]?.folders[0]?.requests.map((r) => r.name)).toEqual(['deep'])

    next = renameCollection(next, 'API v2')
    expect(next.name).toBe('API v2')
    const getReq = listAllRequests(next).find((r) => r.name === 'get')
    expect(getReq).toBeDefined()
    next = renameRequest(next, getReq?.id ?? '', 'get-one')
    expect(listAllRequests(next).find((r) => r.id === getReq?.id)?.name).toBe('get-one')

    next = moveRequest(next, getReq?.id ?? '', nestedFolderId)
    expect(next.folders[0]?.requests).toHaveLength(0)
    expect(next.folders[0]?.folders[0]?.requests.map((r) => r.name)).toEqual(['deep', 'get-one'])

    next = deleteRequest(next, getReq?.id ?? '')
    expect(listAllRequests(next).map((r) => r.name)).toEqual(['list', 'deep'])
    next = deleteFolder(next, nestedFolderId)
    expect(next.folders[0]?.folders).toHaveLength(0)
    expect(listAllRequests(next).map((r) => r.name)).toEqual(['list'])
  })

  it('排序：reorderRequests 按给定 id 序重排，未列出保持原序附后', () => {
    let collection = createCollection({ name: 'API', now: 1000 })
    const ids = ['r-a', 'r-b', 'r-c']
    for (const id of ids) {
      collection = addRequest(collection, {
        ...createRequest({ name: id, collectionId: collection.id }),
        id,
      })
    }
    const reordered = reorderRequests(collection, undefined, ['r-c', 'r-a'])
    expect(reordered.requests.map((r) => r.id)).toEqual(['r-c', 'r-a', 'r-b'])
  })

  it('搜索：name/url 大小写不敏感子串，含 folder 内请求', () => {
    const { collection, folderId } = fixture()
    let next = addRequest(collection, createRequest({ name: 'List Users', url: 'https://a/users', collectionId: collection.id }))
    next = addRequest(next, createRequest({ name: 'ping', url: 'https://a/USERS/1', collectionId: next.id, folderId }))
    expect(searchRequests(next, 'users').map((r) => r.name)).toEqual(['List Users', 'ping'])
    expect(searchRequests(next, 'LIST')).toHaveLength(1)
    expect(searchRequests(next, '')).toEqual([])
  })

  it('Duplicate：request/folder/collection 深拷贝且全部新 id，原件不受影响', () => {
    const { collection, folderId } = fixture()
    let next = addRequest(
      collection,
      createRequest({ name: 'orig', url: 'https://a/o', collectionId: collection.id, folderId }),
    )
    const original = next.folders[0]?.requests[0]
    expect(original).toBeDefined()

    const dupReq = duplicateRequest(next, original?.id ?? '')
    const copy = dupReq.folders[0]?.requests.find((r) => r.id !== original?.id)
    expect(copy).toBeDefined()
    expect(copy?.name).toBe('orig (copy)')
    expect(copy?.headers).not.toBe(original?.headers)

    const dupFolder = duplicateFolder(dupReq, folderId)
    const folderCopy = dupFolder.folders.find((f) => f.id !== folderId)
    expect(folderCopy).toBeDefined()
    expect(folderCopy?.name).toBe('users (copy)')
    expect(folderCopy?.requests[0]?.id).not.toBe(original?.id)

    const dupCollection = duplicateCollection(dupFolder)
    expect(dupCollection.id).not.toBe(dupFolder.id)
    expect(dupCollection.name).toBe('API (copy)')
    const allOriginalIds = new Set(listAllRequests(dupFolder).map((r) => r.id))
    for (const request of listAllRequests(dupCollection)) {
      expect(allOriginalIds.has(request.id)).toBe(false)
      expect(request.collectionId).toBe(dupCollection.id)
    }
    // 深拷贝：改副本不影响原件
    dupCollection.requests[0] && (dupCollection.requests[0].name = 'mutated')
    expect(dupFolder.requests[0]?.name).not.toBe('mutated')
  })
})

describe('TC-C-19: Environment CRUD + 变量启停 + SecretRef 绑定', () => {
  it('Environment CRUD', () => {
    let envs: Environment[] = []
    envs = addEnvironment(envs, 'dev')
    envs = addEnvironment(envs, 'prod')
    expect(envs.map((e) => e.name)).toEqual(['dev', 'prod'])
    const dev = envs[0]
    expect(dev).toBeDefined()
    const renamed = renameEnvironment(dev ?? createEnvironment('x'), 'development')
    expect(renamed.id).toBe(dev?.id)
    expect(renamed.name).toBe('development')
    envs = deleteEnvironment(envs, dev?.id ?? '')
    expect(envs).toHaveLength(1)
  })

  it('变量增删改 + 启停', () => {
    let env = createEnvironment('dev')
    env = upsertVariable(env, 'host', 'a')
    env = upsertVariable(env, 'host', 'b')
    expect(env.variables).toHaveLength(1)
    expect(env.variables[0]?.currentValue).toBe('b')
    env = setVariableEnabled(env, 'host', false)
    expect(env.variables[0]?.enabled).toBe(false)
    env = setVariableEnabled(env, 'host', true)
    expect(env.variables[0]?.enabled).toBe(true)
  })

  it('secret 变量绑定 SecretRef：currentValue 只持 SecretRef，模型不变量成立', () => {
    const ref = createSecretRef()
    let env = createEnvironment('prod')
    env = bindSecret(env, 'api_key', ref)
    const variable = env.variables[0]
    expect(variable?.secret).toBe(true)
    expect(isSecretRef(variable?.currentValue)).toBe(true)
    expect((variable?.currentValue as { $ref: string }).$ref).toBe(ref.$ref)
    expect(() => assertEnvironmentInvariant(env)).not.toThrow()

    env = unbindSecret(env, 'api_key', '')
    expect(env.variables[0]?.secret).toBe(false)
    expect(env.variables[0]?.currentValue).toBe('')
  })

  it('模型不变量：secret=true 持明文 → 断言抛错（AC-42 正向机制）', () => {
    const bad: Environment = {
      id: 'e',
      name: 'bad',
      variables: [{ key: 'k', currentValue: 'plaintext', secret: true, enabled: true }],
    }
    expect(() => assertEnvironmentInvariant(bad)).toThrow(/SecretRef/)
    expect(createVariable({ key: 'v', value: 'plain' }).secret).toBe(false)
  })
})
