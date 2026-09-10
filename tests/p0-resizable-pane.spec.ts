/**
 * WP4：ResizableCollectionPane + useCollectionSidebarWidth（UX §5 / 实施设计 §0.4、§6.6–§6.8）。
 *
 * 覆盖（AC-28…AC-34 client 面）：
 * - 三态临界值（705/706、525/526）与宽度公式逐点断言（纯函数 + DOM 双路）；
 * - 持久化域钳制 220–520 整数（含 §0.4：compact 渲染 180 → 持久化 220 → 回宽屏渲染 220）；
 * - pointer capture 拖动：move 只改 rendered、up/lostpointercapture 持久化、cancel 恢复起点；
 * - 双击 260 立即持久化；键盘 10/40px + 300ms debounce（fake timers）；
 * - hidden：docked width=0 + inert + children 不卸载（同一 DOM 节点）+「展开请求树」按钮；
 * - drawer：宽度公式 min(320, viewport-32)、焦点进搜索框、Tab/Shift+Tab trap、
 *   Esc/backdrop/关闭按钮/再点切换按钮/onRequestOpened 关闭、树节点 toggle 不关闭、
 *   焦点归还按钮、≥526 无动画切回 docked 保留焦点、docked 缩窄默认关闭、overlay 不持久化；
 * - 保存失败 → 中文非阻断 toast，内存宽度不回滚；
 * - 不重挂载契约：树与主编辑器 DOM 节点恒等 + 搜索框草稿值全程保留；
 * - hook 细节：unmount flush 待持久化值、立即 persist 取消 pending debounce、迟到加载不覆盖用户值。
 *
 * jsdom 补差：ResizeObserver / Pointer Events（setPointerCapture、PointerEvent）均为
 * 测试注入的 mock/polyfill——实现侧对缺失容错（见组件头注）。
 */
import { act, createElement, createRef } from 'react'
import type { RefObject } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  captured: [] as number[],
  released: [] as number[],
}))

vi.mock('../src/client/hooks/useHostApi.ts', () => {
  // 忠实真实契约：useHostApi 返回稳定的 client 引用（cached ??= createHostApi()）。
  const client = {
    available: true,
    request: vi.fn(),
    get: mocks.get,
    post: vi.fn(),
    patch: mocks.patch,
    put: vi.fn(),
    delete: vi.fn(),
  }
  return { useHostApi: () => client }
})

vi.mock('../src/client/components/common/Toast.tsx', () => ({
  toast: {
    push: vi.fn(),
    error: mocks.toastError,
    info: mocks.toastInfo,
    dismiss: vi.fn(),
  },
  ToastHost: () => null,
}))

import {
  COMPACT_BREAKPOINT,
  NORMAL_BREAKPOINT,
  ResizableCollectionPane,
  computeDrawerWidth,
  computeRenderedWidth,
  getPaneMode,
  getRenderedRange,
} from '../src/client/components/collection/ResizableCollectionPane.tsx'
import type { ResizableCollectionPaneHandle } from '../src/client/components/collection/ResizableCollectionPane.tsx'
import {
  SIDEBAR_PERSIST_DEBOUNCE_MS,
  SIDEBAR_SAVE_FAILED_MESSAGE,
  SIDEBAR_WIDTH_DEFAULT,
  clampSidebarPreference,
} from '../src/client/hooks/useCollectionSidebarWidth.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ---- jsdom 补差：ResizeObserver / PointerEvent / pointer capture ----

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

interface PointerMockInit extends MouseEventInit {
  pointerId?: number
}

class PointerEventMock extends MouseEvent {
  pointerId: number
  constructor(type: string, init: PointerMockInit = {}) {
    super(type, init)
    this.pointerId = init.pointerId ?? 1
  }
}

function fireResize(width: number): void {
  for (const instance of ResizeObserverMock.instances) instance.fire(width)
}

// ---- 渲染 harness（children/main 为模块级恒定元素：同 key 同实例贯穿全部测试渲染）----

const treeChildren = createElement(
  'div',
  { id: 'tree-root' },
  createElement('input', { id: 'tree-search', placeholder: '搜索请求' }),
  createElement('button', { type: 'button', id: 'tree-node' }, '示例 Collection 节点'),
)
const mainContent = createElement('div', { id: 'main-marker' }, '主编辑器')

let container: HTMLDivElement
let root: Root
let unmounted = false

/** 同一测试内多轮渲染：干净卸载旧 root 并重建容器（保持 unmounted 记账一致）。 */
function freshRoot(): void {
  if (!unmounted) act(() => root.unmount())
  container.remove()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  unmounted = false
}

async function renderPane(viewport: number): Promise<RefObject<ResizableCollectionPaneHandle>> {
  const handleRef = createRef<ResizableCollectionPaneHandle>()
  await act(async () => {
    root.render(
      createElement(ResizableCollectionPane, { ref: handleRef, main: mainContent, children: treeChildren }),
    )
  })
  await act(async () => {}) // 排空 hook 加载链 then/catch/finally 的多级 microtask
  fireResize(viewport)
  return handleRef
}

// ---- 查询助手 ----

function paneEl(): HTMLDivElement {
  const element = container.querySelector<HTMLDivElement>('[data-dsh-api-client="collection-sidebar-pane"]')
  expect(element).not.toBeNull()
  return element!
}
function separatorEl(): HTMLDivElement {
  const element = container.querySelector<HTMLDivElement>('[data-dsh-api-client="collection-sidebar-separator"]')
  expect(element).not.toBeNull()
  return element!
}
function mainWrapperEl(): HTMLDivElement {
  const element = container.querySelector<HTMLDivElement>('[data-dsh-api-client="collection-pane-main"]')
  expect(element).not.toBeNull()
  return element!
}
function toggleEl(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('[data-dsh-api-client="collection-sidebar-drawer-toggle"]')
}
function backdropEl(): HTMLDivElement | null {
  return container.querySelector<HTMLDivElement>('[data-dsh-api-client="collection-sidebar-drawer-backdrop"]')
}
function drawerCloseEl(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('[data-dsh-api-client="collection-sidebar-drawer-close"]')
}
function searchEl(): HTMLInputElement {
  const element = container.querySelector<HTMLInputElement>('#tree-search')
  expect(element).not.toBeNull()
  return element!
}
function treeNodeEl(): HTMLElement {
  const element = container.querySelector<HTMLElement>('#tree-node')
  expect(element).not.toBeNull()
  return element!
}
function mainMarkerEl(): HTMLElement {
  const element = container.querySelector<HTMLElement>('#main-marker')
  expect(element).not.toBeNull()
  return element!
}
function paneWidth(): string {
  return paneEl().style.width
}

// ---- 事件助手 ----

function dispatch(element: Element | Window, event: Event): void {
  act(() => {
    element.dispatchEvent(event)
  })
}
function pointerDown(element: Element, clientX: number, pointerId = 7): void {
  dispatch(element, new PointerEventMock('pointerdown', { clientX, pointerId, bubbles: true, cancelable: true }))
}
function pointerMove(clientX: number): void {
  dispatch(window, new PointerEventMock('pointermove', { clientX, bubbles: true }))
}
function pointerUp(): void {
  dispatch(window, new PointerEventMock('pointerup', { bubbles: true }))
}
function pointerCancel(): void {
  dispatch(window, new PointerEventMock('pointercancel', { bubbles: true }))
}
function lostPointerCapture(element: Element): void {
  dispatch(element, new Event('lostpointercapture', { bubbles: true }))
}
function click(element: Element): void {
  dispatch(element, new MouseEvent('click', { bubbles: true }))
}
function doubleClick(element: Element): void {
  dispatch(element, new MouseEvent('dblclick', { bubbles: true }))
}
function keyDown(element: Element, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  dispatch(element, event)
  return event
}
function windowKey(key: string): void {
  dispatch(window, new KeyboardEvent('keydown', { key, bubbles: true }))
}

function useFakeTimersScoped(): void {
  // 只 fake debounce 用到的定时器：避免连带 fake MessageChannel 卡住 React scheduler。
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
}

beforeEach(() => {
  ResizeObserverMock.instances = []
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverMock
  mocks.get.mockReset()
  mocks.get.mockResolvedValue({ collectionSidebarWidth: SIDEBAR_WIDTH_DEFAULT })
  mocks.patch.mockReset()
  mocks.patch.mockResolvedValue({})
  mocks.toastError.mockReset()
  mocks.toastInfo.mockReset()
  mocks.captured = []
  mocks.released = []
  Element.prototype.setPointerCapture = function (this: Element, pointerId: number): void {
    mocks.captured.push(pointerId)
  }
  Element.prototype.releasePointerCapture = function (this: Element, pointerId: number): void {
    mocks.released.push(pointerId)
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  unmounted = false
})

afterEach(() => {
  if (!unmounted) act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
  delete (Element.prototype as { setPointerCapture?: unknown }).setPointerCapture
  delete (Element.prototype as { releasePointerCapture?: unknown }).releasePointerCapture
})

// ==================================================================
// 纯函数合同（AC-28/AC-29/AC-30）
// ==================================================================

describe('WP4 纯函数：三态临界值与宽度公式', () => {
  it('模式阈值：706/705、526/525（AC-28/AC-29）', () => {
    expect(getPaneMode(1400)).toBe('normal')
    expect(getPaneMode(NORMAL_BREAKPOINT)).toBe('normal') // 706
    expect(getPaneMode(705)).toBe('compact')
    expect(getPaneMode(COMPACT_BREAKPOINT)).toBe('compact') // 526
    expect(getPaneMode(525)).toBe('hidden')
    expect(getPaneMode(0)).toBe('hidden')
  })

  it('normal 公式 rendered = clamp(preferred, 220, min(520, viewport-486)) 逐点', () => {
    expect(getRenderedRange('normal', 706)).toEqual({ min: 220, max: 220 })
    expect(getRenderedRange('normal', 707)).toEqual({ min: 220, max: 221 })
    expect(getRenderedRange('normal', 1006)).toEqual({ min: 220, max: 520 })
    expect(getRenderedRange('normal', 2000)).toEqual({ min: 220, max: 520 })
    expect(computeRenderedWidth('normal', 706, 260)).toBe(220) // max 压到 220
    expect(computeRenderedWidth('normal', 706, 180)).toBe(220) // min 抬到 220
    expect(computeRenderedWidth('normal', 900, 500)).toBe(414) // max = 900-486
    expect(computeRenderedWidth('normal', 1400, 500)).toBe(500)
    expect(computeRenderedWidth('normal', 1400, 600)).toBe(520)
    expect(computeRenderedWidth('normal', 1400, 100)).toBe(220)
  })

  it('compact 公式 rendered = clamp(preferred, 160, viewport-366) 逐点', () => {
    expect(getRenderedRange('compact', 526)).toEqual({ min: 160, max: 160 })
    expect(getRenderedRange('compact', 560)).toEqual({ min: 160, max: 194 })
    expect(getRenderedRange('compact', 705)).toEqual({ min: 160, max: 339 })
    expect(computeRenderedWidth('compact', 526, 260)).toBe(160)
    expect(computeRenderedWidth('compact', 560, 260)).toBe(194)
    expect(computeRenderedWidth('compact', 705, 260)).toBe(260)
    expect(computeRenderedWidth('compact', 705, 400)).toBe(339)
    expect(computeRenderedWidth('compact', 600, 150)).toBe(160) // §0.4：渲染域可到 160–219
    expect(computeRenderedWidth('compact', 600, 200)).toBe(200)
  })

  it('hidden：docked 恒 0；drawer = min(320, viewport-32)（AC-30）', () => {
    expect(getRenderedRange('hidden', 400)).toBeNull()
    expect(computeRenderedWidth('hidden', 400, 260)).toBe(0)
    expect(computeDrawerWidth(400)).toBe(320)
    expect(computeDrawerWidth(352)).toBe(320)
    expect(computeDrawerWidth(351)).toBe(319)
    expect(computeDrawerWidth(300)).toBe(268)
    expect(computeDrawerWidth(100)).toBe(68)
    expect(computeDrawerWidth(32)).toBe(0)
  })
})

describe('WP4 纯函数：持久化偏好域钳制（§0.4/§4.1.3）', () => {
  it('恒钳制到 220–520 整数；非有限数回落 260', () => {
    expect(clampSidebarPreference(160)).toBe(220)
    expect(clampSidebarPreference(180)).toBe(220) // §0.4 核心：compact 180 → 持久化 220
    expect(clampSidebarPreference(219)).toBe(220)
    expect(clampSidebarPreference(220)).toBe(220)
    expect(clampSidebarPreference(300.4)).toBe(300)
    expect(clampSidebarPreference(300.5)).toBe(301)
    expect(clampSidebarPreference(520)).toBe(520)
    expect(clampSidebarPreference(521)).toBe(520)
    expect(clampSidebarPreference(-100)).toBe(220)
    expect(clampSidebarPreference(Number.NaN)).toBe(260)
    expect(clampSidebarPreference(Number.POSITIVE_INFINITY)).toBe(260)
  })
})

// ==================================================================
// settings 加载（GET /settings）
// ==================================================================

describe('WP4 加载：GET /settings 读取偏好', () => {
  it('读到 400 → docked 渲染 400', async () => {
    mocks.get.mockResolvedValue({ collectionSidebarWidth: 400 })
    await renderPane(1000)
    expect(mocks.get).toHaveBeenCalledWith('/settings')
    expect(paneWidth()).toBe('400px')
    expect(separatorEl().getAttribute('aria-valuenow')).toBe('400')
  })

  it('字段缺失 / 响应异常 / 请求失败 → 回落 260（加载失败静默、不弹 toast）', async () => {
    mocks.get.mockResolvedValue({})
    await renderPane(1000)
    expect(paneWidth()).toBe('260px')

    freshRoot()
    mocks.get.mockRejectedValue(new Error('network down'))
    await renderPane(1000)
    expect(paneWidth()).toBe('260px')
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('越界/非整数存量值加载即钳制：180→220、600→520、300.7→301', async () => {
    const cases: Array<[number, string]> = [
      [180, '220px'],
      [600, '520px'],
      [300.7, '301px'],
    ]
    for (const [index, [stored, expected]] of cases.entries()) {
      if (index > 0) freshRoot()
      mocks.get.mockResolvedValue({ collectionSidebarWidth: stored })
      await renderPane(1400)
      expect(paneWidth()).toBe(expected)
    }
  })
})

// ==================================================================
// 三态 DOM 与分隔条 ARIA
// ==================================================================

describe('WP4 三态 DOM 与分隔条 ARIA（§6.6/§6.7）', () => {
  it('normal：6px 命中区分隔条 + role/aria/tabIndex/中文提示完整', async () => {
    await renderPane(1000)
    const separator = separatorEl()
    expect(separator.getAttribute('role')).toBe('separator')
    expect(separator.getAttribute('aria-orientation')).toBe('vertical')
    expect(separator.getAttribute('aria-label')).toBe('请求树侧栏宽度')
    expect(separator.getAttribute('aria-valuenow')).toBe('260')
    expect(separator.getAttribute('aria-valuemin')).toBe('220')
    expect(separator.getAttribute('aria-valuemax')).toBe('514') // min(520, 1000-486)
    expect(separator.getAttribute('tabindex')).toBe('0')
    expect(separator.style.width).toBe('6px')
    expect(separator.style.cursor).toBe('col-resize')
    expect(separator.title).toContain('双击恢复默认 260px')
    expect(paneEl().dataset.paneMode).toBe('normal')
    expect(toggleEl()).toBeNull()
    expect(backdropEl()).toBeNull()
  })

  it('临界值 DOM 逐点：706→220、705→260、526→160、525→hidden', async () => {
    await renderPane(1000)
    expect(paneWidth()).toBe('260px')

    fireResize(706)
    expect(paneWidth()).toBe('220px')
    expect(paneEl().dataset.paneMode).toBe('normal')
    expect(separatorEl().getAttribute('aria-valuemax')).toBe('220')

    fireResize(705)
    expect(paneWidth()).toBe('260px')
    expect(paneEl().dataset.paneMode).toBe('compact')
    expect(separatorEl().getAttribute('aria-valuemin')).toBe('160')
    expect(separatorEl().getAttribute('aria-valuemax')).toBe('339')

    fireResize(526)
    expect(paneWidth()).toBe('160px')
    expect(toggleEl()).toBeNull()

    fireResize(525)
    expect(paneEl().dataset.paneMode).toBe('hidden')
    expect(paneWidth()).toBe('0px')
    expect(separatorEl().style.display).toBe('none')
    expect(toggleEl()).not.toBeNull()
  })

  it('hidden：width=0 + inert + pointer-events none，children 不卸载（同一 DOM 节点），按钮中文', async () => {
    await renderPane(1000)
    const treeNode = container.querySelector('#tree-root')
    const mainMarker = mainMarkerEl()
    expect(treeNode).not.toBeNull()

    fireResize(400)
    const pane = paneEl()
    expect(pane.style.width).toBe('0px')
    expect(pane.style.flex).toBe('0 0 0px')
    expect(pane.style.pointerEvents).toBe('none')
    expect(pane.hasAttribute('inert')).toBe(true)
    // React 树不卸载：同一 DOM 节点仍挂在文档中（AC-34 的树侧保证）
    expect(container.querySelector('#tree-root')).toBe(treeNode)
    expect(container.contains(treeNode!)).toBe(true)
    expect(mainMarkerEl()).toBe(mainMarker)
    // 不使用原生 CSS resize
    expect(pane.style.resize).toBe('')
    expect(separatorEl().style.resize).toBe('')

    const toggle = toggleEl()
    expect(toggle).not.toBeNull()
    expect(toggle!.textContent).toBe('展开请求树')
    expect(toggle!.title).toBe('展开请求树')
    expect(toggle!.getAttribute('aria-expanded')).toBe('false')

    // 回到宽屏：docked 恢复偏好宽度，inert 摘除，同一节点
    fireResize(1000)
    expect(paneWidth()).toBe('260px')
    expect(paneEl().hasAttribute('inert')).toBe(false)
    expect(container.querySelector('#tree-root')).toBe(treeNode)
    expect(toggleEl()).toBeNull()
  })

  it('hidden 态分隔条交互全部无效（不可拖动/键盘）', async () => {
    await renderPane(400)
    pointerDown(separatorEl(), 100)
    expect(mocks.captured).toEqual([])
    pointerMove(300)
    pointerUp()
    keyDown(separatorEl(), { key: 'ArrowRight' })
    expect(mocks.patch).not.toHaveBeenCalled()
    expect(paneWidth()).toBe('0px')
  })
})

// ==================================================================
// pointer 拖动（AC-31）
// ==================================================================

describe('WP4 pointer 拖动', () => {
  it('pointerdown 即 setPointerCapture；move 只更新 rendered 不持久化；up 持久化一次并释放 capture', async () => {
    await renderPane(1000)
    expect(paneWidth()).toBe('260px')

    pointerDown(separatorEl(), 500)
    expect(mocks.captured).toEqual([7])

    pointerMove(600)
    expect(paneWidth()).toBe('360px')
    expect(separatorEl().getAttribute('aria-valuenow')).toBe('360')
    expect(mocks.patch).not.toHaveBeenCalled()

    pointerMove(620)
    expect(paneWidth()).toBe('380px')
    expect(mocks.patch).not.toHaveBeenCalled()

    pointerUp()
    expect(mocks.patch).toHaveBeenCalledTimes(1)
    expect(mocks.patch).toHaveBeenCalledWith('/settings', { collectionSidebarWidth: 380 })
    expect(mocks.released).toEqual([7])
    expect(paneWidth()).toBe('380px')
    // up 之后监听器已收敛：再派发 move 不改变宽度
    pointerMove(900)
    expect(paneWidth()).toBe('380px')
  })

  it('拖动越域钳制：上限 min(520, viewport-486)、下限 220', async () => {
    await renderPane(1000)
    pointerDown(separatorEl(), 500)
    pointerMove(99999)
    expect(paneWidth()).toBe('514px')
    pointerMove(-99999)
    expect(paneWidth()).toBe('220px')
    pointerUp()
    expect(mocks.patch).toHaveBeenCalledTimes(1)
    expect(mocks.patch).toHaveBeenCalledWith('/settings', { collectionSidebarWidth: 220 })
  })

  it('pointercancel 恢复拖动起点且不持久化、偏好不受污染', async () => {
    await renderPane(1000)
    pointerDown(separatorEl(), 500)
    pointerMove(650)
    expect(paneWidth()).toBe('410px')
    pointerCancel()
    expect(paneWidth()).toBe('260px')
    expect(mocks.patch).not.toHaveBeenCalled()
    expect(mocks.released).toEqual([7])
    // preferred 仍是 260：viewport 变化后按 260 派生（若 cancel 污染成 410，此处会是 410）
    fireResize(900)
    expect(paneWidth()).toBe('260px')
  })

  it('lostpointercapture 与 pointerup 等价收敛（持久化一次，幂等）', async () => {
    await renderPane(1000)
    pointerDown(separatorEl(), 500)
    pointerMove(540)
    expect(paneWidth()).toBe('300px')
    lostPointerCapture(separatorEl())
    expect(mocks.patch).toHaveBeenCalledTimes(1)
    expect(mocks.patch).toHaveBeenCalledWith('/settings', { collectionSidebarWidth: 300 })
    expect(paneWidth()).toBe('300px')
    // 随后的 pointerup 幂等（drag 已收敛）
    pointerUp()
    expect(mocks.patch).toHaveBeenCalledTimes(1)
  })
})

// ==================================================================
// 双击 / 键盘（AC-32）
// ==================================================================

describe('WP4 双击分隔条', () => {
  it('恢复 260：立即更新内存并立即持久化；渲染按当前模式域钳制', async () => {
    mocks.get.mockResolvedValue({ collectionSidebarWidth: 400 })
    await renderPane(1000)
    expect(paneWidth()).toBe('400px')

    doubleClick(separatorEl())
    expect(paneWidth()).toBe('260px')
    expect(mocks.patch).toHaveBeenCalledTimes(1)
    expect(mocks.patch).toHaveBeenCalledWith('/settings', { collectionSidebarWidth: 260 })

    // viewport=706：渲染 max=220，双击仍持久化偏好域值 260，渲染 220
    fireResize(706)
    expect(paneWidth()).toBe('220px')
    doubleClick(separatorEl())
    expect(paneWidth()).toBe('220px')
    expect(mocks.patch).toHaveBeenCalledTimes(2)
    expect(mocks.patch).toHaveBeenLastCalledWith('/settings', { collectionSidebarWidth: 260 })
  })
})

describe('WP4 键盘调整 + 300ms debounce', () => {
  it('←/→ 10px、Shift 40px，连续操作只在停顿后持久化一次', async () => {
    useFakeTimersScoped()
    await renderPane(1000)
    const separator = separatorEl()
    separator.focus()
    expect(document.activeElement).toBe(separator)

    keyDown(separator, { key: 'ArrowRight' })
    expect(paneWidth()).toBe('270px')
    expect(mocks.patch).not.toHaveBeenCalled()

    keyDown(separator, { key: 'ArrowRight' })
    expect(paneWidth()).toBe('280px')

    keyDown(separator, { key: 'ArrowRight', shiftKey: true })
    expect(paneWidth()).toBe('320px')

    keyDown(separator, { key: 'ArrowLeft', shiftKey: true })
    expect(paneWidth()).toBe('280px')
    expect(mocks.patch).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(SIDEBAR_PERSIST_DEBOUNCE_MS - 1)
    })
    expect(mocks.patch).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(mocks.patch).toHaveBeenCalledTimes(1)
    expect(mocks.patch).toHaveBeenCalledWith('/settings', { collectionSidebarWidth: 280 })

    // 新一轮连按 → 新的一次 debounce
    keyDown(separator, { key: 'ArrowLeft' })
    keyDown(separator, { key: 'ArrowLeft' })
    expect(paneWidth()).toBe('260px')
    act(() => {
      vi.advanceTimersByTime(SIDEBAR_PERSIST_DEBOUNCE_MS)
    })
    expect(mocks.patch).toHaveBeenCalledTimes(2)
    expect(mocks.patch).toHaveBeenLastCalledWith('/settings', { collectionSidebarWidth: 260 })

    // 域边界钳制：拖到 min 后继续 ← 不动
    fireResize(706) // max=min=220
    expect(paneWidth()).toBe('220px')
    keyDown(separator, { key: 'ArrowLeft' })
    expect(paneWidth()).toBe('220px')
    keyDown(separator, { key: 'ArrowRight' })
    expect(paneWidth()).toBe('220px')
  })

  it('键盘在 compact 域内可低于 220（渲染），aria 值随模式域', async () => {
    useFakeTimersScoped()
    await renderPane(566) // compact：max = 200 → rendered = clamp(260,160,200) = 200
    expect(paneWidth()).toBe('200px')
    const separator = separatorEl()
    expect(separator.getAttribute('aria-valuemin')).toBe('160')
    expect(separator.getAttribute('aria-valuemax')).toBe('200')

    keyDown(separator, { key: 'ArrowLeft' })
    keyDown(separator, { key: 'ArrowLeft' })
    keyDown(separator, { key: 'ArrowLeft' })
    expect(paneWidth()).toBe('170px')
    expect(separator.getAttribute('aria-valuenow')).toBe('170')
  })
})

// ==================================================================
// §0.4 compact 持久化语义
// ==================================================================

describe('WP4 §0.4：compact 渲染 160–219，持久化偏好恒 220–520', () => {
  it('compact pointerup 于 180：当前 viewport 继续渲染 180，持久化写 220，回宽屏渲染 220', async () => {
    await renderPane(560) // compact：max=194 → clamp(260,160,194)=194
    expect(paneWidth()).toBe('194px')

    pointerDown(separatorEl(), 300)
    pointerMove(286) // 194 - 14 = 180
    expect(paneWidth()).toBe('180px')
    pointerUp()

    expect(mocks.patch).toHaveBeenCalledTimes(1)
    expect(mocks.patch).toHaveBeenCalledWith('/settings', { collectionSidebarWidth: 220 }) // 180 → 220
    expect(paneWidth()).toBe('180px') // 当前 viewport 继续渲染 180
    expect(separatorEl().getAttribute('aria-valuenow')).toBe('180')

    fireResize(1000) // 回宽屏
    expect(paneWidth()).toBe('220px') // 渲染持久化偏好 220

    fireResize(560) // 再回 compact：override 已清，按公式派生 clamp(220,160,194)=194
    expect(paneWidth()).toBe('194px')
  })

  it('compact 键盘调到 170：渲染 170，debounce 持久化仍写 220', async () => {
    useFakeTimersScoped()
    await renderPane(566) // max=200 → rendered 200
    const separator = separatorEl()
    keyDown(separator, { key: 'ArrowLeft' })
    keyDown(separator, { key: 'ArrowLeft' })
    keyDown(separator, { key: 'ArrowLeft' })
    expect(paneWidth()).toBe('170px')
    expect(mocks.patch).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(SIDEBAR_PERSIST_DEBOUNCE_MS)
    })
    expect(mocks.patch).toHaveBeenCalledTimes(1)
    expect(mocks.patch).toHaveBeenCalledWith('/settings', { collectionSidebarWidth: 220 })

    fireResize(1000)
    expect(paneWidth()).toBe('220px')
  })
})

// ==================================================================
// drawer（AC-30、§6.8）
// ==================================================================

describe('WP4 drawer：极窄 overlay', () => {
  it('宽度 min(320, viewport-32)；overlay 形态覆盖主区不挤压；打开不持久化', async () => {
    await renderPane(400)
    const mainMarker = mainMarkerEl()
    click(toggleEl()!)

    const pane = paneEl()
    expect(pane.style.position).toBe('absolute')
    expect(pane.style.width).toBe('320px') // min(320, 368)
    expect(pane.style.zIndex).toBe('20')
    expect(pane.hasAttribute('inert')).toBe(false)
    expect(backdropEl()).not.toBeNull()
    expect(backdropEl()!.style.position).toBe('absolute')
    // 主区不被挤压：wrapper 仍 flex 1（jsdom CSSOM 序列化为 '1 1 0%'），编辑器节点未变
    expect(mainWrapperEl().style.flex).toBe('1 1 0%')
    expect(mainMarkerEl()).toBe(mainMarker)
    // 切换按钮进入「收起」形态
    expect(toggleEl()!.textContent).toBe('收起请求树')
    expect(toggleEl()!.getAttribute('aria-expanded')).toBe('true')
    expect(drawerCloseEl()).not.toBeNull()
    expect(drawerCloseEl()!.title).toBe('关闭请求树')
    // overlay 状态不持久化
    expect(mocks.patch).not.toHaveBeenCalled()
  })

  it('viewport=300 时 drawer 宽 268', async () => {
    await renderPane(300)
    click(toggleEl()!)
    expect(paneEl().style.width).toBe('268px') // min(320, 268)
  })

  it('打开后焦点进入搜索框；Tab/Shift+Tab 陷阱在 drawer 内循环', async () => {
    await renderPane(400)
    click(toggleEl()!)
    const search = searchEl()
    expect(document.activeElement).toBe(search)

    const close = drawerCloseEl()!
    const node = treeNodeEl()
    // 焦点顺序（DOM 序）：关闭按钮 → 搜索框 → 树节点
    // 末元素 Tab → 回首元素
    node.focus()
    const tabAtLast = keyDown(node, { key: 'Tab' })
    expect(tabAtLast.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(close)
    // 首元素 Shift+Tab → 回末元素
    const shiftTabAtFirst = keyDown(close, { key: 'Tab', shiftKey: true })
    expect(shiftTabAtFirst.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(node)
    // 中间元素不劫持（走原生序）
    search.focus()
    const tabAtMiddle = keyDown(search, { key: 'Tab' })
    expect(tabAtMiddle.defaultPrevented).toBe(false)
    const shiftTabAtMiddle = keyDown(search, { key: 'Tab', shiftKey: true })
    expect(shiftTabAtMiddle.defaultPrevented).toBe(false)
  })

  it('关闭条件全路径：Esc/backdrop/关闭按钮/再点切换按钮/onRequestOpened；树节点 toggle 不关闭；关闭后焦点回按钮', async () => {
    const handleRef = await renderPane(400)

    // 1) Esc（焦点在 drawer 外的 window 级路径同样生效）
    click(toggleEl()!)
    expect(backdropEl()).not.toBeNull()
    windowKey('Escape')
    expect(backdropEl()).toBeNull()
    expect(paneWidth()).toBe('0px')
    expect(document.activeElement).toBe(toggleEl()!)

    // 2) 点击 backdrop
    click(toggleEl()!)
    click(backdropEl()!)
    expect(backdropEl()).toBeNull()
    expect(document.activeElement).toBe(toggleEl()!)

    // 3) drawer 内关闭按钮
    click(toggleEl()!)
    click(drawerCloseEl()!)
    expect(backdropEl()).toBeNull()
    expect(document.activeElement).toBe(toggleEl()!)

    // 4) 再点切换按钮（收起请求树）
    click(toggleEl()!)
    click(toggleEl()!)
    expect(backdropEl()).toBeNull()
    expect(document.activeElement).toBe(toggleEl()!)

    // 5) 打开 Request（父组件回调）
    click(toggleEl()!)
    act(() => {
      handleRef.current?.onRequestOpened()
    })
    expect(backdropEl()).toBeNull()
    expect(document.activeElement).toBe(toggleEl()!)

    // Collection/Folder toggle（树节点点击）不关闭
    click(toggleEl()!)
    click(treeNodeEl())
    expect(backdropEl()).not.toBeNull()
    expect(paneEl().style.position).toBe('absolute')

    // drawer 已关时 onRequestOpened 为无害 no-op
    windowKey('Escape')
    expect(backdropEl()).toBeNull()
    act(() => {
      handleRef.current?.onRequestOpened()
    })
    expect(backdropEl()).toBeNull()
    expect(mocks.patch).not.toHaveBeenCalled()
  })

  it('drawer 开着 resize 到 ≥526：无动画切回 docked（compact），树/搜索焦点保留', async () => {
    await renderPane(400)
    click(toggleEl()!)
    const search = searchEl()
    expect(document.activeElement).toBe(search)

    fireResize(600) // compact：clamp(260,160,234)=234
    const pane = paneEl()
    expect(pane.dataset.paneMode).toBe('compact')
    expect(pane.style.position).toBe('') // 回到 docked flex 形态
    expect(pane.style.width).toBe('234px')
    expect(pane.style.transition).toBe('') // 无动画
    expect(backdropEl()).toBeNull()
    expect(toggleEl()).toBeNull()
    expect(document.activeElement).toBe(search) // 焦点保留（同一 DOM 节点）
    expect(pane.hasAttribute('inert')).toBe(false)
  })

  it('docked 缩到 <526：drawer 默认关闭只留按钮，树内焦点收回按钮', async () => {
    await renderPane(600)
    searchEl().focus()
    expect(document.activeElement).toBe(searchEl())

    fireResize(400)
    expect(backdropEl()).toBeNull() // drawer 默认关闭
    expect(toggleEl()).not.toBeNull()
    expect(toggleEl()!.textContent).toBe('展开请求树')
    expect(paneEl().hasAttribute('inert')).toBe(true)
    expect(document.activeElement).toBe(toggleEl()!) // 树内焦点 → 展开按钮（§6.8）
  })

  it('主编辑区已有焦点时缩窄不抢焦点（避免打断输入）', async () => {
    await renderPane(600)
    const mainMarker = mainMarkerEl()
    mainMarker.setAttribute('tabindex', '-1')
    mainMarker.focus()
    expect(document.activeElement).toBe(mainMarker)

    fireResize(400)
    expect(document.activeElement).toBe(mainMarker) // 焦点不被展开按钮抢走
  })
})

// ==================================================================
// 不重挂载契约（AC-34）
// ==================================================================

describe('WP4 不重挂载契约：树与编辑器同一 DOM 实例贯穿全部状态切换', () => {
  it('normal↔compact↔hidden↔drawer↔拖动/双击/键盘：节点恒等 + 搜索草稿保留', async () => {
    useFakeTimersScoped()
    await renderPane(1000)
    const treeRoot = container.querySelector('#tree-root')
    const search = searchEl()
    const mainMarker = mainMarkerEl()
    search.value = '草稿查询'

    const assertIntact = (): void => {
      expect(container.querySelector('#tree-root')).toBe(treeRoot)
      expect(searchEl()).toBe(search)
      expect(mainMarkerEl()).toBe(mainMarker)
      expect(searchEl().value).toBe('草稿查询')
    }

    fireResize(600) // compact
    assertIntact()
    fireResize(400) // hidden
    assertIntact()
    click(toggleEl()!) // drawer open
    assertIntact()
    windowKey('Escape') // drawer close
    assertIntact()
    fireResize(560) // compact again
    assertIntact()
    pointerDown(separatorEl(), 300)
    pointerMove(280)
    pointerUp()
    assertIntact()
    doubleClick(separatorEl())
    assertIntact()
    keyDown(separatorEl(), { key: 'ArrowRight' })
    keyDown(separatorEl(), { key: 'ArrowRight', shiftKey: true })
    act(() => {
      vi.advanceTimersByTime(SIDEBAR_PERSIST_DEBOUNCE_MS)
    })
    assertIntact()
    fireResize(1200) // normal
    assertIntact()
    expect(mainWrapperEl().style.flex).toBe('1 1 0%') // 主区始终 flex:1，不被 overlay 挤压
  })
})

// ==================================================================
// 保存失败非阻断（AC-33）
// ==================================================================

describe('WP4 保存失败：中文非阻断 toast，内存宽度不回滚', () => {
  it('PATCH 失败 → toast 中文提示；当前会话继续使用内存宽度', async () => {
    mocks.get.mockResolvedValue({ collectionSidebarWidth: 400 })
    mocks.patch.mockRejectedValue(new Error('boom-detail'))
    await renderPane(1000)
    expect(paneWidth()).toBe('400px')

    doubleClick(separatorEl())
    await act(async () => {}) // 排空 PATCH rejection → catch → toast 的 microtask 链
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    const message: string = mocks.toastError.mock.calls[0]![0] as string
    expect(message).toBe(SIDEBAR_SAVE_FAILED_MESSAGE)
    expect(message).toContain('保存失败')
    expect(message).toMatch(/[\u4e00-\u9fff]/) // 中文文案
    expect(message).not.toContain('boom-detail') // 不透出原始错误细节
    // 不回滚：内存偏好 260 继续生效
    expect(paneWidth()).toBe('260px')
    // 后续拖动照常（会话内可继续使用）
    mocks.patch.mockResolvedValue({})
    pointerDown(separatorEl(), 500)
    pointerMove(540)
    pointerUp()
    expect(paneWidth()).toBe('300px')
    expect(mocks.patch).toHaveBeenLastCalledWith('/settings', { collectionSidebarWidth: 300 })
  })
})

// ==================================================================
// hook 细节
// ==================================================================

describe('WP4 hook 细节', () => {
  it('unmount flush 未落盘的 debounce 值（最后一次键盘调整不丢）', async () => {
    useFakeTimersScoped()
    await renderPane(1000)
    keyDown(separatorEl(), { key: 'ArrowRight' })
    expect(paneWidth()).toBe('270px')
    expect(mocks.patch).not.toHaveBeenCalled()

    act(() => root.unmount())
    unmounted = true
    expect(mocks.patch).toHaveBeenCalledTimes(1)
    expect(mocks.patch).toHaveBeenCalledWith('/settings', { collectionSidebarWidth: 270 })
  })

  it('立即 persist（双击）取消 pending debounce：只落最终值一次', async () => {
    useFakeTimersScoped()
    await renderPane(1000)
    keyDown(separatorEl(), { key: 'ArrowRight' }) // 调度 270
    doubleClick(separatorEl()) // 立即 260，取消 pending
    expect(mocks.patch).toHaveBeenCalledTimes(1)
    expect(mocks.patch).toHaveBeenCalledWith('/settings', { collectionSidebarWidth: 260 })
    act(() => {
      vi.advanceTimersByTime(SIDEBAR_PERSIST_DEBOUNCE_MS)
    })
    expect(mocks.patch).toHaveBeenCalledTimes(1)
    expect(paneWidth()).toBe('260px')
  })

  it('迟到的初始加载不覆盖用户本会话调整', async () => {
    useFakeTimersScoped()
    let resolveGet!: (value: unknown) => void
    mocks.get.mockReturnValue(
      new Promise((resolve) => {
        resolveGet = resolve
      }),
    )
    await renderPane(1000)
    expect(paneWidth()).toBe('260px') // 加载未完成：默认值渲染

    keyDown(separatorEl(), { key: 'ArrowRight' })
    expect(paneWidth()).toBe('270px')
    act(() => {
      vi.advanceTimersByTime(SIDEBAR_PERSIST_DEBOUNCE_MS)
    })
    expect(mocks.patch).toHaveBeenCalledWith('/settings', { collectionSidebarWidth: 270 })

    await act(async () => {
      resolveGet({ collectionSidebarWidth: 400 })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(paneWidth()).toBe('270px') // 用户值优先，不被迟到的 400 覆盖
  })
})
