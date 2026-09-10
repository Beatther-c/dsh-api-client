/**
 * WP5（P0 实施设计 §4.7–§4.9/§6.1/§6.2/§6.4/§8.1 条目 1–4、7 + 键盘契约，
 * UX §4.1–§4.5）验收 spec —— 请求树稳定行 / 折叠与搜索状态模型 / 行内重命名 /
 * 键盘契约 / stale。
 *
 * 用例名对齐 §8.1：hover_does_not_change_name_width、row_click_semantics、
 * initially_collapsed_and_global_toggle、search_uses_transient_expansion、
 * inline_rename_paths；外加 AC-11 键盘契约全表、AC-22 stale 禁用面与
 * 「数据已保存，列表刷新失败」路径（mock fetch 驱动真实 useCollections）。
 *
 * 渲染方式与 p0-tab-lifecycle.spec.ts 同款：react-dom createRoot + act（jsdom）。
 * CollectionTree 是纯 props 面（CollectionsState + TreeClipboardApi 注入），
 * 树行为用 fake 状态驱动；hook 行为用真实 useCollections + fetch mock 驱动。
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiRequest, Collection, TreeClipboardDescriptor } from '@dsh-api-client/shared'
import { CollectionTree } from '../src/client/components/collection/CollectionTree.tsx'
import type { CollectionTreeHandlers, TreeDeleteTarget } from '../src/client/components/collection/CollectionTree.tsx'
import { MAX_VISUAL_DEPTH, projectTree } from '../src/client/components/collection/tree-projection.ts'
import type { CollectionsState, FolderDescriptor, MutationOutcome } from '../src/client/hooks/useCollections.ts'
import { useCollections } from '../src/client/hooks/useCollections.ts'
import type { TreeClipboardApi } from '../src/client/hooks/useTreeClipboard.ts'
import { computePasteEnablement } from '../src/client/hooks/useTreeClipboard.ts'
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

const R1 = (): ApiRequest => makeRequest('r1', '订单列表', { url: 'https://api.example.com/orders' })
const R2 = (): ApiRequest => makeRequest('r2', '创建用户', { method: 'POST', url: 'https://api.example.com/users' })
const R3 = (): ApiRequest => makeRequest('r3', '深层请求', { url: 'https://deep.example.com/x' })

/** c1（f1 > f11 > r3、f1 > r2、顶层 r1；updatedAt=1000）+ c2（空集合，updatedAt=2000）。 */
function fixture(): Collection[] {
  return [
    {
      id: 'c1',
      name: '订单 API',
      variables: [],
      folders: [
        {
          id: 'f1',
          name: '用户模块',
          folders: [{ id: 'f11', name: '子目录', folders: [], requests: [R3()] }],
          requests: [R2()],
        },
      ],
      requests: [R1()],
      createdAt: 1,
      updatedAt: 1000,
    },
    { id: 'c2', name: '空集合', variables: [], folders: [], requests: [], createdAt: 2, updatedAt: 2000 },
  ]
}

const okOutcome: MutationOutcome = { committed: true, refreshed: true }

function fakeCollections(overrides: Partial<CollectionsState> = {}): CollectionsState {
  const base: CollectionsState = {
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
    renameRequest: vi.fn(async () => ({ ...okOutcome, request: R1() })),
    deleteRequest: vi.fn(async () => okOutcome),
    duplicateRequest: vi.fn(async () => {}),
    moveRequest: vi.fn(async () => {}),
    createFolder: vi.fn(async () => ({ ...okOutcome, folder: { id: 'f-new', name: '新目录' } satisfies FolderDescriptor })),
    renameFolder: vi.fn(async () => okOutcome),
    deleteFolder: vi.fn(async () => okOutcome),
    ...overrides,
  }
  return base
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
    // 真实矩阵逻辑（computePasteEnablement 有独立单测）。
    pasteEnablement: (target) => computePasteEnablement(state, target),
    notifyLocalRequestsDeleted: vi.fn(),
  }
}

type SpyHandlers = {
  onOpenRequest: ReturnType<typeof vi.fn>
  onNewRequest: ReturnType<typeof vi.fn>
  onRequestDelete: ReturnType<typeof vi.fn>
  onRequestRenamed: ReturnType<typeof vi.fn>
}

function fakeHandlers(): CollectionTreeHandlers & SpyHandlers {
  return {
    onOpenRequest: vi.fn(),
    onNewRequest: vi.fn(),
    onRequestDelete: vi.fn(),
    onRequestRenamed: vi.fn(),
  }
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
})

interface Rendered extends SpyHandlers {
  collections: CollectionsState
  clipboard: TreeClipboardApi
}

interface RenderTreeProps {
  collections?: Partial<CollectionsState>
  clipboard?: TreeClipboardDescriptor
  selectedRequestId?: string
}

async function renderTree(props: RenderTreeProps = {}): Promise<Rendered> {
  const collections = fakeCollections(props.collections ?? {})
  const clipboard = fakeClipboard(props.clipboard)
  const handlers = fakeHandlers()
  await act(async () => {
    root.render(
      createElement(CollectionTree, {
        collections,
        clipboard,
        handlers,
        ...(props.selectedRequestId !== undefined ? { selectedRequestId: props.selectedRequestId } : {}),
      }),
    )
  })
  return { collections, clipboard, ...handlers }
}

function allRows(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-dsh-api-client="tree-row"]')]
}

function rowKeys(): string[] {
  return allRows().map((element) => element.dataset.treeKey!)
}

function row(key: string): HTMLElement {
  const element = maybeRow(key)
  expect(element, `row ${key} 应已渲染`).not.toBeNull()
  return element!
}

function maybeRow(key: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-tree-key="${key}"]`)
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

async function focusRow(key: string): Promise<void> {
  await act(async () => {
    row(key).focus()
  })
}

function setNativeValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

async function typeSearch(value: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>('[data-dsh-api-client="tree-search"]')!
  await act(async () => {
    setNativeValue(input, value)
  })
}

async function typeIntoRenameInput(value: string): Promise<HTMLInputElement> {
  const input = renameInput()
  expect(input, 'rename 输入框应已挂载').not.toBeNull()
  await act(async () => {
    setNativeValue(input!, value)
  })
  return input!
}

function renameInput(): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>('[data-dsh-api-client="tree-rename-input"]')
}

async function blur(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  })
}

function menuElement(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[data-dsh-api-client="tree-context-menu"]')
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

async function expandCollectionC1(): Promise<void> {
  await click(row('collection:c1'))
}

// ---------- 1. hover_does_not_change_name_width（§8.1#1 / AC-01） ----------

describe('hover_does_not_change_name_width：稳定行，hover 零挂载（AC-01）', () => {
  it('hover 前后名称区宽度差 ≤0.5px，行内零按钮、DOM 结构不变', async () => {
    await renderTree()
    const rowElement = row('collection:c1')
    const nameSlot = rowElement.querySelector<HTMLElement>('[data-dsh-api-client="tree-name-slot"]')!
    expect(nameSlot).not.toBeNull()

    // jsdom 无布局：按 §8.1#1 mock getBoundingClientRect——名称区宽度随行内
    // 按钮数变化（模拟旧实现 hover 挂载按钮挤压名称），新实现必须恒定。
    nameSlot.getBoundingClientRect = (): DOMRect => {
      const buttons = rowElement.querySelectorAll('button').length
      const width = 200 - buttons * 22
      return { width, height: 24, top: 0, left: 0, right: width, bottom: 24, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
    }

    const structureBefore = rowElement.children.length
    const widthBefore = nameSlot.getBoundingClientRect().width

    await act(async () => {
      rowElement.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }))
    })
    await act(async () => {
      rowElement.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, relatedTarget: document.body }))
    })

    const widthAfter = nameSlot.getBoundingClientRect().width
    expect(Math.abs(widthAfter - widthBefore)).toBeLessThanOrEqual(0.5)
    expect(rowElement.children.length).toBe(structureBefore)
    // 旧 hover action buttons 彻底移除：行内零 button，旧动作字形不出现。
    expect(rowElement.querySelectorAll('button')).toHaveLength(0)
    for (const legacy of ['✎', '⧉', '🗑', '+req', 'Rename', 'Duplicate']) {
      expect(rowElement.textContent).not.toContain(legacy)
    }
  })

  it('固定槽位齐备：expand-slot / type-slot / name-slot / state-slot 恒在（空节点也保留占位）', async () => {
    await renderTree()
    for (const key of ['collection:c1', 'collection:c2']) {
      const rowElement = row(key)
      for (const slot of ['tree-expand-slot', 'tree-type-slot', 'tree-name-slot', 'tree-state-slot']) {
        expect(rowElement.querySelector(`[data-dsh-api-client="${slot}"]`), `${key} 应有 ${slot}`).not.toBeNull()
      }
    }
    // 名称 tooltip = 全名（UX §4.1）；初始收缩时 r1 不可见。
    expect(maybeRow('request:r1')).toBeNull()
    expect(row('collection:c1').getAttribute('title')).toBe('订单 API')
  })
})

// ---------- 2. row_click_semantics（§8.1#2 / AC-04） ----------

describe('row_click_semantics：左键/右键行为分发（AC-04/AC-09）', () => {
  it('Collection 整行左键：先选中再 toggle；不调用 open', async () => {
    const { onOpenRequest } = await renderTree()
    const c1 = row('collection:c1')
    expect(c1.getAttribute('aria-expanded')).toBe('false')
    await click(c1)
    expect(row('collection:c1').getAttribute('aria-expanded')).toBe('true')
    expect(row('collection:c1').getAttribute('aria-selected')).toBe('true')
    expect(onOpenRequest).not.toHaveBeenCalled()
    // 再点 → 收缩
    await click(row('collection:c1'))
    expect(row('collection:c1').getAttribute('aria-expanded')).toBe('false')
  })

  it('Folder 整行左键 toggle；Request 左键只打开', async () => {
    const { onOpenRequest } = await renderTree()
    await expandCollectionC1()
    await click(row('folder:f1'))
    expect(row('folder:f1').getAttribute('aria-expanded')).toBe('true')
    expect(onOpenRequest).not.toHaveBeenCalled()

    await click(row('request:r1'))
    expect(onOpenRequest).toHaveBeenCalledTimes(1)
    const opened = onOpenRequest.mock.calls[0]![0] as ApiRequest
    expect(opened.id).toBe('r1')
    expect(row('request:r1').getAttribute('aria-selected')).toBe('true')
  })

  it('右键 Request：只选中+开菜单，不打开请求', async () => {
    const { onOpenRequest } = await renderTree()
    await expandCollectionC1()
    await contextMenuOn(row('request:r1'))
    expect(onOpenRequest).not.toHaveBeenCalled()
    expect(row('request:r1').getAttribute('aria-selected')).toBe('true')
    expect(menuElement()).not.toBeNull()
  })

  it('右键 Folder：只选中+开菜单，不 toggle', async () => {
    await renderTree()
    await expandCollectionC1()
    const before = row('folder:f1').getAttribute('aria-expanded')
    await contextMenuOn(row('folder:f1'))
    expect(row('folder:f1').getAttribute('aria-expanded')).toBe(before)
    expect(row('folder:f1').getAttribute('aria-selected')).toBe('true')
    expect(menuElement()).not.toBeNull()
  })

  it('左键空白区：清除选择 + 关闭菜单', async () => {
    await renderTree()
    await expandCollectionC1()
    await click(row('folder:f1'))
    expect(row('folder:f1').getAttribute('aria-selected')).toBe('true')
    const list = container.querySelector<HTMLElement>('[data-dsh-api-client="collection-tree-list"]')!
    await click(list)
    expect(row('folder:f1').getAttribute('aria-selected')).toBe('false')
    expect(menuElement()).toBeNull()
  })
})

// ---------- 3. initially_collapsed_and_global_toggle（§8.1#3 / AC-02/03） ----------

describe('initially_collapsed_and_global_toggle：默认全收缩 + 双态按钮（AC-02/03）', () => {
  it('初始只渲染 Collection 行（全部收缩），可展开节点 aria-expanded=false', async () => {
    await renderTree()
    expect(rowKeys()).toEqual(['collection:c1', 'collection:c2'])
    expect(row('collection:c1').getAttribute('aria-expanded')).toBe('false')
  })

  it('空 Collection 无伪箭头，但 expand-slot 占位保留', async () => {
    await renderTree()
    const c2 = row('collection:c2')
    // 空节点：不渲染 aria-expanded（无可展开内容），expand-slot 存在且无箭头字符。
    expect(c2.hasAttribute('aria-expanded')).toBe(false)
    const slot = c2.querySelector('[data-dsh-api-client="tree-expand-slot"]')!
    expect(slot).not.toBeNull()
    expect(slot.textContent).toBe('')
    // 有子节点的 c1 显示收缩箭头。
    expect(row('collection:c1').querySelector('[data-dsh-api-client="tree-expand-slot"]')!.textContent).toBe('▸')
  })

  it('全部展开 → 全树可见且按钮切换为「全部收缩」；再点全部收缩', async () => {
    await renderTree()
    const button = () => container.querySelector<HTMLButtonElement>('[data-dsh-api-client="tree-expand-all"]')!
    expect(button().title).toBe('全部展开')
    await click(button())
    // 两组兄弟顺序：Folder 前 Request 后（UX §4.6）。
    expect(rowKeys()).toEqual(['collection:c1', 'folder:f1', 'folder:f11', 'request:r3', 'request:r2', 'request:r1', 'collection:c2'])
    expect(row('collection:c1').getAttribute('aria-expanded')).toBe('true')
    expect(row('folder:f1').getAttribute('aria-expanded')).toBe('true')
    expect(button().title).toBe('全部收缩')
    await click(button())
    expect(rowKeys()).toEqual(['collection:c1', 'collection:c2'])
  })

  it('深层缩进封顶 visualDepth=6（逻辑层级不限）', () => {
    // 纯投影断言：8 层嵌套 folder，visualDepth 到 6 为止，logicalDepth 继续增长。
    let inner: Collection['folders'][number] = { id: 'f-8', name: 'L8', folders: [], requests: [makeRequest('r-deep', '深层')] }
    for (let level = 7; level >= 1; level -= 1) {
      inner = { id: `f-${level}`, name: `L${level}`, folders: [inner], requests: [] }
    }
    const deep: Collection = { id: 'c-deep', name: '深层集合', variables: [], folders: [inner], requests: [], createdAt: 1, updatedAt: 1 }
    const expanded = new Set<string>(['collection:c-deep'])
    for (let level = 1; level <= 8; level += 1) expanded.add(`folder:f-${level}`)
    const result = projectTree({ collections: [deep], query: '', expandedIds: expanded, searchCollapsed: new Set() })
    const depths = result.rows.map((rowNode) => [rowNode.logicalDepth, rowNode.visualDepth])
    expect(depths[0]).toEqual([0, 0])
    // 最深行 = f-8 内的 request：logicalDepth 9 > 视觉上限 6。
    expect(depths.at(-1)).toEqual([9, MAX_VISUAL_DEPTH])
    expect(result.rows.every((rowNode) => rowNode.visualDepth <= MAX_VISUAL_DEPTH)).toBe(true)
  })

  it('VisibleTreeNode 契约：key/kind/collectionId/nodeId/parentKey/firstChildKey（§4.8）', () => {
    const result = projectTree({
      collections: fixture(),
      query: '',
      expandedIds: new Set(['collection:c1', 'folder:f1']),
      searchCollapsed: new Set(),
    })
    const c1 = result.rows.find((rowNode) => rowNode.key === 'collection:c1')!
    expect([c1.kind, c1.collectionId, c1.nodeId]).toEqual(['collection', 'c1', 'c1'])
    expect(c1.parentKey).toBeUndefined()
    expect(c1.firstChildKey).toBe('folder:f1') // 两组兄弟顺序：Folder 在前
    const r2 = result.rows.find((rowNode) => rowNode.key === 'request:r2')!
    expect([r2.collectionId, r2.parentKey]).toEqual(['c1', 'folder:f1'])
    expect(r2.firstChildKey).toBeUndefined()
  })
})

// ---------- 4. search_uses_transient_expansion（§8.1#4 / AC-05/06/07） ----------

describe('search_uses_transient_expansion：搜索临时展开 + 双状态互不污染（AC-05/06/07）', () => {
  it('Request 命中：只显示祖先 + 自身；URL 原始子串也命中（大小写不敏感、不 decode）', async () => {
    await renderTree()
    await typeSearch('深层')
    expect(rowKeys()).toEqual(['collection:c1', 'folder:f1', 'folder:f11', 'request:r3'])
    // URL 命中（原始子串，trim + Unicode 小写）。
    await typeSearch('  API.EXAMPLE.COM/orders ')
    expect(rowKeys()).toEqual(['collection:c1', 'request:r1'])
  })

  it('Collection/Folder 自身命中：显示完整后代', async () => {
    await renderTree()
    await typeSearch('用户模块')
    expect(rowKeys()).toEqual(['collection:c1', 'folder:f1', 'folder:f11', 'request:r3', 'request:r2'])
    await typeSearch('订单 api')
    // c1 命中 → 完整子树（Folder 前 Request 后）。
    expect(rowKeys()).toEqual(['collection:c1', 'folder:f1', 'folder:f11', 'request:r3', 'request:r2', 'request:r1'])
  })

  it('空 query（含纯空格）等同未搜索', async () => {
    await renderTree()
    await typeSearch('   ')
    expect(rowKeys()).toEqual(['collection:c1', 'collection:c2'])
    const button = container.querySelector<HTMLButtonElement>('[data-dsh-api-client="tree-expand-all"]')!
    expect(button.disabled).toBe(false)
  })

  it('搜索 toggle 只改 searchCollapsed；清除搜索恢复普通态（互不污染）', async () => {
    await renderTree()
    // 普通态：展开 c1（expandedIds={c1}），f1 保持收缩。
    await expandCollectionC1()
    expect(rowKeys()).toEqual(['collection:c1', 'folder:f1', 'request:r1', 'collection:c2'])

    await typeSearch('深层')
    expect(rowKeys()).toEqual(['collection:c1', 'folder:f1', 'folder:f11', 'request:r3'])

    // 搜索态收起 f1：只写 searchCollapsed。
    await click(row('folder:f1'))
    expect(rowKeys()).toEqual(['collection:c1', 'folder:f1'])

    // 清除搜索：searchCollapsed 丢弃，普通态 expandedIds={c1} 恢复原样。
    await typeSearch('')
    expect(rowKeys()).toEqual(['collection:c1', 'folder:f1', 'request:r1', 'collection:c2'])
    expect(row('folder:f1').getAttribute('aria-expanded')).toBe('false')

    // 普通态再展开 f1 → 正常（未被搜索态污染）。
    await click(row('folder:f1'))
    expect(row('folder:f1').getAttribute('aria-expanded')).toBe('true')
    expect(rowKeys()).toEqual(['collection:c1', 'folder:f1', 'folder:f11', 'request:r2', 'request:r1', 'collection:c2'])
  })

  it('搜索期间「全部展开/全部收缩」禁用并给中文 tooltip（AC-07）', async () => {
    await renderTree()
    const button = (): HTMLButtonElement => container.querySelector<HTMLButtonElement>('[data-dsh-api-client="tree-expand-all"]')!
    expect(button().disabled).toBe(false)
    await typeSearch('深层')
    expect(button().disabled).toBe(true)
    expect(button().title).toBe('清除搜索后恢复原折叠状态')
    await click(button())
    // 禁用态点击不改变任何折叠状态。
    expect(rowKeys()).toEqual(['collection:c1', 'folder:f1', 'folder:f11', 'request:r3'])
    await typeSearch('')
    expect(button().disabled).toBe(false)
    expect(rowKeys()).toEqual(['collection:c1', 'collection:c2'])
  })

  it('数据刷新后按当前 query 立即重投影（§4.3）', async () => {
    const collections = fakeCollections()
    const clipboard = fakeClipboard(undefined)
    const handlers = fakeHandlers()
    await act(async () => {
      root.render(createElement(CollectionTree, { collections, clipboard, handlers }))
    })
    await typeSearch('深层')
    expect(rowKeys()).toEqual(['collection:c1', 'folder:f1', 'folder:f11', 'request:r3'])
    // Host 刷新：r3 改名不再命中 → 同一 query 立即重算为空。
    const next = fixture()
    next[0]!.folders[0]!.folders[0]!.requests = [makeRequest('r3', '已改名', { url: 'https://deep.example.com/x' })]
    await act(async () => {
      root.render(createElement(CollectionTree, { collections: { ...collections, collections: next }, clipboard, handlers }))
    })
    expect(rowKeys()).toEqual([])
  })
})

// ---------- 5. inline_rename_paths（§8.1#7 / AC-12 / §6.4） ----------

describe('inline_rename_paths：行内重命名全路径（AC-12）', () => {
  it('F2 进入编辑；Enter 提交 trim 后名称（Folder 走 WP3 端点带版本）', async () => {
    const { collections } = await renderTree()
    await expandCollectionC1()
    await focusRow('folder:f1')
    await pressKey(row('folder:f1'), 'F2')
    const input = renameInput()
    expect(input).not.toBeNull()
    expect(input!.value).toBe('用户模块')
    await typeIntoRenameInput('  新用户模块  ')
    await pressKey(renameInput()!, 'Enter')
    expect(vi.mocked(collections.renameFolder)).toHaveBeenCalledWith('c1', 'f1', '新用户模块', 1000)
    expect(renameInput()).toBeNull()
  })

  it('Enter 空/纯空格：不提交、保持编辑态', async () => {
    const { collections } = await renderTree()
    await expandCollectionC1()
    await focusRow('folder:f1')
    await pressKey(row('folder:f1'), 'F2')
    await typeIntoRenameInput('   ')
    await pressKey(renameInput()!, 'Enter')
    expect(collections.renameFolder).not.toHaveBeenCalled()
    expect(renameInput()).not.toBeNull()
  })

  it('Esc 取消恢复原名，不调用 Host，焦点回原树行', async () => {
    const { collections } = await renderTree()
    await expandCollectionC1()
    await focusRow('folder:f1')
    await pressKey(row('folder:f1'), 'F2')
    await typeIntoRenameInput('半途而废')
    await pressKey(renameInput()!, 'Escape')
    expect(collections.renameFolder).not.toHaveBeenCalled()
    expect(renameInput()).toBeNull()
    expect(row('folder:f1').textContent).toContain('用户模块')
    // Esc 取消后焦点回到原树行。
    expect(document.activeElement).toBe(row('folder:f1'))
  })

  it('blur 非空提交；blur 空/纯空格取消恢复原名', async () => {
    const { collections } = await renderTree()
    await expandCollectionC1()
    await focusRow('folder:f1')
    await pressKey(row('folder:f1'), 'F2')
    const first = await typeIntoRenameInput('失焦改名')
    await blur(first)
    expect(vi.mocked(collections.renameFolder)).toHaveBeenCalledWith('c1', 'f1', '失焦改名', 1000)

    // 第二轮：blur 纯空格 → 取消且不再提交。
    await focusRow('folder:f1')
    await pressKey(row('folder:f1'), 'F2')
    const second = await typeIntoRenameInput('   ')
    await blur(second)
    expect(vi.mocked(collections.renameFolder)).toHaveBeenCalledTimes(1)
    expect(renameInput()).toBeNull()
  })

  it('失败保持编辑态：中文错误内联展示、输入不丢', async () => {
    await renderTree({
      collections: { renameFolder: vi.fn(async () => ({ committed: false, refreshed: false, error: '名称不合法' })) },
    })
    await expandCollectionC1()
    await focusRow('folder:f1')
    await pressKey(row('folder:f1'), 'F2')
    await typeIntoRenameInput('坏名字')
    await pressKey(renameInput()!, 'Enter')
    const still = renameInput()
    expect(still).not.toBeNull()
    expect(still!.value).toBe('坏名字')
    const error = container.querySelector('[data-dsh-api-client="tree-rename-error"]')
    expect(error?.textContent).toBe('名称不合法')
    expect(error?.getAttribute('role')).toBe('alert')
  })

  it('提交中忙碌态：pending 期间重复 Enter 不再触发（防重复 mutation）', async () => {
    let resolveRename: (outcome: MutationOutcome) => void = () => {}
    const renameFolder = vi.fn(
      () =>
        new Promise<MutationOutcome>((resolve) => {
          resolveRename = resolve
        }),
    )
    await renderTree({ collections: { renameFolder } })
    await expandCollectionC1()
    await focusRow('folder:f1')
    await pressKey(row('folder:f1'), 'F2')
    await typeIntoRenameInput('忙碌改名')
    await pressKey(renameInput()!, 'Enter')
    expect(renameFolder).toHaveBeenCalledTimes(1)
    // pending：输入框禁用 + 行 state-slot 忙碌指示。
    expect(renameInput()!.disabled).toBe(true)
    expect(row('folder:f1').querySelector('[data-dsh-api-client="tree-state-slot"]')!.textContent).toBe('…')
    await pressKey(renameInput()!, 'Enter')
    expect(renameFolder).toHaveBeenCalledTimes(1)
    await act(async () => {
      resolveRename(okOutcome)
    })
    expect(renameInput()).toBeNull()
  })

  it('失败后可重试（忙碌闸复位）：第二次 Enter 再次提交', async () => {
    const renameFolder = vi.fn(async () => ({ committed: false, refreshed: false, error: '冲突' }))
    await renderTree({ collections: { renameFolder } })
    await expandCollectionC1()
    await focusRow('folder:f1')
    await pressKey(row('folder:f1'), 'F2')
    await typeIntoRenameInput('重试名')
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await act(async () => {
        renameInput()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      })
    }
    expect(renameFolder).toHaveBeenCalledTimes(2)
  })

  it('同一时间仅一个节点编辑；普通行 Enter 不进 rename', async () => {
    await renderTree()
    await expandCollectionC1()
    await focusRow('collection:c1')
    await pressKey(row('collection:c1'), 'F2')
    expect(renameInput()).not.toBeNull()
    // 编辑态期间另一行的 F2 被让位（树键盘契约让位给输入框）。
    await pressKey(row('folder:f1'), 'F2')
    expect(container.querySelectorAll('[data-dsh-api-client="tree-rename-input"]')).toHaveLength(1)
    expect(row('collection:c1').querySelector('[data-dsh-api-client="tree-rename-input"]')).not.toBeNull()
    // 取消后：普通行 Enter = toggle，不进 rename（F2/菜单才进）。
    await pressKey(renameInput()!, 'Escape')
    expect(row('collection:c1').getAttribute('aria-expanded')).toBe('true')
    await focusRow('collection:c1')
    await pressKey(row('collection:c1'), 'Enter')
    expect(renameInput()).toBeNull()
    expect(row('collection:c1').getAttribute('aria-expanded')).toBe('false')
  })

  it('Collection 重命名走 renameCollection（带版本）；Request 重命名成功回调 onRequestRenamed', async () => {
    const { collections, onRequestRenamed } = await renderTree()
    await focusRow('collection:c1')
    await pressKey(row('collection:c1'), 'F2')
    await typeIntoRenameInput('新集合名')
    await pressKey(renameInput()!, 'Enter')
    expect(vi.mocked(collections.renameCollection)).toHaveBeenCalledWith('c1', '新集合名', 1000)

    await expandCollectionC1()
    await focusRow('request:r1')
    await pressKey(row('request:r1'), 'F2')
    await typeIntoRenameInput('新请求名')
    await pressKey(renameInput()!, 'Enter')
    expect(vi.mocked(collections.renameRequest)).toHaveBeenCalledWith('r1', '新请求名', 1000)
    expect(onRequestRenamed).toHaveBeenCalledTimes(1)
    expect((onRequestRenamed.mock.calls[0]![0] as ApiRequest).id).toBe('r1')
  })

  it('右键菜单「重命名」进入编辑态，动作完成后菜单关闭', async () => {
    await renderTree()
    await contextMenuOn(row('collection:c1'))
    await clickMenuItem('rename')
    await flushMicrotasks()
    expect(renameInput()).not.toBeNull()
    expect(menuElement()).toBeNull()
    // R1 交接：行内 rename 输入框挂载后焦点归输入框（菜单焦点还原不抢回树行）。
    expect(document.activeElement).toBe(renameInput())
  })
})

// ---------- 6. 键盘契约全表（AC-11 / UX §4.4） ----------

describe('键盘契约：↑↓←→/Home/End/Enter/Space/F2/Shift+F10/Cmd+C/X/V/Delete/Esc', () => {
  it('↑↓ 在可见节点间移动选择与 DOM 焦点', async () => {
    await renderTree()
    await expandCollectionC1()
    await focusRow('collection:c1')
    await pressKey(row('collection:c1'), 'ArrowDown')
    expect(document.activeElement).toBe(row('folder:f1'))
    expect(row('folder:f1').getAttribute('aria-selected')).toBe('true')
    await pressKey(row('folder:f1'), 'ArrowDown')
    expect(document.activeElement).toBe(row('request:r1'))
    await pressKey(row('request:r1'), 'ArrowDown')
    expect(document.activeElement).toBe(row('collection:c2'))
    // 末尾不越界
    await pressKey(row('collection:c2'), 'ArrowDown')
    expect(document.activeElement).toBe(row('collection:c2'))
    await pressKey(row('collection:c2'), 'ArrowUp')
    expect(document.activeElement).toBe(row('request:r1'))
  })

  it('← 展开则收缩、已收缩到父；→ 收缩则展开、已展开到第一子', async () => {
    await renderTree()
    await expandCollectionC1()
    await focusRow('collection:c1')
    // c1 展开态：← 收缩（选择不动）
    await pressKey(row('collection:c1'), 'ArrowLeft')
    expect(row('collection:c1').getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(row('collection:c1'))
    // 收缩态：→ 展开（不移动）
    await pressKey(row('collection:c1'), 'ArrowRight')
    expect(row('collection:c1').getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(row('collection:c1'))
    // 展开态：→ 到第一子（两组兄弟顺序 → f1）
    await pressKey(row('collection:c1'), 'ArrowRight')
    expect(document.activeElement).toBe(row('folder:f1'))
    // f1 收缩态：← 到父 c1
    await pressKey(row('folder:f1'), 'ArrowLeft')
    expect(document.activeElement).toBe(row('collection:c1'))
  })

  it('Home/End 到首/尾可见节点', async () => {
    await renderTree()
    await expandCollectionC1()
    await focusRow('folder:f1')
    await pressKey(row('folder:f1'), 'End')
    expect(document.activeElement).toBe(row('collection:c2'))
    await pressKey(row('collection:c2'), 'Home')
    expect(document.activeElement).toBe(row('collection:c1'))
  })

  it('Enter/Space：Collection/Folder toggle；Request 打开', async () => {
    const { onOpenRequest } = await renderTree()
    await focusRow('collection:c1')
    await pressKey(row('collection:c1'), 'Enter')
    expect(row('collection:c1').getAttribute('aria-expanded')).toBe('true')
    await pressKey(row('collection:c1'), ' ')
    expect(row('collection:c1').getAttribute('aria-expanded')).toBe('false')
    await pressKey(row('collection:c1'), 'Enter')
    await focusRow('request:r1')
    await pressKey(row('request:r1'), ' ')
    expect(onOpenRequest).toHaveBeenCalledTimes(1)
  })

  it('Shift+F10 与菜单键在当前选择处打开菜单', async () => {
    await renderTree()
    await focusRow('collection:c1')
    await pressKey(row('collection:c1'), 'F10', { shiftKey: true })
    expect(menuElement()).not.toBeNull()
    expect(menuItem('new-request')).not.toBeNull()
    // R2：Shift+F10 打开后焦点同样进入第一个可用项
    expect(document.activeElement).toBe(menuItem('new-request'))
    await pressKey(document.activeElement as HTMLElement, 'Escape')
    await flushMicrotasks()
    expect(menuElement()).toBeNull()

    await focusRow('collection:c2')
    await pressKey(row('collection:c2'), 'ContextMenu')
    expect(menuElement()).not.toBeNull()
  })

  it('Cmd/Ctrl+C 复制当前节点（Host token 剪贴板）', async () => {
    const { clipboard } = await renderTree()
    await expandCollectionC1()
    await focusRow('folder:f1')
    await pressKey(row('folder:f1'), 'c', { metaKey: true })
    await act(async () => {})
    expect(vi.mocked(clipboard.copy)).toHaveBeenCalledWith({ kind: 'folder', collectionId: 'c1', nodeId: 'f1' })
    // Ctrl 形态等价
    await focusRow('collection:c1')
    await pressKey(row('collection:c1'), 'c', { ctrlKey: true })
    await act(async () => {})
    expect(vi.mocked(clipboard.copy)).toHaveBeenLastCalledWith({ kind: 'collection', collectionId: 'c1' })
  })

  it('Cmd/Ctrl+X：仅 Request 剪切；其他节点无动作 + 中文原因 toast（AC-17）', async () => {
    const { clipboard } = await renderTree()
    await expandCollectionC1()
    await focusRow('collection:c1')
    await pressKey(row('collection:c1'), 'x', { metaKey: true })
    expect(clipboard.cut).not.toHaveBeenCalled()
    expect(toastMocks.error).toHaveBeenCalledWith('P0 剪切仅支持 Request 节点')

    await focusRow('request:r1')
    await pressKey(row('request:r1'), 'x', { metaKey: true })
    await act(async () => {})
    expect(vi.mocked(clipboard.cut)).toHaveBeenCalledWith({ requestId: 'r1', requestUpdatedAt: 100, sourceCollectionUpdatedAt: 1000 })
  })

  it('Cmd/Ctrl+V：以当前选择为目标粘贴；目标非法时中文原因 toast 且不调用 paste', async () => {
    const { clipboard } = await renderTree({ clipboard: clipboardDescriptor({ operation: 'copy', kind: 'collection' }) })
    await expandCollectionC1()
    await focusRow('folder:f1')
    await pressKey(row('folder:f1'), 'v', { metaKey: true })
    await act(async () => {})
    // Copy Collection → Folder 目标非法（§6.5 矩阵）。
    expect(clipboard.paste).not.toHaveBeenCalled()
    expect(toastMocks.error).toHaveBeenCalledWith('当前剪贴板内容只能粘贴到 根空白区 或 Collection')

    await focusRow('collection:c2')
    await pressKey(row('collection:c2'), 'v', { metaKey: true })
    await act(async () => {})
    expect(vi.mocked(clipboard.paste)).toHaveBeenCalledWith({ kind: 'collection', targetId: 'c2', targetCollectionId: 'c2', expectedTargetCollectionUpdatedAt: 2000 })
  })

  it('Cmd/Ctrl+V 无选择（焦点在树容器）= 根区域粘贴（UX §4.4）', async () => {
    const { clipboard } = await renderTree({ clipboard: clipboardDescriptor({ operation: 'copy', kind: 'collection' }) })
    const list = container.querySelector<HTMLElement>('[data-dsh-api-client="collection-tree-list"]')!
    // 左键空白清除选择（焦点收进容器）。
    await click(list)
    await pressKey(list, 'v', { metaKey: true })
    await act(async () => {})
    expect(vi.mocked(clipboard.paste)).toHaveBeenCalledWith({ kind: 'root' })
  })

  it('Delete/Backspace 只触发删除确认回调（绝不直接删）', async () => {
    const { collections, onRequestDelete } = await renderTree()
    await expandCollectionC1()
    await focusRow('request:r1')
    await pressKey(row('request:r1'), 'Delete')
    expect(onRequestDelete).toHaveBeenCalledTimes(1)
    const target = onRequestDelete.mock.calls[0]![0] as TreeDeleteTarget
    expect(target.kind).toBe('request')
    expect(target.kind === 'request' && target.request.id).toBe('r1')
    expect(collections.deleteRequest).not.toHaveBeenCalled()
    expect(collections.deleteFolder).not.toHaveBeenCalled()

    await focusRow('folder:f1')
    await pressKey(row('folder:f1'), 'Backspace')
    expect(onRequestDelete).toHaveBeenCalledTimes(2)
    const folderTarget = onRequestDelete.mock.calls[1]![0] as TreeDeleteTarget
    expect(folderTarget.kind === 'folder' && folderTarget.folder.id).toBe('f1')
    expect(folderTarget.kind === 'folder' && folderTarget.collection.id).toBe('c1')
  })

  it('Esc：关菜单且焦点还原到原树行；无菜单时保留行焦点与选择', async () => {
    await renderTree()
    await focusRow('collection:c1')
    await pressKey(row('collection:c1'), 'F10', { shiftKey: true })
    expect(menuElement()).not.toBeNull()
    await pressKey(document.activeElement as HTMLElement, 'Escape')
    await flushMicrotasks()
    expect(menuElement()).toBeNull()
    expect(document.activeElement).toBe(row('collection:c1'))
    // 无菜单 Esc：无副作用（选择保留）
    await pressKey(row('collection:c1'), 'Escape')
    expect(row('collection:c1').getAttribute('aria-selected')).toBe('true')
  })
})

// ---------- 7. stale（AC-22 UI 面 / §4.9） ----------

describe('stale：mutation 禁用 + 重新刷新（AC-22/§4.9）', () => {
  it('stale 时：横幅 + 重新刷新按钮 + 工具区新建禁用；浏览/展开保留', async () => {
    const { collections } = await renderTree({ collections: { stale: true } })
    const banner = container.querySelector('[data-dsh-api-client="tree-stale-banner"]')
    expect(banner).not.toBeNull()
    expect(banner!.textContent).toContain('列表已过期')
    expect(banner!.textContent).not.toContain('回滚')
    expect(container.querySelector('[data-dsh-api-client="tree-new-collection"]')).toHaveProperty('disabled', true)
    // 浏览保留：展开照常可用。
    await expandCollectionC1()
    expect(rowKeys()).toContain('folder:f1')
    await click(container.querySelector<HTMLElement>('[data-dsh-api-client="tree-stale-refresh"]')!)
    expect(vi.mocked(collections.refresh)).toHaveBeenCalledTimes(1)
  })

  it('stale 时菜单 mutation 项禁用并给中文原因；复制/导出保留', async () => {
    await renderTree({ collections: { stale: true } })
    await expandCollectionC1()
    await contextMenuOn(row('request:r1'))
    for (const id of ['rename', 'paste', 'delete']) {
      const item = menuItem(id)!
      expect(item.getAttribute('aria-disabled'), `${id} 应禁用`).toBe('true')
      expect(item.textContent).toContain('列表已过期，请先刷新')
    }
    // 复制/剪切/导出文本不改树数据 → 保留可用（版本冲突由 Host 409 裁决）。
    for (const id of ['copy', 'cut', 'copy-url', 'copy-curl', 'open']) {
      expect(menuItem(id)!.getAttribute('aria-disabled'), `${id} 应可用`).toBe('false')
    }
  })

  it('stale 时键盘 mutation 入口禁用：F2/Delete 中文 toast，不触发回调', async () => {
    const { onRequestDelete } = await renderTree({ collections: { stale: true } })
    await focusRow('collection:c1')
    await pressKey(row('collection:c1'), 'F2')
    expect(renameInput()).toBeNull()
    expect(toastMocks.error).toHaveBeenCalledWith('列表已过期，请先刷新')
    await pressKey(row('collection:c1'), 'Delete')
    expect(onRequestDelete).not.toHaveBeenCalled()
    expect(toastMocks.error).toHaveBeenCalledWith('列表已过期，请先刷新')
  })

  it('刷新成功后恢复：stale=false 重渲染 → 横幅消失、入口恢复', async () => {
    const collections = fakeCollections({ stale: true })
    const clipboard = fakeClipboard(undefined)
    const handlers = fakeHandlers()
    await act(async () => {
      root.render(createElement(CollectionTree, { collections, clipboard, handlers }))
    })
    expect(container.querySelector('[data-dsh-api-client="tree-stale-banner"]')).not.toBeNull()
    await act(async () => {
      root.render(createElement(CollectionTree, { collections: { ...collections, stale: false }, clipboard, handlers }))
    })
    expect(container.querySelector('[data-dsh-api-client="tree-stale-banner"]')).toBeNull()
    expect(container.querySelector('[data-dsh-api-client="tree-new-collection"]')).toHaveProperty('disabled', false)
  })
})

// ---------- 8. 新建对话框（TreeCreateDialog 接线） ----------

describe('TreeCreateDialog：新建 Collection / Folder / 子 Folder', () => {
  function createInput(): HTMLInputElement {
    const input = document.body.querySelector<HTMLInputElement>('[data-dsh-api-client="tree-create-input"]')
    expect(input).not.toBeNull()
    return input!
  }

  async function submitDialog(): Promise<void> {
    await act(async () => {
      document.body.querySelector<HTMLElement>('[data-dsh-api-client="tree-create-submit"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
  }

  it('工具区「+」→ 新建 Collection：非空校验 + 提交 + 成功关闭', async () => {
    const { collections } = await renderTree()
    await click(container.querySelector<HTMLElement>('[data-dsh-api-client="tree-new-collection"]')!)
    await act(async () => {
      setNativeValue(createInput(), '   ')
    })
    await submitDialog()
    expect(document.body.querySelector('[data-dsh-api-client="tree-create-error"]')?.textContent).toBe('名称不能为空')
    expect(collections.createCollection).not.toHaveBeenCalled()

    await act(async () => {
      setNativeValue(createInput(), '新集合')
    })
    await submitDialog()
    expect(vi.mocked(collections.createCollection)).toHaveBeenCalledWith('新集合')
    expect(document.body.querySelector('[data-dsh-api-client="tree-create-dialog"]')).toBeNull()
  })

  it('打开时焦点进输入框；Esc 取消关闭', async () => {
    await renderTree()
    await click(container.querySelector<HTMLElement>('[data-dsh-api-client="tree-new-collection"]')!)
    expect(document.activeElement).toBe(createInput())
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(document.body.querySelector('[data-dsh-api-client="tree-create-dialog"]')).toBeNull()
  })

  it('Collection 菜单「新建 Folder」→ createFolder(collectionId, name, undefined, updatedAt)', async () => {
    const { collections } = await renderTree()
    await contextMenuOn(row('collection:c1'))
    await clickMenuItem('new-folder')
    await flushMicrotasks()
    const dialog = document.body.querySelector('[data-dsh-api-client="tree-create-dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog!.textContent).toContain('创建到 Collection「订单 API」')
    await act(async () => {
      setNativeValue(createInput(), '新目录')
    })
    await submitDialog()
    expect(vi.mocked(collections.createFolder)).toHaveBeenCalledWith('c1', '新目录', undefined, 1000)
  })

  it('Folder 菜单「新建子 Folder」→ createFolder(collectionId, name, parentFolderId, updatedAt)', async () => {
    const { collections } = await renderTree()
    await expandCollectionC1()
    await contextMenuOn(row('folder:f1'))
    await clickMenuItem('new-subfolder')
    await flushMicrotasks()
    expect(document.body.querySelector('[data-dsh-api-client="tree-create-dialog"]')!.textContent).toContain('创建到 Folder「用户模块」')
    await act(async () => {
      setNativeValue(createInput(), '子目录二')
    })
    await submitDialog()
    expect(vi.mocked(collections.createFolder)).toHaveBeenCalledWith('c1', '子目录二', 'f1', 1000)
  })

  it('Host 失败：对话框保持打开、输入不丢、内联中文错误', async () => {
    await renderTree({ collections: { createFolder: vi.fn(async () => ({ committed: false, refreshed: false, error: '名称不合法' })) } })
    await contextMenuOn(row('collection:c1'))
    await clickMenuItem('new-folder')
    await flushMicrotasks()
    await act(async () => {
      setNativeValue(createInput(), '坏名字')
    })
    await submitDialog()
    expect(document.body.querySelector('[data-dsh-api-client="tree-create-dialog"]')).not.toBeNull()
    expect(createInput().value).toBe('坏名字')
    expect(document.body.querySelector('[data-dsh-api-client="tree-create-error"]')?.textContent).toBe('名称不合法')
  })

  it('菜单「新建 Request」→ onNewRequest(collectionId, folderId?)（草稿入口归 WP8）', async () => {
    const { onNewRequest } = await renderTree()
    await contextMenuOn(row('collection:c1'))
    await clickMenuItem('new-request')
    expect(onNewRequest).toHaveBeenCalledWith('c1')

    await expandCollectionC1()
    await contextMenuOn(row('folder:f1'))
    await clickMenuItem('new-request')
    expect(onNewRequest).toHaveBeenLastCalledWith('c1', 'f1')
  })
})

// ---------- 9. useCollections 真实钩子（mock fetch）：§4.9 流程 + WP3 端点形态 ----------

describe('useCollections（mock fetch）：§4.9 stale 流程与 WP3 Folder 端点形态', () => {
  interface FetchCall {
    method: string
    url: string
    init?: RequestInit
  }

  let fetchMock: ReturnType<typeof vi.fn>
  let calls: FetchCall[]
  let captured: CollectionsState | undefined

  function Harness(): null {
    captured = useCollections()
    return null
  }

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

  const getRoutes: Array<[RegExp, RouteHandler]> = [[/GET .*\/collections$/, () => mockResponse(200, fixture())]]

  beforeEach(() => {
    calls = []
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    ;(globalThis as Record<string, unknown>)[TOKEN_GLOBAL_NAME] = { base: '/api-client', token: 'test-token' }
    captured = undefined
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete (globalThis as Record<string, unknown>)[TOKEN_GLOBAL_NAME]
  })

  async function renderHook(): Promise<void> {
    await act(async () => {
      root.render(createElement(Harness))
    })
  }

  it('初始加载：投影落位、stale=false、loading=false', async () => {
    routeFetch(getRoutes)
    await renderHook()
    expect(captured!.collections.map((c) => c.id)).toEqual(['c1', 'c2'])
    expect(captured!.loading).toBe(false)
    expect(captured!.stale).toBe(false)
  })

  it('mutation 成功 + refresh 成功：committed/refreshed=true、投影替换、stale=false、DELETE 带版本 body + CSRF 头', async () => {
    const refreshed = fixture()
    refreshed[1]!.name = '空集合（已改名）'
    routeFetch([
      [/DELETE .*\/requests\/r1$/, () => mockResponse(204)],
      [/GET .*\/collections$/, () => mockResponse(200, refreshed)],
    ])
    await renderHook()
    let outcome: MutationOutcome | undefined
    await act(async () => {
      outcome = await captured!.deleteRequest('r1', 1000)
    })
    expect(outcome).toEqual({ committed: true, refreshed: true })
    expect(captured!.collections[1]!.name).toBe('空集合（已改名）')
    expect(captured!.stale).toBe(false)
    const deleteCall = calls.find((call) => call.method === 'DELETE')!
    expect(JSON.parse(String(deleteCall.init?.body))).toEqual({ expectedCollectionUpdatedAt: 1000 })
    expect((deleteCall.init?.headers as Record<string, string>)['X-Dsh-Api-Client-Request']).toBe('1')
    expect((deleteCall.init?.headers as Record<string, string>)['content-type']).toBe('application/json')
  })

  it('mutation 成功 + refresh 失败：保持旧投影、stale=true、toast「数据已保存，列表刷新失败」（AC-22）', async () => {
    let getCount = 0
    routeFetch([
      [/DELETE .*\/collections\/c2$/, () => mockResponse(204)],
      [
        /GET .*\/collections$/,
        () => {
          getCount += 1
          if (getCount === 1) return mockResponse(200, fixture())
          throw new Error('network down')
        },
      ],
    ])
    await renderHook()
    let outcome: MutationOutcome | undefined
    await act(async () => {
      outcome = await captured!.deleteCollection('c2')
    })
    expect(outcome).toEqual({ committed: true, refreshed: false })
    // 保持旧投影（Host 已提交，不谎称回滚）。
    expect(captured!.collections.map((c) => c.id)).toEqual(['c1', 'c2'])
    expect(captured!.stale).toBe(true)
    expect(toastMocks.error).toHaveBeenCalledWith('数据已保存，列表刷新失败')
    expect(toastMocks.error.mock.calls.flat().join('\n')).not.toContain('回滚')
  })

  it('mutation 409：stale=true + Host 逐字 message toast、保持旧 UI、不发起 refresh；refresh 成功后恢复（§3.1.1）', async () => {
    routeFetch([
      ...getRoutes,
      [/DELETE .*\/collections\/c1\/folders\/f1$/, () => mockResponse(409, { error: { code: 'version-conflict', message: '数据已被其他操作修改，请刷新后重试' } })],
    ])
    await renderHook()
    let outcome: MutationOutcome | undefined
    await act(async () => {
      outcome = await captured!.deleteFolder('c1', 'f1', 999)
    })
    expect(outcome!.committed).toBe(false)
    expect(captured!.stale).toBe(true)
    expect(toastMocks.error).toHaveBeenCalledWith('数据已被其他操作修改，请刷新后重试')
    // 409 后不发 GET（§4.9 流程图：失败分支不进 refresh）；GET 计数 = 初始加载 1 次。
    expect(calls.filter((call) => call.method === 'GET')).toHaveLength(1)
    await act(async () => {
      expect(await captured!.refresh()).toBe(true)
    })
    expect(captured!.stale).toBe(false)
  })

  it('WP3 Folder 端点形态：createFolder/renameFolder POST/PATCH 带版本；deleteFolder DELETE 带 JSON body', async () => {
    routeFetch([
      ...getRoutes,
      [/POST .*\/collections\/c1\/folders$/, () => mockResponse(200, { id: 'f-new', name: '新目录' })],
      [/PATCH .*\/collections\/c1\/folders\/f-new$/, () => mockResponse(200, { id: 'f-new', name: '改名目录' })],
      [/DELETE .*\/collections\/c1\/folders\/f-new$/, () => mockResponse(204)],
    ])
    await renderHook()
    let created: (MutationOutcome & { folder?: FolderDescriptor }) | undefined
    await act(async () => {
      created = await captured!.createFolder('c1', '新目录', undefined, 1000)
    })
    expect(created).toEqual({ committed: true, refreshed: true, folder: { id: 'f-new', name: '新目录' } })
    const post = calls.find((call) => call.method === 'POST')!
    expect(post.url).toBe('/api-client/collections/c1/folders')
    expect(JSON.parse(String(post.init?.body))).toEqual({ name: '新目录', expectedCollectionUpdatedAt: 1000 })

    await act(async () => {
      await captured!.renameFolder('c1', 'f-new', '改名目录', 1001)
    })
    const patch = calls.find((call) => call.method === 'PATCH')!
    expect(patch.url).toBe('/api-client/collections/c1/folders/f-new')
    expect(JSON.parse(String(patch.init?.body))).toEqual({ name: '改名目录', expectedCollectionUpdatedAt: 1001 })

    await act(async () => {
      await captured!.deleteFolder('c1', 'f-new', 1002)
    })
    const del = calls.find((call) => call.method === 'DELETE')!
    expect(del.url).toBe('/api-client/collections/c1/folders/f-new')
    expect(JSON.parse(String(del.init?.body))).toEqual({ expectedCollectionUpdatedAt: 1002 })
  })

  it('createFolder 子目录：body 携带 parentFolderId', async () => {
    routeFetch([...getRoutes, [/POST .*\/collections\/c1\/folders$/, () => mockResponse(200, { id: 'f-sub', name: '子目录' })]])
    await renderHook()
    await act(async () => {
      await captured!.createFolder('c1', '子目录', 'f1', 1000)
    })
    const post = calls.find((call) => call.method === 'POST')!
    expect(JSON.parse(String(post.init?.body))).toEqual({ name: '子目录', parentFolderId: 'f1', expectedCollectionUpdatedAt: 1000 })
  })

  it('patchRequest 版本参数走 query——绝不进 body（Host Object.assign 会持久化污染）', async () => {
    routeFetch([...getRoutes, [/PATCH .*\/requests\/r1/, () => mockResponse(200, { ...R1(), name: '改名' })]])
    await renderHook()
    await act(async () => {
      await captured!.patchRequest('r1', { name: '改名' }, 1000)
    })
    const patch = calls.find((call) => call.method === 'PATCH')!
    expect(patch.url).toBe('/api-client/requests/r1?expectedCollectionUpdatedAt=1000')
    expect(JSON.parse(String(patch.init?.body))).toEqual({ name: '改名' })
  })
})
