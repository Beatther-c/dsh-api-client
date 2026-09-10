/**
 * CollectionTree（P0 实施设计 §4.7/§4.8/§4.9/§6.1–§6.5/§13.1，UX §4.2–§4.6，WP5 重写）：
 * 请求树协调层——消费 tree-projection（纯投影）+ CollectionsState（含 stale，
 * useCollections）+ TreeClipboardApi（useTreeClipboard），组装工具区、稳定行列表、
 * 右键菜单、行内重命名、新建对话框与完整键盘契约。
 *
 * 冻结语义要点：
 * - 默认全收缩（AC-03：expandedIds 初始空集，不持久化）；双态「全部展开/全部收缩」
 *   按钮（图标 + 中文 tooltip）；搜索态禁用该按钮并提示「清除搜索后恢复原折叠状态」（AC-07）；
 * - 搜索即时重算：投影是 (collections, query, 双折叠集合) 的纯函数——数据刷新/
 *   重命名/增删后按当前 query 自动重投影（§4.3）；
 * - 左键：Collection/Folder 整行先选中再 toggle；Request 选中+打开；右键：只选中+
 *   开菜单（不开请求不 toggle）；左键空白：清选择+关菜单；右键空白：根菜单（AC-04/09）；
 * - 键盘契约表（UX §4.4 逐字）见 onRowKeyDown；Delete/Backspace 只触发
 *   onRequestDelete 回调（确认对话框与 Host 删除归 WP8，绝不直接删）；
 * - stale（§4.9）：树 mutation 入口全部禁用（中文原因「列表已过期，请先刷新」）+
 *   「重新刷新」横幅；浏览/搜索/展开/复制/剪切/导出文本保留（Copy/Cut/复制 URL/
 *   cURL 不改树数据，版本冲突由 Host 409 裁决）。「新建 Request」归入树创建入口
 *   一并禁用——虽然其 Host 落库发生在 Save（WP8 另有 Request Save 的 stale 门禁），
 *   stale 期间开放一个最终无法保存的草稿入口是死路 UX，且草稿绑定的 collectionId
 *   可能已被外部删除；
 * - 复制 URL / 复制为 cURL：调 core plan.ts 的 buildCopyUrl / buildCurlCommand
 *   （唯一算法来源，§5.10），navigator.clipboard.writeText 写系统剪贴板——仅此两项
 *   走系统剪贴板（树节点复制走 Host token）；写失败中文 toast 且不改选择；
 *   environment 缺省时按 redaction 默认行为（未解析变量保留 {{name}}，不伪造）。
 *
 * 实现注记：事件处理器一律为每次渲染的新鲜闭包（不做 useCallback 记忆）——菜单
 * 动作矩阵/禁用原因必须读取打开时刻的最新 stale/clipboard/投影状态，记忆化闭包
 * 会造成陈旧菜单；树规模下重建成本可忽略。
 *
 * 本文件不 import 任何 DSH 包（TC-A-03）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactElement, RefObject } from 'react'
import type { ApiRequest, Collection, Environment, Folder } from '@dsh-api-client/shared'
import { buildCopyUrl, buildCurlCommand } from '../../../../packages/core/src/request/plan.ts'
import type { SafeCopyOptions } from '../../../../packages/core/src/request/plan.ts'
import { colors, font } from '../common/theme.ts'
import { toast } from '../common/Toast.tsx'
import type { CollectionsState, MutationOutcome } from '../../hooks/useCollections.ts'
import type { PasteTarget, TreeClipboardApi } from '../../hooks/useTreeClipboard.ts'
import { findRowByKey, projectTree, treeNodeKey } from './tree-projection.ts'
import type { ProjectedTreeNode } from './tree-projection.ts'
import { TreeItem } from './TreeItem.tsx'
import { TreeContextMenu } from './TreeContextMenu.tsx'
import type { TreeMenuItem } from './TreeContextMenu.tsx'
import { TreeCreateDialog } from './TreeCreateDialog.tsx'
import type { TreeCreateMode } from './TreeCreateDialog.tsx'

/** 删除触发目标（WP8 弹 TreeDeleteConfirmDialog：统计用节点引用 + 所属 collection）。 */
export type TreeDeleteTarget =
  | { kind: 'collection'; collection: Collection }
  | { kind: 'folder'; collection: Collection; folder: Folder }
  | { kind: 'request'; collection: Collection; request: ApiRequest }

export interface CollectionTreeHandlers {
  /** Request 左键/Enter/菜单「打开」：打开或激活对应 tab。 */
  onOpenRequest: (request: ApiRequest) => void
  /** 菜单「新建 Request」：WP8 打开绑定目标容器的新草稿 tab（Save 才落 Host；stale 时 Save 由 WP8 禁用）。 */
  onNewRequest: (collectionId: string, folderId?: string) => void
  /** 删除入口（菜单/Delete/Backspace）：WP8 弹确认框并执行 Host 删除 + tab 清理 + clipboard.notifyLocalRequestsDeleted。 */
  onRequestDelete: (target: TreeDeleteTarget) => void
  /** Request 重命名成功回调：WP8 同步已打开 tab 的草稿名。 */
  onRequestRenamed?: (updated: ApiRequest) => void
}

export interface CollectionTreeProps {
  /** useCollections() 完整返回（投影 + mutations + stale/refresh——§4.9）。 */
  collections: CollectionsState
  /** useTreeClipboard 实例（WP8 视图层创建并与删除流程共享——§0.3 Cut 源级联清空）。 */
  clipboard: TreeClipboardApi
  /** 当前激活 tab 的 Request id（行高亮 + 选择同步）。 */
  selectedRequestId?: string
  /** 复制 URL / cURL 的安全拷贝上下文（当前激活环境）；缺省 = buildCurlCommand 默认 redaction 行为。 */
  environment?: Environment
  /** 右键菜单定位边界 = API Client 可视容器；缺省回退视口（§6.3）。 */
  menuBoundaryRef?: RefObject<HTMLElement | null>
  handlers: CollectionTreeHandlers
}

/** stale 期间 mutation 入口的中文禁用原因（§4.9）。 */
const STALE_REASON = '列表已过期，请先刷新'

interface MenuState {
  items: TreeMenuItem[]
  anchor: { x: number; y: number }
}

interface CreateDialogState {
  mode: TreeCreateMode
  collectionId?: string
  parentFolderId?: string
  contextName?: string
}

function toggleInSet(previous: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(previous)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}

export function CollectionTree(props: CollectionTreeProps): ReactElement {
  const { collections, clipboard, handlers } = props
  const [query, setQuery] = useState('')
  /** 普通态展开集合（初始空集 = 全收缩，AC-03；不持久化）。 */
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set())
  /** 搜索态临时收缩集合（命中路径初始展开；清除搜索丢弃——AC-06 互不污染）。 */
  const [searchCollapsed, setSearchCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [selectedKey, setSelectedKey] = useState<string | undefined>()
  const [renamingKey, setRenamingKey] = useState<string | undefined>()
  const [renamePending, setRenamePending] = useState(false)
  const [renameError, setRenameError] = useState<string | undefined>()
  const [menu, setMenu] = useState<MenuState | undefined>()
  /** 每次 openMenu 递增并作为 TreeContextMenu 的 key：强制重挂载，保证 R2 的 one-shot 焦点投放对「未先关闭的连续打开」也生效。 */
  const [menuNonce, setMenuNonce] = useState(0)
  const [createDialog, setCreateDialog] = useState<CreateDialogState | undefined>()
  const [createPending, setCreatePending] = useState(false)
  const [createError, setCreateError] = useState<string | undefined>()
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(new Set())
  const [refreshing, setRefreshing] = useState(false)

  const listRef = useRef<HTMLDivElement>(null)
  const rowRefs = useRef(new Map<string, HTMLDivElement>())
  const menuOpenRef = useRef(false)
  const menuOriginRef = useRef<string | undefined>(undefined)

  const projection = useMemo(
    () => projectTree({ collections: collections.collections, query, expandedIds, searchCollapsed }),
    [collections.collections, query, expandedIds, searchCollapsed],
  )
  const rows = projection.rows
  const searching = projection.searching
  const stale = collections.stale

  // 激活 tab 变化 → 树选择同步（WP8 RequestTabs 切换时高亮跟随）。
  useEffect(() => {
    if (props.selectedRequestId === undefined) return
    setSelectedKey(treeNodeKey('request', props.selectedRequestId))
  }, [props.selectedRequestId])

  const focusRow = (key: string): void => {
    rowRefs.current.get(key)?.focus()
  }

  const selectAndFocus = (key: string): void => {
    setSelectedKey(key)
    focusRow(key)
  }

  const closeMenu = (): void => {
    // menuOpenRef 闸：菜单已关（outside click/滚动等抢先）时，迟到的动作完成回调不再抢焦点。
    if (!menuOpenRef.current) return
    menuOpenRef.current = false
    const origin = menuOriginRef.current
    menuOriginRef.current = undefined
    // R1 修复前置：卸载前抓取菜单 DOM 引用，用于识别「焦点仍停在正在关闭的菜单里」。
    const closingMenu = document.querySelector('[data-dsh-api-client="tree-context-menu"]')
    setMenu(undefined)
    // R1 焦点交接（真实浏览器时序）：菜单动作若打开了对话框（TreeCreateDialog /
    // WP8 删除确认），React 会在处理上面 setMenu 这次更新前**同步冲刷** Modal
    // initialFocus 的 passive effect——焦点此刻已落到对话框输入框/取消按钮；
    // 旧实现随后同步 focusRow 会把它抢回树行（R1 缺陷，jsdom act 会推迟 passive
    // 冲刷故测不出）。修复：还原决策推迟到微任务并**条件接管**——仅当焦点
    // 「无家可归」（body/null/已脱离文档的节点/仍停在正关闭的菜单内）才还原到
    // 原树行（根菜单 → 树容器）。非对话框动作（复制/剪切/粘贴/复制 URL/cURL）
    // 与 Esc/滚动/resize/outside click 关闭时焦点必然无家可归 → 还原行为不变。
    Promise.resolve().then(() => {
      const active = document.activeElement
      const inClosingMenu = closingMenu !== null && active !== null && (active === closingMenu || closingMenu.contains(active))
      const homed = active !== null && active !== document.body && (active as HTMLElement).isConnected === true && !inClosingMenu
      if (homed) return
      // Esc/滚动/resize/动作完成后焦点还原到原树行（§6.3）；根菜单 → 树容器。
      if (origin !== undefined) focusRow(origin)
      else listRef.current?.focus()
    })
  }

  const openMenu = (items: TreeMenuItem[], anchor: { x: number; y: number }, originKey: string | undefined): void => {
    menuOpenRef.current = true
    menuOriginRef.current = originKey
    setMenuNonce((nonce) => nonce + 1)
    setMenu({ items, anchor })
  }

  const toggleNode = (key: string): void => {
    // 搜索态 toggle 只改 searchCollapsed；普通态只改 expandedIds（AC-06）。
    if (searching) setSearchCollapsed((previous) => toggleInSet(previous, key))
    else setExpandedIds((previous) => toggleInSet(previous, key))
  }

  const withRowPending = async (key: string, action: () => Promise<unknown>): Promise<void> => {
    setPendingKeys((previous) => new Set(previous).add(key))
    try {
      await action()
    } finally {
      setPendingKeys((previous) => {
        const next = new Set(previous)
        next.delete(key)
        return next
      })
    }
  }

  const activateRow = (row: ProjectedTreeNode): void => {
    selectAndFocus(row.key)
    if (row.kind === 'request') {
      if (row.request !== undefined) handlers.onOpenRequest(row.request)
      return
    }
    // Collection/Folder：先选中（上一步）再 toggle；空节点无可 toggle。
    if (row.expandable) toggleNode(row.key)
  }

  const toggleExpandAll = (): void => {
    if (searching) return
    if (projection.allExpanded) setExpandedIds(new Set())
    else setExpandedIds(new Set(projection.allExpandableKeys))
  }

  // ---- 行内重命名（§6.4：编辑态归本组件协调——同一时间仅一个节点） ----

  const startRename = (key: string): void => {
    if (stale) {
      toast.error(STALE_REASON)
      return
    }
    setRenamingKey(key)
    setRenameError(undefined)
  }

  const cancelRename = (): void => {
    const key = renamingKey
    setRenamingKey(undefined)
    setRenameError(undefined)
    // 取消后焦点回到原树行（Esc 语义：保留当前行焦点）。
    if (key !== undefined) focusRow(key)
  }

  const submitRename = async (name: string): Promise<void> => {
    if (renamingKey === undefined || renamePending) return
    const row = findRowByKey(rows, renamingKey)
    if (row === undefined) {
      setRenamingKey(undefined)
      return
    }
    setRenamePending(true)
    setRenameError(undefined)
    let outcome: MutationOutcome & { request?: ApiRequest } = { committed: false, refreshed: false, error: '重命名失败，请重试' }
    try {
      if (row.kind === 'collection') {
        outcome = await collections.renameCollection(row.nodeId, name, row.collection.updatedAt)
      } else if (row.kind === 'folder') {
        outcome = await collections.renameFolder(row.collectionId, row.nodeId, name, row.collection.updatedAt)
      } else {
        outcome = await collections.renameRequest(row.nodeId, name, row.collection.updatedAt)
        if (outcome.committed && outcome.request !== undefined) handlers.onRequestRenamed?.(outcome.request)
      }
    } finally {
      setRenamePending(false)
    }
    if (outcome.committed) {
      setRenamingKey(undefined)
      setRenameError(undefined)
      focusRow(row.key)
    } else {
      // 失败 → 保持编辑态 + 中文错误，输入不丢（§6.4；具体 toast 已由 hook 发出）。
      setRenameError(outcome.error ?? '重命名失败，请重试')
    }
  }

  // ---- 删除触发（确认对话框与 Host 删除归 WP8——绝不直接删） ----

  const deleteTargetForRow = (row: ProjectedTreeNode): TreeDeleteTarget | undefined => {
    if (row.kind === 'collection') return { kind: 'collection', collection: row.collection }
    if (row.kind === 'folder') return row.folder === undefined ? undefined : { kind: 'folder', collection: row.collection, folder: row.folder }
    return row.request === undefined ? undefined : { kind: 'request', collection: row.collection, request: row.request }
  }

  const requestDelete = (row: ProjectedTreeNode): void => {
    if (stale) {
      toast.error(STALE_REASON)
      return
    }
    const target = deleteTargetForRow(row)
    if (target !== undefined) handlers.onRequestDelete(target)
  }

  // ---- 复制 / 剪切 / 粘贴（Host token 剪贴板，AC-13/AC-17/§6.5） ----

  const copyNode = async (row: ProjectedTreeNode): Promise<void> => {
    const source =
      row.kind === 'collection'
        ? { kind: 'collection' as const, collectionId: row.collectionId }
        : { kind: row.kind as 'folder' | 'request', collectionId: row.collectionId, nodeId: row.nodeId }
    await withRowPending(row.key, () => clipboard.copy(source))
  }

  const cutNode = (row: ProjectedTreeNode): void => {
    // AC-17：Cut 仅 Request；其他节点无动作 + 中文原因。
    if (row.kind !== 'request' || row.request === undefined) {
      toast.error('P0 剪切仅支持 Request 节点')
      return
    }
    const request = row.request
    void withRowPending(row.key, () =>
      clipboard.cut({ requestId: request.id, requestUpdatedAt: request.updatedAt, sourceCollectionUpdatedAt: row.collection.updatedAt }),
    )
  }

  const pasteTargetForRow = (row: ProjectedTreeNode): PasteTarget => {
    if (row.kind === 'collection') {
      return { kind: 'collection', targetId: row.nodeId, targetCollectionId: row.nodeId, expectedTargetCollectionUpdatedAt: row.collection.updatedAt }
    }
    if (row.kind === 'folder') {
      return { kind: 'folder', targetId: row.nodeId, targetCollectionId: row.collectionId, expectedTargetCollectionUpdatedAt: row.collection.updatedAt }
    }
    return { kind: 'request', targetId: row.nodeId, targetCollectionId: row.collectionId, expectedTargetCollectionUpdatedAt: row.collection.updatedAt }
  }

  const pasteTo = async (target: PasteTarget, rowKey: string | undefined): Promise<void> => {
    if (stale) {
      toast.error(STALE_REASON)
      return
    }
    const enablement = clipboard.pasteEnablement({ kind: target.kind })
    if (!enablement.enabled) {
      toast.error(enablement.reason ?? '当前目标不能粘贴')
      return
    }
    const run = (): Promise<unknown> => clipboard.paste(target)
    if (rowKey !== undefined) await withRowPending(rowKey, run)
    else await run()
  }

  // ---- 复制 URL / 复制为 cURL（§5.10：core plan.ts 唯一算法来源 → 系统剪贴板） ----

  const copyRequestText = async (row: ProjectedTreeNode, which: 'url' | 'curl'): Promise<void> => {
    const request = row.request
    if (request === undefined) return
    const options: SafeCopyOptions = {
      collection: row.collection,
      ...(props.environment !== undefined ? { environment: props.environment } : {}),
    }
    const text = which === 'url' ? buildCopyUrl(request, options) : buildCurlCommand(request, options)
    const what = which === 'url' ? 'URL' : 'cURL'
    const systemClipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
    if (systemClipboard?.writeText === undefined) {
      toast.error(`当前环境不支持系统剪贴板，无法复制 ${what}`)
      return
    }
    try {
      await systemClipboard.writeText(text)
      toast.info(`已复制 ${what}`)
    } catch {
      // 写失败 → 中文 toast 且不改选择（本函数不触碰任何选择状态）。
      toast.error(`复制 ${what} 到系统剪贴板失败`)
    }
  }

  // ---- 新建对话框 ----

  const openCreateDialog = (state: CreateDialogState): void => {
    setCreateError(undefined)
    setCreateDialog(state)
  }

  const closeCreateDialog = (): void => {
    setCreateDialog(undefined)
    setCreateError(undefined)
  }

  const submitCreate = async (name: string): Promise<void> => {
    const dialog = createDialog
    if (dialog === undefined || createPending) return
    setCreatePending(true)
    setCreateError(undefined)
    try {
      if (dialog.mode === 'collection') {
        const created = await collections.createCollection(name)
        if (created === undefined) setCreateError('创建失败，请重试')
        else setCreateDialog(undefined)
        return
      }
      const collection = collections.collections.find((item) => item.id === dialog.collectionId)
      if (collection === undefined) {
        setCreateError('目标 Collection 不存在，请刷新列表')
        return
      }
      const outcome = await collections.createFolder(collection.id, name, dialog.parentFolderId, collection.updatedAt)
      if (!outcome.committed) setCreateError(outcome.error ?? '创建失败，请重试')
      else setCreateDialog(undefined)
    } finally {
      setCreatePending(false)
    }
  }

  // ---- stale 恢复（§4.9：刷新成功才恢复 mutation） ----

  const retryRefresh = async (): Promise<void> => {
    if (refreshing) return
    setRefreshing(true)
    try {
      const ok = await collections.refresh()
      if (!ok) toast.error('列表刷新失败，请稍后重试')
    } finally {
      setRefreshing(false)
    }
  }

  // ---- 菜单动作矩阵（UX §4.4 冻结表 + 分组顺序：创建→编辑→复制/粘贴→导出文本→危险操作） ----

  const withStaleGate = (item: TreeMenuItem): TreeMenuItem =>
    stale ? { ...item, disabled: true, disabledReason: item.disabled === true ? item.disabledReason : STALE_REASON } : item

  const buildPasteItem = (target: PasteTarget, rowKey: string | undefined): TreeMenuItem => {
    const enablement = stale ? { enabled: false, reason: STALE_REASON } : clipboard.pasteEnablement({ kind: target.kind })
    return {
      id: 'paste',
      label: '粘贴',
      group: 'clipboard',
      disabled: !enablement.enabled,
      ...(enablement.reason !== undefined ? { disabledReason: enablement.reason } : {}),
      onRun: async () => {
        await pasteTo(target, rowKey)
      },
    }
  }

  const buildCollectionMenu = (row: ProjectedTreeNode): TreeMenuItem[] => {
    const collection = row.collection
    return [
      withStaleGate({ id: 'new-request', label: '新建 Request', group: 'create', onRun: async () => handlers.onNewRequest(collection.id) }),
      withStaleGate({
        id: 'new-folder',
        label: '新建 Folder',
        group: 'create',
        onRun: async () => openCreateDialog({ mode: 'folder', collectionId: collection.id, contextName: collection.name }),
      }),
      withStaleGate({ id: 'rename', label: '重命名', group: 'edit', onRun: async () => startRename(row.key) }),
      { id: 'copy', label: '复制', group: 'clipboard', onRun: () => copyNode(row) },
      buildPasteItem(pasteTargetForRow(row), row.key),
      withStaleGate({ id: 'delete', label: '删除', group: 'danger', danger: true, onRun: async () => requestDelete(row) }),
    ]
  }

  const buildFolderMenu = (row: ProjectedTreeNode): TreeMenuItem[] => [
    withStaleGate({ id: 'new-request', label: '新建 Request', group: 'create', onRun: async () => handlers.onNewRequest(row.collectionId, row.nodeId) }),
    withStaleGate({
      id: 'new-subfolder',
      label: '新建子 Folder',
      group: 'create',
      onRun: async () => openCreateDialog({ mode: 'subfolder', collectionId: row.collectionId, parentFolderId: row.nodeId, contextName: row.folder?.name ?? row.name }),
    }),
    withStaleGate({ id: 'rename', label: '重命名', group: 'edit', onRun: async () => startRename(row.key) }),
    // AC-17：Collection/Folder 无剪切入口（Cut 仅 Request）。
    { id: 'copy', label: '复制', group: 'clipboard', onRun: () => copyNode(row) },
    buildPasteItem(pasteTargetForRow(row), row.key),
    withStaleGate({ id: 'delete', label: '删除', group: 'danger', danger: true, onRun: async () => requestDelete(row) }),
  ]

  const buildRequestMenu = (row: ProjectedTreeNode): TreeMenuItem[] => {
    const request = row.request
    return [
      {
        id: 'open',
        label: '打开',
        group: 'open',
        onRun: async () => {
          if (request !== undefined) handlers.onOpenRequest(request)
        },
      },
      withStaleGate({ id: 'rename', label: '重命名', group: 'edit', onRun: async () => startRename(row.key) }),
      { id: 'copy', label: '复制', group: 'clipboard', onRun: () => copyNode(row) },
      { id: 'cut', label: '剪切', group: 'clipboard', onRun: async () => cutNode(row) },
      // R-02（GPT review 裁决 b）：Request 作为粘贴目标 = 插在该 Request 之后（§4.6
      // 冻结矩阵）——菜单与键盘 Cmd+V 同走 pasteTargetForRow，鼠标/键盘对同一节点
      // 产生同一数据结果；文案「粘贴到此请求之后」。
      { ...buildPasteItem(pasteTargetForRow(row), row.key), label: '粘贴到此请求之后' },
      { id: 'copy-url', label: '复制 URL', group: 'export', onRun: () => copyRequestText(row, 'url') },
      { id: 'copy-curl', label: '复制为 cURL', group: 'export', onRun: () => copyRequestText(row, 'curl') },
      withStaleGate({ id: 'delete', label: '删除', group: 'danger', danger: true, onRun: async () => requestDelete(row) }),
    ]
  }

  const buildRootMenu = (): TreeMenuItem[] => [
    withStaleGate({ id: 'new-collection', label: '新建 Collection', group: 'create', onRun: async () => openCreateDialog({ mode: 'collection' }) }),
    buildPasteItem({ kind: 'root' }, undefined),
    {
      id: 'toggle-expand-all',
      label: projection.allExpanded ? '全部收缩' : '全部展开',
      group: 'view',
      disabled: searching,
      ...(searching ? { disabledReason: '清除搜索后恢复原折叠状态' } : {}),
      onRun: async () => toggleExpandAll(),
    },
  ]

  const buildRowMenu = (row: ProjectedTreeNode): TreeMenuItem[] => {
    if (row.kind === 'collection') return buildCollectionMenu(row)
    if (row.kind === 'folder') return buildFolderMenu(row)
    return buildRequestMenu(row)
  }

  const openRowMenu = (row: ProjectedTreeNode, clientX: number, clientY: number): void => {
    // 右键：只选中 + 开菜单（不开 Request、不 toggle——§6.2/AC-09）。
    selectAndFocus(row.key)
    openMenu(buildRowMenu(row), { x: clientX, y: clientY }, row.key)
  }

  const openMenuAtRow = (row: ProjectedTreeNode): void => {
    // Shift+F10 / 菜单键：在当前选择行位置打开。
    const rect = rowRefs.current.get(row.key)?.getBoundingClientRect()
    const anchor = rect !== undefined ? { x: rect.left + 24, y: rect.top + Math.max(rect.height, 24) / 2 } : { x: 24, y: 12 }
    openRowMenu(row, anchor.x, anchor.y)
  }

  // ---- 键盘契约（UX §4.4 表逐字） ----

  const moveSelection = (delta: number): void => {
    if (rows.length === 0) return
    const currentIndex = rows.findIndex((row) => row.key === selectedKey)
    const nextIndex = currentIndex === -1 ? (delta > 0 ? 0 : rows.length - 1) : Math.min(Math.max(currentIndex + delta, 0), rows.length - 1)
    const next = rows[nextIndex]
    if (next !== undefined) selectAndFocus(next.key)
  }

  const onRowKeyDown = (row: ProjectedTreeNode, event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const key = event.key
    if (key === 'Escape') {
      // Esc：关菜单（焦点还原到原树行）；rename 的 Esc 由输入框自行处理（已 stopPropagation）。
      if (menuOpenRef.current) {
        event.preventDefault()
        closeMenu()
      }
      return
    }
    if (renamingKey !== undefined) return // 编辑态：树快捷键全部让位给输入框
    if (event.altKey) return
    if (event.metaKey || event.ctrlKey) {
      const lower = key.toLocaleLowerCase()
      if (lower === 'c') {
        event.preventDefault()
        if (!clipboard.pending && !pendingKeys.has(row.key)) void copyNode(row)
        return
      }
      if (lower === 'x') {
        event.preventDefault()
        if (!clipboard.pending && !pendingKeys.has(row.key)) cutNode(row)
        return
      }
      if (lower === 'v') {
        event.preventDefault()
        if (!clipboard.pending && !pendingKeys.has(row.key)) void pasteTo(pasteTargetForRow(row), row.key)
        return
      }
      return // 其余系统快捷键不劫持
    }
    switch (key) {
      case 'ArrowDown':
        event.preventDefault()
        moveSelection(1)
        return
      case 'ArrowUp':
        event.preventDefault()
        moveSelection(-1)
        return
      case 'ArrowLeft':
        // 展开则收缩；已收缩则移动到父节点。
        event.preventDefault()
        if (row.expandable && row.expanded) toggleNode(row.key)
        else if (row.parentKey !== undefined) selectAndFocus(row.parentKey)
        return
      case 'ArrowRight':
        // 收缩则展开；已展开则移动到第一个子节点。
        event.preventDefault()
        if (row.expandable && !row.expanded) toggleNode(row.key)
        else if (row.expanded && row.firstChildKey !== undefined) selectAndFocus(row.firstChildKey)
        return
      case 'Home':
        event.preventDefault()
        if (rows.length > 0) selectAndFocus(rows[0]!.key)
        return
      case 'End':
        event.preventDefault()
        if (rows.length > 0) selectAndFocus(rows[rows.length - 1]!.key)
        return
      case 'Enter':
      case ' ':
        // Enter/Space：Collection/Folder toggle；Request 打开。普通行 Enter 不进 rename。
        event.preventDefault()
        activateRow(row)
        return
      case 'F2':
        event.preventDefault()
        startRename(row.key)
        return
      case 'Delete':
      case 'Backspace':
        // 打开删除确认（WP8 弹框），绝不直接删。
        event.preventDefault()
        requestDelete(row)
        return
      case 'ContextMenu':
        event.preventDefault()
        openMenuAtRow(row)
        return
      case 'F10':
        if (event.shiftKey) {
          event.preventDefault()
          openMenuAtRow(row)
        }
        return
      default:
        return
    }
  }

  // ---- 空白区（§6.2：左键清选择+关菜单；右键开根菜单） ----

  const onBlankClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (event.target !== listRef.current) return
    setSelectedKey(undefined)
    closeMenu()
    listRef.current?.focus()
  }

  const onBlankContextMenu = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (event.target !== listRef.current) return
    event.preventDefault()
    setSelectedKey(undefined)
    openMenu(buildRootMenu(), { x: event.clientX, y: event.clientY }, undefined)
  }

  /** 容器兜底：无选择且焦点在树容器时，Cmd/Ctrl+V = 根区域粘贴（UX §4.4）。 */
  const onContainerKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== listRef.current) return
    if (event.key === 'Escape') {
      closeMenu()
      return
    }
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLocaleLowerCase() === 'v') {
      event.preventDefault()
      if (!clipboard.pending) void pasteTo({ kind: 'root' }, undefined)
    }
  }

  // ---- 搜索（§4.3/§4.7：清除搜索丢弃 searchCollapsed） ----

  const onSearchChange = (value: string): void => {
    setQuery(value)
    if (value.trim() === '') setSearchCollapsed(new Set())
  }

  // 选中行不可见（如激活 tab 的请求被折叠遮蔽）时，首行兜底 tabIndex=0——树始终可 Tab 进入。
  const selectedVisible = rows.some((row) => row.key === selectedKey)
  const rovingTabIndex = (row: ProjectedTreeNode, index: number): number => {
    if (row.key === selectedKey) return 0
    return (selectedKey === undefined || !selectedVisible) && index === 0 ? 0 : -1
  }

  const inputStyle = {
    flex: 1,
    minWidth: 0,
    background: colors.bgLayer1,
    border: `1px solid ${colors.border}`,
    borderRadius: 4,
    color: colors.text,
    font: 'inherit',
    fontSize: font.size,
    padding: '3px 8px',
    outline: 'none',
  } as const

  const toolButtonStyle = {
    background: 'transparent',
    border: `1px solid ${colors.borderStrong}`,
    borderRadius: 4,
    color: colors.textSecondary,
    font: 'inherit',
    fontSize: font.size,
    padding: '2px 8px',
  } as const

  return (
    <div data-dsh-api-client="collection-tree" style={{ display: 'flex', flexDirection: 'column', height: '100%', fontSize: font.size }}>
      {/* 工具区：搜索框 + 双态展开按钮 + 新建 Collection */}
      <div data-dsh-api-client="tree-toolbar" style={{ display: 'flex', gap: 4, padding: '6px 6px 4px', alignItems: 'center' }}>
        <input
          data-dsh-api-client="tree-search"
          value={query}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="搜索请求树"
          aria-label="搜索请求树"
          style={inputStyle}
        />
        <button
          data-dsh-api-client="tree-expand-all"
          type="button"
          title={searching ? '清除搜索后恢复原折叠状态' : projection.allExpanded ? '全部收缩' : '全部展开'}
          aria-label={searching ? '全部展开或收缩（搜索态不可用）' : projection.allExpanded ? '全部收缩' : '全部展开'}
          disabled={searching}
          onClick={toggleExpandAll}
          style={{ ...toolButtonStyle, cursor: searching ? 'default' : 'pointer', opacity: searching ? 0.5 : 1 }}
        >
          {projection.allExpanded ? '▸▸' : '▾▾'}
        </button>
        <button
          data-dsh-api-client="tree-new-collection"
          type="button"
          title={stale ? STALE_REASON : '新建 Collection'}
          aria-label="新建 Collection"
          disabled={stale}
          onClick={() => openCreateDialog({ mode: 'collection' })}
          style={{ ...toolButtonStyle, cursor: stale ? 'default' : 'pointer', opacity: stale ? 0.5 : 1 }}
        >
          +
        </button>
      </div>
      {/* §4.9 stale：禁用 mutation + 「重新刷新」；禁止任何「已回滚」文案 */}
      {stale && (
        <div
          data-dsh-api-client="tree-stale-banner"
          role="status"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            margin: '0 6px 4px',
            padding: '4px 8px',
            borderRadius: 4,
            background: colors.bgLayer2,
            border: `1px solid ${colors.warning}`,
            color: colors.text,
            fontSize: 11,
          }}
        >
          <span style={{ flex: 1 }}>列表已过期，修改暂不可用</span>
          <button
            data-dsh-api-client="tree-stale-refresh"
            type="button"
            disabled={refreshing}
            onClick={() => void retryRefresh()}
            style={{ ...toolButtonStyle, padding: '1px 8px', cursor: refreshing ? 'default' : 'pointer' }}
          >
            {refreshing ? '刷新中…' : '重新刷新'}
          </button>
        </div>
      )}
      <div
        ref={listRef}
        data-dsh-api-client="collection-tree-list"
        role="tree"
        aria-multiselectable={false}
        aria-label="请求树"
        tabIndex={-1}
        onClick={onBlankClick}
        onContextMenu={onBlankContextMenu}
        onKeyDown={onContainerKeyDown}
        style={{ flex: 1, overflow: 'auto', padding: '0 4px 8px', outline: 'none' }}
      >
        {collections.loading && <div data-dsh-api-client="tree-loading" style={{ padding: 8, color: colors.textSecondary }}>加载中…</div>}
        {!collections.loading && collections.collections.length === 0 && (
          <div data-dsh-api-client="tree-empty" style={{ padding: 8, color: colors.textSecondary }}>
            暂无 Collection，点击右上角「+」新建
          </div>
        )}
        {rows.map((row, index) => (
          <TreeItem
            key={row.key}
            nodeKey={row.key}
            kind={row.kind}
            name={row.name}
            method={row.method}
            visualDepth={row.visualDepth}
            ariaLevel={row.logicalDepth + 1}
            expandable={row.expandable}
            expanded={row.expanded}
            selected={row.key === selectedKey}
            tabIndex={rovingTabIndex(row, index)}
            renaming={renamingKey === row.key}
            renamePending={renamingKey === row.key && renamePending}
            renameError={renamingKey === row.key ? renameError : undefined}
            actionPending={pendingKeys.has(row.key)}
            rowRef={(element) => {
              if (element === null) rowRefs.current.delete(row.key)
              else rowRefs.current.set(row.key, element)
            }}
            onActivate={() => activateRow(row)}
            onContextMenu={(event) => {
              event.preventDefault()
              openRowMenu(row, event.clientX, event.clientY)
            }}
            onKeyDown={(event) => onRowKeyDown(row, event)}
            onRenameSubmit={(name) => void submitRename(name)}
            onRenameCancel={cancelRename}
          />
        ))}
      </div>
      {menu !== undefined && (
        <TreeContextMenu
          key={menuNonce}
          items={menu.items}
          anchor={menu.anchor}
          boundaryRef={props.menuBoundaryRef}
          scrollContainerRef={listRef}
          onClose={closeMenu}
        />
      )}
      {createDialog !== undefined && (
        <TreeCreateDialog
          mode={createDialog.mode}
          contextName={createDialog.contextName}
          pending={createPending}
          error={createError}
          onCancel={closeCreateDialog}
          onSubmit={(name) => void submitCreate(name)}
        />
      )}
    </div>
  )
}
