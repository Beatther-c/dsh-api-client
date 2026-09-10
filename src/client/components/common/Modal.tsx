/**
 * 通用 Modal：overlay + 对话框，ESC/点击遮罩关闭。
 *
 * WP6（P0 实施设计 §7.2/§7.5 / UX §4.7）向后兼容增强——既有消费方
 * （SaveRequestModal / ImportReport / ConfirmSendToAgent）零改动、缺省行为不变：
 * - `initialFocus`：打开时把焦点落到指定目标（确认框「取消按钮默认获得焦点」场景）。
 *   缺省不做任何焦点操作（与旧版一致）。字符串关键字依赖内容区约定标记：
 *   'cancel' → 查找 `[data-modal-role="cancel"]`；'first-button' → 内容区第一个
 *   `<button>`（不含右上角关闭按钮）；找不到时退回对话框容器自身（tabIndex=-1）。
 *   也可直接传 `RefObject`，聚焦 ref 指向的元素。
 * - 中文 accessibility：对话框 aria-label 缺省 = title（`ariaLabel` 可覆盖），
 *   补 `aria-modal="true"`；右上角关闭按钮 aria-label 缺省「关闭」（`closeLabel` 可覆盖）。
 * - ESC / 关闭按钮 / 遮罩点击语义保持：一律走 `onClose`。
 */
import { useEffect, useRef } from 'react'
import type { ReactNode, RefObject } from 'react'
import { colors, font } from './theme.ts'

/** 打开时的初始焦点目标（详见文件头注）。 */
export type ModalInitialFocus = 'cancel' | 'first-button' | RefObject<HTMLElement | null>

export interface ModalProps {
  title: string
  onClose: () => void
  children: ReactNode
  width?: number
  /** 打开时应获得焦点的目标；缺省不做焦点操作（向后兼容）。 */
  initialFocus?: ModalInitialFocus
  /** 对话框 aria-label；缺省 = title（不破坏现有调用的 accessibility name）。 */
  ariaLabel?: string
  /** 右上角关闭按钮 aria-label；缺省「关闭」（中文 a11y）。 */
  closeLabel?: string
}

export function Modal(props: ModalProps): React.ReactElement {
  const dialogRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [props])

  // 仅挂载时执行一次：缺省 initialFocus 时不触碰焦点（旧版行为）。
  useEffect(() => {
    const target = props.initialFocus
    if (target === undefined) return
    const dialog = dialogRef.current
    if (dialog === null) return
    if (typeof target !== 'string') {
      if (target.current !== null && target.current !== undefined) target.current.focus()
      else dialog.focus()
      return
    }
    const content = contentRef.current
    const found =
      target === 'cancel'
        ? content?.querySelector<HTMLElement>('[data-modal-role="cancel"]')
        : content?.querySelector<HTMLElement>('button')
    if (found !== null && found !== undefined) found.focus()
    else dialog.focus()
    // 挂载时一次性焦点投放，故 deps 为空（initialFocus 变化不重新抢焦点）。
  }, [])

  return (
    <div
      data-dsh-api-client="modal"
      onClick={props.onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 900,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={props.ariaLabel ?? props.title}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        style={{
          width: props.width ?? 560,
          maxWidth: '90%',
          maxHeight: '85%',
          display: 'flex',
          flexDirection: 'column',
          background: colors.bg,
          color: colors.text,
          border: `1px solid ${colors.borderStrong}`,
          borderRadius: 8,
          boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
          fontSize: font.size,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 14px',
            borderBottom: `1px solid ${colors.border}`,
          }}
        >
          <strong style={{ fontSize: 13 }}>{props.title}</strong>
          <button
            type="button"
            data-modal-role="close"
            onClick={props.onClose}
            style={closeButtonStyle}
            aria-label={props.closeLabel ?? '关闭'}
          >
            ✕
          </button>
        </div>
        <div ref={contentRef} style={{ padding: 14, overflow: 'auto' }}>
          {props.children}
        </div>
      </div>
    </div>
  )
}

const closeButtonStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: 13,
  padding: '2px 6px',
}
