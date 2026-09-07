/**
 * BodyViewer（§8）：Pretty / Raw / Preview 三态；JSON/Text/HTML/XML。
 * Pretty 复用 core response/parse 的 prettyBody；Preview 仅对 html 用
 * sandbox iframe（无脚本权限），json 预览等同 Pretty。
 */
import { useMemo, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import type { HttpExecutionResult } from '@dsh-api-client/shared'
import { prettyBody } from '../../../../packages/core/src/response/parse.ts'
import { colors, font } from '../common/theme.ts'

export interface BodyViewerProps {
  bodyText: string
  bodyKind: HttpExecutionResult['bodyKind']
}

type Mode = 'pretty' | 'raw' | 'preview'

const MODES: readonly Mode[] = ['pretty', 'raw', 'preview']

const preStyle: CSSProperties = {
  margin: 0,
  padding: 10,
  overflow: 'auto',
  flex: 1,
  fontFamily: font.mono,
  fontSize: font.size,
  lineHeight: 1.5,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  color: colors.text,
}

export function BodyViewer(props: BodyViewerProps): ReactElement {
  const [mode, setMode] = useState<Mode>('pretty')
  const pretty = useMemo(() => prettyBody(props.bodyKind, props.bodyText), [props.bodyKind, props.bodyText])
  const canPreview = props.bodyKind === 'html'

  return (
    <div data-dsh-api-client="body-viewer" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', gap: 4, padding: '4px 0' }}>
        {MODES.map((candidate) => (
          <button
            key={candidate}
            type="button"
            disabled={candidate === 'preview' && !canPreview}
            title={candidate === 'preview' && !canPreview ? 'Preview is available for HTML responses' : undefined}
            onClick={() => setMode(candidate)}
            style={{
              background: mode === candidate ? colors.fill : 'transparent',
              border: `1px solid ${colors.borderStrong}`,
              borderRadius: 4,
              color: mode === candidate ? colors.text : colors.textSecondary,
              cursor: 'pointer',
              fontSize: font.size,
              padding: '2px 10px',
              opacity: candidate === 'preview' && !canPreview ? 0.4 : 1,
              textTransform: 'capitalize',
            }}
          >
            {candidate}
          </button>
        ))}
        <span style={{ marginLeft: 'auto', color: colors.textSecondary, fontSize: font.size, alignSelf: 'center' }}>
          {props.bodyKind}
        </span>
      </div>
      {mode === 'pretty' && <pre style={preStyle}>{pretty}</pre>}
      {mode === 'raw' && <pre style={preStyle}>{props.bodyText}</pre>}
      {mode === 'preview' && canPreview && (
        <iframe
          title="response preview"
          sandbox=""
          srcDoc={props.bodyText}
          style={{ flex: 1, border: `1px solid ${colors.border}`, borderRadius: 4, background: '#fff' }}
        />
      )}
    </div>
  )
}
