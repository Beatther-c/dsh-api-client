/**
 * DirtyTabCloseDialog（P0 实施设计 §7.5 / UX §4.7，WP6）：
 * 单独关闭 dirty tab 的确认弹窗。
 *
 * 语义（§7.5 冻结）：RequestTabs 的 onClose 不直接关闭——clean tab 立即关闭；
 * dirty tab 打开本弹窗。文案说明未保存修改将丢失，确认按钮「关闭并放弃修改」；
 * 取消按钮默认获得焦点，Esc / 右上角关闭等同取消；P0 不提供自动保存选项
 * （「P0 不自动 Save」，故本弹窗没有第三种出口）。
 *
 * pending（关闭处理进行中）→ 确认按钮忙碌态 + disabled + 早退防重复触发。
 *
 * 分层纪律（TC-A-03）：本文件不 import 任何 DSH 包。
 */
import type { CSSProperties, ReactElement } from 'react'
import { colors, font } from '../common/theme.ts'
import { Modal } from '../common/Modal.tsx'

export interface DirtyTabCloseDialogProps {
  /** 请求名（可选；提供时纳入警示文案的「」中）。 */
  name?: string
  /** 关闭处理进行中：确认按钮忙碌态且防重复触发。 */
  pending?: boolean
  onCancel: () => void
  onConfirm: () => void
}

export function DirtyTabCloseDialog(props: DirtyTabCloseDialogProps): ReactElement {
  const pending = props.pending ?? false
  const message =
    props.name !== undefined && props.name !== ''
      ? `请求「${props.name}」存在未保存修改，关闭后这些修改将丢失。`
      : '该请求存在未保存修改，关闭后这些修改将丢失。'

  const handleConfirm = (): void => {
    if (pending) return // 防重复触发（双保险之一，另一重是 disabled）
    props.onConfirm()
  }

  return (
    <Modal title="关闭未保存的标签页" width={420} onClose={props.onCancel} initialFocus="cancel">
      <div data-dsh-api-client="dirty-tab-close-dialog" style={{ fontSize: font.size }}>
        <div data-dsh-api-client="dirty-tab-close-message">{message}</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button
            type="button"
            data-modal-role="cancel"
            data-dsh-api-client="dirty-tab-close-cancel"
            onClick={props.onCancel}
            disabled={pending}
            style={cancelButtonStyle}
          >
            取消
          </button>
          <button
            type="button"
            data-dsh-api-client="dirty-tab-close-confirm"
            onClick={handleConfirm}
            disabled={pending}
            aria-busy={pending || undefined}
            style={{ ...confirmButtonStyle, opacity: pending ? 0.6 : 1 }}
          >
            {pending ? '关闭中…' : '关闭并放弃修改'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

const cancelButtonStyle: CSSProperties = {
  background: 'transparent',
  border: `1px solid ${colors.borderStrong}`,
  borderRadius: 4,
  color: colors.text,
  cursor: 'pointer',
  fontSize: font.size,
  padding: '4px 16px',
}

const confirmButtonStyle: CSSProperties = {
  background: colors.danger,
  color: '#ffffff',
  border: 'none',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: font.size,
  padding: '4px 16px',
}
