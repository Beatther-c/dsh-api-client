/** 多请求 Tab 栏（§4）：Method 语义色 chip + 名称 + 未保存圆点 + 关闭。 */
import type { ReactElement } from 'react'
import type { HttpMethod } from '@dsh-api-client/shared'
import { colors, font } from '../common/theme.ts'
import { methodColor } from '../common/method.ts'

export interface RequestTabInfo {
  key: string
  name: string
  method: HttpMethod
  dirty: boolean
}

export interface RequestTabsProps {
  tabs: RequestTabInfo[]
  activeKey: string | undefined
  onSelect: (key: string) => void
  onClose: (key: string) => void
  onNew: () => void
}

export function RequestTabs(props: RequestTabsProps): ReactElement {
  return (
    <div
      data-dsh-api-client="request-tabs"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        overflowX: 'auto',
        borderBottom: `1px solid ${colors.border}`,
        background: colors.bgLayer1,
        padding: '0 4px',
        minHeight: 30,
      }}
    >
      {props.tabs.map((tab) => {
        const active = tab.key === props.activeKey
        return (
          <div
            key={tab.key}
            onClick={() => props.onSelect(tab.key)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 8px',
              cursor: 'pointer',
              fontSize: font.size,
              whiteSpace: 'nowrap',
              color: active ? colors.text : colors.textSecondary,
              background: active ? colors.bg : 'transparent',
              border: `1px solid ${active ? colors.border : 'transparent'}`,
              borderBottom: 'none',
              borderRadius: '6px 6px 0 0',
            }}
            title={tab.name}
          >
            <span style={{ fontFamily: font.mono, fontSize: 10, fontWeight: 700, color: methodColor(tab.method) }}>{tab.method}</span>
            <span style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' }}>{tab.name}</span>
            {tab.dirty && <span style={{ color: colors.warning }}>●</span>}
            <button
              type="button"
              aria-label="close tab"
              onClick={(event) => {
                event.stopPropagation()
                props.onClose(tab.key)
              }}
              style={{ background: 'transparent', border: 'none', color: colors.textSecondary, cursor: 'pointer', fontSize: 11, padding: '0 2px' }}
            >
              ✕
            </button>
          </div>
        )
      })}
      <button
        type="button"
        title="New request tab"
        onClick={props.onNew}
        style={{ background: 'transparent', border: 'none', color: colors.textSecondary, cursor: 'pointer', fontSize: 14, padding: '2px 6px' }}
      >
        +
      </button>
    </div>
  )
}
