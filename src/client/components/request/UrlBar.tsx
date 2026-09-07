/**
 * UrlBar（§7.2）：URL 输入 + {{var}} 高亮 + Send + Save。
 *
 * 高亮实现：镜像层（着色 span，{{var}} 用 brand 色）衬在透明文字 input 之下，
 * 两层同字体同 padding，scrollLeft 同步。变量匹配复用 core variables/parser 的
 * TEMPLATE_PATTERN（纯函数）。
 */
import { useRef } from 'react'
import type { CSSProperties, ReactElement, ReactNode } from 'react'
import { TEMPLATE_PATTERN } from '../../../../packages/core/src/variables/parser.ts'
import { colors, font } from '../common/theme.ts'

export interface UrlBarProps {
  value: string
  onChange: (url: string) => void
  onSend: () => void
  onSave: () => void
  sending: boolean
  saveDisabled?: boolean
}

function highlight(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let index = 0
  for (const match of text.matchAll(TEMPLATE_PATTERN)) {
    const start = match.index ?? 0
    if (start > last) out.push(<span key={index++}>{text.slice(last, start)}</span>)
    out.push(
      <span key={index++} style={{ color: colors.brand, fontWeight: 600 }}>
        {match[0]}
      </span>,
    )
    last = start + match[0].length
  }
  if (last < text.length) out.push(<span key={index++}>{text.slice(last)}</span>)
  if (out.length === 0) out.push(<span key={0} />)
  return out
}

const sharedTextStyle: CSSProperties = {
  fontFamily: font.mono,
  fontSize: font.size,
  lineHeight: '18px',
  padding: '5px 8px',
  whiteSpace: 'pre',
  letterSpacing: 0,
}

export function UrlBar(props: UrlBarProps): ReactElement {
  const mirrorRef = useRef<HTMLDivElement | null>(null)
  return (
    <div data-dsh-api-client="url-bar" style={{ display: 'flex', gap: 6, flex: 1, alignItems: 'stretch' }}>
      <div
        style={{
          position: 'relative',
          flex: 1,
          background: colors.bgLayer1,
          border: `1px solid ${colors.borderStrong}`,
          borderRadius: 4,
          overflow: 'hidden',
        }}
      >
        <div
          ref={mirrorRef}
          aria-hidden
          style={{
            ...sharedTextStyle,
            position: 'absolute',
            inset: 0,
            color: colors.text,
            pointerEvents: 'none',
            overflow: 'hidden',
          }}
        >
          {highlight(props.value)}
          {/* trailing space keeps the mirror width ≥ input scroll width */}
          &nbsp;
        </div>
        <input
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
          onScroll={(event) => {
            if (mirrorRef.current !== null) mirrorRef.current.scrollLeft = event.currentTarget.scrollLeft
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') props.onSend()
          }}
          placeholder="https://api.example.com/users 或 {{base_url}}/users"
          spellCheck={false}
          style={{
            ...sharedTextStyle,
            position: 'relative',
            width: '100%',
            boxSizing: 'border-box',
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: 'transparent',
            caretColor: colors.text,
          }}
        />
      </div>
      <button
        type="button"
        onClick={props.onSend}
        disabled={props.sending}
        style={{
          background: colors.brand,
          color: colors.brandText,
          border: 'none',
          borderRadius: 4,
          cursor: props.sending ? 'default' : 'pointer',
          fontSize: font.size,
          fontWeight: 600,
          padding: '0 18px',
          opacity: props.sending ? 0.6 : 1,
        }}
      >
        {props.sending ? 'Sending…' : 'Send'}
      </button>
      <button
        type="button"
        onClick={props.onSave}
        disabled={props.saveDisabled === true}
        style={{
          background: 'transparent',
          color: colors.text,
          border: `1px solid ${colors.borderStrong}`,
          borderRadius: 4,
          cursor: 'pointer',
          fontSize: font.size,
          padding: '0 12px',
          opacity: props.saveDisabled === true ? 0.5 : 1,
        }}
      >
        Save
      </button>
    </div>
  )
}
