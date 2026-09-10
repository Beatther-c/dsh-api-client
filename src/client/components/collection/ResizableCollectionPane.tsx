/**
 * ResizableCollectionPane（P0 UX §5 / 实施设计 §6.6–§6.8，AC-28…AC-34）：
 * 请求树 docked 三态（normal/compact/hidden）+ 6px 分隔条拖动/双击/键盘调宽 +
 * 极窄 overlay drawer + `collectionSidebarWidth` 偏好持久化。
 *
 * 冻结语义（不得偏离）：
 * - viewportWidth = 本组件根容器（即 API Client 主布局行容器）经 ResizeObserver 的内容宽度；
 * - normal（viewport ≥ 706）：rendered = clamp(effective, 220, min(520, viewport-480-6))；
 * - compact（526–705）：rendered = clamp(effective, 160, viewport-360-6)；
 * - hidden（< 526）：docked pane width=0 不可交互，但 React 树不卸载（同一 DOM 实例），
 *   显示「展开请求树」按钮；drawer 宽 min(320, viewport-32)，覆盖主区、不挤压不重挂载编辑器；
 * - §0.4：compact 渲染可到 160–219，但持久化偏好恒钳制到 220–520（如 compact 中
 *   pointerup 于 180px → 当前 viewport 继续渲染 180，持久化写 220，回宽屏渲染 220）；
 * - pointermove 只更新 renderedWidth；pointerup/lostpointercapture 把最终正常域宽度写
 *   preferredWidth 并持久化；pointercancel 恢复拖动起点且不持久化；
 * - 双击分隔条恢复 260 并立即持久化；键盘 ←/→ 10px、Shift+←/→ 40px、300ms debounce 持久化；
 * - 不重挂载契约：树以 children 传入且渲染位置恒定（无 key 变更/条件卸载）；drawer 打开
 *   只是同一 pane DOM 节点换样式，主编辑器（main prop）永不受宽度/三态/drawer 切换影响；
 * - 不使用原生 CSS resize；零新增运行时依赖（ResizeObserver/Pointer Events 均为浏览器原生，
 *   缺失时容错降级）。
 *
 * 本文件不 import 任何 DSH 包（TC-A-03）。
 */
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactElement, ReactNode } from 'react'
import { colors, font } from '../common/theme.ts'
import { SIDEBAR_WIDTH_DEFAULT, useCollectionSidebarWidth } from '../../hooks/useCollectionSidebarWidth.ts'

// ---- 冻结常量（UX §5 / 设计 §6.6）----

/** viewport ≥ 706：normal（主区保留 480 + 分隔条 6）。 */
export const NORMAL_BREAKPOINT = 706
/** viewport ≥ 526：compact（主区保留 360 + 分隔条 6）；< 526：hidden。 */
export const COMPACT_BREAKPOINT = 526
/** normal 主区 + 分隔条保留宽度（480 + 6）。 */
export const NORMAL_RESERVED = 486
/** compact 主区 + 分隔条保留宽度（360 + 6）。 */
export const COMPACT_RESERVED = 366
/** normal 渲染域下界。 */
export const NORMAL_RENDERED_MIN = 220
/** compact 渲染域下界（§0.4：持久化偏好仍恒在 220–520）。 */
export const COMPACT_RENDERED_MIN = 160
/** 持久化偏好正常域上界（normal 渲染 max 同时受 520 与 viewport 约束）。 */
export const PREFERENCE_MAX = 520
/** 分隔条命中区宽度。 */
export const SEPARATOR_HIT_WIDTH = 6
/** drawer 宽度上限与两侧留白。 */
export const DRAWER_MAX_WIDTH = 320
export const DRAWER_SIDE_MARGIN = 32
/** 键盘步长（←/→ 与 Shift+←/→）。 */
export const KEYBOARD_STEP = 10
export const KEYBOARD_STEP_SHIFT = 40

export type CollectionPaneMode = 'normal' | 'compact' | 'hidden'

export function getPaneMode(viewportWidth: number): CollectionPaneMode {
  if (viewportWidth >= NORMAL_BREAKPOINT) return 'normal'
  if (viewportWidth >= COMPACT_BREAKPOINT) return 'compact'
  return 'hidden'
}

export interface RenderedWidthRange {
  min: number
  max: number
}

/** 当前模式的 rendered 允许域；hidden 无 docked 域（宽度恒 0）返回 null。 */
export function getRenderedRange(mode: CollectionPaneMode, viewportWidth: number): RenderedWidthRange | null {
  if (mode === 'normal') return { min: NORMAL_RENDERED_MIN, max: Math.min(PREFERENCE_MAX, viewportWidth - NORMAL_RESERVED) }
  if (mode === 'compact') return { min: COMPACT_RENDERED_MIN, max: viewportWidth - COMPACT_RESERVED }
  return null
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min // 防御：模式阈值保证 max ≥ min，此处仅兜底
  return Math.min(max, Math.max(min, value))
}

/** rendered 宽度公式（AC-28/AC-29）；hidden 恒 0；输出取整保证 aria/持久化确定性。 */
export function computeRenderedWidth(mode: CollectionPaneMode, viewportWidth: number, effectiveWidth: number): number {
  const range = getRenderedRange(mode, viewportWidth)
  if (range === null) return 0
  return Math.round(clamp(effectiveWidth, range.min, range.max))
}

/** drawer 宽度公式（AC-30）：min(320, viewport-32)，负值兜底为 0。 */
export function computeDrawerWidth(viewportWidth: number): number {
  return Math.round(Math.max(0, Math.min(DRAWER_MAX_WIDTH, viewportWidth - DRAWER_SIDE_MARGIN)))
}

/**
 * drawer/焦点陷阱的可聚焦元素枚举（原生 DOM，零依赖）。
 * 不做可见性剔除：drawer 打开时 pane 内元素必然可视（jsdom 亦无布局信息）。
 */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
}

export interface ResizableCollectionPaneProps {
  /**
   * 请求树（唯一 React 实例）：任何宽度/三态/drawer 切换都不改变其渲染位置与 key，
   * 不条件卸载——query/expanded/searchCollapsed/selected/rename 状态与 DOM 焦点全部保留。
   */
  children: ReactNode
  /** 主编辑区内容：与树并列渲染在根容器内；resize/drawer 永不重挂载它（drawer 以 overlay 覆盖，不挤压）。 */
  main?: ReactNode
}

export interface ResizableCollectionPaneHandle {
  /**
   * 父组件在「打开 Request」成功路径调用：hidden 态 drawer 打开时将其关闭
   * （UX §5 关闭条件；Collection/Folder toggle 不经此方法故不关闭）。
   */
  onRequestOpened: () => void
}

interface DragHandlers {
  move: (event: PointerEvent) => void
  up: (event: PointerEvent) => void
  cancel: (event: PointerEvent) => void
}

interface DragState {
  pointerId: number
  startX: number
  /** 拖动起点的 rendered 宽度（pointercancel 恢复用）。 */
  startRendered: number
  /** 最近一次 pointermove 计算出的宽度（finalize 不依赖渲染时序）。 */
  latest: number
  /** add/remove 引用对称：监听器随 drag 生命周期存放。 */
  handlers: DragHandlers
}

export const ResizableCollectionPane = forwardRef<ResizableCollectionPaneHandle, ResizableCollectionPaneProps>(
  function ResizableCollectionPane(props, ref): ReactElement {
    const { children, main } = props
    const { preferredWidth, persist, persistDebounced } = useCollectionSidebarWidth()

    const rootRef = useRef<HTMLDivElement | null>(null)
    const paneRef = useRef<HTMLDivElement | null>(null)
    const separatorRef = useRef<HTMLDivElement | null>(null)
    const toggleRef = useRef<HTMLButtonElement | null>(null)

    const [viewportWidth, setViewportWidth] = useState(0)
    /** 拖动/键盘钉住的显式渲染宽度；null = 从 preferredWidth 派生（viewport 变化即清空回派生）。 */
    const [widthOverride, setWidthOverride] = useState<number | null>(null)
    const [drawerOpen, setDrawerOpen] = useState(false)
    const [dragging, setDragging] = useState(false)
    const [separatorHovered, setSeparatorHovered] = useState(false)

    const mode = getPaneMode(viewportWidth)
    const drawerVisible = drawerOpen && mode === 'hidden'
    const hiddenClosed = mode === 'hidden' && !drawerVisible
    const range = getRenderedRange(mode, viewportWidth)
    const rendered = computeRenderedWidth(mode, viewportWidth, widthOverride ?? preferredWidth)

    // ---- render 阶段派生状态调整（React「adjust state when props change」模式，避免闪帧）----
    const [lastViewport, setLastViewport] = useState(viewportWidth)
    if (lastViewport !== viewportWidth) {
      // viewport 变化：丢弃拖动/键盘钉住的 override，回到公式派生（「容器恢复后回到偏好宽度」）。
      setLastViewport(viewportWidth)
      setWidthOverride(null)
    }
    const [lastMode, setLastMode] = useState<CollectionPaneMode>(mode)
    if (lastMode !== mode) {
      // 任何模式切换 drawer 复位：docked 缩到 <526 → drawer 默认关闭只留按钮（§6.8）；
      // drawer 开着回到 ≥526 → 无动画切回 docked（同一 DOM 节点换样式，焦点保留）。
      setLastMode(mode)
      if (drawerOpen) setDrawerOpen(false)
    }

    // ---- 处理器读取的最新环境（window 级监听器闭包不依赖渲染时序）----
    const envRef = useRef({ mode, viewportWidth, rendered })
    envRef.current = { mode, viewportWidth, rendered }
    const dragRef = useRef<DragState | null>(null)
    const drawerOpenRef = useRef(drawerOpen)
    drawerOpenRef.current = drawerOpen

    // ---- viewportWidth 测量：ResizeObserver（useLayoutEffect 在首帧绘制前订阅，避免模式闪变）----
    useLayoutEffect(() => {
      const element = rootRef.current
      if (element === null) return
      const initial = element.getBoundingClientRect().width || element.clientWidth
      if (initial > 0) setViewportWidth(initial)
      if (typeof ResizeObserver === 'undefined') return // 容错：极旧环境退化为初始测量值
      const observer = new ResizeObserver((entries) => {
        const entry: ResizeObserverEntry | undefined = entries[0]
        if (entry === undefined) return
        setViewportWidth(entry.contentRect.width)
      })
      observer.observe(element)
      return () => observer.disconnect()
    }, [])

    // ---- hidden 收起态：pane 不可交互（inert 同时隐藏于辅助技术；jsdom 支持 toggleAttribute）----
    useEffect(() => {
      const pane = paneRef.current
      if (pane === null) return
      pane.toggleAttribute('inert', hiddenClosed)
    }, [hiddenClosed])

    // ---- 拖动（pointer capture 语义，AC-31）----

    function detachDragListeners(drag: DragState): void {
      window.removeEventListener('pointermove', drag.handlers.move)
      window.removeEventListener('pointerup', drag.handlers.up)
      window.removeEventListener('pointercancel', drag.handlers.cancel)
    }

    function releaseCaptureLeniently(drag: DragState): void {
      // jsdom 无 Pointer Events API：容错调用；真实浏览器 capture 已隐式释放时同样吞错。
      try {
        separatorRef.current?.releasePointerCapture?.(drag.pointerId)
      } catch {
        /* capture 已失效 */
      }
    }

    /** pointerup / lostpointercapture 双路径幂等收敛：最终宽度 → preferred + 持久化。 */
    function finalizeDrag(): void {
      const drag = dragRef.current
      if (drag === null) return
      dragRef.current = null
      detachDragListeners(drag)
      releaseCaptureLeniently(drag)
      setDragging(false)
      const final = Math.round(drag.latest)
      setWidthOverride(final) // §0.4：compact 中 180 收敛后当前 viewport 继续渲染 180
      persist(final) // hook 内钳制到正常域 220–520：180 → 持久化 220
    }

    /** pointercancel：恢复拖动起点，不持久化。 */
    function cancelDrag(): void {
      const drag = dragRef.current
      if (drag === null) return
      dragRef.current = null
      detachDragListeners(drag)
      releaseCaptureLeniently(drag)
      setDragging(false)
      setWidthOverride(drag.startRendered)
    }

    const onSeparatorPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (mode === 'hidden' || dragRef.current !== null) return
      event.preventDefault()
      const startRendered = envRef.current.rendered
      const handlers: DragHandlers = {
        move: (moveEvent: PointerEvent) => {
          const drag = dragRef.current
          if (drag === null) return
          if (moveEvent.pointerId !== drag.pointerId) return // R-11：忽略其他指针（多指）的 move
          const { mode: currentMode, viewportWidth: currentViewport } = envRef.current
          const currentRange = getRenderedRange(currentMode, currentViewport)
          if (currentRange === null) return
          const next = clamp(drag.startRendered + (moveEvent.clientX - drag.startX), currentRange.min, currentRange.max)
          drag.latest = next
          setWidthOverride(Math.round(next)) // pointermove 只更新 rendered，不持久化
        },
        up: (upEvent: PointerEvent) => {
          const drag = dragRef.current
          if (drag !== null && upEvent.pointerId !== drag.pointerId) return // R-11：其他指针的 up 不收敛当前拖动
          finalizeDrag()
        },
        cancel: (cancelEvent: PointerEvent) => {
          const drag = dragRef.current
          if (drag !== null && cancelEvent.pointerId !== drag.pointerId) return // R-11
          cancelDrag()
        },
      }
      dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startRendered, latest: startRendered, handlers }
      setDragging(true)
      setWidthOverride(startRendered)
      // pointer capture：jsdom 无此 API，容错调用（测试注入 polyfill 断言）。
      try {
        separatorRef.current?.setPointerCapture?.(event.pointerId)
      } catch {
        /* 无 capture 时 window 级监听器仍保证拖动语义 */
      }
      window.addEventListener('pointermove', handlers.move)
      window.addEventListener('pointerup', handlers.up)
      window.addEventListener('pointercancel', handlers.cancel)
    }

    // unmount 清理未收敛拖动的 window 监听器
    useEffect(
      () => () => {
        const drag = dragRef.current
        if (drag !== null) detachDragListeners(drag)
      },
      [],
    )

    /** lostpointercapture 与 pointerup 等价收敛（R-11：过滤 pointerId，防无关指针丢失误收敛）。 */
    const onSeparatorLostPointerCapture = (event: ReactPointerEvent<HTMLDivElement>): void => {
      const drag = dragRef.current
      if (drag !== null && event.pointerId !== drag.pointerId) return
      finalizeDrag()
    }

    // ---- 双击分隔条：恢复 260，立即更新内存并立即持久化 ----
    const onSeparatorDoubleClick = (): void => {
      if (mode === 'hidden') return
      setWidthOverride(null) // 回到派生：clamp(260, 当前模式渲染域)
      persist(SIDEBAR_WIDTH_DEFAULT)
    }

    // ---- 键盘：←/→ 10px、Shift 40px、300ms debounce 持久化（AC-32）----
    const onSeparatorKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (mode === 'hidden') return
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      if (event.ctrlKey || event.metaKey || event.altKey) return // 让位读屏/系统快捷键
      event.preventDefault()
      const currentRange = getRenderedRange(envRef.current.mode, envRef.current.viewportWidth)
      if (currentRange === null) return
      const step = event.shiftKey ? KEYBOARD_STEP_SHIFT : KEYBOARD_STEP
      const delta = event.key === 'ArrowRight' ? step : -step
      const next = Math.round(clamp(envRef.current.rendered + delta, currentRange.min, currentRange.max))
      setWidthOverride(next)
      envRef.current.rendered = next // 同帧连按（事件批处理未重渲染）也逐次累积
      persistDebounced(next) // hook 内钳制 220–520：内存立即更新 + debounce PATCH
    }

    // ---- drawer：打开焦点进搜索框；Esc/backdrop/关闭按钮/再点切换按钮/onRequestOpened 关闭 ----
    const openDrawer = (): void => setDrawerOpen(true)
    const closeDrawer = (): void => setDrawerOpen(false)

    useImperativeHandle(
      ref,
      (): ResizableCollectionPaneHandle => ({
        onRequestOpened: () => {
          if (drawerOpenRef.current) setDrawerOpen(false)
        },
      }),
      [],
    )

    useEffect(() => {
      if (!drawerVisible) return
      const pane = paneRef.current
      if (pane === null) return
      // 焦点进入搜索框（树内首个 input 即 CollectionTree 搜索框）；无 input 时退到首个可聚焦元素。
      const search = pane.querySelector<HTMLElement>('input')
      const target = search ?? focusableElements(pane)[0]
      target?.focus()
    }, [drawerVisible])

    useEffect(() => {
      if (!drawerVisible) return
      const onWindowKeyDown = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') closeDrawer()
      }
      window.addEventListener('keydown', onWindowKeyDown)
      return () => window.removeEventListener('keydown', onWindowKeyDown)
    }, [drawerVisible])

    // 焦点归还：drawer 关闭 → 「展开请求树」按钮；docked 缩到 <526 → 树内/游离焦点收进按钮
    //（主编辑区焦点不抢——避免打断输入；设计 §6.8「focus 回展开按钮」按此解释实现，见 WP4 报告）。
    const prevFocusRef = useRef({ drawerVisible: false, mode })
    useEffect(() => {
      const prev = prevFocusRef.current
      prevFocusRef.current = { drawerVisible, mode }
      if (prev.drawerVisible && !drawerVisible && mode === 'hidden') {
        toggleRef.current?.focus()
        return
      }
      if (prev.mode !== 'hidden' && mode === 'hidden') {
        const active = document.activeElement
        if (active === null || active === document.body || paneRef.current?.contains(active) === true) {
          toggleRef.current?.focus()
        }
      }
    }, [drawerVisible, mode])

    // drawer 内 Tab/Shift+Tab 焦点陷阱（限制在 drawer 内循环，UX §5）。
    const onPaneKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (!drawerVisible || event.key !== 'Tab') return
      const pane = paneRef.current
      if (pane === null) return
      const focusables = focusableElements(pane)
      if (focusables.length === 0) {
        event.preventDefault()
        return
      }
      const first = focusables[0]!
      const last = focusables[focusables.length - 1]!
      const active = document.activeElement
      const insidePane = active !== null && pane.contains(active)
      if (event.shiftKey) {
        if (!insidePane || active === first) {
          event.preventDefault()
          last.focus()
        }
      } else if (!insidePane || active === last) {
        event.preventDefault()
        first.focus()
      }
    }

    // ---- 样式（不使用原生 CSS resize；无 transition——「无动画切回 docked」）----
    const rootStyle: CSSProperties = {
      position: 'relative',
      display: 'flex',
      flex: 1,
      width: '100%',
      minWidth: 0,
      minHeight: 0,
    }

    const paneStyle: CSSProperties = drawerVisible
      ? {
          // drawer：同一 DOM 节点换 overlay 形态（树不重挂载），覆盖主区不挤压。
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: computeDrawerWidth(viewportWidth),
          boxSizing: 'border-box',
          zIndex: 20,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'auto',
          background: colors.bg,
          borderRight: `1px solid ${colors.borderStrong}`,
          boxShadow: '2px 0 12px rgba(0,0,0,0.25)',
          fontSize: font.size,
          color: colors.text,
        }
      : hiddenClosed
        ? {
            // hidden：docked width=0 不可交互，React 树不卸载。
            flex: '0 0 0px',
            width: 0,
            minWidth: 0,
            overflow: 'hidden',
            pointerEvents: 'none',
          }
        : {
            // docked（normal/compact）：rendered px（含 1px 右边框，box-sizing: border-box）。
            flex: `0 0 ${rendered}px`,
            width: rendered,
            minWidth: 0,
            minHeight: 0,
            boxSizing: 'border-box',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            borderRight: `1px solid ${colors.border}`,
          }

    const separatorStyle: CSSProperties = {
      flex: `0 0 ${SEPARATOR_HIT_WIDTH}px`,
      width: SEPARATOR_HIT_WIDTH,
      boxSizing: 'border-box',
      cursor: mode === 'hidden' ? 'default' : 'col-resize',
      background: dragging ? colors.brand : separatorHovered ? colors.fill : 'transparent',
      borderLeft: `1px solid ${colors.border}`,
      touchAction: 'none', // 触摸拖动不被滚动手势劫持
      display: mode === 'hidden' ? 'none' : 'block',
      outline: 'none',
    }

    const toggleLabel = drawerOpen ? '收起请求树' : '展开请求树'

    return (
      <div ref={rootRef} data-dsh-api-client="collection-pane-root" style={rootStyle}>
        <div
          ref={paneRef}
          data-dsh-api-client="collection-sidebar-pane"
          data-pane-mode={mode}
          style={paneStyle}
          onKeyDown={onPaneKeyDown}
        >
          {drawerVisible && (
            <div
              data-dsh-api-client="collection-sidebar-drawer-header"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                padding: '6px 8px',
                borderBottom: `1px solid ${colors.border}`,
                fontSize: font.size,
                color: colors.textSecondary,
              }}
            >
              <span>请求树</span>
              <button
                type="button"
                data-dsh-api-client="collection-sidebar-drawer-close"
                onClick={closeDrawer}
                title="关闭请求树"
                style={{
                  cursor: 'pointer',
                  border: `1px solid ${colors.borderStrong}`,
                  borderRadius: 4,
                  background: colors.bg,
                  color: colors.text,
                  fontSize: font.size,
                  padding: '2px 8px',
                }}
              >
                关闭
              </button>
            </div>
          )}
          {children}
        </div>

        <div
          ref={separatorRef}
          role="separator"
          aria-orientation="vertical"
          aria-label="请求树侧栏宽度"
          aria-valuenow={rendered}
          aria-valuemin={range === null ? undefined : Math.round(range.min)}
          aria-valuemax={range === null ? undefined : Math.round(range.max)}
          tabIndex={mode === 'hidden' ? -1 : 0}
          title="拖动调整侧栏宽度；双击恢复默认 260px；聚焦后 ←/→ 调整 10px，Shift+←/→ 调整 40px"
          data-dsh-api-client="collection-sidebar-separator"
          style={separatorStyle}
          onPointerDown={onSeparatorPointerDown}
          onDoubleClick={onSeparatorDoubleClick}
          onKeyDown={onSeparatorKeyDown}
          onLostPointerCapture={onSeparatorLostPointerCapture}
          onMouseEnter={() => setSeparatorHovered(true)}
          onMouseLeave={() => setSeparatorHovered(false)}
        />

        <div
          data-dsh-api-client="collection-pane-main"
          style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}
        >
          {main}
        </div>

        {drawerVisible && (
          <div
            data-dsh-api-client="collection-sidebar-drawer-backdrop"
            onClick={closeDrawer}
            aria-hidden="true"
            style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 10 }}
          />
        )}

        {mode === 'hidden' && (
          <button
            ref={toggleRef}
            type="button"
            data-dsh-api-client="collection-sidebar-drawer-toggle"
            onClick={() => (drawerOpen ? closeDrawer() : openDrawer())}
            aria-expanded={drawerOpen}
            aria-label={toggleLabel}
            title={toggleLabel}
            style={{
              position: 'absolute',
              top: 8,
              left: 8,
              zIndex: 30,
              cursor: 'pointer',
              border: `1px solid ${colors.borderStrong}`,
              borderRadius: 4,
              background: colors.bg,
              color: colors.text,
              fontSize: font.size,
              padding: '4px 10px',
              boxShadow: '0 1px 4px rgba(0,0,0,0.15)',
            }}
          >
            {toggleLabel}
          </button>
        )}
      </div>
    )
  },
)
