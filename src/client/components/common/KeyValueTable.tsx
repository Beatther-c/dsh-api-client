/**
 * Params/Headers/Body 表单共用的 KeyValue 表格（§7.3/§7.4）：
 * 启停 checkbox、key/value(/description) 编辑、行删除、尾部新增行；
 * 行级告警（重复 key 等）由调用方经 warn 回调注入。
 */
import type { CSSProperties } from 'react'
import type { KeyValue } from '@dsh-api-client/shared'
import { colors, font } from './theme.ts'

export interface KeyValueTableProps {
  rows: KeyValue[]
  onChange: (rows: KeyValue[]) => void
  keyPlaceholder?: string
  valuePlaceholder?: string
  withDescription?: boolean
  /** value 以 password 形态展示（secret masking，§7.4）。 */
  maskValue?: (row: KeyValue) => boolean
  /** 行级告警文案（重复 Key/空值提示等）；返回 undefined 表示无告警。 */
  warn?: (row: KeyValue, index: number, rows: KeyValue[]) => string | undefined
  addLabel?: string
}

const inputStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  background: 'transparent',
  border: 'none',
  color: 'inherit',
  font: 'inherit',
  fontSize: font.size,
  padding: '4px 6px',
  outline: 'none',
}

const cellStyle: CSSProperties = {
  borderBottom: `1px solid ${colors.border}`,
  padding: 0,
  verticalAlign: 'middle',
}

export function KeyValueTable(props: KeyValueTableProps): React.ReactElement {
  const update = (index: number, patch: Partial<KeyValue>): void => {
    props.onChange(props.rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }
  const remove = (index: number): void => {
    props.onChange(props.rows.filter((_, i) => i !== index))
  }
  const add = (): void => {
    props.onChange([...props.rows, { key: '', value: '', enabled: true }])
  }

  return (
    <div data-dsh-api-client="kv-table" style={{ fontSize: font.size }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ color: colors.textSecondary, textAlign: 'left' }}>
            <th style={{ ...cellStyle, width: 28, padding: '4px 6px' }} />
            <th style={{ ...cellStyle, padding: '4px 6px' }}>Key</th>
            <th style={{ ...cellStyle, padding: '4px 6px' }}>Value</th>
            {props.withDescription === true && <th style={{ ...cellStyle, padding: '4px 6px' }}>Description</th>}
            <th style={{ ...cellStyle, width: 28 }} />
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row, index) => {
            const warning = props.warn?.(row, index, props.rows)
            return (
              <tr key={index} style={{ opacity: row.enabled ? 1 : 0.55 }} title={warning}>
                <td style={{ ...cellStyle, textAlign: 'center' }}>
                  <input
                    type="checkbox"
                    checked={row.enabled}
                    onChange={(event) => update(index, { enabled: event.target.checked })}
                    aria-label="enabled"
                  />
                </td>
                <td style={cellStyle}>
                  <input
                    style={inputStyle}
                    value={row.key}
                    placeholder={props.keyPlaceholder ?? 'key'}
                    onChange={(event) => update(index, { key: event.target.value })}
                  />
                </td>
                <td style={{ ...cellStyle, borderLeft: `1px solid ${colors.border}` }}>
                  <input
                    style={inputStyle}
                    type={props.maskValue?.(row) === true ? 'password' : 'text'}
                    value={row.value}
                    placeholder={props.valuePlaceholder ?? 'value'}
                    onChange={(event) => update(index, { value: event.target.value })}
                  />
                </td>
                {props.withDescription === true && (
                  <td style={{ ...cellStyle, borderLeft: `1px solid ${colors.border}` }}>
                    <input
                      style={inputStyle}
                      value={row.description ?? ''}
                      placeholder="description"
                      onChange={(event) => update(index, { description: event.target.value })}
                    />
                  </td>
                )}
                <td style={{ ...cellStyle, textAlign: 'center' }}>
                  <button type="button" onClick={() => remove(index)} style={removeStyle} aria-label="remove row">
                    ✕
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <button type="button" onClick={add} style={addStyle}>
        {props.addLabel ?? '+ Add'}
      </button>
    </div>
  )
}

const removeStyle: CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: colors.textSecondary,
  cursor: 'pointer',
  fontSize: 11,
}

const addStyle: CSSProperties = {
  marginTop: 6,
  background: 'transparent',
  border: `1px solid ${colors.borderStrong}`,
  borderRadius: 4,
  color: colors.textSecondary,
  cursor: 'pointer',
  fontSize: font.size,
  padding: '3px 10px',
}
