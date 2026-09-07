/**
 * VariableTable（§9）：环境变量表格。
 *
 * secret 纪律（§24.1 / §5.2 human-present reveal / AC-42）：
 * - 已保存 secret 行恒显示 `••••••••`（host 投影只给 `<secret-ref:key>`，本组件绝不解析）；
 * - V0.1 无 GET secret 端点——reveal 只允许「编辑态」：用户点击「重新输入」后
 *   在密码框中输入新值，眼睛按钮逐次点击切换 type text/password（human-present、
 *   仅内存展示、不落盘不写日志）；绝不从 host 拉明文；
 * - 明文只出现在 PUT …/secrets/:key 的写请求体中（write-only）。
 *
 * Host API 提供面（§5.1）：普通变量 upsert（无删除端点——已存在的普通变量
 * 只能禁用，删除按钮仅对未保存的新行开放）；secret 变量经 secrets 端点增删。
 */
import type { CSSProperties, ReactElement } from 'react'
import { colors, font } from '../common/theme.ts'

export const SECRET_MASK = '••••••••'

export interface VariableDraftRow {
  key: string
  /** 明文值；已保存 secret 行恒为 ''（值不回显）。 */
  value: string
  initialValue?: string
  secret: boolean
  enabled: boolean
  /** host 侧已有 SecretRef 绑定（保存后由投影重建为 true）。 */
  secretSaved: boolean
  /** 编辑态 reveal（仅内存，type text/password 切换）。 */
  revealed: boolean
  /** 本次会话内新加、尚未写 host 的行。 */
  isNew: boolean
}

export interface VariableTableProps {
  rows: VariableDraftRow[]
  onChange: (rows: VariableDraftRow[]) => void
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

const smallButtonStyle: CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: colors.textSecondary,
  cursor: 'pointer',
  fontSize: 11,
  padding: '1px 4px',
  whiteSpace: 'nowrap',
}

export function VariableTable(props: VariableTableProps): ReactElement {
  const update = (index: number, patch: Partial<VariableDraftRow>): void => {
    props.onChange(props.rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }
  const remove = (index: number): void => {
    props.onChange(props.rows.filter((_, i) => i !== index))
  }
  const add = (): void => {
    props.onChange([...props.rows, { key: '', value: '', secret: false, enabled: true, secretSaved: false, revealed: false, isNew: true }])
  }

  return (
    <div data-dsh-api-client="variable-table" style={{ fontSize: font.size }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ color: colors.textSecondary, textAlign: 'left' }}>
            <th style={{ ...cellStyle, width: 28, padding: '4px 6px' }} />
            <th style={{ ...cellStyle, padding: '4px 6px' }}>Key</th>
            <th style={{ ...cellStyle, padding: '4px 6px' }}>Value</th>
            <th style={{ ...cellStyle, width: 56, padding: '4px 6px' }}>Secret</th>
            <th style={{ ...cellStyle, width: 120 }} />
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row, index) => {
            // 已保存 secret 且未进入编辑态：只读掩码。
            const savedMasked = row.secret && row.secretSaved && !row.isNew && row.value === ''
            return (
              <tr key={index} style={{ opacity: row.enabled ? 1 : 0.55 }}>
                <td style={{ ...cellStyle, textAlign: 'center' }}>
                  <input
                    type="checkbox"
                    checked={row.enabled}
                    onChange={(event) => update(index, { enabled: event.target.checked })}
                    aria-label="enabled"
                  />
                </td>
                <td style={cellStyle}>
                  <input style={inputStyle} value={row.key} placeholder="VARIABLE" onChange={(event) => update(index, { key: event.target.value })} />
                </td>
                <td style={{ ...cellStyle, borderLeft: `1px solid ${colors.border}` }}>
                  {savedMasked ? (
                    <span style={{ ...inputStyle, display: 'inline-block', color: colors.textSecondary, userSelect: 'none' }}>{SECRET_MASK}</span>
                  ) : (
                    <input
                      style={inputStyle}
                      type={row.secret && !row.revealed ? 'password' : 'text'}
                      value={row.value}
                      placeholder={row.secret ? 'enter new secret value' : 'value'}
                      onChange={(event) => update(index, { value: event.target.value })}
                    />
                  )}
                </td>
                <td style={{ ...cellStyle, textAlign: 'center' }}>
                  <input
                    type="checkbox"
                    checked={row.secret}
                    onChange={(event) => update(index, { secret: event.target.checked, revealed: false })}
                    aria-label="secret"
                    title="secret 变量值只经 write-only 端点写入，永不回显"
                  />
                </td>
                <td style={{ ...cellStyle, textAlign: 'right', paddingRight: 4 }}>
                  {row.secret && !savedMasked && (
                    <button
                      type="button"
                      style={smallButtonStyle}
                      title={row.revealed ? 'Hide（human-present reveal，仅内存展示）' : 'Reveal（human-present，仅内存展示，不落盘不写日志）'}
                      onClick={() => update(index, { revealed: !row.revealed })}
                    >
                      {row.revealed ? '🙈' : '👁'}
                    </button>
                  )}
                  {savedMasked && (
                    <button
                      type="button"
                      style={smallButtonStyle}
                      title="重新输入（旧值不可回读；输入新值将覆盖 secret store 中的值）"
                      onClick={() => update(index, { value: '', isNew: true, revealed: false })}
                    >
                      重新输入
                    </button>
                  )}
                  {(row.isNew || row.secret) && (
                    <button type="button" style={{ ...smallButtonStyle, color: colors.danger }} title="删除" onClick={() => remove(index)}>
                      ✕
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 6 }}>
        <button
          type="button"
          onClick={add}
          style={{
            background: 'transparent',
            border: `1px solid ${colors.borderStrong}`,
            borderRadius: 4,
            color: colors.textSecondary,
            cursor: 'pointer',
            fontSize: font.size,
            padding: '3px 10px',
          }}
        >
          + Add variable
        </button>
        <span style={{ color: colors.textSecondary }}>
          secret 行恒显示 {SECRET_MASK}；已存在的普通变量只能禁用（V0.1 host API 无删除端点）。
        </span>
      </div>
    </div>
  )
}
