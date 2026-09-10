/**
 * WP5（P0 实施设计 §0.3/§3.1/§6.3/§6.5/§5.10/§8.1 条目 5–6 + §13.1，
 * UX §4.4/§4.6/§9）验收 spec —— 右键菜单动作矩阵 / 定位与焦点 / 关闭条件 /
 * paste 可用性矩阵 / 复制 URL·cURL 系统剪贴板 / useTreeClipboard（AC-13）。
 *
 * 用例名对齐 §8.1：menu_matrix_by_node_kind、menu_close_focus_and_bounds。
 * 渲染方式与 p0-tab-lifecycle.spec.ts 同款：react-dom createRoot + act（jsdom）；
 * 菜单经 createPortal 挂到 document.body——断言一律查 document.body。
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiRequest, Collection, Environment, TreeClipboardDescriptor } from '@dsh-api-client/shared'
import { CollectionTree } from '../src/client/components/collection/CollectionTree.tsx'
import type { CollectionTreeHandlers } from '../src/client/components/collection/CollectionTree.tsx'
import { TreeContextMenu, computeMenuPlacement } from '../src/client/components/collection/TreeContextMenu.tsx'
import type { TreeMenuItem } from '../src/client/components/collection/TreeContextMenu.tsx'
import type { CollectionsState, MutationOutcome } from '../src/client/hooks/useCollections.ts'
import { useCollections } from '../src/client/hooks/useCollections.ts'
import type { TreeClipboardApi, TreeClipboardBridge } from '../src/client/hooks/useTreeClipboard.ts'
import { computePasteEnablement, useTreeClipboard } from '../src/client/hooks/useTreeClipboard.ts'
import { TOKEN_GLOBAL_NAME } from '../src/client/hooks/useHostApi.ts'

const toastMocks = vi.hoisted(() => ({
  push: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  dismiss: vi.fn(),
}))

vi.mock('../src/client/components/common/Toast.tsx', () => ({
  toast: toastMocks,
  ToastHost: () => null,
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ---------- 夹具 ----------

function makeRequest(id: string, name: string, overrides: Partial<ApiRequest> = {}): ApiRequest {
  return {
    id,
    name,
    method: 'GET',
    url: `https://api.example.com/${id}`,
    params: [],
    headers: [],
    auth: { type: 'none' },
    body: { type: 'none' },
    collectionId: 'c1',
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  }
}

/** c1：f1（r2）+ 顶层 r1；c2 空集合。r1 即「敏感请求」（复制 URL/cURL 用例改写其字段）。 */
function fixture(): Collection[] {
  return [
    {
      id: 'c1',
      name: '订单 API',
      variables: [],
      folders: [{ id: 'f1', name: '用户模块', folders: [], requests: [makeRequest('r2', '创建用户', { method: 'POST' })] }],
      requests: [makeRequest('r1', '订单列表')],
      createdAt: 1,
      updatedAt: 1000,
    },
    { id: 'c2', name: '空集合', variables: [], folders: [], requests: [], createdAt: 2, updatedAt: 2000 },
  ]
}

function secretFixture(): Collection[] {
  const list = fixture()
  list[0]!.requests = [
    makeRequest('r1', '敏感请求', {
      url: '{{basePath}}/v1/orders?tk={{secretToken}}',
      headers: [
        { key: 'Authorization', value: 'Bearer literal-token-xyz', enabled: true },
        { key: 'X-Trace', value: 'trace-1', enabled: true },
      ],
      body: { type: 'json', json: '{"pin":"{{secretToken}}"}' },
    }),
  ]
  return list
}

function secretEnvironment(): Environment {
  return {
    id: 'env-1',
    name: '生产',
    variables: [
      { key: 'secretToken', currentValue: { $ref: 'sec-ref-1' }, secret: true, enabled: true },
      { key: 'basePath', currentValue: 'https://prod.example.com', secret: false, enabled: true },
    ],
  }
}

const okOutcome: MutationOutcome = { committed: true, refreshed: true }

function fakeCollections(overrides: Partial<CollectionsState> = {}): CollectionsState {
  return {
    collections: fixture(),
    loading: false,
    error: undefined,
    stale: false,
    refresh: vi.fn(async () => true),
    runMutation: vi.fn(async (action: () => Promise<unknown>) => ({ result: await action(), committed: true, refreshed: true })) as unknown as CollectionsState["runMutation"],
    createCollection: vi.fn(async (name: string) => ({ ...fixture()[1]!, id: 'c-new', name })),
    renameCollection: vi.fn(async () => okOutcome),
    deleteCollection: vi.fn(async () => okOutcome),
    duplicateCollection: vi.fn(async () => {}),
    reorderCollection: vi.fn(async () => {}),
    saveRequest: vi.fn(async () => undefined),
    patchRequest: vi.fn(async () => undefined),
    renameRequest: vi.fn(async () => ({ ...okOutcome })),
    deleteRequest: vi.fn(async () => okOutcome),
    duplicateRequest: vi.fn(async () => {}),
    moveRequest: vi.fn(async () => {}),
    createFolder: vi.fn(async () => ({ ...okOutcome, folder: { id: 'f-new', name: '新目录' } })),
    renameFolder: vi.fn(async () => okOutcome),
    deleteFolder: vi.fn(async () => okOutcome),
    ...overrides,
  }
}

function clipboardDescriptor(overrides: Partial<TreeClipboardDescriptor> = {}): TreeClipboardDescriptor {
  return { token: 'tk-1', operation: 'copy', kind: 'request', expiresAt: Date.now() + 60_000, ...overrides }
}

function fakeClipboard(state?: TreeClipboardDescriptor): TreeClipboardApi {
  return {
    clipboard: state,
    pending: false,
    copy: vi.fn(async () => true),
    cut: vi.fn(async () => true),
    paste: vi.fn(async () => true),
    clear: vi.fn(async () => {}),
    pasteEnablement: (target) => computePasteEnablement(state, target),
    notifyLocalRequestsDeleted: vi.fn(),
  }
}

function fakeHandlers(): CollectionTreeHandlers {
  return { onOpenRequest: vi.fn(), onNewRequest: vi.fn(), onRequestDelete: vi.fn(), onRequestRenamed: vi.fn() }
}

// ---------- 渲染基建 ----------

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  toastMocks.error.mockClear()
  toastMocks.info.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
})

interface RenderTreeOptions {
  collections?: Partial<CollectionsState>
  clipboard?: TreeClipboardDescriptor
  environment?: Environment
}

interface Rendered {
  collections: CollectionsState
  clipboard: TreeClipboardApi
  handlers: CollectionTreeHandlers
}

async function renderTree(options: RenderTreeOptions = {}): Promise<Rendered> {
  const collections = fakeCollections(options.collections ?? {})
  const clipboard = fakeClipboard(options.clipboard)
  const handlers = fakeHandlers()
  await act(async () => {
    root.render(
      createElement(CollectionTree, {
        collections,
        clipboard,
        handlers,
        ...(options.environment !== undefined ? { environment: options.environment } : {}),
      }),
    )
  })
  return { collections, clipboard, handlers }
}

function row(key: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[data-tree-key="${key}"]`)
  expect(element, `row ${key} 应已渲染`).not.toBeNull()
  return element!
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

async function contextMenuOn(element: HTMLElement, x = 30, y = 40): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }))
  })
}

async function pressKey(element: HTMLElement, key: string, init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
  })
}

/** R1 修复后菜单关闭的焦点还原是「微任务 + 条件接管」——断言焦点终态前先冲刷微任务队列。 */
async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

async function expandC1(): Promise<void> {
  await click(row('collection:c1'))
}

function menuElement(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[data-dsh-api-client="tree-context-menu"]')
}

function menuItems(): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>('[data-dsh-api-client="tree-context-menu"] [role="menuitem"]')]
}

function menuLabels(): string[] {
  return menuItems().map((item) => item.childNodes[0]?.textContent ?? '')
}

function menuItem(actionId: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-menu-action="${actionId}"]`)
}

async function clickMenuItem(actionId: string): Promise<void> {
  const item = menuItem(actionId)
  expect(item, `菜单项 ${actionId} 应存在`).not.toBeNull()
  await act(async () => {
    item!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

function stubSystemClipboard(writeText: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
}

function stubViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true })
}

function stubMenuRect(width: number, height: number): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.dshApiClient === 'tree-context-menu') {
      return { width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
    }
    return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
  })
}

// ---------- 1. menu_matrix_by_node_kind（§8.1#5 / AC-08/AC-17） ----------

describe('menu_matrix_by_node_kind：四种目标动作矩阵逐字（AC-08）', () => {
  it('树空白区 = 新建 Collection / 粘贴 / 全部展开（无剪贴板时粘贴禁用 + 中文原因）', async () => {
    await renderTree()
    const list = container.querySelector<HTMLElement>('[data-dsh-api-client="collection-tree-list"]')!
    await contextMenuOn(list)
    const menu = menuElement()
    expect(menu).not.toBeNull()
    expect(menu!.getAttribute('role')).toBe('menu')
    expect(menuLabels()).toEqual(['新建 Collection', '粘贴', '全部展开'])
    expect(menuItem('paste')!.getAttribute('aria-disabled')).toBe('true')
    expect(menuItem('paste')!.textContent).toContain('剪贴板没有内容')
    // 分组分隔线：create | clipboard | view
    expect(document.body.querySelectorAll('[data-dsh-api-client="tree-menu-separator"]')).toHaveLength(2)
  })

  it('Collection = 新建 Request / 新建 Folder / 重命名 / 复制 / 粘贴 / 删除（无剪切入口，AC-17）', async () => {
    await renderTree()
    await contextMenuOn(row('collection:c1'))
    expect(menuLabels()).toEqual(['新建 Request', '新建 Folder', '重命名', '复制', '粘贴', '删除'])
    expect(menuItem('cut')).toBeNull()
    // 分组分隔线：create | edit | clipboard | danger
    expect(document.body.querySelectorAll('[data-dsh-api-client="tree-menu-separator"]')).toHaveLength(3)
    // 危险项样式标记
    expect(menuItem('delete')!.dataset.menuAction).toBe('delete')
  })

  it('Folder = 新建 Request / 新建子 Folder / 重命名 / 复制 / 粘贴 / 删除（无剪切入口，AC-17）', async () => {
    await renderTree()
    await expandC1()
    await contextMenuOn(row('folder:f1'))
    expect(menuLabels()).toEqual(['新建 Request', '新建子 Folder', '重命名', '复制', '粘贴', '删除'])
    expect(menuItem('cut')).toBeNull()
  })

  it('Request = 打开 / 重命名 / 复制 / 剪切 / 粘贴到此请求之后 / 复制 URL / 复制为 cURL / 删除', async () => {
    await renderTree()
    await expandC1()
    await contextMenuOn(row('request:r1'))
    expect(menuLabels()).toEqual(['打开', '重命名', '复制', '剪切', '粘贴到此请求之后', '复制 URL', '复制为 cURL', '删除'])
    // 分组分隔线：open | edit | clipboard | export | danger
    expect(document.body.querySelectorAll('[data-dsh-api-client="tree-menu-separator"]')).toHaveLength(4)
    menuItems().forEach((item) => expect(item.getAttribute('role')).toBe('menuitem'))
  })

  it('右键只选中：不打开 Request、不 toggle、菜单出现', async () => {
    const { handlers } = await renderTree()
    await expandC1()
    await contextMenuOn(row('request:r1'))
    expect(handlers.onOpenRequest).not.toHaveBeenCalled()
    expect(row('request:r1').getAttribute('aria-selected')).toBe('true')
    expect(menuElement()).not.toBeNull()
    const folderBefore = row('folder:f1').getAttribute('aria-expanded')
    await contextMenuOn(row('folder:f1'))
    expect(row('folder:f1').getAttribute('aria-expanded')).toBe(folderBefore)
  })

  it('菜单「打开」触发 onOpenRequest；「删除」触发 onRequestDelete（绝不直接删）', async () => {
    const { collections, handlers } = await renderTree()
    await expandC1()
    await contextMenuOn(row('request:r1'))
    await clickMenuItem('open')
    await flushMicrotasks()
    expect(vi.mocked(handlers.onOpenRequest)).toHaveBeenCalledTimes(1)
    expect(menuElement()).toBeNull()

    await contextMenuOn(row('request:r1'))
    await clickMenuItem('delete')
    await flushMicrotasks()
    expect(vi.mocked(handlers.onRequestDelete)).toHaveBeenCalledTimes(1)
    expect(collections.deleteRequest).not.toHaveBeenCalled()
  })
})

// ---------- 2. paste 可用性矩阵（§6.5 逐字 / AC-19） ----------

describe('pasteEnablement：§6.5 静态矩阵与中文原因', () => {
  const cb = (operation: 'copy' | 'cut', kind: 'collection' | 'folder' | 'request', expiresAt = Date.now() + 60_000): TreeClipboardDescriptor => ({
    token: 't',
    operation,
    kind,
    expiresAt,
  })

  it('矩阵逐字：Copy Collection→root/collection；Copy Folder→collection/folder；Copy/Cut Request→collection/folder/request；其余禁用', () => {
    const expectations: Array<[TreeClipboardDescriptor, Record<string, boolean>]> = [
      [cb('copy', 'collection'), { root: true, collection: true, folder: false, request: false }],
      [cb('copy', 'folder'), { root: false, collection: true, folder: true, request: false }],
      [cb('copy', 'request'), { root: false, collection: true, folder: true, request: true }],
      [cb('cut', 'request'), { root: false, collection: true, folder: true, request: true }],
    ]
    for (const [clipboard, allowed] of expectations) {
      for (const [targetKind, enabled] of Object.entries(allowed)) {
        const result = computePasteEnablement(clipboard, { kind: targetKind as 'root' })
        expect(result.enabled, `${clipboard.operation}-${clipboard.kind} → ${targetKind}`).toBe(enabled)
      }
    }
  })

  it('禁用原因为中文具体目标（设计 §6.5 示例逐字）', () => {
    expect(computePasteEnablement(cb('copy', 'folder'), { kind: 'request' }).reason).toBe('当前剪贴板内容只能粘贴到 Collection 或 Folder')
    expect(computePasteEnablement(cb('copy', 'collection'), { kind: 'folder' }).reason).toBe('当前剪贴板内容只能粘贴到 根空白区 或 Collection')
    expect(computePasteEnablement(cb('cut', 'request'), { kind: 'root' }).reason).toBe('当前剪贴板内容只能粘贴到 Collection 或 Folder 或 Request')
  })

  it('无内容 / 已过期（§0.3 本地判定）', () => {
    expect(computePasteEnablement(undefined, { kind: 'root' })).toEqual({ enabled: false, reason: '剪贴板没有内容' })
    const expired = cb('copy', 'request', 1000)
    expect(computePasteEnablement(expired, { kind: 'collection' }, 2000)).toEqual({ enabled: false, reason: '剪贴板已过期' })
  })

  it('菜单内联禁用原因：Copy Collection → Folder 目标；过期 → 「剪贴板已过期」；Cut → 根菜单禁用', async () => {
    await renderTree({ clipboard: clipboardDescriptor({ operation: 'copy', kind: 'collection' }) })
    await expandC1()
    await contextMenuOn(row('folder:f1'))
    expect(menuItem('paste')!.getAttribute('aria-disabled')).toBe('true')
    expect(menuItem('paste')!.textContent).toContain('当前剪贴板内容只能粘贴到 根空白区 或 Collection')

    // 重渲染复用同一组件实例（展开态保留）：只换 clipboard 描述符。
    await pressKey(document.activeElement as HTMLElement, 'Escape')
    await flushMicrotasks()
    await renderTree({ clipboard: clipboardDescriptor({ expiresAt: Date.now() - 1000 }) })
    await contextMenuOn(row('folder:f1'))
    expect(menuItem('paste')!.textContent).toContain('剪贴板已过期')

    await pressKey(document.activeElement as HTMLElement, 'Escape')
    await flushMicrotasks()
    await renderTree({ clipboard: clipboardDescriptor({ operation: 'cut', kind: 'request' }) })
    const list = container.querySelector<HTMLElement>('[data-dsh-api-client="collection-tree-list"]')!
    await contextMenuOn(list)
    expect(menuItem('paste')!.getAttribute('aria-disabled')).toBe('true')
    expect(menuItem('paste')!.textContent).toContain('当前剪贴板内容只能粘贴到 Collection 或 Folder 或 Request')
  })

  it('合法目标粘贴：paste 收到 §3.1 完整入参（targetId/targetCollectionId/expectedTargetCollectionUpdatedAt）', async () => {
    const { clipboard } = await renderTree({ clipboard: clipboardDescriptor({ operation: 'copy', kind: 'request' }) })
    await expandC1()
    await contextMenuOn(row('folder:f1'))
    await clickMenuItem('paste')
    await flushMicrotasks()
    expect(vi.mocked(clipboard.paste)).toHaveBeenCalledWith({ kind: 'folder', targetId: 'f1', targetCollectionId: 'c1', expectedTargetCollectionUpdatedAt: 1000 })
    expect(menuElement()).toBeNull()
  })

  it('R-02：Request 菜单「粘贴到此请求之后」→ 目标 = 该 Request 自身（插在其后，§4.6 冻结矩阵），与键盘 Cmd+V 路径一致', async () => {
    // ≥3 个 sibling 的容器、锚点取中间 r3：targetKind:'request' 的语义按冻结矩阵 =
    // 「插在目标 Request 之后」（新节点紧跟锚点而非容器末尾——插入位置本身归 Host
    // 契约，p0-host-tree-api.spec 已验证；client 侧断言入参正确且鼠标/键盘一致）。
    const wide = fixture()
    wide[0]!.requests = [makeRequest('r1', '订单列表'), makeRequest('r3', '订单详情'), makeRequest('r4', '订单取消')]
    const { clipboard } = await renderTree({
      collections: { collections: wide },
      clipboard: clipboardDescriptor({ operation: 'copy', kind: 'request' }),
    })
    await expandC1()
    await contextMenuOn(row('request:r3'))
    expect(menuLabels()).toContain('粘贴到此请求之后')
    await clickMenuItem('paste')
    await flushMicrotasks()
    const expectedTarget = { kind: 'request', targetId: 'r3', targetCollectionId: 'c1', expectedTargetCollectionUpdatedAt: 1000 }
    expect(vi.mocked(clipboard.paste)).toHaveBeenCalledWith(expectedTarget)
    // 键盘 Cmd+V 同节点同入参（修复前：菜单走容器末尾目标、键盘走 request 目标——同一节点两种数据结果）。
    await pressKey(row('request:r3'), 'v', { metaKey: true })
    await act(async () => {})
    expect(vi.mocked(clipboard.paste)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(clipboard.paste)).toHaveBeenLastCalledWith(expectedTarget)
  })
})

// ---------- 3. menu_close_focus_and_bounds（§8.1#6 / AC-09/AC-10） ----------

describe('menu_close_focus_and_bounds：关闭条件全枚举', () => {
  it('Esc 关闭且焦点还原到原树行', async () => {
    await renderTree()
    await contextMenuOn(row('collection:c1'))
    expect(menuElement()).not.toBeNull()
    // 打开时焦点已进入第一个可用项（R2：落位可见后投放）
    expect(document.activeElement).toBe(menuItem('new-request'))
    await pressKey(document.activeElement as HTMLElement, 'Escape')
    await flushMicrotasks()
    expect(menuElement()).toBeNull()
    expect(document.activeElement).toBe(row('collection:c1'))
  })

  it('outside click（mousedown）关闭', async () => {
    await renderTree()
    await contextMenuOn(row('collection:c1'))
    await act(async () => {
      container.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    await flushMicrotasks()
    expect(menuElement()).toBeNull()
  })

  it('菜单内 mousedown 不关闭', async () => {
    await renderTree()
    await contextMenuOn(row('collection:c1'))
    await act(async () => {
      menuElement()!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(menuElement()).not.toBeNull()
  })

  it('树滚动关闭', async () => {
    await renderTree()
    await contextMenuOn(row('collection:c1'))
    await act(async () => {
      container.querySelector<HTMLElement>('[data-dsh-api-client="collection-tree-list"]')!.dispatchEvent(new Event('scroll'))
    })
    await flushMicrotasks()
    expect(menuElement()).toBeNull()
  })

  it('window resize 关闭', async () => {
    await renderTree()
    await contextMenuOn(row('collection:c1'))
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
    })
    await flushMicrotasks()
    expect(menuElement()).toBeNull()
  })

  it('动作成功后关闭', async () => {
    const { clipboard } = await renderTree()
    await contextMenuOn(row('collection:c1'))
    await clickMenuItem('copy')
    await flushMicrotasks()
    expect(clipboard.copy).toHaveBeenCalledTimes(1)
    expect(menuElement()).toBeNull()
  })

  it('动作失败（onRun reject）后同样关闭', async () => {
    const onClose = vi.fn()
    await act(async () => {
      root.render(
        createElement(TreeContextMenu, {
          items: [
            {
              id: 'boom',
              label: '会失败',
              group: 'create',
              onRun: async () => {
                throw new Error('action failed')
              },
            },
          ] satisfies TreeMenuItem[],
          anchor: { x: 10, y: 10 },
          onClose,
        }),
      )
    })
    await clickMenuItem('boom')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('pane 切换（组件卸载）：portal 菜单随之移除', async () => {
    await renderTree()
    await contextMenuOn(row('collection:c1'))
    expect(menuElement()).not.toBeNull()
    await act(async () => {
      root.unmount()
    })
    expect(document.body.querySelector('[data-dsh-api-client="tree-context-menu"]')).toBeNull()
    // 重新挂载（afterEach 的 unmount 幂等）
    root = createRoot(container)
  })
})

// ---------- 3b. R1 焦点交接：菜单关闭不抢对话框已承接的焦点 ----------

describe('R1 焦点交接：菜单 → 对话框路径终态焦点归对话框，非对话框路径归还树行', () => {
  it('焦点已被菜单外有意义目标承接时，关闭菜单不抢回（交接规则，jsdom 可判定）', async () => {
    await renderTree()
    await contextMenuOn(row('collection:c1'))
    expect(menuElement()).not.toBeNull()
    // 模拟 Modal initialFocus 已落位的终态：焦点在菜单外的已连接元素（以搜索框代言）。
    const search = container.querySelector<HTMLElement>('[data-dsh-api-client="tree-search"]')!
    act(() => {
      search.focus()
    })
    await act(async () => {
      container.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    await flushMicrotasks()
    expect(menuElement()).toBeNull()
    // 修复前：closeMenu 同步 focusRow 把焦点抢回树行。
    expect(document.activeElement).toBe(search)
  })

  it('菜单 → 新建 Folder 对话框：终态焦点 = 名称输入框（真实浏览器验收项——jsdom act 会推迟 passive effect 冲刷、无法复刻浏览器内「setMenu 同步冲刷 Modal initialFocus → 旧 focusRow 抢回」的时序，本断言为同向锚点，机制回归由上一用例钉死）', async () => {
    await renderTree()
    await contextMenuOn(row('collection:c1'))
    await clickMenuItem('new-folder')
    await flushMicrotasks()
    const input = document.body.querySelector<HTMLElement>('[data-dsh-api-client="tree-create-input"]')
    expect(input).not.toBeNull()
    expect(document.activeElement).toBe(input)
    expect(document.activeElement).not.toBe(row('collection:c1'))
  })

  it('非对话框动作（复制）：菜单关闭后焦点仍归还原树行（不回归）', async () => {
    const { clipboard } = await renderTree()
    await contextMenuOn(row('collection:c1'))
    await clickMenuItem('copy')
    await flushMicrotasks()
    expect(clipboard.copy).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(row('collection:c1'))
  })

  it('根菜单（无原行）关闭：焦点归还树容器', async () => {
    await renderTree()
    const list = container.querySelector<HTMLElement>('[data-dsh-api-client="collection-tree-list"]')!
    await contextMenuOn(list)
    expect(menuElement()).not.toBeNull()
    await pressKey(document.activeElement as HTMLElement, 'Escape')
    await flushMicrotasks()
    expect(menuElement()).toBeNull()
    expect(document.activeElement).toBe(list)
  })
})

describe('menu_close_focus_and_bounds：定位 4px 边界 / 翻转 / 超高滚动（AC-09）', () => {
  beforeEach(() => {
    stubViewport(1200, 800)
  })

  it('computeMenuPlacement：右/下不足翻转；翻转越界钳到边界+4px；高度不足压缩 maxHeight', () => {
    const boundary = { left: 0, top: 0, right: 400, bottom: 400 }
    // 右侧不足 → 向左翻
    expect(computeMenuPlacement({ x: 390, y: 10 }, 200, 100, boundary)).toEqual({ left: 190, top: 10 })
    // 翻转后仍越左界 → 钳到 4px
    expect(computeMenuPlacement({ x: 50, y: 10 }, 200, 100, { left: 0, top: 0, right: 240, bottom: 400 })).toEqual({ left: 4, top: 10 })
    // 下侧不足 → 向上翻
    expect(computeMenuPlacement({ x: 10, y: 390 }, 200, 100, boundary)).toEqual({ left: 10, top: 290 })
    // 翻转后仍越上界 → 钳到 4px + maxHeight 压缩
    expect(computeMenuPlacement({ x: 10, y: 50 }, 200, 300, { left: 0, top: 0, right: 400, bottom: 100 })).toEqual({ left: 10, top: 4, maxHeight: 92 })
  })

  it('视口右缘：菜单 fixed 定位翻转后完整位于视口内 ≥4px', async () => {
    stubViewport(400, 400)
    stubMenuRect(200, 100)
    await act(async () => {
      root.render(
        createElement(TreeContextMenu, {
          items: [{ id: 'a', label: '动作', group: 'create', onRun: () => {} }] satisfies TreeMenuItem[],
          anchor: { x: 390, y: 10 },
          onClose: vi.fn(),
        }),
      )
    })
    const menu = menuElement()!
    expect(menu.style.position).toBe('fixed')
    expect(menu.style.left).toBe('190px')
    expect(menu.style.top).toBe('10px')
    // 右缘约束：left + width ≤ innerWidth - 4
    expect(parseFloat(menu.style.left) + 200).toBeLessThanOrEqual(400 - 4)
  })

  it('视口下缘超高：翻转钳顶 + maxHeight + overflow-y:auto（所有项可滚动到达）', async () => {
    stubViewport(400, 100)
    stubMenuRect(200, 300)
    await act(async () => {
      root.render(
        createElement(TreeContextMenu, {
          items: [{ id: 'a', label: '动作', group: 'create', onRun: () => {} }] satisfies TreeMenuItem[],
          anchor: { x: 10, y: 50 },
          onClose: vi.fn(),
        }),
      )
    })
    const menu = menuElement()!
    expect(menu.style.top).toBe('4px')
    expect(menu.style.maxHeight).toBe('92px')
    expect(menu.style.overflowY).toBe('auto')
  })

  it('boundaryRef = API Client 可视容器：定位钳制在容器内 ≥4px（不用视口）', async () => {
    stubViewport(1200, 800)
    stubMenuRect(200, 100)
    const boundaryElement = document.createElement('div')
    document.body.appendChild(boundaryElement)
    boundaryElement.getBoundingClientRect = (): DOMRect =>
      ({ left: 100, top: 50, right: 500, bottom: 400, width: 400, height: 350, x: 100, y: 50, toJSON: () => ({}) }) as DOMRect
    const boundaryRef = { current: boundaryElement }
    await act(async () => {
      root.render(
        createElement(TreeContextMenu, {
          items: [{ id: 'a', label: '动作', group: 'create', onRun: () => {} }] satisfies TreeMenuItem[],
          anchor: { x: 495, y: 395 },
          boundaryRef,
          onClose: vi.fn(),
        }),
      )
    })
    const menu = menuElement()!
    // 右/下均翻转：left = 495-200 = 295；top = 395-100 = 295——且在容器内 ≥4px。
    expect(menu.style.left).toBe('295px')
    expect(menu.style.top).toBe('295px')
    expect(parseFloat(menu.style.left)).toBeGreaterThanOrEqual(100 + 4)
    expect(parseFloat(menu.style.left) + 200).toBeLessThanOrEqual(500 - 4)
    expect(parseFloat(menu.style.top)).toBeGreaterThanOrEqual(50 + 4)
    expect(parseFloat(menu.style.top) + 100).toBeLessThanOrEqual(400 - 4)
    boundaryElement.remove()
  })
})

describe('menu_close_focus_and_bounds：焦点进入/移动/还原与 pending 防重复（AC-10）', () => {
  beforeEach(() => {
    stubViewport(1200, 800)
  })

  function menuFixtureItems(overrides: { onRunA?: () => void | Promise<void>; disabledB?: boolean } = {}): TreeMenuItem[] {
    return [
      { id: 'a', label: '动作A', group: 'create', onRun: overrides.onRunA ?? (() => {}) },
      { id: 'b', label: '动作B', group: 'edit', disabled: overrides.disabledB ?? true, disabledReason: '当前不可用', onRun: () => {} },
      { id: 'c', label: '动作C', group: 'danger', onRun: () => {} },
    ]
  }

  async function renderDirectMenu(items: TreeMenuItem[], onClose = vi.fn()): Promise<void> {
    await act(async () => {
      root.render(createElement(TreeContextMenu, { items, anchor: { x: 100, y: 100 }, onClose }))
    })
  }

  it('打开焦点进第一个可用项；↑↓ 跳过禁用项循环移动；Home/End 首尾', async () => {
    await renderDirectMenu(menuFixtureItems())
    expect(document.activeElement).toBe(menuItem('a'))
    await pressKey(document.activeElement as HTMLElement, 'ArrowDown')
    expect(document.activeElement).toBe(menuItem('c')) // 跳过禁用的 b
    await pressKey(document.activeElement as HTMLElement, 'ArrowDown')
    expect(document.activeElement).toBe(menuItem('a')) // 循环
    await pressKey(document.activeElement as HTMLElement, 'End')
    expect(document.activeElement).toBe(menuItem('c'))
    await pressKey(document.activeElement as HTMLElement, 'Home')
    expect(document.activeElement).toBe(menuItem('a'))
    await pressKey(document.activeElement as HTMLElement, 'ArrowUp')
    expect(document.activeElement).toBe(menuItem('c')) // 反向循环
  })

  it('Enter 执行聚焦项并关闭', async () => {
    const onRunA = vi.fn()
    const onClose = vi.fn()
    await renderDirectMenu(menuFixtureItems({ onRunA }), onClose)
    await pressKey(document.activeElement as HTMLElement, 'Enter')
    expect(onRunA).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('禁用项 Enter/点击不执行', async () => {
    const onClose = vi.fn()
    await renderDirectMenu(menuFixtureItems(), onClose)
    await act(async () => {
      menuItem('b')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(onClose).not.toHaveBeenCalled()
    expect(menuElement()).not.toBeNull()
  })

  it('全部禁用：打开不崩溃、焦点落菜单容器（键盘契约兜底承接点，R2）', async () => {
    await renderDirectMenu([
      { id: 'x', label: 'X', group: 'create', disabled: true, disabledReason: '不可用', onRun: () => {} },
    ])
    expect(menuElement()).not.toBeNull()
    expect(document.activeElement).toBe(menuElement())
    expect(document.activeElement).not.toBe(menuItem('x'))
  })

  it('pending 防重复：执行中全部项 aria-disabled、忙碌标记、重复点击不再触发；settle 后关闭', async () => {
    let resolveRun: () => void = () => {}
    const onRunA = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRun = resolve
        }),
    )
    const onRunC = vi.fn()
    const onClose = vi.fn()
    await renderDirectMenu(
      [
        { id: 'a', label: '动作A', group: 'create', onRun: onRunA },
        { id: 'c', label: '动作C', group: 'danger', onRun: onRunC },
      ],
      onClose,
    )
    await act(async () => {
      menuItem('a')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(onRunA).toHaveBeenCalledTimes(1)
    expect(menuItem('a')!.textContent).toBe('动作A…')
    expect(menuItem('a')!.getAttribute('aria-disabled')).toBe('true')
    expect(menuItem('c')!.getAttribute('aria-disabled')).toBe('true')
    // 重复点击其他项与同项均被抑制
    await act(async () => {
      menuItem('c')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      menuItem('a')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(onRunC).not.toHaveBeenCalled()
    expect(onRunA).toHaveBeenCalledTimes(1)
    await act(async () => {
      resolveRun()
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('菜单执行 mutation 期间树只读导航仍可用（仅菜单与目标行 pending）', async () => {
    let resolveCopy: (value: boolean) => void = () => {}
    const clipboard = fakeClipboard(undefined)
    vi.mocked(clipboard.copy).mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveCopy = resolve
        }),
    )
    const collections = fakeCollections()
    await act(async () => {
      root.render(createElement(CollectionTree, { collections, clipboard, handlers: fakeHandlers() }))
    })
    await contextMenuOn(row('collection:c1'))
    await act(async () => {
      menuItem('copy')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    // 目标行进入 pending（state-slot 忙碌指示），菜单仍开着
    expect(row('collection:c1').getAttribute('aria-busy')).toBe('true')
    expect(menuElement()).not.toBeNull()
    // 树其他只读导航仍可用：c2 行可点击 toggle（选择/展开不被阻塞）
    await click(row('collection:c2'))
    expect(row('collection:c2').getAttribute('aria-selected')).toBe('true')
    await act(async () => {
      resolveCopy(true)
    })
    await flushMicrotasks()
  })
})

// ---------- 4. 复制 URL / 复制为 cURL（§5.10 / UX §6.4） ----------

describe('复制 URL / 复制为 cURL：系统剪贴板 + redaction（§5.10）', () => {
  async function renderSecretTree(environment?: Environment): Promise<Rendered> {
    const collections = fakeCollections({ collections: secretFixture() })
    const clipboard = fakeClipboard(undefined)
    const handlers = fakeHandlers()
    await act(async () => {
      root.render(
        createElement(CollectionTree, {
          collections,
          clipboard,
          handlers,
          ...(environment !== undefined ? { environment } : {}),
        }),
      )
    })
    return { collections, clipboard, handlers }
  }

  it('复制 URL：secret 环境变量引用 → <redacted>；普通变量保留 {{name}}；写入系统剪贴板', async () => {
    const writeText = vi.fn(async (_text: string) => {})
    stubSystemClipboard(writeText)
    await renderSecretTree(secretEnvironment())
    await expandC1()
    await contextMenuOn(row('request:r1'))
    await clickMenuItem('copy-url')
    expect(writeText).toHaveBeenCalledTimes(1)
    const text = writeText.mock.calls[0]![0] as string
    expect(text).toContain('tk=<redacted>')
    expect(text).toContain('{{basePath}}')
    expect(text).not.toContain('{{secretToken}}')
    expect(text).not.toContain('sec-ref-1')
    expect(toastMocks.info).toHaveBeenCalledWith('已复制 URL')
    expect(menuElement()).toBeNull()
  })

  it('复制为 cURL：POSIX 引号 + 敏感 Header 字面量 <redacted> + secret 引用 <redacted>；真实值零出现', async () => {
    const writeText = vi.fn(async (_text: string) => {})
    stubSystemClipboard(writeText)
    await renderSecretTree(secretEnvironment())
    await expandC1()
    await contextMenuOn(row('request:r1'))
    await clickMenuItem('copy-curl')
    expect(writeText).toHaveBeenCalledTimes(1)
    const text = writeText.mock.calls[0]![0] as string
    expect(text.startsWith('curl -X GET ')).toBe(true)
    expect(text).toContain("'Authorization: <redacted>'")
    expect(text).toContain("'X-Trace: trace-1'")
    expect(text).toContain('--data-raw')
    expect(text).toContain('{"pin":"<redacted>"}')
    // 真实敏感值零出现（秘密边界红线）
    expect(text).not.toContain('literal-token-xyz')
    expect(text).not.toContain('sec-ref-1')
    expect(toastMocks.info).toHaveBeenCalledWith('已复制 cURL')
  })

  it('environment 上下文缺省：按 buildCurlCommand 默认 redaction 行为——未解析变量保留 {{name}}（不伪造）', async () => {
    const writeText = vi.fn(async (_text: string) => {})
    stubSystemClipboard(writeText)
    await renderSecretTree(undefined)
    await expandC1()
    await contextMenuOn(row('request:r1'))
    await clickMenuItem('copy-url')
    const text = writeText.mock.calls[0]![0] as string
    expect(text).toContain('{{secretToken}}')
    expect(text).toContain('{{basePath}}')
  })

  it('剪贴板写入失败：中文 toast、不改选择、菜单正常关闭', async () => {
    const writeText = vi.fn(async (_text: string) => {
      throw new Error('denied')
    })
    stubSystemClipboard(writeText)
    await renderSecretTree(secretEnvironment())
    await expandC1()
    await contextMenuOn(row('request:r1'))
    await clickMenuItem('copy-url')
    expect(toastMocks.error).toHaveBeenCalledWith('复制 URL 到系统剪贴板失败')
    expect(row('request:r1').getAttribute('aria-selected')).toBe('true')
    expect(menuElement()).toBeNull()
  })

  it('navigator.clipboard 不可用：中文降级 toast，不抛异常', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    await renderSecretTree(secretEnvironment())
    await expandC1()
    await contextMenuOn(row('request:r1'))
    await clickMenuItem('copy-curl')
    expect(toastMocks.error).toHaveBeenCalledWith('当前环境不支持系统剪贴板，无法复制 cURL')
  })
})

// ---------- 5. useTreeClipboard 真实钩子（mock fetch）：AC-13 + §0.3 + §13.1 ----------

describe('useTreeClipboard（mock fetch）：四字段状态、Cut 源删除清空、paste 生命周期', () => {
  interface FetchCall {
    method: string
    url: string
    init?: RequestInit
  }

  let fetchMock: ReturnType<typeof vi.fn>
  let calls: FetchCall[]
  let captured: TreeClipboardApi | undefined

  function mockResponse(status: number, body?: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (body === undefined ? '' : JSON.stringify(body)),
    } as unknown as Response
  }

  type RouteHandler = (call: FetchCall) => Response | Promise<Response>

  function routeFetch(routes: Array<[matcher: RegExp, handler: RouteHandler]>): void {
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

  /** 简化 bridge：成功 → committed/refreshed；失败 → 携带原始 HostApiError（cause）。 */
  const bridge: TreeClipboardBridge = {
    runMutation: async (action) => {
      try {
        return { result: await action(), committed: true, refreshed: true }
      } catch (cause) {
        return { result: undefined, committed: false, refreshed: false, cause }
      }
    },
  }

  function ClipHarness(): null {
    captured = useTreeClipboard(bridge)
    return null
  }

  let capturedCollections: CollectionsState | undefined

  /** R-08 回归：真实 useCollections × 真实 useTreeClipboard（WP8 接线同形态）。 */
  function CombinedHarness(): null {
    const collections = useCollections()
    capturedCollections = collections
    captured = useTreeClipboard({ runMutation: collections.runMutation })
    return null
  }

  async function renderCombinedHook(): Promise<void> {
    await act(async () => {
      root.render(createElement(CombinedHarness))
    })
  }

  beforeEach(() => {
    calls = []
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    ;(globalThis as Record<string, unknown>)[TOKEN_GLOBAL_NAME] = { base: '/api-client', token: 'test-token' }
    captured = undefined
    capturedCollections = undefined
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete (globalThis as Record<string, unknown>)[TOKEN_GLOBAL_NAME]
  })

  async function renderHook(): Promise<void> {
    await act(async () => {
      root.render(createElement(ClipHarness))
    })
  }

  const cutRoutes: Array<[RegExp, RouteHandler]> = [
    [
      /POST .*\/tree\/clipboard\/cut$/,
      () => mockResponse(200, { token: 'tk-cut', operation: 'cut', kind: 'request', expiresAt: Date.now() + 1_800_000 }),
    ],
    [/DELETE .*\/tree\/clipboard\//, () => mockResponse(204)],
  ]

  async function performCut(): Promise<void> {
    await act(async () => {
      await captured!.cut({ requestId: 'r1', requestUpdatedAt: 100, sourceCollectionUpdatedAt: 1000 })
    })
  }

  it('cut 成功后 Client 状态恰好四字段（AC-13：无 snapshot/源节点 id/业务内容）', async () => {
    routeFetch(cutRoutes)
    await renderHook()
    expect(captured!.clipboard).toBeUndefined()
    await performCut()
    const state = captured!.clipboard
    expect(state).toBeDefined()
    expect(Object.keys(state!).sort()).toEqual(['expiresAt', 'kind', 'operation', 'token'])
    expect(state!.operation).toBe('cut')
    expect(state!.kind).toBe('request')
    // cut 端点入参 = §3.1 契约
    const post = calls.find((call) => call.method === 'POST')!
    expect(JSON.parse(String(post.init?.body))).toEqual({ requestId: 'r1', requestUpdatedAt: 100, sourceCollectionUpdatedAt: 1000 })
  })

  it('§0.3：本 Client 删除 Cut 源 → 立即清空本地 token；删除其他 Request 不影响', async () => {
    routeFetch(cutRoutes)
    await renderHook()
    await performCut()
    expect(captured!.clipboard).toBeDefined()
    // 删除其他请求：不清空
    await act(async () => {
      captured!.notifyLocalRequestsDeleted(['r-other'])
    })
    expect(captured!.clipboard).toBeDefined()
    // 删除 Cut 源：立即清空 + 中文提示 + best-effort Host 清空（DELETE 幂等）
    await act(async () => {
      captured!.notifyLocalRequestsDeleted(['r1', 'r-x'])
    })
    expect(captured!.clipboard).toBeUndefined()
    expect(captured!.pasteEnablement({ kind: 'collection' })).toEqual({ enabled: false, reason: '剪贴板没有内容' })
    expect(toastMocks.info).toHaveBeenCalledWith('剪切来源已被删除，剪贴板已清空')
    expect(calls.some((call) => call.method === 'DELETE' && call.url.includes('/tree/clipboard/tk-cut'))).toBe(true)
  })

  it('级联删除（Folder/Collection 内含 Cut 源）同样清空', async () => {
    routeFetch(cutRoutes)
    await renderHook()
    await performCut()
    await act(async () => {
      captured!.notifyLocalRequestsDeleted(['r-a', 'r1', 'r-b'])
    })
    expect(captured!.clipboard).toBeUndefined()
  })

  it('Cut paste 成功 consumed=true → 本地清空；Copy paste consumed=false → token 保留可重复粘贴', async () => {
    routeFetch([
      ...cutRoutes,
      [/POST .*\/tree\/clipboard\/tk-cut\/paste$/, () => mockResponse(200, { operation: 'cut', kind: 'request', consumed: true })],
      [/POST .*\/tree\/clipboard\/copy$/, () => mockResponse(200, { token: 'tk-copy', operation: 'copy', kind: 'request', expiresAt: Date.now() + 1_800_000 })],
      [/POST .*\/tree\/clipboard\/tk-copy\/paste$/, () => mockResponse(200, { operation: 'copy', kind: 'request', consumed: false })],
    ])
    await renderHook()
    await performCut()
    let pasted = false
    await act(async () => {
      pasted = await captured!.paste({ kind: 'collection', targetId: 'c2', targetCollectionId: 'c2', expectedTargetCollectionUpdatedAt: 2000 })
    })
    expect(pasted).toBe(true)
    expect(captured!.clipboard).toBeUndefined()
    expect(toastMocks.info).toHaveBeenCalledWith('移动完成')
    // paste 请求体 = §3.1 入参
    const pasteCall = calls.find((call) => call.url.includes('/tk-cut/paste'))!
    expect(JSON.parse(String(pasteCall.init?.body))).toEqual({
      targetKind: 'collection',
      targetId: 'c2',
      targetCollectionId: 'c2',
      expectedTargetCollectionUpdatedAt: 2000,
    })

    await act(async () => {
      await captured!.copy({ kind: 'request', collectionId: 'c1', nodeId: 'r1' })
    })
    await act(async () => {
      pasted = await captured!.paste({ kind: 'folder', targetId: 'f1', targetCollectionId: 'c1', expectedTargetCollectionUpdatedAt: 1000 })
    })
    expect(pasted).toBe(true)
    expect(captured!.clipboard?.token).toBe('tk-copy') // Copy token 可重复粘贴
    expect(toastMocks.info).toHaveBeenCalledWith('粘贴完成')
  })

  it('R-01：Cut paste 目标版本 409 → token 保留（Host §3.1.1 不消费），刷新后同 token 重试成功并消费', async () => {
    let pasteCount = 0
    routeFetch([
      ...cutRoutes,
      [
        /POST .*\/tree\/clipboard\/tk-cut\/paste$/,
        () => {
          pasteCount += 1
          // 第一次：目标 Collection 版本冲突（可恢复——刷新后换新 expected 重试）；第二次：成功。
          return pasteCount === 1
            ? mockResponse(409, { error: { code: 'version-conflict', message: '数据已被其他操作修改，请刷新后重试' } })
            : mockResponse(200, { operation: 'cut', kind: 'request', consumed: true })
        },
      ],
    ])
    await renderHook()
    await performCut()
    let pasted = true
    await act(async () => {
      pasted = await captured!.paste({ kind: 'collection', targetId: 'c2', targetCollectionId: 'c2', expectedTargetCollectionUpdatedAt: 2000 })
    })
    expect(pasted).toBe(false)
    // 409 一律保留 token（修复前：误清空 + 「请重新剪切」，把可恢复的目标冲突打成不可恢复态）。
    expect(captured!.clipboard?.token).toBe('tk-cut')
    expect(toastMocks.info).not.toHaveBeenCalledWith('剪切内容已无法粘贴，请重新剪切')
    // 刷新（§4.9 stale 流程归真实 runMutation——本 fake bridge 不触发）后以新 expected 重试：同 token 成功且 consumed → 本地清空。
    await act(async () => {
      pasted = await captured!.paste({ kind: 'collection', targetId: 'c2', targetCollectionId: 'c2', expectedTargetCollectionUpdatedAt: 2001 })
    })
    expect(pasted).toBe(true)
    expect(captured!.clipboard).toBeUndefined()
    const pasteCalls = calls.filter((call) => call.url.includes('/tk-cut/paste'))
    expect(pasteCalls).toHaveLength(2)
    expect(pasteCalls[0]!.url).toBe(pasteCalls[1]!.url) // 同一 token
    expect(JSON.parse(String(pasteCalls[1]!.init?.body))).toEqual({
      targetKind: 'collection',
      targetId: 'c2',
      targetCollectionId: 'c2',
      expectedTargetCollectionUpdatedAt: 2001,
    })
  })

  it('R-01：Cut paste 源已被外部删除（404 request-not-found）→ 按 §0.3 清空 token + 中文提示', async () => {
    routeFetch([
      ...cutRoutes,
      [/POST .*\/tree\/clipboard\/tk-cut\/paste$/, () => mockResponse(404, { error: { code: 'request-not-found', message: 'request not found: r1' } })],
    ])
    await renderHook()
    await performCut()
    let pasted = true
    await act(async () => {
      pasted = await captured!.paste({ kind: 'collection', targetId: 'c2', targetCollectionId: 'c2', expectedTargetCollectionUpdatedAt: 2000 })
    })
    expect(pasted).toBe(false)
    expect(captured!.clipboard).toBeUndefined()
    expect(toastMocks.info).toHaveBeenCalledWith('剪切来源已被删除，剪贴板已清空')
  })

  it('paste 404 clipboard-not-found（Host 重启/过期）→ 本地同步清空', async () => {
    routeFetch([
      ...cutRoutes,
      [/POST .*\/tree\/clipboard\/tk-cut\/paste$/, () => mockResponse(404, { error: { code: 'clipboard-not-found', message: '剪贴板内容不存在或已过期' } })],
    ])
    await renderHook()
    await performCut()
    await act(async () => {
      await captured!.paste({ kind: 'collection', targetId: 'c2', targetCollectionId: 'c2', expectedTargetCollectionUpdatedAt: 2000 })
    })
    expect(captured!.clipboard).toBeUndefined()
  })

  it('本地预判：过期 token 与矩阵非法目标不发请求（§0.3）', async () => {
    routeFetch([
      [/POST .*\/tree\/clipboard\/copy$/, () => mockResponse(200, { token: 'tk-exp', operation: 'copy', kind: 'collection', expiresAt: Date.now() - 1 })],
    ])
    await renderHook()
    await act(async () => {
      await captured!.copy({ kind: 'collection', collectionId: 'c1' })
    })
    const postsBefore = calls.filter((call) => call.method === 'POST').length
    await act(async () => {
      expect(await captured!.paste({ kind: 'root' })).toBe(false)
    })
    expect(toastMocks.error).toHaveBeenCalledWith('剪贴板已过期')
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(postsBefore)
  })

  it('clear：本地清空 + Host DELETE（幂等）', async () => {
    routeFetch(cutRoutes)
    await renderHook()
    await performCut()
    await act(async () => {
      await captured!.clear()
    })
    expect(captured!.clipboard).toBeUndefined()
    expect(calls.some((call) => call.method === 'DELETE' && call.url.includes('/tree/clipboard/tk-cut'))).toBe(true)
  })

  it('R-08：copy 成功 → 零 GET /collections、不置 stale（只建 Host 内存 clipboard entry）', async () => {
    let getCount = 0
    routeFetch([
      [
        /GET .*\/collections$/,
        () => {
          getCount += 1
          // 「GET 失败不产生 stale」的更强形态：copy 后若仍发起刷新，这里直接抛错——
          // 修复前的 runMutation 路径会吃到该失败并置 stale=true，下方断言即红。
          if (getCount > 1) throw new Error('copy 后不应刷新投影')
          return mockResponse(200, fixture())
        },
      ],
      [/POST .*\/tree\/clipboard\/copy$/, () => mockResponse(200, { token: 'tk-copy', operation: 'copy', kind: 'collection', expiresAt: Date.now() + 1_800_000 })],
    ])
    await renderCombinedHook()
    expect(getCount).toBe(1) // 仅初始加载
    let copied = false
    await act(async () => {
      copied = await captured!.copy({ kind: 'collection', collectionId: 'c1' })
    })
    expect(copied).toBe(true)
    expect(getCount).toBe(1) // copy 后零刷新
    expect(capturedCollections!.stale).toBe(false)
    expect(captured!.clipboard?.token).toBe('tk-copy')
    expect(toastMocks.info).toHaveBeenCalledWith('已复制，可粘贴到目标位置')
  })

  it('R-08 残留修复（loop2）：cut 源版本 409 → 树 stale（§3.1.1/§4.9）+ Host 逐字冲突文案 + 零额外 GET；refresh 成功后 stale 清除', async () => {
    let getCount = 0
    routeFetch([
      [
        /GET .*\/collections$/,
        () => {
          getCount += 1
          return mockResponse(200, fixture())
        },
      ],
      [/POST .*\/tree\/clipboard\/cut$/, () => mockResponse(409, { error: { code: 'version-conflict', message: '数据已被其他操作修改，请刷新后重试' } })],
    ])
    await renderCombinedHook()
    let cut = true
    await act(async () => {
      cut = await captured!.cut({ requestId: 'r1', requestUpdatedAt: 100, sourceCollectionUpdatedAt: 1000 })
    })
    expect(cut).toBe(false)
    expect(captured!.clipboard).toBeUndefined()
    expect(toastMocks.error).toHaveBeenCalledWith('数据已被其他操作修改，请刷新后重试')
    // §3.1.1 把 cut.requestUpdatedAt/sourceCollectionUpdatedAt 列入冻结 409 条件，
    // 409 后果清单要求「Client 将树标记为 stale，直到重新成功刷新」——loop1 误固化
    // 为 stale=false，本断言为 GPT 复审裁决后的纠正。
    expect(capturedCollections!.stale).toBe(true)
    // 失败分支零刷新：GET 仅初始加载 1 次。
    expect(getCount).toBe(1)
    // stale 清除路径不回归：refresh() 成功 → stale=false（第二次 GET）。
    await act(async () => {
      expect(await capturedCollections!.refresh()).toBe(true)
    })
    expect(capturedCollections!.stale).toBe(false)
    expect(getCount).toBe(2)
  })

  it('R-08 边界（loop2 勿扩大）：cut 非 409 失败（404 request-not-found）→ 只 toast 不置 stale；copy 失败永不置 stale', async () => {
    let getCount = 0
    routeFetch([
      [
        /GET .*\/collections$/,
        () => {
          getCount += 1
          return mockResponse(200, fixture())
        },
      ],
      [/POST .*\/tree\/clipboard\/cut$/, () => mockResponse(404, { error: { code: 'request-not-found', message: 'request not found: r1' } })],
      [/POST .*\/tree\/clipboard\/copy$/, () => mockResponse(404, { error: { code: 'collection-not-found', message: 'collection not found: c-x' } })],
    ])
    await renderCombinedHook()
    let cut = true
    await act(async () => {
      cut = await captured!.cut({ requestId: 'r1', requestUpdatedAt: 100, sourceCollectionUpdatedAt: 1000 })
    })
    expect(cut).toBe(false)
    expect(capturedCollections!.stale).toBe(false) // 404 不是版本冲突 → 不 stale（§4.9 仅 409）
    let copied = true
    await act(async () => {
      copied = await captured!.copy({ kind: 'collection', collectionId: 'c-x' })
    })
    expect(copied).toBe(false)
    expect(capturedCollections!.stale).toBe(false) // copy 无版本前置，失败永不 stale
    expect(getCount).toBe(1) // 全程零刷新
  })

  it('R-08 对照：paste 仍走 runMutation——成功后刷新投影（第二次 GET），copy 后不刷新', async () => {
    let getCount = 0
    routeFetch([
      [
        /GET .*\/collections$/,
        () => {
          getCount += 1
          return mockResponse(200, fixture())
        },
      ],
      [/POST .*\/tree\/clipboard\/copy$/, () => mockResponse(200, { token: 'tk-copy', operation: 'copy', kind: 'request', expiresAt: Date.now() + 1_800_000 })],
      [/POST .*\/tree\/clipboard\/tk-copy\/paste$/, () => mockResponse(200, { operation: 'copy', kind: 'request', consumed: false })],
    ])
    await renderCombinedHook()
    await act(async () => {
      await captured!.copy({ kind: 'request', collectionId: 'c1', nodeId: 'r1' })
    })
    expect(getCount).toBe(1)
    let pasted = false
    await act(async () => {
      pasted = await captured!.paste({ kind: 'folder', targetId: 'f1', targetCollectionId: 'c1', expectedTargetCollectionUpdatedAt: 1000 })
    })
    expect(pasted).toBe(true)
    expect(getCount).toBe(2) // paste 成功 → §4.9 刷新
    expect(capturedCollections!.stale).toBe(false)
  })
})
