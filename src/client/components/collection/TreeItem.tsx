/**
 * Collection Tree 节点行（Collection / Folder / Request 三级）：
 * - Request 行带 Method 语义色徽标（§5.2：GET 绿 / POST 橙 / PUT 蓝 / PATCH 紫 / DELETE 红）；
 * - 行操作为按钮组（hover 显示），具体动作由 CollectionTree 注入。
 */
import { useState } from 'react'
import type { ReactElement } from 'react'
import type { HttpMethod } from '@dsh-api-client/shared'
import { colors, font } from '../common/theme.ts'
import { methodColor } from '../common/method.ts'

export type TreeItemKind = 'collection' | 'folder' | 'request'

export interface TreeItemAction {
  label: string
  title: string
  onClick: () => void
  danger?: boolean
}

export interface TreeItemProps {
  kind: TreeItemKind
  name: string
  depth: number
  method?: HttpMethod
  expanded?: boolean
  hasChildren?: boolean
  selected?: boolean
  dimmed?: boolean
  actions?: TreeItemAction[]
  onToggleExpand?: () => void
  onSelect?: () => void
}

export function TreeItem(props: TreeItemProps): ReactElement {
  const [hover, setHover] = useState(false)
  const expandable = props.hasChildren === true
  return (
    <div
      data-dsh-api-client={`tree-${props.kind}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={props.onSelect}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        paddingLeft: 6 + props.depth * 14,
        paddingRight: 4,
        height: 24,
        cursor: props.onSelect === undefined ? 'default' : 'pointer',
        background: props.selected === true ? colors.fill : 'transparent',
        borderRadius: 4,
        opacity: props.dimmed === true ? 0.45 : 1,
        fontSize: font.size,
        color: colors.text,
        userSelect: 'none',
      }}
      title={props.name}
    >
      <span
        onClick={(event) => {
          if (!expandable) return
          event.stopPropagation()
          props.onToggleExpand?.()
        }}
        style={{ width: 14, textAlign: 'center', color: colors.textSecondary, flex: '0 0 14px', cursor: expandable ? 'pointer' : 'default' }}
      >
        {expandable ? (props.expanded === true ? '▾' : '▸') : props.kind === 'collection' ? '▣' : ''}
      </span>
      {props.kind === 'request' && props.method !== undefined && (
        <span
          style={{
            flex: '0 0 auto',
            fontSize: 10,
            fontWeight: 700,
            fontFamily: font.mono,
            color: methodColor(props.method),
            minWidth: 42,
          }}
        >
          {props.method}
        </span>
      )}
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{props.name}</span>
      {hover && props.actions !== undefined && props.actions.length > 0 && (
        <span style={{ flex: '0 0 auto', display: 'flex', gap: 2 }} onClick={(event) => event.stopPropagation()}>
          {props.actions.map((action) => (
            <button
              key={action.label}
              type="button"
              title={action.title}
              onClick={action.onClick}
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                fontSize: 11,
                padding: '1px 4px',
                color: action.danger === true ? colors.danger : colors.textSecondary,
              }}
            >
              {action.label}
            </button>
          ))}
        </span>
      )}
    </div>
  )
}
