/**
 * WP6（P0 实施设计 §7.1–§7.5 / UX §4.7、§9）验收 spec：
 *
 * 1. `removeTabsAndSelectNext` 纯函数全分支：active 未删 / 左邻最近存活 /
 *    右侧第一个存活 / 全删空 / 删非 active / removedKeys 空 / 数组与 Set 等价 /
 *    泛型保留额外字段（RequestTab 形状直接可用）/ 不可变性。
 * 2. TreeDeleteConfirmDialog：三种 kind 文案、递归统计行、dirty 追加警示与
 *    确认按钮文案切换、取消默认焦点、Esc/X=取消、pending 忙碌态防重复触发。
 * 3. DirtyTabCloseDialog：未保存修改警示文案、确认按钮「关闭并放弃修改」、
 *    取消默认焦点、Esc/X=取消、pending 防重复、P0 不提供自动保存出口。
 * 4. Modal 向后兼容回归：缺省行为（不抢焦点、Esc/X/遮罩=onClose、内容点击不关）
 *    与旧版一致；新增 initialFocus（'cancel'/'first-button'/RefObject）与中文 a11y。
 *
 * 渲染方式与 history-view.spec.ts 同款：react-dom createRoot + act（jsdom）。
 */
import { act, createElement, Fragment, useRef } from 'react'
import type { ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTabsAndSelectNext } from '../src/client/components/request/tab-lifecycle.ts'
import { TreeDeleteConfirmDialog } from '../src/client/components/collection/TreeDeleteConfirmDialog.tsx'
import { DirtyTabCloseDialog } from '../src/client/components/request/DirtyTabCloseDialog.tsx'
import { Modal } from '../src/client/components/common/Modal.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ---------- 1. tab-lifecycle 纯函数（§7.4） ----------

describe('removeTabsAndSelectNext：active tab 算法（§7.4）', () => {
  interface Tab {
    key: string
    label: string
  }
  const tabs = (...keys: string[]): Tab[] => keys.map((key) => ({ key, label: key.toUpperCase() }))
  const keysOf = (list: Tab[]): string[] => list.map((tab) => tab.key)

  it('active 未被删：activeKey 保持，其余按原顺序移除', () => {
    const result = removeTabsAndSelectNext(tabs('a', 'b', 'c'), 'b', new Set(['a', 'c']))
    expect(keysOf(result.tabs)).toEqual(['b'])
    expect(result.activeKey).toBe('b')
  })

  it('active 被删：选原 active 位置左侧最近的存活 tab', () => {
    expect(removeTabsAndSelectNext(tabs('a', 'b', 'c', 'd'), 'c', new Set(['c'])).activeKey).toBe('b')
    // 左邻被连带删除时继续向左找最近存活
    expect(removeTabsAndSelectNext(tabs('a', 'b', 'c', 'd'), 'd', new Set(['c', 'd'])).activeKey).toBe('b')
  })

  it('左侧没有存活：选右侧第一个存活 tab', () => {
    expect(removeTabsAndSelectNext(tabs('a', 'b', 'c'), 'a', new Set(['a'])).activeKey).toBe('b')
    expect(removeTabsAndSelectNext(tabs('a', 'b', 'c', 'd'), 'b', new Set(['a', 'b'])).activeKey).toBe('c')
    expect(removeTabsAndSelectNext(tabs('a', 'b', 'c', 'd'), 'b', new Set(['a', 'b', 'c'])).activeKey).toBe('d')
  })

  it('两侧都有存活：左侧优先于右侧', () => {
    expect(removeTabsAndSelectNext(tabs('a', 'b', 'c'), 'b', new Set(['b'])).activeKey).toBe('a')
  })

  it('全部被删：tabs 为空且 activeKey=undefined（回到空状态）', () => {
    const result = removeTabsAndSelectNext(tabs('a', 'b'), 'a', new Set(['a', 'b']))
    expect(result.tabs).toEqual([])
    expect(result.activeKey).toBeUndefined()
  })

  it('只删非 active tab：activeKey 不受影响', () => {
    const result = removeTabsAndSelectNext(tabs('a', 'b', 'c'), 'a', ['b'])
    expect(keysOf(result.tabs)).toEqual(['a', 'c'])
    expect(result.activeKey).toBe('a')
  })

  it('removedKeys 为空（Set 与数组）：原样返回，语义不变', () => {
    const source = tabs('a', 'b')
    for (const empty of [new Set<string>(), [] as string[]]) {
      const result = removeTabsAndSelectNext(source, 'a', empty)
      expect(result.tabs).toEqual(source)
      expect(result.activeKey).toBe('a')
    }
  })

  it('removedKeys 的 string[] 与 ReadonlySet 形态结果一致', () => {
    const asArray = removeTabsAndSelectNext(tabs('a', 'b', 'c'), 'b', ['b'])
    const asSet = removeTabsAndSelectNext(tabs('a', 'b', 'c'), 'b', new Set(['b']))
    expect(asArray).toEqual(asSet)
  })

  it('activeKey=undefined：保持 undefined，仅过滤 tabs', () => {
    const result = removeTabsAndSelectNext(tabs('a', 'b'), undefined, new Set(['b']))
    expect(keysOf(result.tabs)).toEqual(['a'])
    expect(result.activeKey).toBeUndefined()
  })

  it('泛型保留额外字段与对象引用（RequestTab 形状直接可用）', () => {
    interface RequestTabLike {
      key: string
      dirty: boolean
      requestId?: string
    }
    const list: RequestTabLike[] = [
      { key: 'r1', dirty: false, requestId: 'r1' },
      { key: 'draft-1', dirty: true },
    ]
    const result = removeTabsAndSelectNext(list, 'draft-1', new Set(['r1']))
    expect(result.tabs[0]).toBe(list[1]) // 存活 tab 保持原对象引用
    expect(result.activeKey).toBe('draft-1')
  })

  it('退化：activeKey 在 removedKeys 中但已不在 tabs 里 → 选第一个存活 tab', () => {
    const result = removeTabsAndSelectNext(tabs('a', 'b'), 'gone', new Set(['gone']))
    expect(keysOf(result.tabs)).toEqual(['a', 'b'])
    expect(result.activeKey).toBe('a')
  })

  it('纯函数：不修改入参数组', () => {
    const source = tabs('a', 'b', 'c')
    const result = removeTabsAndSelectNext(source, 'b', new Set(['b']))
    expect(keysOf(source)).toEqual(['a', 'b', 'c'])
    expect(result.tabs).not.toBe(source)
  })
})

// ---------- 渲染基建（与 history-view.spec.ts 同款） ----------

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function render(element: ReactElement): Promise<void> {
  await act(async () => {
    root.render(element)
  })
}

function query(attr: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-dsh-api-client="${attr}"]`)
}

function click(element: HTMLElement): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

async function pressEscape(): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
}

function closeButton(): HTMLElement {
  const button = container.querySelector<HTMLElement>('[data-modal-role="close"]')
  expect(button).not.toBeNull()
  return button!
}

// ---------- 2. TreeDeleteConfirmDialog（§7.1/§7.2） ----------

describe('TreeDeleteConfirmDialog：删除确认文案与交互', () => {
  it('kind=request：「确定删除请求「name」？」，确认按钮=「删除」，无统计行', async () => {
    await render(
      createElement(TreeDeleteConfirmDialog, {
        kind: 'request',
        name: '登录接口',
        onCancel: vi.fn(),
        onConfirm: vi.fn(),
      }),
    )
    expect(query('tree-delete-headline')?.textContent).toBe('确定删除请求「登录接口」？')
    expect(query('tree-delete-confirm')?.textContent).toBe('删除')
    expect(query('tree-delete-stats')).toBeNull()
    expect(query('tree-delete-dirty')).toBeNull()
  })

  it('kind=folder：显示递归统计「包含 N 个子文件夹、M 个请求」（目标本身不计入 N，调用方传入）', async () => {
    await render(
      createElement(TreeDeleteConfirmDialog, {
        kind: 'folder',
        name: '用户模块',
        descendantFolderCount: 2,
        requestCount: 7,
        onCancel: vi.fn(),
        onConfirm: vi.fn(),
      }),
    )
    expect(query('tree-delete-headline')?.textContent).toBe('确定删除文件夹「用户模块」？')
    expect(query('tree-delete-stats')?.textContent).toBe('包含 2 个子文件夹、7 个请求')
  })

  it('kind=folder 统计缺省：按 0 展示，不出现 undefined', async () => {
    await render(
      createElement(TreeDeleteConfirmDialog, { kind: 'folder', name: '空目录', onCancel: vi.fn(), onConfirm: vi.fn() }),
    )
    expect(query('tree-delete-stats')?.textContent).toBe('包含 0 个子文件夹、0 个请求')
  })

  it('kind=collection：显示递归 Request 总数', async () => {
    await render(
      createElement(TreeDeleteConfirmDialog, {
        kind: 'collection',
        name: '订单 API',
        requestCount: 12,
        onCancel: vi.fn(),
        onConfirm: vi.fn(),
      }),
    )
    expect(query('tree-delete-headline')?.textContent).toBe('确定删除集合「订单 API」？')
    expect(query('tree-delete-stats')?.textContent).toBe('包含 12 个请求')
  })

  it('dirtyTabCount>0：追加「将放弃 N 个未保存修改」，确认按钮=「删除并放弃修改」', async () => {
    await render(
      createElement(TreeDeleteConfirmDialog, {
        kind: 'collection',
        name: '订单 API',
        requestCount: 3,
        dirtyTabCount: 2,
        onCancel: vi.fn(),
        onConfirm: vi.fn(),
      }),
    )
    expect(query('tree-delete-dirty')?.textContent).toBe('将放弃 2 个未保存修改')
    expect(query('tree-delete-confirm')?.textContent).toBe('删除并放弃修改')
  })

  it('dirtyTabCount=0：无警示行，确认按钮=「删除」', async () => {
    await render(
      createElement(TreeDeleteConfirmDialog, {
        kind: 'request',
        name: 'r',
        dirtyTabCount: 0,
        onCancel: vi.fn(),
        onConfirm: vi.fn(),
      }),
    )
    expect(query('tree-delete-dirty')).toBeNull()
    expect(query('tree-delete-confirm')?.textContent).toBe('删除')
  })

  it('打开时取消按钮默认获得焦点', async () => {
    await render(
      createElement(TreeDeleteConfirmDialog, { kind: 'request', name: 'r', onCancel: vi.fn(), onConfirm: vi.fn() }),
    )
    expect(document.activeElement).toBe(query('tree-delete-cancel'))
  })

  it('点击确认触发 onConfirm 一次；点击取消触发 onCancel 一次', async () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    await render(createElement(TreeDeleteConfirmDialog, { kind: 'request', name: 'r', onCancel, onConfirm }))
    click(query('tree-delete-confirm')!)
    expect(onConfirm).toHaveBeenCalledTimes(1)
    click(query('tree-delete-cancel')!)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('Esc 等同取消：触发 onCancel', async () => {
    const onCancel = vi.fn()
    await render(
      createElement(TreeDeleteConfirmDialog, { kind: 'request', name: 'r', onCancel, onConfirm: vi.fn() }),
    )
    await pressEscape()
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('右上角关闭按钮等同取消：触发 onCancel', async () => {
    const onCancel = vi.fn()
    await render(
      createElement(TreeDeleteConfirmDialog, { kind: 'request', name: 'r', onCancel, onConfirm: vi.fn() }),
    )
    click(closeButton())
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('pending：确认按钮忙碌态且 disabled，重复点击不触发 onConfirm', async () => {
    const onConfirm = vi.fn()
    await render(
      createElement(TreeDeleteConfirmDialog, {
        kind: 'request',
        name: 'r',
        pending: true,
        onCancel: vi.fn(),
        onConfirm,
      }),
    )
    const confirm = query('tree-delete-confirm') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    expect(confirm.getAttribute('aria-busy')).toBe('true')
    expect(confirm.textContent).toBe('删除中…')
    click(confirm)
    click(confirm)
    expect(onConfirm).not.toHaveBeenCalled()
  })
})

// ---------- 3. DirtyTabCloseDialog（§7.5） ----------

describe('DirtyTabCloseDialog：dirty tab 关闭确认', () => {
  it('文案说明未保存修改将丢失（含请求名），确认按钮=「关闭并放弃修改」', async () => {
    await render(createElement(DirtyTabCloseDialog, { name: '创建订单', onCancel: vi.fn(), onConfirm: vi.fn() }))
    const message = query('dirty-tab-close-message')?.textContent ?? ''
    expect(message).toContain('「创建订单」')
    expect(message).toContain('未保存修改')
    expect(message).toContain('将丢失')
    expect(query('dirty-tab-close-confirm')?.textContent).toBe('关闭并放弃修改')
  })

  it('P0 不提供自动保存选项：只有 X/取消/关闭并放弃修改三个按钮', async () => {
    await render(createElement(DirtyTabCloseDialog, { name: 'r', onCancel: vi.fn(), onConfirm: vi.fn() }))
    // 可及名优先（X 按钮文本是「✕」、a11y 名是「关闭」），其余按钮取文本。
    const buttons = [...container.querySelectorAll('button')].map((button) => button.getAttribute('aria-label') ?? button.textContent)
    expect(buttons).toEqual(['关闭', '取消', '关闭并放弃修改'])
    expect(container.textContent).not.toContain('自动保存')
    expect(container.textContent).not.toContain('保存并关闭')
  })

  it('打开时取消按钮默认获得焦点', async () => {
    await render(createElement(DirtyTabCloseDialog, { onCancel: vi.fn(), onConfirm: vi.fn() }))
    expect(document.activeElement).toBe(query('dirty-tab-close-cancel'))
  })

  it('Esc 与右上角关闭都等同取消', async () => {
    const onCancel = vi.fn()
    await render(createElement(DirtyTabCloseDialog, { name: 'r', onCancel, onConfirm: vi.fn() }))
    await pressEscape()
    click(closeButton())
    expect(onCancel).toHaveBeenCalledTimes(2)
  })

  it('点击确认触发 onConfirm 一次', async () => {
    const onConfirm = vi.fn()
    await render(createElement(DirtyTabCloseDialog, { name: 'r', onCancel: vi.fn(), onConfirm }))
    click(query('dirty-tab-close-confirm')!)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('pending：确认按钮忙碌态且 disabled，重复点击不触发 onConfirm', async () => {
    const onConfirm = vi.fn()
    await render(createElement(DirtyTabCloseDialog, { name: 'r', pending: true, onCancel: vi.fn(), onConfirm }))
    const confirm = query('dirty-tab-close-confirm') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    expect(confirm.getAttribute('aria-busy')).toBe('true')
    expect(confirm.textContent).toBe('关闭中…')
    click(confirm)
    click(confirm)
    expect(onConfirm).not.toHaveBeenCalled()
  })
})

// ---------- 4. Modal 向后兼容（既有消费方零回归 + WP6 扩展） ----------

describe('Modal：向后兼容与 WP6 增强', () => {
  it('缺省渲染：role=dialog、aria-modal、aria-label=title、关闭按钮 aria-label=「关闭」', async () => {
    // ModalProps.children 为必填，createElement 走 props.children 形态（JSX 消费方不受影响）。
    await render(
      createElement(Modal, {
        title: '保存请求',
        onClose: vi.fn(),
        children: createElement('div', { 'data-dsh-api-client': 'body' }, '内容'),
      }),
    )
    const dialog = container.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.getAttribute('aria-modal')).toBe('true')
    expect(dialog?.getAttribute('aria-label')).toBe('保存请求')
    expect(closeButton().getAttribute('aria-label')).toBe('关闭')
    expect(query('body')?.textContent).toBe('内容')
  })

  it('缺省 initialFocus：不抢焦点（旧版行为不变）', async () => {
    await render(
      createElement(Modal, {
        title: 't',
        onClose: vi.fn(),
        children: createElement('button', { type: 'button' }, 'ok'),
      }),
    )
    expect(document.activeElement).toBe(document.body)
  })

  it('Esc / X / 遮罩点击都触发 onClose；内容点击不关闭（stopPropagation 保持）', async () => {
    const onClose = vi.fn()
    await render(
      createElement(Modal, {
        title: 't',
        onClose,
        children: createElement('div', { 'data-dsh-api-client': 'body' }, '内容'),
      }),
    )
    click(query('body')!)
    expect(onClose).not.toHaveBeenCalled()
    click(closeButton())
    expect(onClose).toHaveBeenCalledTimes(1)
    click(query('modal')!)
    expect(onClose).toHaveBeenCalledTimes(2)
    await pressEscape()
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it("initialFocus='cancel'：焦点落到 [data-modal-role=cancel] 标记元素", async () => {
    await render(
      createElement(Modal, {
        title: 't',
        onClose: vi.fn(),
        initialFocus: 'cancel',
        children: createElement(
          Fragment,
          null,
          createElement('button', { type: 'button', 'data-dsh-api-client': 'first' }, '先'),
          createElement('button', { type: 'button', 'data-modal-role': 'cancel', 'data-dsh-api-client': 'cancel' }, '取消'),
        ),
      }),
    )
    expect(document.activeElement).toBe(query('cancel'))
  })

  it("initialFocus='first-button'：焦点落到内容区第一个 button（不含右上角关闭）", async () => {
    await render(
      createElement(Modal, {
        title: 't',
        onClose: vi.fn(),
        initialFocus: 'first-button',
        children: createElement(
          Fragment,
          null,
          createElement('button', { type: 'button', 'data-dsh-api-client': 'first' }, '先'),
          createElement('button', { type: 'button', 'data-dsh-api-client': 'second' }, '后'),
        ),
      }),
    )
    expect(document.activeElement).toBe(query('first'))
  })

  it('initialFocus=RefObject：焦点落到 ref 指向元素', async () => {
    function RefFocusProbe(): ReactElement {
      const ref = useRef<HTMLButtonElement>(null)
      return createElement(Modal, {
        title: 'ref 探针',
        onClose: () => {},
        initialFocus: ref,
        children: createElement('button', { type: 'button', ref, 'data-dsh-api-client': 'probe-button' }, '探针'),
      })
    }
    await render(createElement(RefFocusProbe))
    expect(document.activeElement).toBe(query('probe-button'))
  })
})
