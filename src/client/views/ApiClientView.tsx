/**
 * ApiClientView（§4 主页面布局；WP8 最终汇聚）：
 * 顶栏（历史 / 导入 / 环境 + 环境切换）+ ResizableCollectionPane（请求树 ⇆ 编辑器列，
 * 三态/drawer 不重挂载）+ RequestTabs + MethodSelector/UrlBar/Send/Save +
 * Params/Headers/Auth/Body/Scripts 编辑器 + ResponseViewer +
 * 删除确认（TreeDeleteConfirmDialog）/ dirty tab 关闭确认（DirtyTabCloseDialog）。
 *
 * 汇聚纪律（§10 WP8「只做汇聚，不重新实现子包算法」）：
 * paste legality matrix → useTreeClipboard；request-plan priority → plan preview
 * （Headers/Params 编辑器内部消费）；tree projection search → tree-projection；
 * sidebar clamp math → ResizableCollectionPane/useCollectionSidebarWidth；
 * tab-selection algorithm → tab-lifecycle.removeTabsAndSelectNext；
 * 删除递归统计 → core 权威版 countFolderDescendants/countCollectionRequests（WP1）。
 *
 * 一致性契约：
 * - §7.3：树删除必须 await Host DELETE，committed 之后才 removeTabsAndSelectNext；
 *   committed=false → tree/tabs/activeKey 全不动（失败 toast 由 useCollections 统一发）；
 *   受影响 tab 按 key∨requestId 双匹配后映射回 tab.key（R3：保存成功的草稿 tab
 *   key 仍为 draft-N，仅 requestId 指向 Host 记录，不得幽灵存活）；
 * - §0.3：删除 committed 后调 clipboard.notifyLocalRequestsDeleted（Cut 源级联清空）；
 * - §7.5：dirty tab 单独关闭必须经 DirtyTabCloseDialog 确认（P0 无自动保存）；
 * - §4.9：stale 时 Save 禁用、Send/浏览/tab/草稿保留；SaveRequestModal 的提交经
 *   父级注入 callback 走唯一 useCollections 状态机（R-05：不自建第二个 hook 实例，
 *   杜绝「POST 成功+刷新失败」的 stale 随 Modal 卸载丢失）；
 * - R-07：openRequest 查重按 key∨requestId 双匹配——保存成功的 draft-key tab
 *   再被树打开时激活原 tab，不产生双 tab（完整 identity 重构留 P1）；
 * - §6.6/AC-34：编辑器列恒定渲染在 pane 的 main prop，外层不附加 key/条件卸载。
 *
 * 分层纪律（TC-A-03）：本文件不 import 任何 DSH 包；数据全部经 hooks 走
 * Host API（Host 为权威状态源，client 只做投影——D16）；URL↔Params 双向同步、
 * 参数编码等复用 core request/build 纯函数。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import type {
  ApiRequest,
  Collection,
  Folder,
  HttpExecutionResult,
  ImportReport,
  PluginSettings,
  RedactedRequestSnapshot,
  RedactedResponseSnapshot,
  SafeApiDebugContext,
} from '@dsh-api-client/shared'
import { collapseMirroredQuery, paramsToUrl, serializeParams, urlToParams } from '../../../packages/core/src/request/build.ts'
import { countCollectionRequests, countFolderDescendants } from '../../../packages/core/src/collection/ops.ts'
import type { BuildSafeApiDebugContextInput } from '../../../packages/core/src/security/redactor.ts'
import { buildSafeApiDebugContext } from '../../../packages/core/src/security/redactor.ts'
import type { MutationOutcome } from '../hooks/useCollections.ts'
import { useCollections } from '../hooks/useCollections.ts'
import { useEnvironments } from '../hooks/useEnvironments.ts'
import { useExecute } from '../hooks/useExecute.ts'
import { useHostApi } from '../hooks/useHostApi.ts'
import { useTreeClipboard } from '../hooks/useTreeClipboard.ts'
import { CollectionTree } from '../components/collection/CollectionTree.tsx'
import type { CollectionTreeHandlers, TreeDeleteTarget } from '../components/collection/CollectionTree.tsx'
import { ResizableCollectionPane } from '../components/collection/ResizableCollectionPane.tsx'
import type { ResizableCollectionPaneHandle } from '../components/collection/ResizableCollectionPane.tsx'
import { TreeDeleteConfirmDialog } from '../components/collection/TreeDeleteConfirmDialog.tsx'
import { collectSubtreeRequestIds } from '../components/collection/tree-projection.ts'
import { RequestTabs } from '../components/request/RequestTabs.tsx'
import { DirtyTabCloseDialog } from '../components/request/DirtyTabCloseDialog.tsx'
import { removeTabsAndSelectNext } from '../components/request/tab-lifecycle.ts'
import { MethodSelector } from '../components/request/MethodSelector.tsx'
import { UrlBar } from '../components/request/UrlBar.tsx'
import { ParamsEditor } from '../components/request/ParamsEditor.tsx'
import { HeadersEditor } from '../components/request/HeadersEditor.tsx'
import { AuthEditor } from '../components/request/AuthEditor.tsx'
import { BodyEditor } from '../components/request/BodyEditor.tsx'
import { ScriptsPanel } from '../components/request/ScriptsPanel.tsx'
import { ResponseViewer } from '../components/response/ResponseViewer.tsx'
import { EnvironmentSelector } from '../components/environment/EnvironmentSelector.tsx'
import { Modal } from '../components/common/Modal.tsx'
import { ConfirmSendToAgent } from '../components/common/ConfirmSendToAgent.tsx'
import { ToastHost, toast } from '../components/common/Toast.tsx'
import { colors, font } from '../components/common/theme.ts'
import { HistoryView } from './HistoryView.tsx'
import { EnvironmentView } from './EnvironmentView.tsx'
import { ImportReportView } from './ImportReportView.tsx'

/** 「交给 Agent」结果面（WP7）：dsh-adapter/session-bridge 的 SendToAgentResult 结构兼容本类型。 */
export interface SendToAgentOutcome {
  ok: boolean
  /** 降级点/完成步骤（路径记录，失败时随 toast 展示）。 */
  stage: string
  /** 人类可读路径记录。 */
  detail: string
}

/** 出域入口签名：只接受 buildSafeApiDebugContext 的输出（唯一允许出域形态，§5.3）。 */
export type SendToAgentFn = (context: SafeApiDebugContext) => Promise<SendToAgentOutcome>

export interface ApiClientViewProps {
  /** 面板关闭（yield 回官方 Conversation）。slot/dom 两路径都由 adapter 注入。 */
  onClose?: () => void
  /** session-maybe owner props 标准套件（接收但不依赖）。 */
  sessionId?: string | undefined
  /** 「交给 Agent」出域链路（dsh-adapter/session-bridge 经 slots/adapter 装配注入）。 */
  onSendToAgent?: SendToAgentFn
}

interface RequestTab {
  key: string
  requestId?: string
  draft: ApiRequest
  dirty: boolean
  /** Auth 区被编辑过才把 auth 放进 PATCH（防止 `<redacted>` 占位材料回流）。 */
  authDirty: boolean
  response?: HttpExecutionResult
  /** 最近一次执行的 host 脱敏请求快照（「交给 Agent」优先数据源，§5.3）。 */
  requestEcho?: RedactedRequestSnapshot
  /** 最近一次执行的 host 跟踪脱敏响应快照（「交给 Agent」优先于本地 response 脱敏，WP8 C-1）。 */
  responseEcho?: RedactedResponseSnapshot
  /** 最近一次执行的 historyId（ExecutionMetadata 数据源；saveHistory=off 时缺省）。 */
  historyId?: string
}

type PaneView = 'main' | 'history' | 'environment'
type EditorTab = 'params' | 'headers' | 'auth' | 'body' | 'scripts'

const EDITOR_TABS: ReadonlyArray<{ value: EditorTab; label: string }> = [
  { value: 'params', label: 'Params' },
  { value: 'headers', label: 'Headers' },
  { value: 'auth', label: 'Auth' },
  { value: 'body', label: 'Body' },
  { value: 'scripts', label: 'Scripts' },
]

let tabSeq = 1

/** 新草稿：folderId 由树「新建 Request」入口注入（SaveRequestModal 的文件夹默认值）。 */
function blankDraft(collectionId?: string, folderId?: string): ApiRequest {
  return {
    id: '',
    name: '未命名请求',
    method: 'GET',
    url: '',
    params: [],
    headers: [],
    auth: { type: 'none' },
    body: { type: 'none' },
    collectionId: collectionId ?? '',
    ...(folderId !== undefined && folderId !== '' ? { folderId } : {}),
    createdAt: 0,
    updatedAt: 0,
  }
}

function newTab(draft: ApiRequest, requestId?: string): RequestTab {
  const tab: RequestTab = { key: requestId ?? `draft-${tabSeq++}`, draft, dirty: requestId === undefined, authDirty: false }
  if (requestId !== undefined) tab.requestId = requestId
  return tab
}

interface FolderOption {
  id: string
  label: string
}

function flattenFolders(folders: Folder[], prefix: string, out: FolderOption[]): void {
  for (const folder of folders) {
    const label = prefix === '' ? folder.name : `${prefix}/${folder.name}`
    out.push({ id: folder.id, label })
    flattenFolders(folder.folders, label, out)
  }
}

/** 删除确认框的展示统计（§7.1；递归数字来自 core 权威纯函数，dirty 数来自当前 tabs）。 */
interface DeleteStats {
  name: string
  /** kind='folder'：递归后代子文件夹数（目标本身不计入）。 */
  descendantFolderCount?: number
  /** kind='folder'：递归请求数；kind='collection'：递归 Request 总数。 */
  requestCount?: number
  /** 受影响 tab 中 dirty 的数量（§7.2）。 */
  dirtyTabCount: number
}

/**
 * R3（draft-key 幽灵 tab）：tab 是否受「被删 request id 集合」影响。
 * 已保存 tab 的 key=requestId 直接命中；经 SaveRequestModal 保存成功的草稿 tab
 * key 仍为 `draft-N`（仅 requestId 指向 Host 记录），必须再按 requestId 匹配——
 * 删除流把受影响 tab 统一映射回 tab.key 后才交给 removeTabsAndSelectNext
 * （纯函数按 key 匹配是 WP6 冻结契约，draft-key 适配责任在汇聚层）。
 */
function tabAffectedByDeletion(tab: RequestTab, deletedRequestIds: readonly string[]): boolean {
  return deletedRequestIds.includes(tab.key) || (tab.requestId !== undefined && deletedRequestIds.includes(tab.requestId))
}

/**
 * §7.1 删除统计（§13.3：Client 根据当前 projection 统计 subtree + dirty tabs）：
 * request → 名称；folder → countFolderDescendants（folderCount 不含自身）；
 * collection → countCollectionRequests；dirtyTabCount = 受影响 tab（key∨requestId
 * 双匹配，R3）中 dirty 的数量。递归算法一律消费 core 权威版（WP1）。
 */
function computeDeleteStats(target: TreeDeleteTarget, tabs: readonly RequestTab[]): DeleteStats {
  const affected = collectSubtreeRequestIds(target)
  const dirtyTabCount = tabs.filter((tab) => tab.dirty && tabAffectedByDeletion(tab, affected)).length
  if (target.kind === 'request') return { name: target.request.name, dirtyTabCount }
  if (target.kind === 'folder') {
    const { folderCount, requestCount } = countFolderDescendants(target.folder)
    return { name: target.folder.name, descendantFolderCount: folderCount, requestCount, dirtyTabCount }
  }
  return { name: target.collection.name, requestCount: countCollectionRequests(target.collection), dirtyTabCount }
}

export function ApiClientView(props: ApiClientViewProps): ReactElement {
  const api = useHostApi()
  const collections = useCollections()
  // WP5 契约：视图层创建 clipboard 实例，与树（props）和删除流（Cut 源级联清空）共享。
  const treeClipboard = useTreeClipboard({ runMutation: collections.runMutation })
  const environments = useEnvironments()
  const execute = useExecute()

  const [pane, setPane] = useState<PaneView>('main')
  const [tabs, setTabs] = useState<RequestTab[]>([])
  const [activeKey, setActiveKey] = useState<string | undefined>()
  const [editorTab, setEditorTab] = useState<EditorTab>('params')
  const [activeEnvironmentId, setActiveEnvironmentId] = useState<string | undefined>()
  const [importReport, setImportReport] = useState<ImportReport | undefined>()
  const [saveModalTab, setSaveModalTab] = useState<RequestTab | undefined>()
  /** 树删除确认（§7.1–§7.3）：目标节点快照 + Host DELETE pending。 */
  const [deleteTarget, setDeleteTarget] = useState<TreeDeleteTarget | undefined>()
  const [deletePending, setDeletePending] = useState(false)
  /** dirty tab 关闭确认（§7.5）：待关闭 tab key。 */
  const [closingTabKey, setClosingTabKey] = useState<string | undefined>()
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  /** API Client 根容器（右键菜单定位边界，CollectionTree §6.3）。 */
  const apiClientRootRef = useRef<HTMLDivElement | null>(null)
  /** ResizableCollectionPane 命令柄（打开 Request 成功路径 → drawer 自动关闭，UX §5）。 */
  const paneRef = useRef<ResizableCollectionPaneHandle | null>(null)

  // 初始加载 profile settings（activeEnvironmentId 持久化选择状态）。
  useEffect(() => {
    api
      .get<PluginSettings>('/settings')
      .then((settings) => {
        const id = settings.activeEnvironmentId
        setActiveEnvironmentId(id === undefined || id === '' ? undefined : id)
      })
      .catch(() => {
        // settings 读取失败不阻断主视图（toast 由 hooks 层统一报）。
      })
  }, [api])

  const activeTab = tabs.find((tab) => tab.key === activeKey)
  /** 当前激活环境（树的安全拷贝上下文 + Headers/Params plan preview 解析上下文）。 */
  const activeEnvironment = environments.environments.find((environment) => environment.id === activeEnvironmentId)
  /** 激活草稿所属 Collection（plan preview 的 inherit auth 链 + collection 变量上下文）。 */
  const activeCollection =
    activeTab === undefined || activeTab.draft.collectionId === ''
      ? undefined
      : collections.collections.find((item) => item.id === activeTab.draft.collectionId)

  // 最新 tabs/activeKey 的渲染期镜像（与 ResizableCollectionPane 的 envRef 同款模式）：
  // 删除/关闭的异步续体在 await 之后读取，避免陈旧闭包算错 tab selection。
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const activeKeyRef = useRef(activeKey)
  activeKeyRef.current = activeKey

  const updateTab = useCallback((key: string, updater: (tab: RequestTab) => RequestTab): void => {
    setTabs((prev) => prev.map((tab) => (tab.key === key ? updater(tab) : tab)))
  }, [])

  /** tab 移除统一出口：removeTabsAndSelectNext 纯函数（§7.4 左邻规则），此处不重实现。 */
  const applyTabRemoval = useCallback((removedKeys: string[]): void => {
    const selection = removeTabsAndSelectNext(tabsRef.current, activeKeyRef.current, removedKeys)
    setTabs(selection.tabs)
    setActiveKey(selection.activeKey)
  }, [])

  const openRequest = useCallback(
    (request: ApiRequest): void => {
      setPane('main')
      // R-07（GPT 裁决 h，本轮最小修复；完整 tab identity 重构留 P1）：查重按
      // key∨requestId 双匹配——保存成功的草稿 tab key 仍为 draft-N、requestId 指向
      // 同一 Host 记录；从树再打开必须激活原 tab（其真实 key），绝不产生第二个 tab。
      const existing = tabsRef.current.find((tab) => tab.key === request.id || tab.requestId === request.id)
      // 规范形落库（base-only url + params 承载 query）的请求在 URL bar 还原完整
      // 显示（paramsToUrl 与 collapseMirroredQuery 互逆，round-trip 幂等）；
      // url 自带 query 的数据（导入/手写合并语义）原样展示。
      const displayUrl =
        request.params.length > 0 && urlToParams(request.url).length === 0 ? paramsToUrl(request.url, request.params) : request.url
      setTabs((prev) => {
        // 函数式守卫防双击重复（同帧竞态下 tabsRef 可能滞后于 prev）；命中既有 tab
        // （含 draft-key 形态）时不覆盖其草稿——tab 才是编辑器权威状态。
        if (prev.some((tab) => tab.key === request.id || tab.requestId === request.id)) return prev
        return [...prev, newTab({ ...request, url: displayUrl, params: [...request.params], headers: [...request.headers] }, request.id)]
      })
      setActiveKey(existing !== undefined ? existing.key : request.id)
      // UX §5 关闭条件：打开 Request → hidden 态 drawer 自动关闭（docked 态无副作用）。
      paneRef.current?.onRequestOpened()
    },
    [],
  )

  const openNewRequest = useCallback((collectionId?: string, folderId?: string): void => {
    setPane('main')
    const tab = newTab(blankDraft(collectionId, folderId))
    setTabs((prev) => [...prev, tab])
    setActiveKey(tab.key)
    // 树「新建 Request」（drawer 内入口）同样属于「打开 Request」成功路径。
    paneRef.current?.onRequestOpened()
  }, [])

  // ---- URL ↔ Params 双向同步（core request/build 互逆纯函数）----
  // 同步不变量：url.query ≡ serializeParams(enabled params)（表格是 query 的结构化镜像）。
  // 因此执行/落库前必须经 collapseMirroredQuery 剥离 URL 自带 query（幂等化），否则
  // resolveRequest 的 buildUrl 合并会把同一 key 复制成双份（sweep 遗留 #3 的 `?x=1&x=1`）；
  // 非镜像数据（手写 url query + 独立 params，TC-C-04 合并语义）不受影响。
  const handleUrlChange = (tab: RequestTab, url: string): void => {
    updateTab(tab.key, (current) => {
      const oldPairs = serializeParams(urlToParams(current.draft.url))
      const newPairs = serializeParams(urlToParams(url))
      // query 未变（只编辑了 base/hash）：保留表格里的启停/描述行。
      const params = oldPairs === newPairs ? current.draft.params : urlToParams(url)
      return { ...current, draft: { ...current.draft, url, params }, dirty: true }
    })
  }

  const handleParamsChange = (tab: RequestTab, params: ApiRequest['params']): void => {
    updateTab(tab.key, (current) => {
      const url = paramsToUrl(current.draft.url, params)
      return { ...current, draft: { ...current.draft, url, params }, dirty: true }
    })
  }

  // ---- Send ----
  const send = async (tab: RequestTab): Promise<void> => {
    if (tab.draft.url.trim() === '') {
      toast.error('URL 为空')
      return
    }
    // Clean saved tabs execute by requestId so the history entry carries the
    // requestId chain (§10 「重新执行」经 requestId + SecretRef 链；dirty drafts
    // keep executing the in-editor projection).
    // §4.9：stale 只禁 mutation（Save/树），Send 保留。
    const response = await execute.execute({
      ...(tab.requestId !== undefined && !tab.dirty && !tab.authDirty
        ? { requestId: tab.requestId }
        : { request: { ...tab.draft, url: collapseMirroredQuery(tab.draft.url, tab.draft.params) } }),
      ...(activeEnvironmentId !== undefined ? { environment: activeEnvironmentId } : {}),
    })
    if (response !== undefined) {
      updateTab(tab.key, (current) => ({
        ...current,
        response: response.result,
        requestEcho: response.requestEcho,
        responseEcho: response.responseEcho,
        historyId: response.historyId,
      }))
    }
  }

  // ---- 交给 Agent（WP7 §5.3）：build Safe context → §14.4 确认弹窗 → session-bridge ----
  const [agentConfirm, setAgentConfirm] = useState<{ tabKey: string; includeResponseBody: boolean; sending: boolean } | undefined>()

  const buildAgentInput = useCallback(
    (tab: RequestTab): BuildSafeApiDebugContextInput => {
      const collection =
        tab.draft.collectionId !== '' ? collections.collections.find((item) => item.id === tab.draft.collectionId) : undefined
      const environmentName =
        activeEnvironmentId === undefined
          ? undefined
          : environments.environments.find((env) => env.id === activeEnvironmentId)?.name
      return {
        requestName: tab.draft.name,
        draft: {
          method: tab.draft.method,
          url: tab.draft.url,
          headers: tab.draft.headers,
          body: tab.draft.body,
          auth: tab.draft.auth,
        },
        ...(tab.requestEcho !== undefined ? { requestEcho: tab.requestEcho } : {}),
        ...(tab.responseEcho !== undefined ? { responseEcho: tab.responseEcho } : {}),
        ...(tab.response !== undefined ? { response: tab.response } : {}),
        ...(collection !== undefined
          ? { collection: { id: collection.id, name: collection.name, requestCount: countCollectionRequests(collection) } }
          : {}),
        ...(environmentName !== undefined ? { environmentName } : {}),
        ...(tab.historyId !== undefined && tab.response !== undefined
          ? { execution: { historyId: tab.historyId, durationMs: tab.response.durationMs, source: 'human' as const } }
          : {}),
      }
    },
    [collections.collections, environments.environments, activeEnvironmentId],
  )

  const agentTab = agentConfirm === undefined ? undefined : tabs.find((tab) => tab.key === agentConfirm.tabKey)
  // 勾选「包含 response body」触发重建：弹窗 ✓/✗ 清单随勾选实时翻转（数据源 = redactionSummary）。
  const agentContext =
    agentTab === undefined || agentConfirm === undefined
      ? undefined
      : buildSafeApiDebugContext({ ...buildAgentInput(agentTab), includeResponseBody: agentConfirm.includeResponseBody })

  const openAgentConfirm = (tab: RequestTab): void => {
    if (props.onSendToAgent === undefined) {
      toast.error('交给 Agent 不可用：session bridge 未装配')
      return
    }
    setAgentConfirm({ tabKey: tab.key, includeResponseBody: false, sending: false })
  }

  const confirmSendToAgent = async (): Promise<void> => {
    if (agentConfirm === undefined || agentContext === undefined || props.onSendToAgent === undefined) return
    setAgentConfirm({ ...agentConfirm, sending: true })
    const sendToAgent = props.onSendToAgent
    const context = agentContext
    let result: SendToAgentOutcome
    try {
      result = await sendToAgent(context)
    } catch (error) {
      result = { ok: false, stage: 'unexpected', detail: error instanceof Error ? error.message : String(error) }
    }
    setAgentConfirm(undefined)
    if (result.ok) {
      toast.info('已预填到新会话，请确认发送')
    } else {
      toast.error(`交给 Agent 未完成（${result.stage}）：${result.detail}`)
    }
  }

  // ---- Save（§4.9：stale 时按钮禁用；send 不受限）----
  const save = (tab: RequestTab): void => {
    if (tab.requestId !== undefined) {
      const patch: Record<string, unknown> = {
        name: tab.draft.name,
        method: tab.draft.method,
        // 落库为规范形（base+hash + params 单一承载 query），requestId 重放/工具
        // 执行路径与 draft 投影路径得到同一份 URL（同步幂等，sweep 遗留 #3）。
        url: collapseMirroredQuery(tab.draft.url, tab.draft.params),
        params: tab.draft.params,
        headers: tab.draft.headers,
        body: tab.draft.body,
        // §4.1.1：suppression 清单随 Save 持久化（Host PATCH 已做 §3.3 校验+规范化）。
        ...(tab.draft.suppressedGeneratedHeaders !== undefined ? { suppressedGeneratedHeaders: tab.draft.suppressedGeneratedHeaders } : {}),
      }
      if (tab.authDirty) patch.auth = tab.draft.auth
      void collections.patchRequest(tab.requestId, patch).then((updated) => {
        if (updated !== undefined) {
          updateTab(tab.key, (current) => ({ ...current, dirty: false, authDirty: false }))
          toast.info('请求已保存')
        }
      })
      return
    }
    setSaveModalTab(tab)
  }

  // ---- Import（Postman v2.1，走 §5.1 端点 25）----
  const onImportFile = async (file: File): Promise<void> => {
    try {
      const text = await file.text()
      const parsed: unknown = JSON.parse(text)
      const report = await api.post<ImportReport>('/import/postman', { collection: parsed, name: file.name.replace(/\.json$/i, '') })
      setImportReport(report)
      void collections.refresh()
    } catch (error) {
      toast.error(`导入失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // ---- 树 handlers（WP5 新契约：树已内化 create/rename/duplicate/reorder/clipboard 动作）----
  const treeHandlers: CollectionTreeHandlers = {
    onOpenRequest: openRequest,
    onNewRequest: (collectionId, folderId) => openNewRequest(collectionId, folderId),
    onRequestDelete: (target) => setDeleteTarget(target),
    // 树行内重命名成功 → 同步已打开 tab 的草稿名（Host 已持久化，不置 dirty）。
    // R3 同类匹配：保存成功的草稿 tab key 仍为 draft-N，须按 key∨requestId 双匹配。
    onRequestRenamed: (updated) => {
      setTabs((prev) =>
        prev.map((tab) =>
          tab.key === updated.id || tab.requestId === updated.id ? { ...tab, draft: { ...tab.draft, name: updated.name } } : tab,
        ),
      )
    },
  }

  // ---- 树删除流（§7.1 统计 → §7.2 dirty 警示 → §7.3 Host 成功后才关 tab）----

  /** 确认框统计：递归数字 = core 权威纯函数；dirty 数 = 受影响 tab 快照（§7.1）。 */
  const deleteStats = deleteTarget === undefined ? undefined : computeDeleteStats(deleteTarget, tabs)

  const confirmDelete = async (): Promise<void> => {
    const target = deleteTarget
    if (target === undefined || deletePending) return
    // 统计/清理共用同一份快照：affected request ids 必须在 mutation 之前取
    //（删除成功后投影即刷新，目标节点引用会消失）。
    const affectedIds = collectSubtreeRequestIds(target)
    setDeletePending(true)
    let outcome: MutationOutcome = { committed: false, refreshed: false }
    try {
      // 版本参数 = 打开确认框时刻的投影 updatedAt（§4.3 乐观锁；并发修改 → Host 409）。
      if (target.kind === 'request') outcome = await collections.deleteRequest(target.request.id, target.collection.updatedAt)
      else if (target.kind === 'folder') outcome = await collections.deleteFolder(target.collection.id, target.folder.id, target.collection.updatedAt)
      else outcome = await collections.deleteCollection(target.collection.id, target.collection.updatedAt)
    } finally {
      setDeletePending(false)
      setDeleteTarget(undefined)
    }
    // §7.3：committed=false（含 409）→ tree/tabs/activeKey 全不动；错误 toast 已由 hook 发出。
    if (!outcome.committed) return
    // Host 成功后才移除 affected tabs（§7.4 左邻规则，纯函数不重实现）。
    // R3：被删 request ids 经 key∨requestId 双匹配映射回 tab.key——保存成功的
    // draft-key tab（key=draft-N，仅 requestId 指向 Host 记录）不再幽灵存活。
    const removedKeys = tabsRef.current.filter((tab) => tabAffectedByDeletion(tab, affectedIds)).map((tab) => tab.key)
    applyTabRemoval(removedKeys)
    // §0.3：本 Client 删除了 Cut 源（含 Folder/Collection 级联）→ 立即清空本地剪贴板 token。
    // 通知面 = request ids（与 Cut 源 requestId 比对），不是 tab keys。
    treeClipboard.notifyLocalRequestsDeleted(affectedIds)
  }

  // ---- dirty tab 关闭（§7.5）：clean 立即关；dirty 先确认（P0 无自动保存）----
  const requestCloseTab = (key: string): void => {
    const tab = tabs.find((item) => item.key === key)
    if (tab === undefined) return
    if (!tab.dirty) {
      applyTabRemoval([key])
      return
    }
    setClosingTabKey(key)
  }

  const closingTab = closingTabKey === undefined ? undefined : tabs.find((tab) => tab.key === closingTabKey)

  return (
    <div
      ref={apiClientRootRef}
      data-dsh-api-client="api-client-view"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: colors.bg,
        color: colors.text,
        fontFamily: font.family,
        fontSize: font.size,
        overflow: 'hidden',
      }}
    >
      {/* 顶栏（§4）：历史 / 导入 / 环境 + 环境切换 + 交给 Agent + 关闭 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: `1px solid ${colors.border}` }}>
        <strong style={{ fontSize: 14 }}>API Client</strong>
        <span style={{ flex: 1 }} />
        <EnvironmentSelector environments={environments.environments} activeEnvironmentId={activeEnvironmentId} onSelected={setActiveEnvironmentId} />
        <button type="button" style={topButtonStyle} onClick={() => setPane('history')}>
          历史
        </button>
        <button type="button" style={topButtonStyle} onClick={() => fileInputRef.current?.click()}>
          导入
        </button>
        <button type="button" style={topButtonStyle} onClick={() => setPane('environment')}>
          环境
        </button>
        <button
          type="button"
          title="交给 Agent：Safe context → 出域确认 → 新 Session 预填（WP7 §5.3）"
          style={topButtonStyle}
          onClick={() => {
            if (activeTab === undefined) {
              toast.error('先打开一个请求再交给 Agent')
              return
            }
            openAgentConfirm(activeTab)
          }}
        >
          交给 Agent
        </button>
        {props.onClose !== undefined && (
          <button type="button" style={topButtonStyle} onClick={props.onClose} title="关闭面板（回到对话）">
            ✕
          </button>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          style={{ display: 'none' }}
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file !== undefined) void onImportFile(file)
          }}
        />
      </div>

      {pane === 'history' && <HistoryView onBack={() => setPane('main')} activeEnvironmentId={activeEnvironmentId} />}
      {pane === 'environment' && <EnvironmentView onBack={() => setPane('main')} />}
      {pane === 'main' && (
        /* WP4 契约：pane 根容器宽度 = viewport 参照系（外层不再包滚动/填充容器）；
           树为 children、编辑器整列为 main——resize/三态/drawer 切换不重挂载（AC-34）。 */
        <ResizableCollectionPane
          ref={paneRef}
          main={
            <>
              <RequestTabs
                tabs={tabs.map((tab) => ({ key: tab.key, name: tab.draft.name, method: tab.draft.method, dirty: tab.dirty }))}
                activeKey={activeKey}
                onSelect={setActiveKey}
                onClose={requestCloseTab}
                onNew={() => openNewRequest()}
              />
              {activeTab === undefined && (
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: colors.textSecondary }}>
                  从左侧请求树打开一个请求，或新建一个标签页。
                </div>
              )}
              {activeTab !== undefined && (
                <>
                  <div style={{ display: 'flex', gap: 6, padding: '8px 10px', alignItems: 'stretch' }}>
                    <MethodSelector
                      value={activeTab.draft.method}
                      onChange={(method) => updateTab(activeTab.key, (current) => ({ ...current, draft: { ...current.draft, method }, dirty: true }))}
                    />
                    <UrlBar
                      value={activeTab.draft.url}
                      onChange={(url) => handleUrlChange(activeTab, url)}
                      onSend={() => void send(activeTab)}
                      onSave={() => save(activeTab)}
                      sending={execute.executing}
                      saveDisabled={collections.stale || (!activeTab.dirty && activeTab.requestId !== undefined)}
                    />
                  </div>
                  <div style={{ display: 'flex', gap: 2, padding: '0 10px', borderBottom: `1px solid ${colors.border}` }}>
                    {EDITOR_TABS.map((tab) => (
                      <button
                        key={tab.value}
                        type="button"
                        onClick={() => setEditorTab(tab.value)}
                        style={{
                          background: 'transparent',
                          border: 'none',
                          borderBottom: editorTab === tab.value ? `2px solid ${colors.brand}` : '2px solid transparent',
                          color: editorTab === tab.value ? colors.text : colors.textSecondary,
                          cursor: 'pointer',
                          fontSize: font.size,
                          padding: '4px 8px',
                        }}
                      >
                        {tab.label}
                      </button>
                    ))}
                    <span style={{ flex: 1 }} />
                    <input
                      value={activeTab.draft.name}
                      onChange={(event) => updateTab(activeTab.key, (current) => ({ ...current, draft: { ...current.draft, name: event.target.value }, dirty: true }))}
                      title="请求名称"
                      style={{
                        width: 200,
                        background: 'transparent',
                        border: 'none',
                        borderBottom: `1px solid ${colors.border}`,
                        color: colors.text,
                        font: 'inherit',
                        fontSize: font.size,
                        padding: '2px 4px',
                        outline: 'none',
                        textAlign: 'right',
                      }}
                    />
                  </div>
                  <div style={{ flex: 1, overflow: 'auto', padding: '10px 12px', minHeight: 0 }}>
                    {editorTab === 'params' && (
                      <ParamsEditor
                        draft={activeTab.draft}
                        environment={activeEnvironment}
                        collection={activeCollection}
                        onRowsChange={(rows) => handleParamsChange(activeTab, rows)}
                        onNavigate={setEditorTab}
                      />
                    )}
                    {editorTab === 'headers' && (
                      <HeadersEditor
                        draft={activeTab.draft}
                        environment={activeEnvironment}
                        collection={activeCollection}
                        onRowsChange={(rows) => updateTab(activeTab.key, (current) => ({ ...current, draft: { ...current.draft, headers: rows }, dirty: true }))}
                        onSuppressedChange={(next) =>
                          updateTab(activeTab.key, (current) => ({
                            ...current,
                            draft: { ...current.draft, suppressedGeneratedHeaders: next },
                            dirty: true,
                          }))
                        }
                        onNavigate={setEditorTab}
                      />
                    )}
                    {editorTab === 'auth' && (
                      <AuthEditor
                        value={activeTab.draft.auth}
                        onChange={(auth) => updateTab(activeTab.key, (current) => ({ ...current, draft: { ...current.draft, auth }, dirty: true, authDirty: true }))}
                      />
                    )}
                    {editorTab === 'body' && (
                      <BodyEditor
                        value={activeTab.draft.body}
                        onChange={(body) => updateTab(activeTab.key, (current) => ({ ...current, draft: { ...current.draft, body }, dirty: true }))}
                      />
                    )}
                    {editorTab === 'scripts' && <ScriptsPanel scripts={activeTab.draft.scripts} />}
                  </div>
                  <div style={{ flex: '0 0 38%', minHeight: 120, display: 'flex', flexDirection: 'column' }}>
                    <ResponseViewer
                      result={activeTab.response}
                      executing={execute.executing}
                      scripts={activeTab.draft.scripts}
                      onSendToAgent={() => openAgentConfirm(activeTab)}
                    />
                  </div>
                </>
              )}
            </>
          }
        >
          <CollectionTree
            collections={collections}
            clipboard={treeClipboard}
            selectedRequestId={activeTab?.requestId}
            environment={activeEnvironment}
            menuBoundaryRef={apiClientRootRef}
            handlers={treeHandlers}
          />
        </ResizableCollectionPane>
      )}

      {/* 树删除确认（§7.1/§7.2；确认按钮 pending 期间 Esc/X/遮罩不再取消——删除已在途） */}
      {deleteTarget !== undefined && deleteStats !== undefined && (
        <TreeDeleteConfirmDialog
          kind={deleteTarget.kind}
          name={deleteStats.name}
          descendantFolderCount={deleteStats.descendantFolderCount}
          requestCount={deleteStats.requestCount}
          dirtyTabCount={deleteStats.dirtyTabCount}
          pending={deletePending}
          onCancel={() => {
            if (!deletePending) setDeleteTarget(undefined)
          }}
          onConfirm={() => void confirmDelete()}
        />
      )}
      {/* dirty tab 关闭确认（§7.5；P0 不提供自动保存出口） */}
      {closingTab !== undefined && (
        <DirtyTabCloseDialog
          name={closingTab.draft.name}
          onCancel={() => setClosingTabKey(undefined)}
          onConfirm={() => {
            applyTabRemoval([closingTab.key])
            setClosingTabKey(undefined)
          }}
        />
      )}
      {saveModalTab !== undefined && (
        <SaveRequestModal
          tab={saveModalTab}
          collections={collections.collections}
          // R-05：提交走父级唯一 useCollections 状态机（mutation/refresh/stale 统一管理）。
          onSubmit={(collectionId, payload) => collections.saveRequest(collectionId, payload)}
          onCancel={() => setSaveModalTab(undefined)}
          onSaved={(request) => {
            updateTab(saveModalTab.key, (current) => ({
              ...current,
              requestId: request.id,
              draft: { ...current.draft, id: request.id, collectionId: request.collectionId },
              dirty: false,
              authDirty: false,
            }))
            setSaveModalTab(undefined)
            // 树刷新已由父级 runMutation 在 POST 成功后完成（§4.9 单一状态机），
            // 此处不再重复 GET；刷新失败时 stale 同样落在父级（横幅+禁 mutation）。
            toast.info('请求已保存')
          }}
        />
      )}
      {importReport !== undefined && (
        <Modal title="Postman 导入 — 迁移报告" width={720} onClose={() => setImportReport(undefined)}>
          <ImportReportView report={importReport} onClose={() => setImportReport(undefined)} />
        </Modal>
      )}
      {agentConfirm !== undefined && agentTab !== undefined && agentContext !== undefined && (
        <ConfirmSendToAgent
          context={agentContext}
          hasResponseBody={
            agentTab.responseEcho !== undefined
              ? (agentTab.responseEcho.bodyPreview ?? '') !== ''
              : (agentTab.response?.bodyText ?? '') !== ''
          }
          includeResponseBody={agentConfirm.includeResponseBody}
          sending={agentConfirm.sending}
          onToggleResponseBody={(include) =>
            setAgentConfirm((current) => (current === undefined ? current : { ...current, includeResponseBody: include }))
          }
          onCancel={() => setAgentConfirm(undefined)}
          onConfirm={() => void confirmSendToAgent()}
        />
      )}
      <ToastHost />
    </div>
  )
}

const topButtonStyle: CSSProperties = {
  background: 'transparent',
  border: `1px solid ${colors.borderStrong}`,
  borderRadius: 4,
  color: colors.text,
  cursor: 'pointer',
  fontSize: font.size,
  padding: '3px 10px',
}

/** SaveRequestModal 提交 payload（= useCollections.saveRequest 的 request 入参形态，§5.1 端点 9）。 */
type SaveRequestPayload = Omit<ApiRequest, 'id' | 'createdAt' | 'updatedAt' | 'collectionId'> & { folderId?: string }

/** Save 到 Collection（含选 folder，§6/TC-UI-13）：草稿携带的 folderId 作为文件夹默认值。 */
function SaveRequestModal(props: {
  tab: RequestTab
  collections: Collection[]
  /**
   * R-05（GPT review P0-blocker）：提交经父级注入的 callback 走**父级唯一**
   * useCollections 状态机（runMutation 统一管 mutation/refresh/stale）。本组件
   * 绝不自建第二个 hook 实例——「POST 成功 + 刷新失败」的 stale 若落在临时实例上，
   * Modal 卸载即丢，主界面会在旧投影上继续放行 mutation（违反 §4.9）。
   */
  onSubmit: (collectionId: string, payload: SaveRequestPayload) => Promise<ApiRequest | undefined>
  onCancel: () => void
  onSaved: (request: ApiRequest) => void
}): ReactElement {
  const [collectionId, setCollectionId] = useState(props.tab.draft.collectionId !== '' ? props.tab.draft.collectionId : (props.collections[0]?.id ?? ''))
  // 树「新建 Request」入口注入的默认文件夹（onNewRequest → blankDraft.folderId）。
  const [folderId, setFolderId] = useState(props.tab.draft.folderId ?? '')
  const collection = props.collections.find((item) => item.id === collectionId)
  const folderOptions: FolderOption[] = []
  if (collection !== undefined) flattenFolders(collection.folders, '', folderOptions)

  const submit = async (): Promise<void> => {
    if (collectionId === '') {
      toast.error('请先选择一个集合')
      return
    }
    const draft = props.tab.draft
    const saved = await props.onSubmit(collectionId, {
      name: draft.name,
      method: draft.method,
      // 规范形落库（同步幂等，见 save() 注）。
      url: collapseMirroredQuery(draft.url, draft.params),
      params: draft.params,
      headers: draft.headers,
      auth: draft.auth,
      body: draft.body,
      ...(draft.scripts !== undefined ? { scripts: draft.scripts } : {}),
      // §4.1.1：草稿携带的 suppression 清单随首次保存落库（Host 默认 []）。
      ...(draft.suppressedGeneratedHeaders !== undefined ? { suppressedGeneratedHeaders: draft.suppressedGeneratedHeaders } : {}),
      ...(folderId !== '' ? { folderId } : {}),
    })
    if (saved !== undefined) props.onSaved(saved)
  }

  return (
    <Modal title="保存请求到集合" onClose={props.onCancel}>
      {props.collections.length === 0 && <div style={{ color: colors.textSecondary }}>暂无集合 —— 请先在左侧请求树中新建。</div>}
      <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr', gap: 8, alignItems: 'center' }}>
        <span style={{ color: colors.textSecondary }}>名称</span>
        <input value={props.tab.draft.name} style={modalInputStyle} readOnly title="名称在编辑器顶栏改名" />
        <span style={{ color: colors.textSecondary }}>集合</span>
        <select
          value={collectionId}
          onChange={(event) => {
            // 切换集合后原 folderId 不再合法 → 复位到（顶层）。
            setCollectionId(event.target.value)
            setFolderId('')
          }}
          style={modalInputStyle}
        >
          {props.collections.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        <span style={{ color: colors.textSecondary }}>文件夹</span>
        <select value={folderId} onChange={(event) => setFolderId(event.target.value)} style={modalInputStyle}>
          <option value="">（顶层）</option>
          {folderOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <div style={{ marginTop: 14, textAlign: 'right' }}>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={props.collections.length === 0}
          style={{
            background: colors.brand,
            color: colors.brandText,
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
            fontSize: font.size,
            padding: '4px 16px',
            opacity: props.collections.length === 0 ? 0.5 : 1,
          }}
        >
          保存
        </button>
      </div>
    </Modal>
  )
}

const modalInputStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  background: colors.bgLayer1,
  border: `1px solid ${colors.border}`,
  borderRadius: 4,
  color: colors.text,
  font: 'inherit',
  fontSize: font.size,
  padding: '4px 8px',
  outline: 'none',
}
