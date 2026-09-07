/**
 * AuthEditor（§7.5 V0.1 五项）：none / bearer / basic / apikey / inherit。
 *
 * 脱敏纪律（§5.1 投影契约 + §5.2 human-present reveal）：
 * - host 投影中 secret 材料只会是 `<redacted>` 或 SecretRef（{$ref}）——
 *   本组件绝不回显这些占位值：输入框显示为空，placeholder 说明「已保存，重新输入以覆盖」；
 * - 用户一旦编辑本区任何字段，占位材料被重置为空串（防止把字面量 `<redacted>`
 *   存回 host）；完全未触碰本区时父视图不把 auth 放进 PATCH（原样保留）。
 * - secret 材料输入一律 password 形态（masking）。
 */
import type { CSSProperties, ReactElement } from 'react'
import type { AuthConfig } from '@dsh-api-client/shared'
import { isSecretRef } from '@dsh-api-client/shared'
import { colors, font } from '../common/theme.ts'

export interface AuthEditorProps {
  value: AuthConfig
  onChange: (auth: AuthConfig) => void
}

const AUTH_TYPES: ReadonlyArray<{ value: AuthConfig['type']; label: string }> = [
  { value: 'none', label: 'No Auth' },
  { value: 'bearer', label: 'Bearer Token' },
  { value: 'basic', label: 'Basic Auth' },
  { value: 'apikey', label: 'API Key' },
  { value: 'inherit', label: 'Inherit Auth From Parent' },
]

const REDACTED_LITERAL = '<redacted>'

/** 占位材料（redacted 字面量 / SecretRef）→ 展示为空 + 提示文案。 */
function materialDisplay(material: string | { $ref: string }): { value: string; placeholder: string } {
  if (isSecretRef(material)) return { value: '', placeholder: 'stored via secret store — re-enter to replace' }
  if (material === REDACTED_LITERAL) return { value: '', placeholder: 'saved (not echoed) — re-enter to replace' }
  return { value: material, placeholder: '' }
}

/** 编辑时把占位材料归零，绝不让 `<redacted>` 字面量回流到 host。 */
function clearPlaceholder(material: string | { $ref: string }): string {
  return isSecretRef(material) || material === REDACTED_LITERAL ? '' : material
}

const inputStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  background: colors.bgLayer1,
  border: `1px solid ${colors.border}`,
  borderRadius: 4,
  color: colors.text,
  font: 'inherit',
  fontSize: font.size,
  padding: '4px 8px',
  outline: 'none',
}

const rowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '110px 1fr 110px 1fr',
  gap: 8,
  alignItems: 'center',
  marginBottom: 8,
  fontSize: font.size,
}

function Field(props: { label: string; children: React.ReactNode }): ReactElement {
  return (
    <>
      <span style={{ color: colors.textSecondary }}>{props.label}</span>
      {props.children}
    </>
  )
}

export function AuthEditor(props: AuthEditorProps): ReactElement {
  const auth = props.value
  const switchType = (type: AuthConfig['type']): void => {
    switch (type) {
      case 'none':
        props.onChange({ type: 'none' })
        return
      case 'bearer':
        props.onChange({ type: 'bearer', token: auth.type === 'bearer' ? clearPlaceholder(auth.token) : '' })
        return
      case 'basic':
        props.onChange({
          type: 'basic',
          username: auth.type === 'basic' ? auth.username : '',
          password: auth.type === 'basic' ? clearPlaceholder(auth.password) : '',
        })
        return
      case 'apikey':
        props.onChange({
          type: 'apikey',
          key: auth.type === 'apikey' ? auth.key : '',
          value: auth.type === 'apikey' ? clearPlaceholder(auth.value) : '',
          in: auth.type === 'apikey' ? auth.in : 'header',
        })
        return
      case 'inherit':
        props.onChange({ type: 'inherit' })
        return
    }
  }

  return (
    <div data-dsh-api-client="auth-editor" style={{ maxWidth: 720 }}>
      <div style={rowStyle}>
        <Field label="Type">
          <select value={auth.type} onChange={(event) => switchType(event.target.value as AuthConfig['type'])} style={inputStyle}>
            {AUTH_TYPES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        <span />
        <span />
      </div>
      {auth.type === 'bearer' && (
        <div style={rowStyle}>
          <Field label="Token">
            <input
              type="password"
              style={inputStyle}
              value={materialDisplay(auth.token).value}
              placeholder={materialDisplay(auth.token).placeholder}
              onChange={(event) => props.onChange({ type: 'bearer', token: event.target.value })}
            />
          </Field>
          <span />
          <span />
        </div>
      )}
      {auth.type === 'basic' && (
        <div style={rowStyle}>
          <Field label="Username">
            <input
              style={inputStyle}
              value={auth.username}
              onChange={(event) => props.onChange({ type: 'basic', username: event.target.value, password: clearPlaceholder(auth.password) })}
            />
          </Field>
          <Field label="Password">
            <input
              type="password"
              style={inputStyle}
              value={materialDisplay(auth.password).value}
              placeholder={materialDisplay(auth.password).placeholder}
              onChange={(event) => props.onChange({ type: 'basic', username: auth.username, password: event.target.value })}
            />
          </Field>
        </div>
      )}
      {auth.type === 'apikey' && (
        <>
          <div style={rowStyle}>
            <Field label="Key">
              <input
                style={inputStyle}
                value={auth.key}
                onChange={(event) => props.onChange({ ...auth, key: event.target.value, value: clearPlaceholder(auth.value) })}
              />
            </Field>
            <Field label="Value">
              <input
                type="password"
                style={inputStyle}
                value={materialDisplay(auth.value).value}
                placeholder={materialDisplay(auth.value).placeholder}
                onChange={(event) => props.onChange({ ...auth, value: event.target.value })}
              />
            </Field>
          </div>
          <div style={rowStyle}>
            <Field label="Add to">
              <select value={auth.in} onChange={(event) => props.onChange({ ...auth, in: event.target.value as 'header' | 'query' })} style={inputStyle}>
                <option value="header">Header</option>
                <option value="query">Query Params</option>
              </select>
            </Field>
            <span />
            <span />
          </div>
        </>
      )}
      {auth.type === 'inherit' && (
        <div style={{ color: colors.textSecondary, fontSize: font.size }}>
          Auth is resolved from the parent chain (folder → collection) at send time.
        </div>
      )}
      {auth.type === 'none' && (
        <div style={{ color: colors.textSecondary, fontSize: font.size }}>This request sends no authorization material.</div>
      )}
    </div>
  )
}
