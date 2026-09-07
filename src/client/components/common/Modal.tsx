/** 通用 Modal：overlay + 对话框，ESC/点击遮罩关闭。 */
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { colors, font } from './theme.ts'

export interface ModalProps {
  title: string
  onClose: () => void
  children: ReactNode
  width?: number
}

export function Modal(props: ModalProps): React.ReactElement {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [props])

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
        role="dialog"
        aria-label={props.title}
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
          <button type="button" onClick={props.onClose} style={closeButtonStyle} aria-label="Close">
            ✕
          </button>
        </div>
        <div style={{ padding: 14, overflow: 'auto' }}>{props.children}</div>
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
