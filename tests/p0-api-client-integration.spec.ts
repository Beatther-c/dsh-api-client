/**
 * WP8：ApiClientView 最终集成 spec（P0 实施设计 §7 全部 / §8.1 条目 9–10 的
 * 集成半边 / §12 批次 4–5 / §13.3 / §4.9；UX §4.7、§9；AC-21/23/24/25/26/27/34/47）。
 *
 * 与 p0-tab-lifecycle.spec.ts（纯函数 + 对话框单元）互补：本文件渲染**完整
 * ApiClientView**（真实 useCollections/useTreeClipboard/CollectionTree/
 * ResizableCollectionPane/RequestTabs/对话框），只 mock：
 * - fetch + `window.__DSH_API_CLIENT_BOOTSTRAP__`（Host 权威状态源，路由表驱动）；
 * - Toast（记录文案断言，免模块级 items 跨用例污染）；
 * - HeadersEditor/ParamsEditor → 探针组件（断言 WP7 props 接线：draft/environment/
 *   collection 透传、onSuppressedChange 写回、onNavigate 切换——编辑器内部行为归
 *   p0-generated-items-ui.spec.ts）；
 * - ResizableCollectionPane → 薄包装（spy onRequestOpened 后委托真实组件，pane
 *   行为本体归 p0-resizable-pane.spec.ts）；
 * - useTreeClipboard → 薄包装（spy notifyLocalRequestsDeleted 后委托真实钩子）。
 * - ResizeObserver / navigator.clipboard：jsdom 补差。
 *
 * 覆盖：
 * 1. 删除统计与确认（AC-24/25）：Folder 菜单入口递归统计 + dirty 警示 + 「删除并
 *    放弃修改」；取消零变化；Delete 键路径取消默认焦点；确认后 DELETE 携带乐观锁
 *    版本、committed 才级联关闭子树全部 tabs（全删 → 空状态）+ notifyLocalRequestsDeleted；
 * 2. Host 409 拒绝（AC-21）：tree/tab/activeKey 零变化 + stale 横幅 + Host 逐字
 *    中文 toast + 不发 refresh GET；
 * 3. Host 成功后才关 tab（AC-23/26）：DELETE resolve 前 pending 忙碌态且 tabs 不动；
 *    resolve 后 affected tab 关闭 + active 左邻选择；
 * 4. Collection 删除：递归 Request 总数统计；只关闭该集合的 tabs，其他集合 tab 保留；
 * 5. dirty tab 单独关闭（AC-27）：clean 立即关；dirty 弹确认（取消默认焦点）、取消
 *    保留、确认关闭且绝不发 PATCH（P0 无自动保存）；
 * 6. WP7 接线：Params/Headers 探针收到 draft/environment/collection；
 *    onSuppressedChange 写回 draft.suppressedGeneratedHeaders 且置 dirty；Save 走
 *    PATCH → toast「请求已保存」；onNavigate 切换 editorTab（headers/params → auth）；
 * 7. stale 一致性（§4.9/AC-22）：committed + refresh 失败 → 「数据已保存，列表刷新
 *    失败」（绝无「回滚」）；草稿 tab Save 禁用、Send 保留（空 URL → 「URL 为空」）；
 *    「重新刷新」成功后 Save 恢复；
 * 8. pane 集成（WP4 契约/AC-34 结构面）：树渲染在 pane 内、编辑器列在 pane main 内、
 *    normal 三态；打开请求/新建请求各触发一次 onRequestOpened；
 * 9. 主界面 P0 文案中文化（AC-47）：顶栏/空态/新 tab 名/SaveRequestModal 关键中文串
 *    存在且对应英文句子文案不存在；
 * 10. R3 回归（浏览器验收缺陷，AC-23/24 语义泄漏）：草稿 tab 保存成功后 key 仍为
 *    draft-N（仅 requestId 指向 Host 记录）——Request/Folder 删除按 key∨requestId
 *    双匹配映射回 tab.key 后关闭（active 左邻规则）、dirty 统计计入确认框；
 *    树重命名成功后的草稿名同步同类双匹配。
 */
import { act, createElement } from 'react'
import type { ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiRequest, Collection, Folder } from '@dsh-api-client/shared'
import type { HeadersEditorProps } from '../src/client/components/request/HeadersEditor.tsx'
import type { ParamsEditorProps } from '../src/client/components/request/ParamsEditor.tsx'
import type {
  ResizableCollectionPaneHandle,
  ResizableCollectionPaneProps,
} from '../src/client/components/collection/ResizableCollectionPane.tsx'
import type { TreeClipboardApi, TreeClipboardBridge } from '../src/client/hooks/useTreeClipboard.ts'

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  onRequestOpened: vi.fn(),
  notifyDeleted: vi.fn(),
  lastHeadersProps: undefined as import('../src/client/components/request/HeadersEditor.tsx').HeadersEditorProps | undefined,
  lastParamsProps: undefined as import('../src/client/components/request/ParamsEditor.tsx').ParamsEditorProps | undefined,
}))

// ---- Toast：记录文案（hooks/树/视图共用同一模块出口） ----
vi.mock('../src/client/components/common/Toast.tsx', () => ({
  toast: {
    push: vi.fn(),
    error: mocks.toastError,
    info: mocks.toastInfo,
    dismiss: vi.fn(),
  },
  ToastHost: () => null,
}))

// ---- Headers/Params → 探针组件（只断言 WP8 接线，编辑器行为归 WP7 spec） ----
vi.mock('../src/client/components/request/HeadersEditor.tsx', async () => {
  const { createElement: ce } = await import('react')
  function HeadersEditorProbe(props: HeadersEditorProps): ReactElement {
    mocks.lastHeadersProps = props
    return ce(
      'div',
      { 'data-dsh-api-client': 'headers-probe' },
      ce(
        'button',
        {
          type: 'button',
          'data-dsh-api-client': 'probe-suppress',
          onClick: () => props.onSuppressedChange([{ name: 'Accept', source: 'client-default' }]),
        },
        '抑制 Accept',
      ),
      ce('button', { type: 'button', 'data-dsh-api-client': 'probe-navigate', onClick: () => props.onNavigate('auth') }, '跳转认证'),
    )
  }
  return { HeadersEditor: HeadersEditorProbe }
})

vi.mock('../src/client/components/request/ParamsEditor.tsx', async () => {
  const { createElement: ce } = await import('react')
  function ParamsEditorProbe(props: ParamsEditorProps): ReactElement {
    mocks.lastParamsProps = props
    return ce(
      'div',
      { 'data-dsh-api-client': 'params-probe' },
      ce('button', { type: 'button', 'data-dsh-api-client': 'probe-params-navigate', onClick: () => props.onNavigate('auth') }, '跳转认证'),
    )
  }
  return { ParamsEditor: ParamsEditorProbe }
})

// ---- ResizableCollectionPane：spy onRequestOpened 后委托真实组件（行为本体归 WP4 spec） ----
vi.mock('../src/client/components/collection/ResizableCollectionPane.tsx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/components/collection/ResizableCollectionPane.tsx')>()
  const react = await import('react')
  const Wrapped = react.forwardRef<ResizableCollectionPaneHandle, ResizableCollectionPaneProps>((props, ref) => {
    const inner = react.useRef<ResizableCollectionPaneHandle | null>(null)
    react.useImperativeHandle(
      ref,
      (): ResizableCollectionPaneHandle => ({
        onRequestOpened: () => {
          mocks.onRequestOpened()
          inner.current?.onRequestOpened()
        },
      }),
      [],
    )
    return react.createElement(actual.ResizableCollectionPane, { ...props, ref: inner })
  })
  return { ...actual, ResizableCollectionPane: Wrapped }
})

// ---- useTreeClipboard：spy notifyLocalRequestsDeleted 后委托真实钩子（§0.3 级联断言） ----
vi.mock('../src/client/hooks/useTreeClipboard.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/hooks/useTreeClipboard.ts')>()
  return {
    ...actual,
    useTreeClipboard: (bridge: TreeClipboardBridge): TreeClipboardApi => {
      const real = actual.useTreeClipboard(bridge)
      return {
        ...real,
        notifyLocalRequestsDeleted: (deletedRequestIds: readonly string[]) => {
          mocks.notifyDeleted([...deletedRequestIds])
          real.notifyLocalRequestsDeleted(deletedRequestIds)
        },
      }
    },
  }
})

import { ApiClientView } from '../src/client/views/ApiClientView.tsx'
import { TOKEN_GLOBAL_NAME } from '../src/client/hooks/useHostApi.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
// bootstrap 必须先于首次 useHostApi()（模块级缓存 createHostApi 时读取一次）。
;(globalThis as Record<string, unknown>)[TOKEN_GLOBAL_NAME] = { base: '/api-client', token: 'test-token' }

// ---- jsdom 补差：ResizeObserver / navigator.clipboard ----

type ResizeCallbackMock = (entries: Array<{ contentRect: { width: number } }>) => void

class ResizeObserverMock {
  static instances: ResizeObserverMock[] = []
  private readonly callback: ResizeCallbackMock
  private disconnected = false
  constructor(callback: ResizeCallbackMock) {
    this.callback = callback
    ResizeObserverMock.instances.push(this)
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {
    this.disconnected = true
  }
  fire(width: number): void {
    if (this.disconnected) return
    act(() => {
      this.callback([{ contentRect: { width } }])
    })
  }
}

function fireResize(width: number): void {
  for (const instance of ResizeObserverMock.instances) instance.fire(width)
}

/** normal 态 viewport（>=706；pane 三态公式见 ResizableCollectionPane）。 */
const PANE_VIEWPORT = 1200

// ---- Host 夹具与 fetch 路由 ----

function makeRequest(id: string, name: string, url: string, collectionId: string): ApiRequest {
  return { id, name, method: 'GET', url, params: [], headers: [], auth: { type: 'none' }, body: { type: 'none' }, collectionId, createdAt: 0, updatedAt: 100 }
}

/**
 * c1「示例集合」(updatedAt=1000)：f1「用户模块」{ r1, f1a「子模块」{ r2 } } + 顶层 r3；
 * c2「第二集合」(updatedAt=2000)：r4。
 * f1 递归统计 = 1 个子文件夹、2 个请求；c1 递归 Request 总数 = 3。
 */
function fixture(): Collection[] {
  const r1 = makeRequest('r1', 'r1 用户列表', 'https://api.example.com/r1', 'c1')
  const r2 = makeRequest('r2', 'r2 创建用户', 'https://api.example.com/r2', 'c1')
  const r3 = makeRequest('r3', 'r3 顶层请求', 'https://api.example.com/r3', 'c1')
  const r4 = makeRequest('r4', 'r4 其它集合请求', 'https://api.example.com/r4', 'c2')
  const f1a: Folder = { id: 'f1a', name: '子模块', folders: [], requests: [r2] }
  const f1: Folder = { id: 'f1', name: '用户模块', folders: [f1a], requests: [r1] }
  const c1: Collection = { id: 'c1', name: '示例集合', variables: [], folders: [f1], requests: [r3], createdAt: 0, updatedAt: 1000 }
  const c2: Collection = { id: 'c2', name: '第二集合', variables: [], folders: [], requests: [r4], createdAt: 0, updatedAt: 2000 }
  return [c1, c2]
}

function withoutRequest(list: Collection[], requestId: string): Collection[] {
  const next = JSON.parse(JSON.stringify(list)) as Collection[]
  const filterFolders = (folders: Folder[]): Folder[] =>
    folders.map((folder) => ({ ...folder, folders: filterFolders(folder.folders), requests: folder.requests.filter((r) => r.id !== requestId) }))
  return next.map((c) => ({ ...c, folders: filterFolders(c.folders), requests: c.requests.filter((r) => r.id !== requestId) }))
}

function findRequestIn(list: Collection[], requestId: string): ApiRequest | undefined {
  const walk = (folders: Folder[]): ApiRequest | undefined => {
    for (const folder of folders) {
      const hit = folder.requests.find((r) => r.id === requestId)
      if (hit !== undefined) return hit
      const deep = walk(folder.folders)
      if (deep !== undefined) return deep
    }
    return undefined
  }
  for (const collection of list) {
    const top = collection.requests.find((r) => r.id === requestId)
    if (top !== undefined) return top
    const nested = walk(collection.folders)
    if (nested !== undefined) return nested
  }
  return undefined
}

function insertRequest(list: Collection[], request: ApiRequest, folderId: string | undefined): Collection[] {
  const next = JSON.parse(JSON.stringify(list)) as Collection[]
  const collection = next.find((c) => c.id === request.collectionId)
  if (collection === undefined) return next
  if (folderId === undefined) {
    collection.requests.push(request)
    return next
  }
  const walk = (folders: Folder[]): boolean => {
    for (const folder of folders) {
      if (folder.id === folderId) {
        folder.requests.push(request)
        return true
      }
      if (walk(folder.folders)) return true
    }
    return false
  }
  walk(collection.folders)
  return next
}

/** POST /collections/c1/requests 路由：按 §3.2 语义生成 id='r-new' 的已保存请求并写回 server 投影。 */
function savedRequestRoute(): [RegExp, RouteHandler] {
  return [
    /^POST \/api-client\/collections\/c1\/requests$/,
    (call) => {
      const payload = JSON.parse(String(call.init?.body)) as Record<string, unknown>
      const folderId = payload.folderId === undefined ? undefined : String(payload.folderId)
      const saved: ApiRequest = {
        id: 'r-new',
        name: String(payload.name),
        method: 'GET',
        url: String(payload.url),
        params: [],
        headers: [],
        auth: { type: 'none' },
        body: { type: 'none' },
        collectionId: 'c1',
        ...(folderId !== undefined ? { folderId } : {}),
        createdAt: 0,
        updatedAt: 500,
      }
      server = insertRequest(server, JSON.parse(JSON.stringify(saved)) as ApiRequest, folderId)
      return mockResponse(200, saved)
    },
  ]
}

interface FetchCall {
  method: string
  url: string
  init?: RequestInit
}

type RouteHandler = (call: FetchCall) => Response | Promise<Response>

let fetchMock: ReturnType<typeof vi.fn>
let calls: FetchCall[]
/** Host 权威投影（GET /collections 动态读取；DELETE 成功路径同步变更）。 */
let server: Collection[]

function mockResponse(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as unknown as Response
}

function routeFetch(extra: Array<[RegExp, RouteHandler]> = []): void {
  const routes: Array<[RegExp, RouteHandler]> = [
    ...extra,
    [/^GET \/api-client\/collections$/, () => mockResponse(200, server)],
    [/^GET \/api-client\/environments$/, () => mockResponse(200, [{ id: 'e1', name: 'dev', variables: [] }])],
    [/^GET \/api-client\/settings$/, () => mockResponse(200, { activeEnvironmentId: 'e1', collectionSidebarWidth: 260 })],
  ]
  fetchMock.mockImplementation(async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    calls.push({ method, url, init })
    for (const [matcher, handler] of routes) {
      if (matcher.test(`${method} ${url}`)) return handler({ method, url, init })
    }
    throw new Error(`unexpected fetch: ${method} ${url}`)
  })
}

function deferredResponse(): { promise: Promise<Response>; resolve: (response: Response) => void } {
  let resolve!: (response: Response) => void
  const promise = new Promise<Response>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function collectionGets(): FetchCall[] {
  return calls.filter((call) => call.method === 'GET' && call.url === '/api-client/collections')
}

// ---- 渲染 harness（history-view / p0-tab-lifecycle 同款 createRoot + act） ----

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  mocks.toastError.mockClear()
  mocks.toastInfo.mockClear()
  mocks.onRequestOpened.mockClear()
  mocks.notifyDeleted.mockClear()
  mocks.lastHeadersProps = undefined
  mocks.lastParamsProps = undefined
  calls = []
  server = fixture()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  ResizeObserverMock.instances = []
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverMock
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => {}) }, configurable: true })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
})

async function renderView(extra: Array<[RegExp, RouteHandler]> = []): Promise<void> {
  routeFetch(extra)
  await act(async () => {
    root.render(createElement(ApiClientView, { onClose: () => {} }))
  })
  // pane 以根容器宽度为 viewport 参照系：jsdom 无布局 → 经 ResizeObserver 注入 normal 态宽度。
  fireResize(PANE_VIEWPORT)
}

// ---- DOM 助手 ----

function q(attr: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-dsh-api-client="${attr}"]`)
}

function treeRowOrNull(name: string): HTMLElement | null {
  const rows = [...container.querySelectorAll<HTMLElement>('[data-dsh-api-client="tree-row"]')]
  return rows.find((row) => row.querySelector('[data-dsh-api-client="tree-name-slot"]')?.textContent === name) ?? null
}

function treeRow(name: string): HTMLElement {
  const row = treeRowOrNull(name)
  expect(row, `未找到树行：${name}`).not.toBeNull()
  return row!
}

async function clickRow(name: string): Promise<void> {
  const row = treeRow(name)
  await act(async () => {
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

async function rowKeydown(name: string, key: string): Promise<void> {
  const row = treeRow(name)
  await act(async () => {
    row.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
}

async function openRowMenu(name: string): Promise<void> {
  const row = treeRow(name)
  await act(async () => {
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 40 }))
  })
}

async function clickMenuItem(action: string): Promise<void> {
  // 菜单经 createPortal 挂在 document.body（不在 container 内）。
  const item = document.querySelector<HTMLElement>(`[data-menu-action="${action}"]`)
  expect(item, `未找到菜单项：${action}`).not.toBeNull()
  await act(async () => {
    item!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

async function clickEl(element: HTMLElement | null): Promise<void> {
  expect(element, '点击目标不存在').not.toBeNull()
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function tabNames(): string[] {
  return [...container.querySelectorAll<HTMLElement>('[data-dsh-api-client="request-tabs"] div[title]')].map((tab) => tab.getAttribute('title')!)
}

function urlInput(): HTMLInputElement {
  const input = q('url-bar')?.querySelector('input')
  expect(input, 'URL 输入框不存在').not.toBeNull()
  return input as HTMLInputElement
}

function urlInputValue(): string {
  return urlInput().value
}

/** React 受控 input 赋值：原生 value setter + input 事件。 */
function setUrlInput(value: string): void {
  const input = urlInput()
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === text)
}

function newTabButton(): HTMLElement {
  const button = container.querySelector<HTMLElement>('[data-dsh-api-client="request-tabs"] button[title="New request tab"]')
  expect(button, '新建 tab 按钮不存在').not.toBeNull()
  return button!
}

function closeTabButtons(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-dsh-api-client="request-tabs"] [aria-label="close tab"]')]
}

function confirmDeleteButton(): HTMLButtonElement {
  const button = q('tree-delete-confirm')
  expect(button, '删除确认按钮不存在').not.toBeNull()
  return button as HTMLButtonElement
}

function deleteCallBody(): unknown {
  const deleteCall = calls.find((call) => call.method === 'DELETE')
  expect(deleteCall, '未发出 DELETE 请求').toBeDefined()
  return JSON.parse(String(deleteCall!.init?.body))
}

/**
 * 走真实保存链路构造 R3 前置形态：'+' 新建草稿（key=draft-N）→ 编辑 URL →
 * Save 弹 SaveRequestModal →（可选选 folder）→「保存」POST 成功 →
 * onSaved 只写 requestId/draft.id，**tab.key 保持 draft-N**（幽灵 tab 成因）。
 */
async function saveDraftViaModal(opts: { url: string; folderId?: string }): Promise<void> {
  await clickEl(newTabButton())
  setUrlInput(opts.url)
  await clickEl(buttonByText('Save')!)
  const dialog = container.querySelector('[role="dialog"]')
  expect(dialog, '保存对话框未打开').not.toBeNull()
  if (opts.folderId !== undefined) {
    // 第二个 select = 文件夹（第一个是集合）；React 受控 select 用原生 setter + change。
    const folderSelect = dialog!.querySelectorAll('select')[1] as HTMLSelectElement
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!
    act(() => {
      setter.call(folderSelect, opts.folderId!)
      folderSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })
  }
  const saveButton = [...dialog!.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '保存')
  await clickEl(saveButton!)
}

// ---- 1. 删除统计与确认（§7.1/§7.2，AC-24/25）+ Folder 级联（§0.3/§13.3） ----

describe('ApiClientView 树删除：统计、确认与级联（AC-24/25）', () => {
  it('Folder 删除：菜单入口显示递归统计与 dirty 警示；取消零变化；Delete 键重开时取消默认焦点', async () => {
    await renderView([
      [
        /^DELETE \/api-client\/collections\/c1\/folders\/f1$/,
        () => {
          server = server.map((c) => (c.id === 'c1' ? { ...c, folders: [] } : c))
          return mockResponse(204)
        },
      ],
    ])
    await clickRow('示例集合')
    await clickRow('用户模块')
    await clickRow('子模块')
    await clickRow('r1 用户列表')
    await clickRow('r2 创建用户')
    setUrlInput('https://api.example.com/r2-edited') // active r2 → dirty

    await openRowMenu('用户模块')
    await clickMenuItem('delete')
    expect(q('tree-delete-headline')?.textContent).toBe('确定删除文件夹「用户模块」？')
    // 递归统计（core countFolderDescendants 权威版）：f1a 1 个子文件夹（不含自身）+ r1/r2 2 个请求
    expect(q('tree-delete-stats')?.textContent).toBe('包含 1 个子文件夹、2 个请求')
    expect(q('tree-delete-dirty')?.textContent).toBe('将放弃 1 个未保存修改')
    expect(confirmDeleteButton().textContent).toBe('删除并放弃修改')

    // 取消 → 对话框关闭、tree/tab/activeKey 零变化
    await clickEl(q('tree-delete-cancel'))
    expect(q('tree-delete-dialog')).toBeNull()
    expect(tabNames()).toEqual(['r1 用户列表', 'r2 创建用户'])
    expect(urlInputValue()).toBe('https://api.example.com/r2-edited')
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false)

    // Delete 键路径（无菜单焦点归还干扰）：取消按钮默认获得焦点（AC-25）
    await rowKeydown('用户模块', 'Delete')
    expect(q('tree-delete-dialog')).not.toBeNull()
    expect(document.activeElement).toBe(q('tree-delete-cancel'))
  })

  it('Folder 删除确认：DELETE 携带乐观锁版本；committed 后级联关闭子树全部 tabs（全删 → 空状态）并通知 Cut 源级联', async () => {
    await renderView([
      [
        /^DELETE \/api-client\/collections\/c1\/folders\/f1$/,
        () => {
          server = server.map((c) => (c.id === 'c1' ? { ...c, folders: [] } : c))
          return mockResponse(204)
        },
      ],
    ])
    await clickRow('示例集合')
    await clickRow('用户模块')
    await clickRow('子模块')
    await clickRow('r1 用户列表')
    await clickRow('r2 创建用户')

    await rowKeydown('用户模块', 'Delete')
    await clickEl(confirmDeleteButton())

    // §3.1：Folder DELETE 走 JSON body 携带 expectedCollectionUpdatedAt（投影版本 1000）
    expect(deleteCallBody()).toEqual({ expectedCollectionUpdatedAt: 1000 })
    // §7.3：committed → 子树 tabs（r1+r2）全部关闭；两侧无存活 → 回到空状态（§7.4）
    expect(tabNames()).toEqual([])
    expect(q('url-bar')).toBeNull()
    expect(container.textContent).toContain('从左侧请求树打开一个请求')
    // §0.3：Cut 源级联清空通知收到子树全部 request ids
    const notified = mocks.notifyDeleted.mock.calls.at(-1)![0] as string[]
    expect([...notified].sort()).toEqual(['r1', 'r2'])
    // refresh 成功 → 树投影已更新（f1 消失）
    expect(treeRowOrNull('用户模块')).toBeNull()
    expect(treeRowOrNull('r3 顶层请求')).not.toBeNull()
  })
})

// ---- 2. Host 失败零变化（§7.3，AC-21） ----

describe('ApiClientView 树删除：Host 失败一致性（AC-21）', () => {
  it('409 拒绝：tree/tab/activeKey 零变化 + stale 横幅 + Host 逐字中文 toast，不发 refresh、不动剪贴板', async () => {
    await renderView([
      [
        /^DELETE \/api-client\/requests\/r2$/,
        () => mockResponse(409, { error: { code: 'version-conflict', message: '数据已被其他操作修改，请刷新后重试' } }),
      ],
    ])
    await clickRow('示例集合')
    await clickRow('用户模块')
    await clickRow('子模块')
    await clickRow('r1 用户列表')
    await clickRow('r2 创建用户')
    const getsBefore = collectionGets().length

    await rowKeydown('r2 创建用户', 'Delete')
    expect(q('tree-delete-headline')?.textContent).toBe('确定删除请求「r2 创建用户」？')
    expect(q('tree-delete-stats')).toBeNull() // request 无统计行（§7.1）
    expect(q('tree-delete-dirty')).toBeNull() // r2 clean → 确认按钮=「删除」
    expect(confirmDeleteButton().textContent).toBe('删除')

    await clickEl(confirmDeleteButton())

    // 零变化：tabs / activeKey（编辑器仍显示 r2）/ 树行全部保持
    expect(tabNames()).toEqual(['r1 用户列表', 'r2 创建用户'])
    expect(urlInputValue()).toBe('https://api.example.com/r2')
    expect(treeRowOrNull('r2 创建用户')).not.toBeNull()
    // 409 → stale + Host 逐字 message toast（§3.1.1/§4.9）；失败分支不发 refresh GET
    expect(mocks.toastError).toHaveBeenCalledWith('数据已被其他操作修改，请刷新后重试')
    expect(q('tree-stale-banner')).not.toBeNull()
    expect(collectionGets().length).toBe(getsBefore)
    // committed=false → 不触发 Cut 源级联清空
    expect(mocks.notifyDeleted).not.toHaveBeenCalled()
    // 对话框已关闭（失败原因经 toast 传达；stale 横幅提供「重新刷新」恢复入口）
    expect(q('tree-delete-dialog')).toBeNull()
  })
})

// ---- 3. Host 成功后才关 tab（§7.3/§7.4，AC-23/26） ----

describe('ApiClientView 树删除：成功前不动、成功后左邻选择（AC-23/26）', () => {
  it('Request 删除：DELETE resolve 前 pending 忙碌态且 tabs 不动；committed 后关闭且 active 选左邻', async () => {
    const deferred = deferredResponse()
    await renderView([[/^DELETE \/api-client\/requests\/r3$/, () => deferred.promise]])
    await clickRow('示例集合')
    await clickRow('用户模块')
    await clickRow('r1 用户列表')
    await clickRow('r3 顶层请求') // active = r3

    await rowKeydown('r3 顶层请求', 'Delete')
    await clickEl(confirmDeleteButton())

    // AC-23：Host 未确认前绝不乐观关 tab——pending 忙碌态 + tabs/activeKey 原样
    expect(confirmDeleteButton().textContent).toBe('删除中…')
    expect(confirmDeleteButton().disabled).toBe(true)
    expect(tabNames()).toEqual(['r1 用户列表', 'r3 顶层请求'])
    expect(urlInputValue()).toBe('https://api.example.com/r3')

    // Host 提交 + 刷新投影 → 才关闭 affected tab；active 被删 → 左邻 r1（AC-26）
    await act(async () => {
      server = withoutRequest(server, 'r3')
      deferred.resolve(mockResponse(204))
    })
    expect(tabNames()).toEqual(['r1 用户列表'])
    expect(urlInputValue()).toBe('https://api.example.com/r1')
    expect(mocks.notifyDeleted).toHaveBeenCalledWith(['r3'])
    expect(treeRowOrNull('r3 顶层请求')).toBeNull()
    expect(deleteCallBody()).toEqual({ expectedCollectionUpdatedAt: 1000 })
  })

  it('Collection 删除：统计=递归 Request 总数；committed 后只关闭该集合的 tabs，其他集合 tab 保留', async () => {
    await renderView([
      [
        /^DELETE \/api-client\/collections\/c1$/,
        () => {
          server = server.filter((c) => c.id !== 'c1')
          return mockResponse(204)
        },
      ],
    ])
    await clickRow('示例集合')
    await clickRow('用户模块')
    await clickRow('r1 用户列表')
    await clickRow('第二集合')
    await clickRow('r4 其它集合请求') // active = r4（c2，不受删除影响）

    await rowKeydown('示例集合', 'Delete')
    // core countCollectionRequests 权威版：c1 递归 3 个请求（r1+r2+r3）
    expect(q('tree-delete-headline')?.textContent).toBe('确定删除集合「示例集合」？')
    expect(q('tree-delete-stats')?.textContent).toBe('包含 3 个请求')
    expect(q('tree-delete-dirty')).toBeNull()
    expect(confirmDeleteButton().textContent).toBe('删除')

    await clickEl(confirmDeleteButton())

    expect(deleteCallBody()).toEqual({ expectedCollectionUpdatedAt: 1000 })
    // c1 的已打开 tab（r1）关闭；c2 的 r4 保留且 active 未被删 → 保持（§7.4）
    expect(tabNames()).toEqual(['r4 其它集合请求'])
    expect(urlInputValue()).toBe('https://api.example.com/r4')
    const notified = mocks.notifyDeleted.mock.calls.at(-1)![0] as string[]
    expect([...notified].sort()).toEqual(['r1', 'r2', 'r3'])
    expect(treeRowOrNull('示例集合')).toBeNull()
    expect(treeRowOrNull('第二集合')).not.toBeNull()
  })
})

// ---- 3b. R3 回归：draft-key 幽灵 tab（浏览器验收缺陷，AC-23/24 语义泄漏） ----

describe('ApiClientView R3 回归：保存成功的 draft-key tab 在节点删除后不得存活', () => {
  it('Request 路径：删除树节点后 draft-key tab 经 requestId 匹配关闭，active 走左邻规则', async () => {
    await renderView([
      savedRequestRoute(),
      [
        /^DELETE \/api-client\/requests\/r-new$/,
        () => {
          server = withoutRequest(server, 'r-new')
          return mockResponse(204)
        },
      ],
    ])
    await clickRow('示例集合')
    await clickRow('用户模块')
    await clickRow('r1 用户列表')
    // 新建草稿 → 保存成功：tab.key 仍是 draft-N、requestId=r-new（R3 前置真实形态）
    await saveDraftViaModal({ url: 'https://api.example.com/echo' })
    expect(tabNames()).toEqual(['r1 用户列表', '未命名请求'])
    // requestId 已设置的旁证：clean+saved 形态 → Save 基线禁用
    expect(buttonByText('Save')!.disabled).toBe(true)

    await rowKeydown('未命名请求', 'Delete')
    expect(q('tree-delete-headline')?.textContent).toBe('确定删除请求「未命名请求」？')
    await clickEl(confirmDeleteButton())

    // 修复前：removedKeys=['r-new'] 按 key 匹配不中 draft-N → 幽灵 tab 存活。
    // 修复后：key∨requestId 双匹配 → tab 关闭；active（被删）→ 左邻 r1（§7.4）
    expect(tabNames()).toEqual(['r1 用户列表'])
    expect(urlInputValue()).toBe('https://api.example.com/r1')
    expect(mocks.notifyDeleted).toHaveBeenCalledWith(['r-new'])
    expect(treeRowOrNull('未命名请求')).toBeNull()
  })

  it('Folder 路径（验收复现形态）：dirty 统计计入 draft-key tab；级联删除后 r1 与 draft-key tab 全部关闭', async () => {
    await renderView([
      savedRequestRoute(),
      [
        /^DELETE \/api-client\/collections\/c1\/folders\/f1$/,
        () => {
          server = server.map((c) => (c.id === 'c1' ? { ...c, folders: [] } : c))
          return mockResponse(204)
        },
      ],
    ])
    await clickRow('示例集合')
    await clickRow('用户模块')
    await clickRow('r1 用户列表')
    await saveDraftViaModal({ url: 'https://api.example.com/echo', folderId: 'f1' })
    setUrlInput('https://api.example.com/echo2') // 保存后再编辑 → draft-key tab dirty

    await rowKeydown('用户模块', 'Delete')
    // AC-24：统计基于刷新后投影（f1 = r1 + r-new + f1a/r2）
    expect(q('tree-delete-stats')?.textContent).toBe('包含 1 个子文件夹、3 个请求')
    // 修复前 dirtyTabCount 按 key 匹配漏掉 draft-key tab（显示 0/「删除」）；修复后计入
    expect(q('tree-delete-dirty')?.textContent).toBe('将放弃 1 个未保存修改')
    expect(confirmDeleteButton().textContent).toBe('删除并放弃修改')

    await clickEl(confirmDeleteButton())

    // r1（key 匹配）与 draft-N（requestId 匹配）全部关闭 → 空状态；Cut 级联通知收全部子树 ids
    expect(tabNames()).toEqual([])
    expect(q('url-bar')).toBeNull()
    expect(container.textContent).toContain('从左侧请求树打开一个请求')
    const notified = mocks.notifyDeleted.mock.calls.at(-1)![0] as string[]
    expect([...notified].sort()).toEqual(['r-new', 'r1', 'r2'])
    expect(treeRowOrNull('用户模块')).toBeNull()
  })

  it('同类加固：树重命名成功后 draft-key tab 的草稿名经 requestId 同步', async () => {
    await renderView([
      savedRequestRoute(),
      [
        /^PATCH \/api-client\/requests\/r-new(\?.*)?$/,
        (call) => {
          const payload = JSON.parse(String(call.init?.body)) as { name?: string }
          const target = findRequestIn(server, 'r-new')!
          target.name = payload.name ?? target.name
          target.updatedAt = 501
          return mockResponse(200, JSON.parse(JSON.stringify(target)))
        },
      ],
    ])
    await clickRow('示例集合')
    await saveDraftViaModal({ url: 'https://api.example.com/echo' })
    expect(tabNames()).toEqual(['未命名请求'])

    // F2 行内重命名 → PATCH 成功 → onRequestRenamed(updated)
    await rowKeydown('未命名请求', 'F2')
    const renameInput = container.querySelector<HTMLInputElement>('[data-dsh-api-client="tree-rename-input"]')
    expect(renameInput, '重命名输入框未出现').not.toBeNull()
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      setter.call(renameInput!, '回声请求')
      renameInput!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      renameInput!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    // 修复前 updateTab(updated.id) 按 key 匹配不中 draft-N → tab 标题滞留旧名
    expect(tabNames()).toEqual(['回声请求'])
    expect(treeRowOrNull('回声请求')).not.toBeNull()
  })
})

// ---- 4. dirty tab 单独关闭（§7.5，AC-27） ----

describe('ApiClientView dirty tab 关闭（AC-27）', () => {
  it('clean tab 立即关闭；dirty tab 必须确认——取消默认焦点、取消保留、确认关闭且绝不自动保存', async () => {
    await renderView()
    await clickRow('示例集合')
    await clickRow('用户模块')
    await clickRow('r1 用户列表')

    // clean（saved + 未编辑）→ 立即关闭，无对话框
    await clickEl(closeTabButtons()[0]!)
    expect(tabNames()).toEqual([])
    expect(q('dirty-tab-close-dialog')).toBeNull()

    // 重新打开并编辑 → dirty
    await clickRow('r1 用户列表')
    setUrlInput('https://api.example.com/r1-edited')
    await clickEl(closeTabButtons()[0]!)

    // §7.5：dirty → DirtyTabCloseDialog；文案含请求名与丢失警示；取消默认焦点
    const message = q('dirty-tab-close-message')?.textContent ?? ''
    expect(message).toContain('「r1 用户列表」')
    expect(message).toContain('未保存修改')
    expect(message).toContain('将丢失')
    expect(q('dirty-tab-close-confirm')?.textContent).toBe('关闭并放弃修改')
    expect(document.activeElement).toBe(q('dirty-tab-close-cancel'))

    // 取消 → tab 与草稿原样保留
    await clickEl(q('dirty-tab-close-cancel'))
    expect(tabNames()).toEqual(['r1 用户列表'])
    expect(urlInputValue()).toBe('https://api.example.com/r1-edited')

    // 确认 → 关闭；P0 无自动保存：全程零 PATCH
    await clickEl(closeTabButtons()[0]!)
    await clickEl(q('dirty-tab-close-confirm'))
    expect(tabNames()).toEqual([])
    expect(calls.some((call) => call.method === 'PATCH')).toBe(false)
  })
})

// ---- 5. Headers/Params WP7 接线 ----

describe('ApiClientView Headers/Params 接线（WP7 契约）', () => {
  it('draft/environment/collection 透传；suppression 写回并置 dirty；Save→PATCH→「请求已保存」；onNavigate 切换编辑区', async () => {
    await renderView([
      [
        /^PATCH \/api-client\/requests\/r1$/,
        () => {
          const updated = JSON.parse(JSON.stringify(findRequestIn(server, 'r1')!)) as ApiRequest
          return mockResponse(200, { ...updated, updatedAt: 101 })
        },
      ],
    ])
    await clickRow('示例集合')
    await clickRow('用户模块')
    await clickRow('r1 用户列表')

    // Params（默认编辑页）：draft/environment/collection 三件套
    expect(q('params-probe')).not.toBeNull()
    expect(mocks.lastParamsProps!.draft.url).toBe('https://api.example.com/r1')
    expect(mocks.lastParamsProps!.draft.method).toBe('GET')
    expect(mocks.lastParamsProps!.environment?.id).toBe('e1')
    expect(mocks.lastParamsProps!.collection?.id).toBe('c1')

    // Headers：同款三件套（environment 来自 settings.activeEnvironmentId 解析）
    await clickEl(buttonByText('Headers')!)
    expect(q('headers-probe')).not.toBeNull()
    expect(mocks.lastHeadersProps!.draft.url).toBe('https://api.example.com/r1')
    expect(mocks.lastHeadersProps!.environment?.name).toBe('dev')
    expect(mocks.lastHeadersProps!.collection?.name).toBe('示例集合')

    // clean saved tab：Save 基线禁用
    expect(buttonByText('Save')!.disabled).toBe(true)
    // onSuppressedChange → draft.suppressedGeneratedHeaders 写回 + dirty（Save 解禁）
    await clickEl(q('probe-suppress'))
    expect(mocks.lastHeadersProps!.draft.suppressedGeneratedHeaders).toEqual([{ name: 'Accept', source: 'client-default' }])
    expect(buttonByText('Save')!.disabled).toBe(false)

    // Save → PATCH（含 suppression 落库字段）→ toast「请求已保存」→ 回到 clean
    await clickEl(buttonByText('Save')!)
    expect(mocks.toastInfo).toHaveBeenCalledWith('请求已保存')
    const patchCall = calls.find((call) => call.method === 'PATCH')!
    expect(JSON.parse(String(patchCall.init?.body))).toMatchObject({
      name: 'r1 用户列表',
      url: 'https://api.example.com/r1',
      suppressedGeneratedHeaders: [{ name: 'Accept', source: 'client-default' }],
    })
    expect(buttonByText('Save')!.disabled).toBe(true)

    // onNavigate（headers 探针 → 'auth'）→ 认证编辑区
    await clickEl(q('probe-navigate'))
    expect(q('auth-editor')).not.toBeNull()
    // onNavigate（params 探针 → 'auth'）同款接线
    await clickEl(buttonByText('Params')!)
    expect(q('params-probe')).not.toBeNull()
    await clickEl(q('probe-params-navigate'))
    expect(q('auth-editor')).not.toBeNull()
  })
})

// ---- 6. stale 一致性（§4.9，AC-22 集成面） ----

describe('ApiClientView stale 一致性（§4.9）', () => {
  it('mutation 提交但刷新失败：固定文案 + stale 横幅；草稿 Save 禁用、Send 保留；刷新成功后恢复', async () => {
    let getCount = 0
    await renderView([
      [
        /^DELETE \/api-client\/requests\/r3$/,
        () => {
          server = withoutRequest(server, 'r3')
          return mockResponse(204)
        },
      ],
      [
        /^GET \/api-client\/collections$/,
        () => {
          getCount += 1
          if (getCount === 2) throw new Error('network down')
          return mockResponse(200, server)
        },
      ],
    ])
    await clickRow('示例集合')
    await rowKeydown('r3 顶层请求', 'Delete')
    await clickEl(confirmDeleteButton())

    // committed + refresh 失败 → 固定文案（绝不谎称回滚）+ stale
    expect(mocks.toastError).toHaveBeenCalledWith('数据已保存，列表刷新失败')
    expect(mocks.toastError.mock.calls.flat().join('\n')).not.toContain('回滚')
    expect(q('tree-stale-banner')).not.toBeNull()
    expect(q('tree-stale-banner')?.textContent).toContain('列表已过期')

    // 草稿 tab：Save 禁用（stale）、Send 不受限（§4.9 保留 Send）
    await clickEl(newTabButton())
    expect(tabNames()).toEqual(['未命名请求'])
    expect(buttonByText('Save')!.disabled).toBe(true)
    expect(buttonByText('Send')!.disabled).toBe(false)
    // Send 路径存活：空 URL → 中文 toast，无网络请求
    await clickEl(buttonByText('Send')!)
    expect(mocks.toastError).toHaveBeenCalledWith('URL 为空')

    // 「重新刷新」成功 → stale 解除 → Save 恢复可用
    await clickEl(q('tree-stale-refresh'))
    expect(q('tree-stale-banner')).toBeNull()
    expect(buttonByText('Save')!.disabled).toBe(false)
  })
})

// ---- 7. ResizableCollectionPane 集成（WP4 契约，AC-34 结构面） ----

describe('ApiClientView × ResizableCollectionPane 集成', () => {
  it('树与编辑器列渲染在 pane 内（normal 态）；打开请求/新建请求各触发一次 onRequestOpened', async () => {
    await renderView()
    const paneRoot = q('collection-pane-root')
    expect(paneRoot).not.toBeNull()
    // 树 = pane children（同一 React 实例位置恒定，AC-34 结构前提）
    expect(paneRoot!.querySelector('[data-dsh-api-client="collection-tree"]')).not.toBeNull()
    expect(q('collection-sidebar-separator')).not.toBeNull()
    expect(q('collection-sidebar-pane')?.getAttribute('data-pane-mode')).toBe('normal')
    // 编辑器列恒在 pane 的 main 容器内
    expect(q('collection-pane-main')?.querySelector('[data-dsh-api-client="request-tabs"]')).not.toBeNull()

    expect(mocks.onRequestOpened).not.toHaveBeenCalled()
    await clickRow('示例集合')
    await clickRow('用户模块')
    // 打开 Request 成功路径 → onRequestOpened（hidden 态 drawer 自动关闭的接线点）
    await clickRow('r1 用户列表')
    expect(mocks.onRequestOpened).toHaveBeenCalledTimes(1)
    // 新建草稿 tab 同属「打开 Request」成功路径
    await clickEl(newTabButton())
    expect(mocks.onRequestOpened).toHaveBeenCalledTimes(2)
    // 三态/宽度切换不影响编辑器列（AC-34：draft 不丢、不重挂载由 pane 保证——此处断言内容仍在）
    fireResize(400) // hidden 态
    expect(q('collection-sidebar-pane')?.getAttribute('data-pane-mode')).toBe('hidden')
    expect(tabNames()).toEqual(['r1 用户列表', '未命名请求'])
    expect(urlInputValue()).toBe('')
    fireResize(PANE_VIEWPORT) // 回 normal
    expect(q('collection-sidebar-pane')?.getAttribute('data-pane-mode')).toBe('normal')
    expect(tabNames()).toEqual(['r1 用户列表', '未命名请求'])
  })
})

// ---- 8. 主界面 P0 文案中文化（AC-47） ----

describe('ApiClientView P0 文案中文化（AC-47）', () => {
  it('顶栏/空态/新 tab 名/关闭 title/SaveRequestModal 关键中文串齐备，英文句子文案不存在', async () => {
    await renderView()
    // 顶栏按钮
    expect(buttonByText('历史')).toBeDefined()
    expect(buttonByText('导入')).toBeDefined()
    expect(buttonByText('环境')).toBeDefined()
    expect(buttonByText('交给 Agent')).toBeDefined()
    for (const legacy of ['History', 'Import', 'Environment']) {
      expect(buttonByText(legacy), `顶栏不应再有英文按钮：${legacy}`).toBeUndefined()
    }
    // 关闭面板 title
    expect(container.querySelector('button[title="关闭面板（回到对话）"]')).not.toBeNull()
    expect(container.querySelector('button[title="Close panel (yield to Conversation)"]')).toBeNull()
    // 空态提示
    expect(container.textContent).toContain('从左侧请求树打开一个请求，或新建一个标签页。')
    expect(container.textContent).not.toContain('Open a request from the tree')
    // 新 tab 默认名
    await clickEl(newTabButton())
    expect(tabNames()).toEqual(['未命名请求'])
    expect(container.textContent).not.toContain('Untitled Request')
    // SaveRequestModal（草稿 tab → Save 打开）
    await clickEl(buttonByText('Save')!)
    const dialog = container.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.getAttribute('aria-label')).toBe('保存请求到集合')
    const text = dialog?.textContent ?? ''
    for (const zh of ['名称', '集合', '文件夹', '（顶层）', '保存']) {
      expect(text, `保存对话框缺少中文文案：${zh}`).toContain(zh)
    }
    for (const en of ['Save request to collection', '(top level)', 'No collections yet', 'Select a collection first']) {
      expect(text, `保存对话框不应再有英文文案：${en}`).not.toContain(en)
    }
  })
})
