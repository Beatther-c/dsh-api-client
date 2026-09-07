/**
 * BodyEditor（§7.6 V0.1 六种）：none / raw(Text) / json / form-data / urlencoded。
 * json 走 JsonEditor；form-data / urlencoded 走 KeyValueTable。
 * 切换类型时保留各形态的草稿（父视图持有 BodyConfig，本组件按类型渲染）。
 */
import type { CSSProperties, ReactElement } from 'react'
import type { BodyConfig } from '@dsh-api-client/shared'
import { colors, font } from '../common/theme.ts'
import { JsonEditor } from './JsonEditor.tsx'
import { KeyValueTable } from '../common/KeyValueTable.tsx'

export interface BodyEditorProps {
  value: BodyConfig
  onChange: (body: BodyConfig) => void
}

const BODY_TYPES: ReadonlyArray<{ value: BodyConfig['type']; label: string }> = [
  { value: 'none', label: 'none' },
  { value: 'raw', label: 'raw (Text)' },
  { value: 'json', label: 'JSON' },
  { value: 'form-data', label: 'form-data' },
  { value: 'urlencoded', label: 'x-www-form-urlencoded' },
]

const radioStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  marginRight: 12,
  cursor: 'pointer',
  fontSize: font.size,
  color: colors.text,
}

export function BodyEditor(props: BodyEditorProps): ReactElement {
  const body = props.value
  const switchType = (type: BodyConfig['type']): void => {
    switch (type) {
      case 'none':
        props.onChange({ type: 'none' })
        return
      case 'raw':
        props.onChange({ type: 'raw', raw: body.type === 'raw' ? body.raw : '' })
        return
      case 'json':
        props.onChange({ type: 'json', json: body.type === 'json' ? body.json : '' })
        return
      case 'form-data':
        props.onChange({ type: 'form-data', fields: body.type === 'form-data' ? body.fields : [] })
        return
      case 'urlencoded':
        props.onChange({ type: 'urlencoded', fields: body.type === 'urlencoded' ? body.fields : [] })
        return
    }
  }

  return (
    <div data-dsh-api-client="body-editor">
      <div style={{ marginBottom: 8 }}>
        {BODY_TYPES.map((option) => (
          <label key={option.value} style={radioStyle}>
            <input type="radio" checked={body.type === option.value} onChange={() => switchType(option.value)} />
            {option.label}
          </label>
        ))}
      </div>
      {body.type === 'none' && <div style={{ color: colors.textSecondary, fontSize: font.size }}>This request has no body.</div>}
      {body.type === 'raw' && (
        <textarea
          value={body.raw}
          onChange={(event) => props.onChange({ type: 'raw', raw: event.target.value })}
          placeholder="Raw text body (sent as text/plain)"
          spellCheck={false}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            minHeight: 120,
            resize: 'vertical',
            background: colors.bgLayer1,
            border: `1px solid ${colors.border}`,
            borderRadius: 4,
            color: colors.text,
            fontFamily: font.mono,
            fontSize: font.size,
            padding: 8,
            outline: 'none',
          }}
        />
      )}
      {body.type === 'json' && <JsonEditor value={body.json} onChange={(json) => props.onChange({ type: 'json', json })} />}
      {(body.type === 'form-data' || body.type === 'urlencoded') && (
        <KeyValueTable
          rows={body.fields}
          onChange={(fields) => props.onChange({ type: body.type, fields } as BodyConfig)}
          keyPlaceholder="field"
          valuePlaceholder="value"
          addLabel="+ Add field"
        />
      )}
    </div>
  )
}
