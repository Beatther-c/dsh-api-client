/**
 * ResponseViewer（§8）：Status/Latency/Size 摘要行 + Body/Headers/Cookies/Tests
 * 五个 tab。Tests tab 仅展示导入脚本警告（D15：V0.1 不执行脚本）。
 * 「交给 Agent」按钮由 WP7 接线：onSendToAgent 由视图注入（Safe context →
 * 确认弹窗 → session-bridge 链路在 ApiClientView 侧编排）。
 */
import { useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import type { HttpExecutionResult, ScriptConfig } from '@dsh-api-client/shared'
import { colors, font } from '../common/theme.ts'
import { BodyViewer } from './BodyViewer.tsx'

export interface ResponseViewerProps {
  result: HttpExecutionResult | undefined
  executing: boolean
  /** 当前请求的导入脚本（Tests tab 警告数据源）。 */
  scripts?: ScriptConfig | undefined
  /** 「交给 Agent」入口（WP7 §5.3）；未装配时不渲染按钮。 */
  onSendToAgent?: (() => void) | undefined
}

type ResponseTab = 'body' | 'headers' | 'cookies' | 'tests'

const TABS: ReadonlyArray<{ value: ResponseTab; label: string }> = [
  { value: 'body', label: 'Body' },
  { value: 'headers', label: 'Headers' },
  { value: 'cookies', label: 'Cookies' },
  { value: 'tests', label: 'Tests' },
]

function statusColor(status: number): string {
  if (status >= 200 && status < 300) return colors.success
  if (status >= 400) return colors.danger
  return colors.warning
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(2)} MB`
}

const kvPreStyle: CSSProperties = {
  margin: 0,
  padding: 10,
  overflow: 'auto',
  flex: 1,
  fontFamily: font.mono,
  fontSize: font.size,
  lineHeight: 1.6,
  color: colors.text,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
}

export function ResponseViewer(props: ResponseViewerProps): ReactElement {
  const [tab, setTab] = useState<ResponseTab>('body')
  const result = props.result

  return (
    <div data-dsh-api-client="response-viewer" style={{ display: 'flex', flexDirection: 'column', height: '100%', borderTop: `1px solid ${colors.border}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 10px', fontSize: font.size }}>
        <span style={{ color: colors.textSecondary }}>Response</span>
        {result !== undefined && (
          <>
            <span style={{ fontWeight: 700, color: statusColor(result.status) }}>
              {result.status} {result.statusText}
            </span>
            <span style={{ color: colors.textSecondary }}>{result.durationMs} ms</span>
            <span style={{ color: colors.textSecondary }}>{formatSize(result.size)}</span>
            {result.redirected && <span style={{ color: colors.warning }}>redirected</span>}
          </>
        )}
        {props.executing && <span style={{ color: colors.textSecondary }}>Executing…</span>}
        {props.onSendToAgent !== undefined && (
          <button
            type="button"
            title="交给 Agent：Safe context → 出域确认 → 新 Session 预填（WP7 §5.3）"
            onClick={props.onSendToAgent}
            style={{
              marginLeft: 'auto',
              background: 'transparent',
              border: `1px solid ${colors.borderStrong}`,
              borderRadius: 4,
              color: colors.text,
              fontSize: font.size,
              padding: '2px 10px',
              cursor: 'pointer',
            }}
          >
            交给 Agent
          </button>
        )}
      </div>
      {result === undefined && !props.executing && (
        <div style={{ padding: 16, color: colors.textSecondary, fontSize: font.size }}>Send a request to see the response here.</div>
      )}
      {result !== undefined && (
        <>
          <div style={{ display: 'flex', gap: 2, padding: '0 10px', borderBottom: `1px solid ${colors.border}` }}>
            {TABS.map((candidate) => (
              <button
                key={candidate.value}
                type="button"
                onClick={() => setTab(candidate.value)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  borderBottom: tab === candidate.value ? `2px solid ${colors.brand}` : '2px solid transparent',
                  color: tab === candidate.value ? colors.text : colors.textSecondary,
                  cursor: 'pointer',
                  fontSize: font.size,
                  padding: '4px 8px',
                }}
              >
                {candidate.label}
                {candidate.value === 'headers' && ` (${result.headers.length})`}
                {candidate.value === 'cookies' && ` (${result.cookies.length})`}
              </button>
            ))}
          </div>
          <div style={{ flex: 1, display: 'flex', minHeight: 0, padding: tab === 'body' ? '4px 10px 10px' : 0 }}>
            {tab === 'body' && <BodyViewer bodyText={result.bodyText} bodyKind={result.bodyKind} />}
            {tab === 'headers' && (
              <pre style={kvPreStyle}>
                {result.headers.map((header) => `${header.key}: ${header.value}`).join('\n') || '(no headers)'}
              </pre>
            )}
            {tab === 'cookies' && (
              <pre style={kvPreStyle}>
                {result.cookies.map((cookie) => `${cookie.key}: ${cookie.value}`).join('\n') || '(no cookies)'}
              </pre>
            )}
            {tab === 'tests' && (
              <div style={{ padding: 12, fontSize: font.size }}>
                <div style={{ padding: '6px 10px', border: `1px solid ${colors.warning}`, borderRadius: 4, color: colors.warning }}>
                  ⚠ {props.scripts?.warning ?? 'V0.1 不执行脚本（D15）：导入的 Tests 脚本仅展示，不会运行，无断言结果。'}
                </div>
                {props.scripts?.tests !== undefined && props.scripts.tests !== '' && (
                  <pre style={{ ...kvPreStyle, padding: '10px 0' }}>{props.scripts.tests}</pre>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
