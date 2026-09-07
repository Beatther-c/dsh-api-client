/**
 * JsonEditor（§7.6）：format / compact / validate / error line / 只读高亮预览。
 * validate/format/compact 复用 core request/body 纯函数；语法高亮为内联
 * tokenizer 渲染的只读预览（编辑区保持 textarea，避免引入编辑器依赖）。
 */
import { useMemo, useState } from 'react'
import type { CSSProperties, ReactElement, ReactNode } from 'react'
import { jsonCompact, jsonFormat, jsonValidate } from '../../../../packages/core/src/request/body.ts'
import { toast } from '../common/Toast.tsx'
import { colors, font } from '../common/theme.ts'

export interface JsonEditorProps {
  value: string
  onChange: (text: string) => void
  placeholder?: string
}

const JSON_TOKEN_PATTERN = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(\btrue\b|\bfalse\b|\bnull\b)/g

function highlightJson(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let index = 0
  for (const match of text.matchAll(JSON_TOKEN_PATTERN)) {
    const start = match.index ?? 0
    if (start > last) out.push(<span key={index++}>{text.slice(last, start)}</span>)
    const [whole, stringToken, colon, numberToken, literalToken] = match
    let color: string = colors.text
    if (stringToken !== undefined) color = colon !== undefined ? '#8250df' : '#1a7f37'
    else if (numberToken !== undefined) color = '#0969da'
    else if (literalToken !== undefined) color = '#c26a00'
    out.push(
      <span key={index++} style={{ color }}>
        {whole}
      </span>,
    )
    last = start + whole.length
  }
  if (last < text.length) out.push(<span key={index++}>{text.slice(last)}</span>)
  return out
}

const toolButtonStyle: CSSProperties = {
  background: 'transparent',
  border: `1px solid ${colors.borderStrong}`,
  borderRadius: 4,
  color: colors.textSecondary,
  cursor: 'pointer',
  fontSize: font.size,
  padding: '2px 8px',
}

export function JsonEditor(props: JsonEditorProps): ReactElement {
  const [showPreview, setShowPreview] = useState(false)
  const validation = useMemo(() => (props.value.trim() === '' ? undefined : jsonValidate(props.value)), [props.value])

  const applyTransform = (transform: (text: string) => string, label: string): void => {
    try {
      props.onChange(transform(props.value))
    } catch (error) {
      toast.error(`${label} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return (
    <div data-dsh-api-client="json-editor">
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
        <button type="button" style={toolButtonStyle} onClick={() => applyTransform((t) => jsonFormat(t), 'Format')}>
          Format
        </button>
        <button type="button" style={toolButtonStyle} onClick={() => applyTransform((t) => jsonCompact(t), 'Compact')}>
          Compact
        </button>
        <button type="button" style={toolButtonStyle} onClick={() => setShowPreview((v) => !v)}>
          {showPreview ? 'Hide highlight' : 'Highlight'}
        </button>
        {validation !== undefined && (
          <span style={{ fontSize: font.size, color: validation.ok ? colors.success : colors.danger }}>
            {validation.ok ? '✓ valid JSON' : `✗ line ${validation.line ?? '?'}: ${validation.message}`}
          </span>
        )}
      </div>
      <textarea
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        placeholder={props.placeholder ?? '{ "key": "value" }'}
        spellCheck={false}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          minHeight: 140,
          resize: 'vertical',
          background: colors.bgLayer1,
          border: `1px solid ${validation !== undefined && !validation.ok ? colors.danger : colors.border}`,
          borderRadius: 4,
          color: colors.text,
          fontFamily: font.mono,
          fontSize: font.size,
          lineHeight: 1.5,
          padding: 8,
          outline: 'none',
        }}
      />
      {showPreview && props.value !== '' && (
        <pre
          style={{
            margin: '6px 0 0',
            padding: 8,
            maxHeight: 240,
            overflow: 'auto',
            background: colors.bgLayer2,
            borderRadius: 4,
            fontFamily: font.mono,
            fontSize: font.size,
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >
          {highlightJson(props.value)}
        </pre>
      )}
    </div>
  )
}
