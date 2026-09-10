/**
 * TreeContextMenu（P0 实施设计 §6.3，UX §4.4，WP5）：请求树右键上下文菜单。
 *
 * 冻结契约：
 * - `createPortal(..., document.body)` + `position: fixed`——不被树区域
 *   `overflow: auto` 裁切（react-dom 为既有 runtime external，零新增依赖）；
 * - 定位：菜单完整位于 API Client 可视容器（boundaryRef，缺省回退视口）内并保留
 *   ≥4px margin；右侧/下方空间不足 → 向左/上翻转；翻转后仍放不下 → 钳到边界 +
 *   max-height + overflow-y:auto（所有项可滚动到达）；
 * - 分组渲染顺序由调用方传入的 items 顺序决定（创建→编辑→复制/粘贴→导出文本→
 *   危险操作的固定矩阵在 CollectionTree 组装），group 变化处插入 role=separator；
 * - 禁用项：aria-disabled + 中文原因内联展示（如「粘贴」的 §6.5 矩阵原因）；
 * - 焦点：打开且**落位可见后**进入第一个可用项（R2：首帧 visibility:hidden 时
 *   真实浏览器拒绝 focus，故焦点投放在落位后的独立 layout effect；全部禁用 →
 *   焦点落菜单容器）；↑↓ 在可用项间循环移动；Home/End 首尾；Enter/Space 执行；
 *   Esc 关闭；Tab 关闭（焦点不逃逸到背景 UI）；
 *   关闭后焦点还原由调用方 onClose 处理（CollectionTree 按 R1 交接规则：
 *   焦点已被对话框等有意义目标承接时不抢回，否则还原到原树行）；
 * - 关闭条件全实现：outside click（mousedown）/ Esc / 树滚动（scrollContainerRef，
 *   capture 捕获嵌套滚动）/ window resize / 卸载（pane 切换随树卸载）/
 *   动作成功或失败（onRun settle 后一律 onClose）；
 * - pending：动作执行中仅本菜单进入忙碌——running 项显示「…」、全部项
 *   aria-disabled（同节点重复 mutation 被抑制，UX §9）；树的其他只读导航不受影响
 *   （菜单不阻塞树交互）。
 *
 * role=menu / role=menuitem（AC-10）。本文件不 import 任何 DSH 包（TC-A-03）。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactElement, RefObject } from 'react'
import { createPortal } from 'react-dom'
import { colors, font } from '../common/theme.ts'

export type TreeMenuGroup = 'open' | 'create' | 'edit' | 'clipboard' | 'export' | 'view' | 'danger'

export interface TreeMenuItem {
  id: string
  label: string
  group: TreeMenuGroup
  /** 禁用（矩阵不允许/stale/无剪贴板内容等）——仍渲染，显示中文原因。 */
  disabled?: boolean
  /** 禁用原因（中文，内联展示 + title）。 */
  disabledReason?: string
  danger?: boolean
  /** 动作执行（成功或失败后菜单关闭——错误 toast 归 mutation 层）。 */
  onRun: () => void | Promise<void>
}

export interface TreeContextMenuProps {
  items: TreeMenuItem[]
  /** 视口坐标锚点（右键 clientX/clientY，或 Shift+F10 时的行位置）。 */
  anchor: { x: number; y: number }
  /** API Client 可视容器（定位边界）；缺省 = 视口。 */
  boundaryRef?: RefObject<HTMLElement | null>
  /** 树滚动容器：滚动即关闭（capture 监听，嵌套滚动也捕获）。 */
  scrollContainerRef?: RefObject<HTMLElement | null>
  /** 关闭（含焦点还原）由调用方执行。 */
  onClose: () => void
}

/** 边界内保留的最小边距（AC-09：≥4px）。 */
const BOUNDARY_MARGIN = 4

interface Placement {
  left: number
  top: number
  maxHeight?: number
}

function boundaryRect(boundaryRef: TreeContextMenuProps['boundaryRef']): { left: number; top: number; right: number; bottom: number; height: number } {
  const element = boundaryRef?.current
  if (element !== null && element !== undefined) {
    const rect = element.getBoundingClientRect()
    if (rect.width > 0 || rect.height > 0) {
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, height: rect.height }
    }
  }
  return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight, height: window.innerHeight }
}

/**
 * 定位算法（可单测的纯函数形态）：右/下溢出 → 翻转；翻转后仍越界 → 钳到
 * 边界 + margin；垂直空间不足 → maxHeight 压缩（配 overflow-y:auto）。
 */
export function computeMenuPlacement(
  anchor: { x: number; y: number },
  menuWidth: number,
  menuHeight: number,
  boundary: { left: number; top: number; right: number; bottom: number },
  margin: number = BOUNDARY_MARGIN,
): Placement {
  let left = anchor.x
  let top = anchor.y
  if (left + menuWidth > boundary.right - margin) left = anchor.x - menuWidth
  if (left < boundary.left + margin) left = boundary.left + margin
  if (top + menuHeight > boundary.bottom - margin) top = anchor.y - menuHeight
  if (top < boundary.top + margin) top = boundary.top + margin
  const availableHeight = boundary.bottom - margin - top
  const maxHeight = menuHeight > availableHeight ? Math.max(availableHeight, margin * 2) : undefined
  return maxHeight === undefined ? { left, top } : { left, top, maxHeight }
}

export function TreeContextMenu(props: TreeContextMenuProps): ReactElement {
  const menuRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [placement, setPlacement] = useState<Placement | null>(null)
  const [focusedIndex, setFocusedIndex] = useState(-1)
  const [runningId, setRunningId] = useState<string | null>(null)
  /** R2：初始焦点只在「落位后」投放一次（见下方 layout effect）。 */
  const initialFocusDoneRef = useRef(false)

  const enabledIndices = props.items
    .map((item, index) => (item.disabled === true || runningId !== null ? -1 : index))
    .filter((index) => index >= 0)

  const focusIndex = (index: number): void => {
    if (index < 0 || index >= props.items.length) return
    setFocusedIndex(index)
    itemRefs.current[index]?.focus()
  }

  const moveFocus = (delta: number): void => {
    if (enabledIndices.length === 0) return
    const currentPos = enabledIndices.indexOf(focusedIndex)
    const nextPos = currentPos === -1 ? (delta > 0 ? 0 : enabledIndices.length - 1) : (currentPos + delta + enabledIndices.length) % enabledIndices.length
    focusIndex(enabledIndices[nextPos]!)
  }

  const runItem = (index: number): void => {
    const item = props.items[index]
    if (item === undefined || item.disabled === true || runningId !== null) return
    setRunningId(item.id)
    setFocusedIndex(index)
    void (async () => {
      try {
        await item.onRun()
      } catch {
        // 动作失败也关闭（§6.3 关闭条件）；错误 toast 归 mutation 层，不在此重复。
      }
      props.onClose()
    })()
  }

  // 挂载后测量并落位（两阶段：先隐形渲染取自然尺寸，再钳制/翻转到边界内）。
  // R2 修复（真实浏览器焦点时序）：焦点**不再**在本 effect 投放——此刻菜单仍是
  // 首帧的 visibility:hidden，真实浏览器会静默拒绝对不可见元素的 focus() 调用
  //（jsdom 无布局语义，旧实现在此聚焦照样成功，导致 jsdom 全绿而浏览器焦点
  // 从未进入菜单）。焦点投放移到下方「落位后」的独立 layout effect。
  useLayoutEffect(() => {
    const element = menuRef.current
    if (element === null) return
    const rect = element.getBoundingClientRect()
    const boundary = boundaryRect(props.boundaryRef)
    setPlacement(computeMenuPlacement(props.anchor, rect.width, rect.height, boundary))
    // 仅挂载时定位一次（菜单生命周期内 anchor 不变；重开 = 重新挂载）。
  }, [])

  // R2/AC-10：placement 落位（visibility:visible 已在同一次 commit 生效）后，
  // 焦点进第一个可用项；全部禁用 → 落菜单容器自身（tabIndex=-1），保证 Esc/
  // 键盘契约始终有承接点。仅执行一次（one-shot ref）。
  useLayoutEffect(() => {
    if (placement === null || initialFocusDoneRef.current) return
    initialFocusDoneRef.current = true
    const firstEnabled = props.items.findIndex((item) => item.disabled !== true)
    if (firstEnabled >= 0) {
      setFocusedIndex(firstEnabled)
      itemRefs.current[firstEnabled]?.focus()
    } else {
      setFocusedIndex(-1)
      menuRef.current?.focus()
    }
  }, [placement, props.items])

  // 关闭条件：outside click / Esc / 树滚动 / window resize（卸载天然覆盖 pane 切换）。
  useEffect(() => {
    const onDocumentMouseDown = (event: MouseEvent): void => {
      const element = menuRef.current
      if (element !== null && !element.contains(event.target as Node)) props.onClose()
    }
    const onDocumentKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose()
    }
    const onWindowResize = (): void => props.onClose()
    const onTreeScroll = (): void => props.onClose()
    document.addEventListener('mousedown', onDocumentMouseDown, true)
    document.addEventListener('keydown', onDocumentKeyDown, true)
    window.addEventListener('resize', onWindowResize)
    const scrollContainer = props.scrollContainerRef?.current
    scrollContainer?.addEventListener('scroll', onTreeScroll, true)
    return () => {
      document.removeEventListener('mousedown', onDocumentMouseDown, true)
      document.removeEventListener('keydown', onDocumentKeyDown, true)
      window.removeEventListener('resize', onWindowResize)
      scrollContainer?.removeEventListener('scroll', onTreeScroll, true)
    }
  }, [props])

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        event.stopPropagation()
        moveFocus(1)
        return
      case 'ArrowUp':
        event.preventDefault()
        event.stopPropagation()
        moveFocus(-1)
        return
      case 'Home':
        event.preventDefault()
        event.stopPropagation()
        if (enabledIndices.length > 0) focusIndex(enabledIndices[0]!)
        return
      case 'End':
        event.preventDefault()
        event.stopPropagation()
        if (enabledIndices.length > 0) focusIndex(enabledIndices[enabledIndices.length - 1]!)
        return
      case 'Enter':
      case ' ':
        event.preventDefault()
        event.stopPropagation()
        if (focusedIndex >= 0) runItem(focusedIndex)
        return
      case 'Escape':
        event.preventDefault()
        event.stopPropagation()
        props.onClose()
        return
      case 'Tab':
        // 焦点不得逃逸到背景 UI：Tab 直接关闭（调用方还原焦点到原树行）。
        event.preventDefault()
        event.stopPropagation()
        props.onClose()
        return
      default:
        return
    }
  }

  const menuStyle: CSSProperties = {
    position: 'fixed',
    left: placement?.left ?? props.anchor.x,
    top: placement?.top ?? props.anchor.y,
    ...(placement?.maxHeight !== undefined ? { maxHeight: placement.maxHeight, overflowY: 'auto' } : {}),
    visibility: placement === null ? 'hidden' : 'visible',
    zIndex: 1100,
    minWidth: 180,
    maxWidth: 300,
    padding: 4,
    background: colors.bg,
    border: `1px solid ${colors.borderStrong}`,
    borderRadius: 6,
    boxShadow: '0 6px 24px rgba(0,0,0,0.28)',
    fontSize: font.size,
    color: colors.text,
  }

  let previousGroup: string | undefined
  const children: ReactElement[] = []
  props.items.forEach((item, index) => {
    if (previousGroup !== undefined && previousGroup !== item.group) {
      children.push(
        <div key={`separator-${item.id}`} role="separator" data-dsh-api-client="tree-menu-separator" style={{ height: 1, margin: '4px 2px', background: colors.borderStrong }} />,
      )
    }
    previousGroup = item.group
    const disabled = item.disabled === true || runningId !== null
    const running = runningId === item.id
    children.push(
      <button
        key={item.id}
        ref={(element) => {
          itemRefs.current[index] = element
        }}
        type="button"
        role="menuitem"
        data-dsh-api-client="tree-menu-item"
        data-menu-action={item.id}
        aria-disabled={disabled}
        title={item.disabled === true ? item.disabledReason : undefined}
        tabIndex={-1}
        onMouseEnter={() => {
          if (!disabled) setFocusedIndex(index)
        }}
        onClick={() => runItem(index)}
        style={{
          display: 'block',
          width: '100%',
          textAlign: 'left',
          background: focusedIndex === index && !disabled ? colors.fill : 'transparent',
          border: 'none',
          borderRadius: 4,
          cursor: disabled ? 'default' : 'pointer',
          padding: '5px 10px',
          color: item.disabled === true ? colors.textSecondary : item.danger === true ? colors.danger : colors.text,
          font: 'inherit',
          fontSize: font.size,
          lineHeight: 1.4,
        }}
      >
        {running ? `${item.label}…` : item.label}
        {item.disabled === true && item.disabledReason !== undefined && (
          <span data-dsh-api-client="tree-menu-item-reason" style={{ display: 'block', fontSize: 10, lineHeight: 1.4, color: colors.textSecondary }}>
            {item.disabledReason}
          </span>
        )}
      </button>,
    )
  })

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-orientation="vertical"
      aria-label="请求树上下文菜单"
      data-dsh-api-client="tree-context-menu"
      tabIndex={-1}
      onKeyDown={onMenuKeyDown}
      style={menuStyle}
    >
      {children}
    </div>,
    document.body,
  )
}
