/**
 * ApiClientView（§4 主页面布局）：
 * 顶栏（History / Import / Environment + 环境切换）+ CollectionTree +
 * RequestTabs + MethodSelector/UrlBar/Send/Save + Params/Headers/Auth/Body/Scripts
 * 编辑器 + ResponseViewer。
 *
 * 分层纪律（TC-A-03）：本文件不 import 任何 DSH 包；数据全部经 hooks 走
 * Host API（Host 为权威状态源，client 只做投影——D16）；URL↔Params 双向同步、
 * 参数编码等复用 core request/build 纯函数。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import type { BuildSafeApiDebugContextInput } from '../../../packages/core/src/security/redactor.ts'
import { buildSafeApiDebugContext } from '../../../packages/core/src/security/redactor.ts'
import { useCollections } from '../hooks/useCollections.ts'
import { useEnvironments } from '../hooks/useEnvironments.ts'
import { useExecute } from '../hooks/useExecute.ts'
import { useHostApi } from '../hooks/useHostApi.ts'
import { CollectionTree } from '../components/collection/CollectionTree.tsx'
import { RequestTabs } from '../components/request/RequestTabs.tsx'
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

function blankDraft(collectionId?: string): ApiRequest {
  return {
    id: '',
    name: 'Untitled Request',
    method: 'GET',
    url: '',
    params: [],
    headers: [],
    auth: { type: 'none' },
    body: { type: 'none' },
    collectionId: collectionId ?? '',
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

/** CollectionSummary.requestCount（§4.1）：顶层 + 任意嵌套 folder 的请求总数。 */
function countCollectionRequests(collection: Collection): number {
  let count = collection.requests.length
  const walk = (folders: Folder[]): void => {
    for (const folder of folders) {
      count += folder.requests.length
      walk(folder.folders)
    }
  }
  walk(collection.folders)
  return count
}

export function ApiClientView(props: ApiClientViewProps): ReactElement {
  const api = useHostApi()
  const collections = useCollections()
  const environments = useEnvironments()
  const execute = useExecute()

  const [pane, setPane] = useState<PaneView>('main')
  const [tabs, setTabs] = useState<RequestTab[]>([])
  const [activeKey, setActiveKey] = useState<string | undefined>()
  const [editorTab, setEditorTab] = useState<EditorTab>('params')
  const [activeEnvironmentId, setActiveEnvironmentId] = useState<string | undefined>()
  const [importReport, setImportReport] = useState<ImportReport | undefined>()
  const [saveModalTab, setSaveModalTab] = useState<RequestTab | undefined>()
  const fileInputRef = useRef<HTMLInputElement | null>(null)

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

  const updateTab = useCallback((key: string, updater: (tab: RequestTab) => RequestTab): void => {
    setTabs((prev) => prev.map((tab) => (tab.key === key ? updater(tab) : tab)))
  }, [])

  const openRequest = useCallback(
    (request: ApiRequest): void => {
      setPane('main')
      // 规范形落库（base-only url + params 承载 query）的请求在 URL bar 还原完整
      // 显示（paramsToUrl 与 collapseMirroredQuery 互逆，round-trip 幂等）；
      // url 自带 query 的数据（导入/手写合并语义）原样展示。
      const displayUrl =
        request.params.length > 0 && urlToParams(request.url).length === 0 ? paramsToUrl(request.url, request.params) : request.url
      setTabs((prev) => {
        if (prev.some((tab) => tab.key === request.id)) return prev
        return [...prev, newTab({ ...request, url: displayUrl, params: [...request.params], headers: [...request.headers] }, request.id)]
      })
      setActiveKey(request.id)
    },
    [],
  )

  const openNewRequest = useCallback((collectionId?: string): void => {
    setPane('main')
    const tab = newTab(blankDraft(collectionId))
    setTabs((prev) => [...prev, tab])
    setActiveKey(tab.key)
  }, [])

  const closeTab = useCallback(
    (key: string): void => {
      setTabs((prev) => prev.filter((tab) => tab.key !== key))
      if (activeKey === key) {
        setActiveKey((prev) => {
          const remaining = tabs.filter((tab) => tab.key !== key)
          return remaining.length > 0 ? remaining[remaining.length - 1]!.key : prev === key ? undefined : prev
        })
      }
    },
    [activeKey, tabs],
  )

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
      toast.error('URL is empty')
      return
    }
    // Clean saved tabs execute by requestId so the history entry carries the
    // requestId chain (§10 「重新执行」经 requestId + SecretRef 链；dirty drafts
    // keep executing the in-editor projection).
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

  // ---- Save ----
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
      }
      if (tab.authDirty) patch.auth = tab.draft.auth
      void collections.patchRequest(tab.requestId, patch).then((updated) => {
        if (updated !== undefined) {
          updateTab(tab.key, (current) => ({ ...current, dirty: false, authDirty: false }))
          toast.info('Request saved')
        }
      })
      return
    }
    setSaveModalTab(tab)
  }

  const impliedContentType = (tab: RequestTab): string | undefined => {
    const body = tab.draft.body
    switch (body.type) {
      case 'json':
        return 'application/json'
      case 'raw':
        return 'text/plain'
      case 'urlencoded':
        return 'application/x-www-form-urlencoded'
      case 'form-data':
        return 'multipart/form-data'
      default:
        return undefined
    }
  }

  // ---- Import（Postman v2.1，走 §5.1 端点 25）----
  const onImportFile = async (file: File): Promise<void> => {
    try {
      const text = await file.text()
      const parsed: unknown = JSON.parse(text)
      const report = await api.post<ImportReport>('/import/postman', { collection: parsed, name: file.name.replace(/\.json$/i, '') })
      setImportReport(report)
      collections.refresh()
    } catch (error) {
      toast.error(`import failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const treeHandlers = useMemo(
    () => ({
      onOpenRequest: openRequest,
      onNewCollection: () => {
        const name = globalThis.prompt?.('Collection name:')
        if (name !== undefined && name !== null && name.trim() !== '') void collections.createCollection(name.trim())
      },
      onNewRequest: (collectionId: string) => openNewRequest(collectionId),
      onRenameCollection: (collection: { id: string; name: string }) => {
        const name = globalThis.prompt?.('Rename collection:', collection.name)
        if (name !== undefined && name !== null && name.trim() !== '') void collections.renameCollection(collection.id, name.trim())
      },
      onDeleteCollection: (collection: { id: string; name: string }) => {
        if (globalThis.confirm?.(`Delete collection "${collection.name}"?`) === true) void collections.deleteCollection(collection.id)
      },
      onDuplicateCollection: (collection: { id: string }) => void collections.duplicateCollection(collection.id),
      onRenameRequest: (request: ApiRequest) => {
        const name = globalThis.prompt?.('Rename request:', request.name)
        if (name !== undefined && name !== null && name.trim() !== '') {
          void collections.patchRequest(request.id, { name: name.trim() }).then((updated) => {
            if (updated !== undefined) updateTab(request.id, (current) => ({ ...current, draft: { ...current.draft, name: updated.name } }))
          })
        }
      },
      onDeleteRequest: (request: ApiRequest) => {
        if (globalThis.confirm?.(`Delete request "${request.name}"?`) === true) {
          void collections.deleteRequest(request.id)
          closeTab(request.id)
        }
      },
      onDuplicateRequest: (request: ApiRequest) => void collections.duplicateRequest(request.id),
      onReorderRequest: (collection: { id: string; requests: ApiRequest[] }, request: ApiRequest, direction: -1 | 1) => {
        const ids = collection.requests.map((item) => item.id)
        const index = ids.indexOf(request.id)
        const target = index + direction
        if (index < 0 || target < 0 || target >= ids.length) return
        ;[ids[index], ids[target]] = [ids[target]!, ids[index]!]
        void collections.reorderCollection(collection.id, ids)
      },
    }),
    [collections, openRequest, openNewRequest, closeTab, updateTab],
  )

  return (
    <div
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
      {/* 顶栏（§4）：History / Import / Environment + 环境切换 + 关闭 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: `1px solid ${colors.border}` }}>
        <strong style={{ fontSize: 14 }}>API Client</strong>
        <span style={{ flex: 1 }} />
        <EnvironmentSelector environments={environments.environments} activeEnvironmentId={activeEnvironmentId} onSelected={setActiveEnvironmentId} />
        <button type="button" style={topButtonStyle} onClick={() => setPane('history')}>
          History
        </button>
        <button type="button" style={topButtonStyle} onClick={() => fileInputRef.current?.click()}>
          Import
        </button>
        <button type="button" style={topButtonStyle} onClick={() => setPane('environment')}>
          Environment
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
          <button type="button" style={topButtonStyle} onClick={props.onClose} title="Close panel (yield to Conversation)">
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
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <div style={{ flex: '0 0 260px', borderRight: `1px solid ${colors.border}`, minHeight: 0 }}>
            <CollectionTree
              collections={collections.collections}
              loading={collections.loading}
              selectedRequestId={activeTab?.requestId}
              handlers={treeHandlers}
            />
          </div>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
            <RequestTabs
              tabs={tabs.map((tab) => ({ key: tab.key, name: tab.draft.name, method: tab.draft.method, dirty: tab.dirty }))}
              activeKey={activeKey}
              onSelect={setActiveKey}
              onClose={closeTab}
              onNew={() => openNewRequest()}
            />
            {activeTab === undefined && (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: colors.textSecondary }}>
                Open a request from the tree, or start a new tab.
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
                    saveDisabled={!activeTab.dirty && activeTab.requestId !== undefined}
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
                    title="Request name"
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
                  {editorTab === 'params' && <ParamsEditor rows={activeTab.draft.params} onChange={(rows) => handleParamsChange(activeTab, rows)} />}
                  {editorTab === 'headers' && (
                    <HeadersEditor
                      rows={activeTab.draft.headers}
                      onChange={(rows) => updateTab(activeTab.key, (current) => ({ ...current, draft: { ...current.draft, headers: rows }, dirty: true }))}
                      impliedContentType={impliedContentType(activeTab)}
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
          </div>
        </div>
      )}

      {saveModalTab !== undefined && (
        <SaveRequestModal
          tab={saveModalTab}
          collections={collections.collections}
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
            // Refresh the tree so the saved request appears without a page reload.
            collections.refresh()
            toast.info('Request saved')
          }}
        />
      )}
      {importReport !== undefined && (
        <Modal title="Postman Import — Migration Report" width={720} onClose={() => setImportReport(undefined)}>
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

/** Save 到 Collection（含选 folder，§6/TC-UI-13）。 */
function SaveRequestModal(props: {
  tab: RequestTab
  collections: ReturnType<typeof useCollections>['collections']
  onCancel: () => void
  onSaved: (request: ApiRequest) => void
}): ReactElement {
  const collections = useCollections()
  const [collectionId, setCollectionId] = useState(props.tab.draft.collectionId !== '' ? props.tab.draft.collectionId : (props.collections[0]?.id ?? ''))
  const [folderId, setFolderId] = useState('')
  const collection = props.collections.find((item) => item.id === collectionId)
  const folderOptions: FolderOption[] = []
  if (collection !== undefined) flattenFolders(collection.folders, '', folderOptions)

  const submit = async (): Promise<void> => {
    if (collectionId === '') {
      toast.error('Select a collection first')
      return
    }
    const draft = props.tab.draft
    const saved = await collections.saveRequest(collectionId, {
      name: draft.name,
      method: draft.method,
      // 规范形落库（同步幂等，见 save() 注）。
      url: collapseMirroredQuery(draft.url, draft.params),
      params: draft.params,
      headers: draft.headers,
      auth: draft.auth,
      body: draft.body,
      ...(draft.scripts !== undefined ? { scripts: draft.scripts } : {}),
      ...(folderId !== '' ? { folderId } : {}),
    })
    if (saved !== undefined) props.onSaved(saved)
  }

  return (
    <Modal title="Save request to collection" onClose={props.onCancel}>
      {props.collections.length === 0 && <div style={{ color: colors.textSecondary }}>No collections yet — create one from the tree first.</div>}
      <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr', gap: 8, alignItems: 'center' }}>
        <span style={{ color: colors.textSecondary }}>Name</span>
        <input value={props.tab.draft.name} style={modalInputStyle} readOnly title="名称在编辑器顶栏改名" />
        <span style={{ color: colors.textSecondary }}>Collection</span>
        <select value={collectionId} onChange={(event) => setCollectionId(event.target.value)} style={modalInputStyle}>
          {props.collections.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        <span style={{ color: colors.textSecondary }}>Folder</span>
        <select value={folderId} onChange={(event) => setFolderId(event.target.value)} style={modalInputStyle}>
          <option value="">(top level)</option>
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
          Save
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
