/**
 * TreeCreateDialog（P0，WP5）：新建 Collection / Folder / 子 Folder 的中文输入对话框。
 *
 * 契约：
 * - 基于 common/Modal（Esc / 右上角关闭 / 遮罩点击 = 取消；打开时焦点进输入框——
 *   Modal initialFocus=RefObject）；
 * - name trim 后非空校验：空/纯空格 → 内联中文错误「名称不能为空」，不触发提交；
 * - Enter 提交（原生 form submit）；
 * - pending（Host 创建进行中）→ 提交按钮忙碌态「创建中…」+ disabled + 防重复触发；
 * - error（Host 失败）→ 对话框保持打开、输入不丢、内联展示中文错误（§6.4 同款语义）。
 *
 * 本文件不 import 任何 DSH 包（TC-A-03）。
 */
import { useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactElement } from 'react'
import { colors, font } from '../common/theme.ts'
import { Modal } from '../common/Modal.tsx'

export type TreeCreateMode = 'collection' | 'folder' | 'subfolder'

export interface TreeCreateDialogProps {
  mode: TreeCreateMode
  /** 标题下的目标上下文名（folder = 目标 Collection 名；subfolder = 父 Folder 名）。 */
  contextName?: string
  /** Host 创建进行中：提交按钮忙碌态 + 防重复。 */
  pending?: boolean
  /** 提交失败的中文错误（保持打开、不丢输入）。 */
  error?: string
  onCancel: () => void
  onSubmit: (name: string) => void
}

const MODE_TITLES: Record<TreeCreateMode, string> = {
  collection: '新建 Collection',
  folder: '新建 Folder',
  subfolder: '新建子 Folder',
}

function modeContextLine(mode: TreeCreateMode, contextName: string | undefined): string | undefined {
  if (contextName === undefined || contextName === '') return undefined
  return mode === 'folder' ? `创建到 Collection「${contextName}」` : mode === 'subfolder' ? `创建到 Folder「${contextName}」` : undefined
}

export function TreeCreateDialog(props: TreeCreateDialogProps): ReactElement {
  const [name, setName] = useState('')
  const [localError, setLocalError] = useState<string | undefined>()
  const inputRef = useRef<HTMLInputElement>(null)
  const pending = props.pending === true

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const error = localError ?? props.error

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (pending) return
    const trimmed = name.trim()
    if (trimmed === '') {
      setLocalError('名称不能为空')
      return
    }
    setLocalError(undefined)
    props.onSubmit(trimmed)
  }

  const contextLine = modeContextLine(props.mode, props.contextName)

  return (
    <Modal title={MODE_TITLES[props.mode]} onClose={props.onCancel} width={420} initialFocus={inputRef}>
      <form
        data-dsh-api-client="tree-create-dialog"
        onSubmit={submit}
        style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: font.size, color: colors.text }}
      >
        {contextLine !== undefined && <div style={{ color: colors.textSecondary }}>{contextLine}</div>}
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span>名称</span>
          <input
            ref={inputRef}
            data-dsh-api-client="tree-create-input"
            value={name}
            disabled={pending}
            aria-invalid={error !== undefined}
            onChange={(event) => {
              setName(event.target.value)
              if (localError !== undefined) setLocalError(undefined)
            }}
            style={{
              background: colors.bgLayer1,
              border: `1px solid ${error !== undefined ? colors.danger : colors.borderStrong}`,
              borderRadius: 4,
              color: colors.text,
              font: 'inherit',
              fontSize: font.size,
              padding: '5px 8px',
              outline: 'none',
            }}
          />
        </label>
        {error !== undefined && (
          <div data-dsh-api-client="tree-create-error" role="alert" style={{ color: colors.danger, fontSize: 11 }}>
            {error}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            type="button"
            data-dsh-api-client="tree-create-cancel"
            data-modal-role="cancel"
            onClick={props.onCancel}
            style={buttonStyle}
          >
            取消
          </button>
          <button
            type="submit"
            data-dsh-api-client="tree-create-submit"
            disabled={pending}
            aria-busy={pending}
            style={{ ...buttonStyle, background: colors.brand, borderColor: colors.brand, color: colors.brandText, cursor: pending ? 'default' : 'pointer' }}
          >
            {pending ? '创建中…' : '创建'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

const buttonStyle = {
  background: 'transparent',
  border: `1px solid ${colors.borderStrong}`,
  borderRadius: 4,
  color: colors.text,
  cursor: 'pointer',
  font: 'inherit',
  fontSize: font.size,
  padding: '4px 12px',
} as const
