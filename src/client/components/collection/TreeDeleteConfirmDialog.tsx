/**
 * TreeDeleteConfirmDialog（P0 实施设计 §7.1/§7.2 / UX §4.7，WP6）：
 * 树节点（Request/Folder/Collection）删除确认弹窗。
 *
 * 契约要点：
 * - 统计数字（descendantFolderCount / requestCount / dirtyTabCount）由调用方
 *   基于当前 projection 计算后传入，本组件不做树遍历（递归统计纯函数归 core，
 *   WP1/WP8 消费）；Folder 的 descendantFolderCount 不含目标 Folder 本身。
 * - dirtyTabCount>0 → 追加「将放弃 N 个未保存修改」，确认按钮「删除并放弃修改」；
 *   否则确认按钮「删除」。
 * - 取消按钮默认获得焦点（Modal initialFocus='cancel' + data-modal-role 约定）；
 *   Esc 与右上角关闭都等同取消（Modal onClose = onCancel）。
 * - pending（Host 删除进行中）→ 确认按钮忙碌态 + disabled + 早退，双保险防重复
 *   触发（UX §9：所有 mutation 都有 pending 状态，重复触发被抑制）。
 * - P0 强确认、不提供 Undo（UX §4.7），本组件不得出现「撤销」入口。
 *
 * 分层纪律（TC-A-03）：本文件不 import 任何 DSH 包。
 */
import type { CSSProperties, ReactElement } from 'react'
import { colors, font } from '../common/theme.ts'
import { Modal } from '../common/Modal.tsx'

export type TreeDeleteKind = 'request' | 'folder' | 'collection'

export interface TreeDeleteConfirmDialogProps {
  kind: TreeDeleteKind
  /** 目标名称（「」内原样展示；由调用方从 projection 取）。 */
  name: string
  /** kind='folder'：递归后代子文件夹数（目标 Folder 本身不计入）。 */
  descendantFolderCount?: number
  /** kind='folder'：递归请求数；kind='collection'：递归 Request 总数。 */
  requestCount?: number
  /** 受影响 dirty tab 数；>0 时追加警示并切换确认按钮文案。 */
  dirtyTabCount?: number
  /** Host 删除进行中：确认按钮忙碌态且防重复触发。 */
  pending?: boolean
  onCancel: () => void
  onConfirm: () => void
}

const KIND_TITLES: Record<TreeDeleteKind, string> = {
  request: '删除请求',
  folder: '删除文件夹',
  collection: '删除集合',
}

const KIND_NOUNS: Record<TreeDeleteKind, string> = {
  request: '请求',
  folder: '文件夹',
  collection: '集合',
}

export function TreeDeleteConfirmDialog(props: TreeDeleteConfirmDialogProps): ReactElement {
  const dirtyCount = props.dirtyTabCount ?? 0
  const dirty = dirtyCount > 0
  const pending = props.pending ?? false

  let stats: string | undefined
  if (props.kind === 'folder') {
    stats = `包含 ${props.descendantFolderCount ?? 0} 个子文件夹、${props.requestCount ?? 0} 个请求`
  } else if (props.kind === 'collection') {
    stats = `包含 ${props.requestCount ?? 0} 个请求`
  }

  const confirmLabel = pending ? '删除中…' : dirty ? '删除并放弃修改' : '删除'
  const handleConfirm = (): void => {
    if (pending) return // 防重复触发（双保险之一，另一重是 disabled）
    props.onConfirm()
  }

  return (
    <Modal title={KIND_TITLES[props.kind]} width={440} onClose={props.onCancel} initialFocus="cancel">
      <div data-dsh-api-client="tree-delete-dialog" style={{ fontSize: font.size }}>
        <div data-dsh-api-client="tree-delete-headline">
          {`确定删除${KIND_NOUNS[props.kind]}「${props.name}」？`}
        </div>
        {stats !== undefined && (
          <div data-dsh-api-client="tree-delete-stats" style={{ color: colors.textSecondary, marginTop: 6 }}>
            {stats}
          </div>
        )}
        {dirty && (
          <div data-dsh-api-client="tree-delete-dirty" style={{ color: colors.danger, marginTop: 6 }}>
            {`将放弃 ${dirtyCount} 个未保存修改`}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button
            type="button"
            data-modal-role="cancel"
            data-dsh-api-client="tree-delete-cancel"
            onClick={props.onCancel}
            disabled={pending}
            style={cancelButtonStyle}
          >
            取消
          </button>
          <button
            type="button"
            data-dsh-api-client="tree-delete-confirm"
            onClick={handleConfirm}
            disabled={pending}
            aria-busy={pending || undefined}
            style={{ ...confirmButtonStyle, opacity: pending ? 0.6 : 1 }}
          >
            {confirmLabel}
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
