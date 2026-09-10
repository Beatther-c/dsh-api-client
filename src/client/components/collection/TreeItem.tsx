/**
 * TreeItem（P0 实施设计 §6.1/§6.2/§6.4，UX §4.1/§4.2/§4.5，WP5 重写）：
 * 稳定行结构的树节点行（Collection / Folder / Request）。
 *
 * AC-01/02 冻结点：
 * - 固定槽位 `[expand-slot 14px][type/method-slot 40px][name flex-1 省略号+title][state-slot 16px]`；
 * - **彻底移除 hover 挂载按钮**——全部操作进右键菜单（TreeContextMenu）；
 *   hover 只改背景色，名称区 DOM 结构与宽度零变化（≤0.5px 由结构恒定保证）；
 * - 空 Collection/Folder：expand-slot 保留 14px 占位但不显示 ▸/▾（无伪箭头）；
 * - 缩进由 visualDepth（= min(logicalDepth, 6)，tree-projection 计算）驱动。
 *
 * 交互（语义全部由 CollectionTree 分发，本组件不自行决定 toggle/open）：
 * - 左键整行 → onActivate（Collection/Folder = 先选中再 toggle；Request = 选中+打开）；
 * - 右键 → onContextMenu（只选中+开菜单，不开请求不 toggle）；
 * - 键盘 → onKeyDown（§4.4 契约表由 CollectionTree 统一实现）；
 * - 行内 rename（§6.4）：Enter 提交（trim 非空才 await Host）/Esc 取消恢复原名/
 *   blur 非空提交、空或纯空格取消恢复；提交中忙碌态（input 禁用 + state-slot「…」）；
 *   失败保持编辑态显示中文错误、不丢输入；编辑态归 CollectionTree 协调
 *   （renaming prop），同一时间仅一个节点编辑。普通行 Enter 不进 rename（F2/菜单才进）。
 *
 * 可聚焦与 a11y：role=treeitem + tabIndex（roving，由树协调）+ aria-selected/
 * aria-expanded/aria-level + focus 描边样式。
 *
 * 本文件不 import 任何 DSH 包（TC-A-03）。
 */
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactElement } from 'react'
import type { HttpMethod } from '@dsh-api-client/shared'
import { colors, font } from '../common/theme.ts'
import { methodColor } from '../common/method.ts'

export type TreeItemKind = 'collection' | 'folder' | 'request'

export interface TreeItemProps {
  nodeKey: string
  kind: TreeItemKind
  name: string
  /** kind='request'：type/method-slot 的语义色徽标。 */
  method?: HttpMethod
  /** 视觉缩进层级（tree-projection：min(logicalDepth, 6)）。 */
  visualDepth: number
  /** aria-level = logicalDepth + 1（逻辑层级不受视觉上限影响）。 */
  ariaLevel: number
  /** 数据上有子节点；false = 空 Collection/Folder → 无箭头但占位保留。 */
  expandable: boolean
  expanded: boolean
  selected: boolean
  /** roving tabIndex（selected 行 0，其余 -1；无选择时首行 0）。 */
  tabIndex: number
  /** 行内编辑态（CollectionTree 协调——同一时间仅一个节点为 true）。 */
  renaming: boolean
  renamePending?: boolean
  /** 提交失败的中文错误（保持编辑态展示，不丢输入）。 */
  renameError?: string
  /** 本行为 mutation 目标且执行中（state-slot 忙碌指示）。 */
  actionPending?: boolean
  rowRef: (element: HTMLDivElement | null) => void
  onActivate: () => void
  onContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => void
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void
  onRenameSubmit: (name: string) => void
  onRenameCancel: () => void
}

/** 行内重命名输入（§6.4）：draft 本地持有——失败保持编辑态时输入不丢。 */
interface RenameInputProps {
  initialName: string
  pending: boolean
  error?: string
  onSubmit: (name: string) => void
  onCancel: () => void
}

function RenameInput(props: RenameInputProps): ReactElement {
  const [draft, setDraft] = useState(props.initialName)
  const inputRef = useRef<HTMLInputElement>(null)
  /**
   * 提交/取消已发起标记：Esc 取消 → 父级把焦点还给树行 → 输入框 blur——若无此闸，
   * blur 提交语义会把刚取消的重命名又提交一遍。提交失败保持编辑态时，pending
   * 回落（true→false）后由下方 effect 复位，允许重试。
   */
  const doneRef = useRef(false)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  useEffect(() => {
    if (!props.pending) doneRef.current = false
  }, [props.pending])

  /** Enter/blur 共用：trim 非空才提交；空/纯空格在 blur 时取消恢复原名（Enter 时保持编辑）。 */
  const commit = (source: 'enter' | 'blur'): void => {
    if (props.pending || doneRef.current) return
    const trimmed = draft.trim()
    if (trimmed === '') {
      if (source === 'blur') {
        doneRef.current = true
        props.onCancel()
      }
      return
    }
    doneRef.current = true
    props.onSubmit(trimmed)
  }

  return (
    <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: '1 1 auto' }}>
      <input
        ref={inputRef}
        data-dsh-api-client="tree-rename-input"
        value={draft}
        disabled={props.pending}
        aria-label="重命名"
        aria-invalid={props.error !== undefined}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
          // 编辑态按键全部归输入框：绝不冒泡到树键盘契约（Backspace 删行、Enter 打开等）。
          event.stopPropagation()
          if (event.key === 'Enter') {
            event.preventDefault()
            commit('enter')
          } else if (event.key === 'Escape') {
            event.preventDefault()
            if (!props.pending && !doneRef.current) {
              doneRef.current = true
              props.onCancel()
            }
          }
        }}
        onBlur={() => commit('blur')}
        onClick={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.stopPropagation()}
        style={{
          flex: '1 1 auto',
          minWidth: 0,
          background: colors.bg,
          border: `1px solid ${props.error !== undefined ? colors.danger : colors.brand}`,
          borderRadius: 3,
          color: colors.text,
          font: 'inherit',
          fontSize: font.size,
          padding: '1px 4px',
          outline: 'none',
        }}
      />
      {props.error !== undefined && (
        <span data-dsh-api-client="tree-rename-error" role="alert" style={{ fontSize: 10, lineHeight: 1.4, color: colors.danger }}>
          {props.error}
        </span>
      )}
      {props.pending && (
        <span data-dsh-api-client="tree-rename-pending" style={{ fontSize: 10, lineHeight: 1.4, color: colors.textSecondary }}>
          提交中…
        </span>
      )}
    </span>
  )
}

export function TreeItem(props: TreeItemProps): ReactElement {
  const [hover, setHover] = useState(false)
  const [focused, setFocused] = useState(false)
  const busy = props.actionPending === true || props.renamePending === true

  const rowStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    paddingLeft: 6 + props.visualDepth * 14,
    paddingRight: 4,
    minHeight: 24,
    cursor: 'pointer',
    background: props.selected ? colors.fill : hover ? colors.bgLayer1 : 'transparent',
    borderRadius: 4,
    fontSize: font.size,
    color: colors.text,
    userSelect: 'none',
    outline: focused ? `1px solid ${colors.brand}` : 'none',
    outlineOffset: -1,
  }

  return (
    <div
      ref={props.rowRef}
      role="treeitem"
      data-dsh-api-client="tree-row"
      data-tree-key={props.nodeKey}
      data-tree-kind={props.kind}
      aria-level={props.ariaLevel}
      aria-selected={props.selected}
      {...(props.expandable ? { 'aria-expanded': props.expanded } : {})}
      {...(busy ? { 'aria-busy': true } : {})}
      tabIndex={props.tabIndex}
      title={props.renaming ? undefined : props.name}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onClick={props.onActivate}
      onContextMenu={props.onContextMenu}
      onKeyDown={props.onKeyDown}
      style={rowStyle}
    >
      {/* expand-slot：固定 14px；空节点无箭头但占位保留（AC-02，名称不跳动）。 */}
      <span
        data-dsh-api-client="tree-expand-slot"
        aria-hidden="true"
        style={{ flex: '0 0 14px', width: 14, textAlign: 'center', color: colors.textSecondary }}
      >
        {props.expandable ? (props.expanded ? '▾' : '▸') : ''}
      </span>
      {/* type/method-slot：固定 40px（名称列跨行对齐；hover 无关，结构恒定）。 */}
      <span
        data-dsh-api-client="tree-type-slot"
        aria-hidden="true"
        style={{ flex: '0 0 40px', width: 40, overflow: 'hidden', whiteSpace: 'nowrap' }}
      >
        {props.kind === 'request' && props.method !== undefined ? (
          <span style={{ fontSize: 10, fontWeight: 700, fontFamily: font.mono, color: methodColor(props.method) }}>{props.method}</span>
        ) : props.kind === 'collection' ? (
          <span style={{ color: colors.textSecondary }}>▣</span>
        ) : (
          ''
        )}
      </span>
      {/* name：flex-1 省略号 + title tooltip 全名；rename 时原位替换为输入框。 */}
      <span
        data-dsh-api-client="tree-name-slot"
        style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center' }}
      >
        {props.renaming ? (
          <RenameInput
            initialName={props.name}
            pending={props.renamePending === true}
            error={props.renameError}
            onSubmit={props.onRenameSubmit}
            onCancel={props.onRenameCancel}
          />
        ) : (
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{props.name}</span>
        )}
      </span>
      {/* state-slot：固定 16px；忙碌指示（mutation pending）——结构恒定不挤压名称。 */}
      <span data-dsh-api-client="tree-state-slot" aria-hidden="true" style={{ flex: '0 0 16px', width: 16, textAlign: 'center', color: colors.textSecondary }}>
        {busy ? '…' : ''}
      </span>
    </div>
  )
}
