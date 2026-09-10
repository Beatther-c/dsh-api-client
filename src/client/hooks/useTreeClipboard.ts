/**
 * Tree clipboard 钩子（P0 实施设计 §0.3/§3.1/§4.2/§6.5/§13.1，UX §4.6，WP5）。
 *
 * 红线（AC-13）：Client 剪贴板状态**只存** TreeClipboardDescriptor 四字段
 * `{token, operation, kind, expiresAt}`——绝不存 Host 权威 snapshot、URL/Body/
 * Header/Auth 等业务内容；API 响应形态即状态形态（WP3 契约保证不下发更多）。
 *
 * §0.3 冻结边界下的 paste 可用性判定：
 * - expiresAt 已过 → 本地禁用，原因「剪贴板已过期」；
 * - kind + operation + targetKind 静态矩阵（§6.5 表逐字）→ 本地禁用 + 中文具体原因；
 * - 本 Client 自己删除了 Cut 源 → 立即清空本地 token（notifyLocalRequestsDeleted）；
 * - 外部删除/版本变化**不做本地预判**——执行 paste 由 Host 404/409 裁决：
 *   404 clipboard-not-found / Cut 源 request-not-found / Cut 409 → token 永远无法
 *   再成功 → 清空本地 token + 中文提示引导重新剪切；Copy token 可重复粘贴
 *   （命名由 Host 按「副本/副本 2」自动生成），Cut 成功后 consumed → 清空。
 *
 * 关于 `cutSourceRef`（实现注记，见 WP5 报告）：§0.3 要求「本 Client 自己删除
 * Cut 来源时立即清空本地 token」，判定需要把删除的 Request id 与剪切源比对。
 * AC-13 约束的是**剪贴板状态**（对外暴露/可序列化的 clipboard 对象恰好四字段，
 * 有测试钉死）；此处用一个组件内存 ref 暂存剪切动作入参里的 requestId 作纯本地
 * 瞬态比对标记——不暴露、不渲染、不持久化、不含任何业务内容，性质与树的选中态
 * （§4.8 本来就持有节点 id）相同。这是不新增 clipboard status 端点（§0.3 冻结）
 * 前提下实现该条款的唯一途径。
 *
 * mutation 流程复用 useCollections.runMutation（bridge 注入）：paste 成功 →
 * await GET /collections 刷新投影；409 → stale=true + Host message toast；
 * 刷新失败 → stale +「数据已保存，列表刷新失败」（§4.9 全流程）。
 *
 * 本文件不 import 任何 DSH 包（TC-A-03）。
 */
import { useCallback, useRef, useState } from 'react'
import type { TreeClipboardDescriptor, TreePasteResult } from '@dsh-api-client/shared'
import { toast } from '../components/common/Toast.tsx'
import { HostApiError, useHostApi } from './useHostApi.ts'
import type { MutationRun } from './useCollections.ts'

/** Client 剪贴板状态 = Host 回执四字段逐字（AC-13：绝不加宽）。 */
export type TreeClipboardState = TreeClipboardDescriptor

export type ClipboardNodeKind = 'collection' | 'folder' | 'request'

export type PasteTargetKind = 'root' | 'collection' | 'folder' | 'request'

/** paste 目标描述（§3.1 入参；由树从当前投影组装）。 */
export interface PasteTarget {
  kind: PasteTargetKind
  /** kind='collection' 时 = 目标 Collection id（Host 用 targetId 定位）；folder/request 时 = 目标节点 id。 */
  targetId?: string
  /** kind='folder'/'request'：目标所在 Collection id（可省略由 Host 跨 collection 权威定位；树总是携带）。 */
  targetCollectionId?: string
  /** 非 root 必带：目标所在 Collection 的当前 updatedAt（来自投影；不符 → Host 409 裁决）。 */
  expectedTargetCollectionUpdatedAt?: number
}

export interface PasteEnablement {
  enabled: boolean
  /** 禁用时的中文具体原因（菜单内联展示 / toast）。 */
  reason?: string
}

/** §6.5 冻结合法矩阵（与 Host tree-clipboard-service PASTE_MATRIX 同源同值）。 */
const PASTE_MATRIX: Readonly<Record<string, readonly PasteTargetKind[]>> = {
  'copy-collection': ['root', 'collection'],
  'copy-folder': ['collection', 'folder'],
  'copy-request': ['collection', 'folder', 'request'],
  'cut-request': ['collection', 'folder', 'request'],
}

const TARGET_LABELS: Readonly<Record<PasteTargetKind, string>> = {
  root: '根空白区',
  collection: 'Collection',
  folder: 'Folder',
  request: 'Request',
}

/**
 * 静态可用性判定（纯函数，供钩子与测试共用）：无内容 → 「剪贴板没有内容」；
 * 过期 → 「剪贴板已过期」；矩阵外 → 「当前剪贴板内容只能粘贴到 X 或 Y」。
 */
export function computePasteEnablement(
  clipboard: TreeClipboardState | undefined,
  target: { kind: PasteTargetKind },
  now: number = Date.now(),
): PasteEnablement {
  if (clipboard === undefined) return { enabled: false, reason: '剪贴板没有内容' }
  if (clipboard.expiresAt <= now) return { enabled: false, reason: '剪贴板已过期' }
  const allowed = PASTE_MATRIX[`${clipboard.operation}-${clipboard.kind}`] ?? []
  if (!allowed.includes(target.kind)) {
    if (allowed.length === 0) return { enabled: false, reason: '当前剪贴板内容不能粘贴到该目标' }
    return { enabled: false, reason: `当前剪贴板内容只能粘贴到 ${allowed.map((kind) => TARGET_LABELS[kind]).join(' 或 ')}` }
  }
  return { enabled: true }
}

/** paste 请求体（§3.1：root 只有 targetKind；非 root 必带 expectedTargetCollectionUpdatedAt）。 */
export function buildPasteBody(target: PasteTarget): Record<string, unknown> {
  if (target.kind === 'root') return { targetKind: 'root' }
  return {
    targetKind: target.kind,
    targetId: target.targetId,
    ...(target.targetCollectionId !== undefined ? { targetCollectionId: target.targetCollectionId } : {}),
    expectedTargetCollectionUpdatedAt: target.expectedTargetCollectionUpdatedAt,
  }
}

/** useCollections 注入的 §4.9 统一 mutation 流程（409→stale+toast；成功→refresh；刷新失败→stale+固定文案）。 */
export interface TreeClipboardBridge {
  runMutation: <T>(action: () => Promise<T>) => Promise<MutationRun<T>>
}

export interface CopySource {
  kind: ClipboardNodeKind
  collectionId: string
  /** kind='folder'/'request' 必填：源节点 id。 */
  nodeId?: string
}

export interface CutSource {
  requestId: string
  requestUpdatedAt: number
  sourceCollectionUpdatedAt: number
}

export interface TreeClipboardApi {
  /** AC-13：恰好 {token, operation, kind, expiresAt} 或 undefined——绝无其他字段。 */
  clipboard: TreeClipboardState | undefined
  /** 任一 clipboard 操作进行中（防重复触发，UX §9）。 */
  pending: boolean
  /** POST /tree/clipboard/copy：成功 → 本地只存回执四字段；返回是否成功。 */
  copy: (source: CopySource) => Promise<boolean>
  /** POST /tree/clipboard/cut（仅 Request，AC-17 的 UI 入口约束在树侧）。 */
  cut: (source: CutSource) => Promise<boolean>
  /** 本地判定（过期/矩阵）→ POST /tree/clipboard/:token/paste → §4.9 流程；返回是否粘贴成功。 */
  paste: (target: PasteTarget) => Promise<boolean>
  /** 主动清空：本地立即清 + best-effort Host DELETE（幂等 204；失败静默——本地已清）。 */
  clear: () => Promise<void>
  /** §6.5 静态矩阵判定（当前 clipboard 状态）。 */
  pasteEnablement: (target: { kind: PasteTargetKind }) => PasteEnablement
  /**
   * §0.3：本 Client 删除 Request 成功（含随 Folder/Collection 级联删除）后，
   * 调用方（WP8 删除流程）传入全部被删 Request id；命中 Cut 源 → 立即清空本地 token。
   */
  notifyLocalRequestsDeleted: (deletedRequestIds: readonly string[]) => void
}

const enc = encodeURIComponent

export function useTreeClipboard(bridge: TreeClipboardBridge): TreeClipboardApi {
  const api = useHostApi()
  const [clipboard, setClipboard] = useState<TreeClipboardState | undefined>()
  const [pending, setPending] = useState(false)
  /** 剪切源 requestId 的本地瞬态比对标记（见文件头注——不属于剪贴板状态）。 */
  const cutSourceRef = useRef<string | undefined>(undefined)
  /** 最新 clipboard 的同步镜像（paste/clear 闭包内读取，避免 stale closure）。 */
  const clipboardRef = useRef<TreeClipboardState | undefined>(undefined)
  const pendingRef = useRef(false)

  const updateClipboard = useCallback((next: TreeClipboardState | undefined) => {
    clipboardRef.current = next
    setClipboard(next)
  }, [])

  const beginOperation = useCallback((): boolean => {
    if (pendingRef.current) return false
    pendingRef.current = true
    setPending(true)
    return true
  }, [])

  const endOperation = useCallback(() => {
    pendingRef.current = false
    setPending(false)
  }, [])

  const copy = useCallback(
    async (source: CopySource): Promise<boolean> => {
      if (!beginOperation()) return false
      try {
        // copy 不改 collections 数据，但走 runMutation 复用统一错误 toast；成功后的
        // refresh 顺带把投影版本刷到最新（降低后续 paste 409 概率）。
        const run = await bridge.runMutation(() =>
          api.post<TreeClipboardDescriptor>(
            '/tree/clipboard/copy',
            source.nodeId === undefined ? { kind: source.kind, collectionId: source.collectionId } : { kind: source.kind, collectionId: source.collectionId, nodeId: source.nodeId },
          ),
        )
        if (!run.committed || run.result === undefined) return false
        cutSourceRef.current = undefined
        updateClipboard(run.result)
        toast.info('已复制，可粘贴到目标位置')
        return true
      } finally {
        endOperation()
      }
    },
    [api, beginOperation, bridge, endOperation, updateClipboard],
  )

  const cut = useCallback(
    async (source: CutSource): Promise<boolean> => {
      if (!beginOperation()) return false
      try {
        // 409（源版本已变）→ runMutation 统一 stale=true + Host message toast。
        const run = await bridge.runMutation(() =>
          api.post<TreeClipboardDescriptor>('/tree/clipboard/cut', {
            requestId: source.requestId,
            requestUpdatedAt: source.requestUpdatedAt,
            sourceCollectionUpdatedAt: source.sourceCollectionUpdatedAt,
          }),
        )
        if (!run.committed || run.result === undefined) return false
        cutSourceRef.current = source.requestId
        updateClipboard(run.result)
        toast.info('已剪切，粘贴到目标位置完成移动')
        return true
      } finally {
        endOperation()
      }
    },
    [api, beginOperation, bridge, endOperation, updateClipboard],
  )

  /** 本地清空 + best-effort Host DELETE（幂等；失败静默）。 */
  const clear = useCallback(async (): Promise<void> => {
    const current = clipboardRef.current
    updateClipboard(undefined)
    cutSourceRef.current = undefined
    if (current === undefined) return
    try {
      await api.delete(`/tree/clipboard/${enc(current.token)}`)
    } catch {
      // Host 侧 token 由 TTL 清理（§4.2）；本地已清即达成 UI 语义。
    }
  }, [api, updateClipboard])

  const paste = useCallback(
    async (target: PasteTarget): Promise<boolean> => {
      const current = clipboardRef.current
      if (current === undefined) {
        toast.error('剪贴板没有内容')
        return false
      }
      // 本地静态判定（§0.3：过期 + 矩阵；外部删除/版本变化留给 Host 裁决）。
      const enablement = computePasteEnablement(current, target)
      if (!enablement.enabled) {
        toast.error(enablement.reason ?? '当前目标不能粘贴')
        return false
      }
      if (!beginOperation()) return false
      try {
        const run = await bridge.runMutation(() =>
          api.post<TreePasteResult>(`/tree/clipboard/${enc(current.token)}/paste`, buildPasteBody(target)),
        )
        if (run.committed && run.result !== undefined) {
          // Cut 成功即消费（consumed=true）→ 清空；Copy token 可重复粘贴（保留）。
          if (run.result.consumed) {
            updateClipboard(undefined)
            cutSourceRef.current = undefined
            toast.info('移动完成')
          } else {
            toast.info('粘贴完成')
          }
          return true
        }
        // 失败分支（409/404 已由 runMutation 统一 toast + stale 处理；此处只做 token 生命周期）。
        const cause = run.cause
        if (cause instanceof HostApiError) {
          if (cause.code === 'clipboard-not-found') {
            // Host 已无此 token（过期/重启）→ 本地同步清空。
            updateClipboard(undefined)
            cutSourceRef.current = undefined
          } else if (current.operation === 'cut' && (cause.status === 409 || cause.code === 'request-not-found')) {
            // Cut 409 后 token 永不消费但永远无法再成功（WP3 对接确认）；源被外部删除同理。
            updateClipboard(undefined)
            cutSourceRef.current = undefined
            toast.info('剪切内容已无法粘贴，请重新剪切')
          }
        }
        return false
      } finally {
        endOperation()
      }
    },
    [api, beginOperation, bridge, endOperation, updateClipboard],
  )

  const pasteEnablement = useCallback(
    (target: { kind: PasteTargetKind }): PasteEnablement => computePasteEnablement(clipboardRef.current, target),
    [],
  )

  const notifyLocalRequestsDeleted = useCallback(
    (deletedRequestIds: readonly string[]): void => {
      const current = clipboardRef.current
      const cutSource = cutSourceRef.current
      if (current === undefined || current.operation !== 'cut' || cutSource === undefined) return
      if (!deletedRequestIds.includes(cutSource)) return
      // §0.3：本 Client 自己删除了 Cut 源 → 立即清空本地 token，Paste 禁用。
      updateClipboard(undefined)
      cutSourceRef.current = undefined
      // Host 侧孤儿 token 由 TTL 清理；顺手 best-effort 清空（失败静默）。
      api.delete(`/tree/clipboard/${enc(current.token)}`).catch(() => {})
      toast.info('剪切来源已被删除，剪贴板已清空')
    },
    [api, updateClipboard],
  )

  return { clipboard, pending, copy, cut, paste, clear, pasteEnablement, notifyLocalRequestsDeleted }
}
