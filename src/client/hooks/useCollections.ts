/**
 * Collections 数据钩子（Host 为权威状态源，client 只做投影——D16）：
 * 每次变更后从 Host 重新拉取投影，不在 client 侧维护本地副本一致性。
 *
 * P0 扩展（实施设计 §3.1/§3.2/§4.9，WP5）：
 * - `stale` + `refresh(): Promise<boolean>`：§4.9 mutation 后刷新状态机——
 *   mutation 失败 → 保持旧 UI（409 → stale=true + Host 中文 message toast）；
 *   mutation 成功 → await GET /collections，成功 → 替换投影 stale=false，
 *   失败 → 保持旧投影 stale=true + toast「数据已保存，列表刷新失败」。
 *   禁止任何「已回滚」文案（Host 已提交时绝不谎称回滚）。
 * - `runMutation`：§4.9 统一流程的公开封装，供外部 mutation 调用方
 *   （useTreeClipboard 的 copy/cut/paste）复用同一套 409/refresh/stale 语义。
 * - Folder 三方法走 WP3 冻结端点（POST/PATCH/DELETE /collections/:id/folders…，
 *   全部必带 expectedCollectionUpdatedAt；DELETE 带 JSON body——useHostApi 已支持）。
 * - 既有 mutation 补传版本参数能力（可选尾参 expectedCollectionUpdatedAt）：
 *   collection 级端点（显式挑字段的 body 处理）直接并入 JSON body；
 *   `PATCH /requests/:id` 的 Host 实现将未知 body 字段 Object.assign 进请求对象
 *   （会持久化污染），因此该端点的版本参数改经 query string 传递（router 支持
 *   ctx.query，当前 handler 忽略之——诚实传递、零污染、向后兼容）。
 * - 既有方法签名只增不改：新增可选尾参 / 加宽返回值（void → MutationOutcome、
 *   void → {committed,refreshed}），既有调用面（ApiClientView 的 void 调用）编译不破。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiRequest, Collection } from '@dsh-api-client/shared'
import { toast } from '../components/common/Toast.tsx'
import { HostApiError, useHostApi } from './useHostApi.ts'

/** §3.1 FolderDescriptor 的 client 侧同形（Host 返回仅 id/name，无节点内容）。 */
export interface FolderDescriptor {
  id: string
  name: string
}

/**
 * §4.9 mutation 结果：committed = Host mutation 已成功提交；refreshed = 提交后
 * 投影刷新是否成功。WP8 的 §7.3 顺序契约（Host 成功后才能关 tab/更新 UI）消费
 * `committed`；committed=true 且 refreshed=false 时树已 stale（数据已保存）。
 */
export interface MutationOutcome {
  committed: boolean
  refreshed: boolean
  /** 失败时的中文错误（409 = Host §3.1.1 逐字 message）；成功为 undefined。 */
  error?: string
}

/** runMutation 完整返回：outcome + Host 响应对象 + 原始错误（供调用方按 code 分支）。 */
export interface MutationRun<T> extends MutationOutcome {
  result: T | undefined
  /** 原始异常（典型为 HostApiError——useTreeClipboard 按 status/code 分支消费）。 */
  cause?: unknown
}

export interface CollectionsState {
  collections: Collection[]
  loading: boolean
  error: string | undefined
  /**
   * §4.9：409 版本冲突、或 mutation 已提交但刷新失败 → true。stale 期间禁用树
   * mutation 与 Request Save（WP8/树消费），保留浏览/tab/草稿/Send；
   * `refresh()` 成功才恢复。
   */
  stale: boolean
  /** 直接拉取投影：成功 → 替换投影 + stale=false + 返回 true；失败 → 保持旧投影返回 false（不 toast，由调用方决定文案）。 */
  refresh: () => Promise<boolean>
  /** §4.9 统一 mutation 流程封装（外部 mutation——如 clipboard paste——复用）。 */
  runMutation: <T>(action: () => Promise<T>) => Promise<MutationRun<T>>
  createCollection: (name: string) => Promise<Collection | undefined>
  /** 加宽：void → MutationOutcome（inline rename 需要失败原因；旧 void 调用不受影响）。 */
  renameCollection: (id: string, name: string, expectedCollectionUpdatedAt?: number) => Promise<MutationOutcome>
  /** 加宽：void → MutationOutcome（WP8 §7.3「Host 成功后才关 tabs」顺序契约）。 */
  deleteCollection: (id: string, expectedCollectionUpdatedAt?: number) => Promise<MutationOutcome>
  duplicateCollection: (id: string) => Promise<void>
  reorderCollection: (id: string, itemIds: string[]) => Promise<void>
  saveRequest: (collectionId: string, request: Omit<ApiRequest, 'id' | 'createdAt' | 'updatedAt' | 'collectionId'> & { folderId?: string }, expectedCollectionUpdatedAt?: number) => Promise<ApiRequest | undefined>
  patchRequest: (id: string, patch: Record<string, unknown>, expectedCollectionUpdatedAt?: number) => Promise<ApiRequest | undefined>
  /** Request 行内重命名专用（树 WP5）：outcome + 更新后对象（WP8 同步已打开 tab 草稿名）。 */
  renameRequest: (id: string, name: string, expectedCollectionUpdatedAt?: number) => Promise<MutationOutcome & { request?: ApiRequest }>
  /** 加宽：void → MutationOutcome（WP8 §7.3「Host 成功后才关 tab」顺序契约）。 */
  deleteRequest: (id: string, expectedCollectionUpdatedAt?: number) => Promise<MutationOutcome>
  duplicateRequest: (id: string) => Promise<void>
  moveRequest: (id: string, folderId?: string, expectedCollectionUpdatedAt?: number) => Promise<void>
  /** WP3 端点：POST /collections/:id/folders（parentFolderId 缺省 = 顶层 Folder）。 */
  createFolder: (collectionId: string, name: string, parentFolderId: string | undefined, expectedCollectionUpdatedAt: number) => Promise<MutationOutcome & { folder?: FolderDescriptor }>
  /** WP3 端点：PATCH /collections/:id/folders/:folderId。 */
  renameFolder: (collectionId: string, folderId: string, name: string, expectedCollectionUpdatedAt: number) => Promise<MutationOutcome & { folder?: FolderDescriptor }>
  /** WP3 端点：DELETE /collections/:id/folders/:folderId（JSON body 带版本，递归删除）。 */
  deleteFolder: (collectionId: string, folderId: string, expectedCollectionUpdatedAt: number) => Promise<MutationOutcome>
}

/** 错误 → 中文可读 message（Host message 已经 redaction；不展示原始响应体）。 */
function errorMessage(error: unknown): string {
  return error instanceof HostApiError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error)
}

function isConflict(error: unknown): boolean {
  return error instanceof HostApiError && error.status === 409
}

/** 409 的用户可见文案 = Host §3.1.1 逐字 message（已经是中文）。 */
function conflictMessage(error: unknown): string {
  return error instanceof HostApiError ? error.message : errorMessage(error)
}

/** body 安全端点：版本参数并入 JSON body（Host handler 显式挑字段，多余字段被忽略）。 */
function withVersion<T extends Record<string, unknown>>(body: T, expectedCollectionUpdatedAt: number | undefined): T | (T & { expectedCollectionUpdatedAt: number }) {
  return expectedCollectionUpdatedAt === undefined ? body : { ...body, expectedCollectionUpdatedAt }
}

/** PATCH /requests/:id 专用：版本参数走 query（Host 会把未知 body 字段写进请求对象——不可污染）。 */
function versionQuery(expectedCollectionUpdatedAt: number | undefined): string {
  return expectedCollectionUpdatedAt === undefined ? '' : `?expectedCollectionUpdatedAt=${encodeURIComponent(expectedCollectionUpdatedAt)}`
}

const enc = encodeURIComponent

export function useCollections(): CollectionsState {
  const api = useHostApi()
  const [collections, setCollections] = useState<Collection[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>()
  const [stale, setStale] = useState(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // 初始加载（仅挂载时一次；后续刷新走 refresh()）。
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api
      .get<Collection[]>('/collections')
      .then((list) => {
        if (cancelled) return
        setCollections(list)
        setError(undefined)
        setStale(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const message = errorMessage(err)
        setError(message)
        toast.error(message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [api])

  const refresh = useCallback(async (): Promise<boolean> => {
    try {
      const list = await api.get<Collection[]>('/collections')
      if (!mounted.current) return false
      setCollections(list)
      setError(undefined)
      setStale(false)
      return true
    } catch (err) {
      if (mounted.current) setError(errorMessage(err))
      return false
    }
  }, [api])

  /**
   * §4.9 流程逐字：
   * mutation 失败 → 保持旧 UI；409 → stale=true + Host message toast；其他 → 错误 toast。
   * mutation 成功 → await GET /collections；成功 → 替换投影 stale=false；
   * 失败 → 保持旧投影 + stale=true + toast「数据已保存，列表刷新失败」。
   */
  const runMutation = useCallback(
    async <T,>(action: () => Promise<T>): Promise<MutationRun<T>> => {
      let result: T
      try {
        result = await action()
      } catch (err) {
        if (isConflict(err)) {
          if (mounted.current) setStale(true)
          toast.error(conflictMessage(err))
          return { result: undefined, committed: false, refreshed: false, error: conflictMessage(err), cause: err }
        }
        const message = errorMessage(err)
        toast.error(message)
        return { result: undefined, committed: false, refreshed: false, error: message, cause: err }
      }
      const refreshed = await refresh()
      if (!refreshed) {
        if (mounted.current) setStale(true)
        // Host 已提交——绝不谎称回滚（§4.9 固定文案）。
        toast.error('数据已保存，列表刷新失败')
      }
      return { result, committed: true, refreshed }
    },
    [refresh],
  )

  /** MutationRun<T> → 既有 `T | undefined` 返回面（createCollection/saveRequest/patchRequest）。 */
  const run = useCallback(
    async <T,>(action: () => Promise<T>): Promise<T | undefined> => (await runMutation(action)).result,
    [runMutation],
  )

  /** MutationRun<T> → MutationOutcome（剥离 result/cause）。 */
  const outcome = useCallback(
    async <T,>(action: () => Promise<T>): Promise<MutationOutcome> => {
      const { result: _result, cause: _cause, ...rest } = await runMutation(action)
      return rest
    },
    [runMutation],
  )

  return {
    collections,
    loading,
    error,
    stale,
    refresh,
    runMutation,
    createCollection: (name) => run(() => api.post<Collection>('/collections', { name })),
    renameCollection: (id, name, expectedCollectionUpdatedAt) =>
      outcome(() => api.patch<Collection>(`/collections/${enc(id)}`, withVersion({ name }, expectedCollectionUpdatedAt))),
    deleteCollection: (id, expectedCollectionUpdatedAt) =>
      outcome(() =>
        expectedCollectionUpdatedAt === undefined
          ? api.delete(`/collections/${enc(id)}`)
          : api.delete(`/collections/${enc(id)}`, { expectedCollectionUpdatedAt }),
      ),
    duplicateCollection: async (id) => {
      await run(() => api.post<Collection>(`/collections/${enc(id)}/duplicate`))
    },
    reorderCollection: async (id, itemIds) => {
      await run(() => api.post<Collection>(`/collections/${enc(id)}/reorder`, { itemIds }))
    },
    saveRequest: (collectionId, request, expectedCollectionUpdatedAt) =>
      run(() =>
        api.post<ApiRequest>(
          `/collections/${enc(collectionId)}/requests`,
          expectedCollectionUpdatedAt === undefined ? request : { ...request, expectedCollectionUpdatedAt },
        ),
      ),
    patchRequest: (id, patch, expectedCollectionUpdatedAt) =>
      run(() => api.patch<ApiRequest>(`/requests/${enc(id)}${versionQuery(expectedCollectionUpdatedAt)}`, patch)),
    renameRequest: async (id, name, expectedCollectionUpdatedAt) => {
      const { result, ...rest } = await runMutation(() =>
        api.patch<ApiRequest>(`/requests/${enc(id)}${versionQuery(expectedCollectionUpdatedAt)}`, { name }),
      )
      return { ...rest, ...(result !== undefined ? { request: result } : {}) }
    },
    deleteRequest: (id, expectedCollectionUpdatedAt) =>
      outcome(() =>
        expectedCollectionUpdatedAt === undefined
          ? api.delete(`/requests/${enc(id)}`)
          : api.delete(`/requests/${enc(id)}`, { expectedCollectionUpdatedAt }),
      ),
    duplicateRequest: async (id) => {
      await run(() => api.post<ApiRequest>(`/requests/${enc(id)}/duplicate`))
    },
    moveRequest: async (id, folderId, expectedCollectionUpdatedAt) => {
      await run(() => api.post<ApiRequest>(`/requests/${enc(id)}/move`, withVersion({ folderId }, expectedCollectionUpdatedAt)))
    },
    // ---- WP3 Folder 端点（§3.1 冻结合同：expectedCollectionUpdatedAt 必填）----
    createFolder: async (collectionId, name, parentFolderId, expectedCollectionUpdatedAt) => {
      const { result, ...rest } = await runMutation(() =>
        api.post<FolderDescriptor>(
          `/collections/${enc(collectionId)}/folders`,
          parentFolderId === undefined ? { name, expectedCollectionUpdatedAt } : { name, parentFolderId, expectedCollectionUpdatedAt },
        ),
      )
      return { ...rest, ...(result !== undefined ? { folder: result } : {}) }
    },
    renameFolder: async (collectionId, folderId, name, expectedCollectionUpdatedAt) => {
      const { result, ...rest } = await runMutation(() =>
        api.patch<FolderDescriptor>(`/collections/${enc(collectionId)}/folders/${enc(folderId)}`, { name, expectedCollectionUpdatedAt }),
      )
      return { ...rest, ...(result !== undefined ? { folder: result } : {}) }
    },
    deleteFolder: (collectionId, folderId, expectedCollectionUpdatedAt) =>
      outcome(() => api.delete(`/collections/${enc(collectionId)}/folders/${enc(folderId)}`, { expectedCollectionUpdatedAt })),
  }
}
