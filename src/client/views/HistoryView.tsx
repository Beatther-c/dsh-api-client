/**
 * HistoryView（§10）：脱敏快照列表 + 单条详情 + 「重新执行」。
 *
 * - 列表项：method（语义色）/ displayUrl / source 徽标 human/agent(/runner) / 时间；
 * - 详情：request/response 双快照（均 host 侧脱敏，敏感头/secret 只出现
 *   `<redacted>` / `<secret-ref:key>`）；
 * - 「重新执行」走 requestId 链（POST /api-client/execute { requestId }）——
 *   host 侧沿 SecretRef 解析，client 永不回读 secret（AC-32）；无 requestId 的
 *   条目（未关联已保存请求）不可重放，按钮 disabled 并注明原因。
 */
import { useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import type { ExecutionHistory } from '@dsh-api-client/shared'
import { useHistory } from '../hooks/useHistory.ts'
import { useExecute } from '../hooks/useExecute.ts'
import { toast } from '../components/common/Toast.tsx'
import { colors, font } from '../components/common/theme.ts'
import { methodColor } from '../components/common/method.ts'

export interface HistoryViewProps {
  onBack: () => void
  /** 重新执行时显式传入的当前环境（§5.2：逐次显式，无全局 switch）。 */
  activeEnvironmentId?: string | undefined
}

const SOURCE_BADGES: Record<ExecutionHistory['source'], { label: string; color: string }> = {
  human: { label: 'Human', color: '#0969da' },
  agent: { label: 'Agent', color: '#8250df' },
  runner: { label: 'Runner', color: '#6e7781' },
}

const preStyle: CSSProperties = {
  margin: '4px 0 12px',
  padding: 8,
  background: colors.bgLayer1,
  border: `1px solid ${colors.border}`,
  borderRadius: 4,
  fontFamily: font.mono,
  fontSize: font.size,
  lineHeight: 1.6,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  maxHeight: 200,
  overflow: 'auto',
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function DetailSection(props: { title: string; children: React.ReactNode }): ReactElement {
  return (
    <section>
      <div style={{ color: colors.textSecondary, fontSize: font.size, marginBottom: 2 }}>{props.title}</div>
      {props.children}
    </section>
  )
}

export function HistoryView(props: HistoryViewProps): ReactElement {
  const history = useHistory()
  const [selectedId, setSelectedId] = useState<string | undefined>()
  const execute = useExecute(() => history.refresh())
  const selected = history.entries.find((entry) => entry.id === selectedId)

  const rerun = async (entry: ExecutionHistory): Promise<void> => {
    if (entry.requestId === undefined) return
    const response = await execute.execute({
      requestId: entry.requestId,
      ...(props.activeEnvironmentId !== undefined ? { environment: props.activeEnvironmentId } : {}),
    })
    if (response !== undefined) toast.info(`Re-executed: ${response.result.status} ${response.result.statusText}`)
  }

  return (
    <div data-dsh-api-client="history-view" style={{ display: 'flex', flexDirection: 'column', height: '100%', fontSize: font.size, color: colors.text }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: `1px solid ${colors.border}` }}>
        <button type="button" onClick={props.onBack} style={navButtonStyle}>
          ← Back
        </button>
        <strong>History</strong>
        <span style={{ color: colors.textSecondary }}>redacted snapshots only</span>
        <button
          type="button"
          onClick={() => {
            if (globalThis.confirm?.('Clear all history for this profile?') === true) void history.clear()
          }}
          style={{ ...navButtonStyle, marginLeft: 'auto', color: colors.danger }}
        >
          Clear
        </button>
      </div>
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div style={{ flex: '0 0 320px', overflow: 'auto', borderRight: `1px solid ${colors.border}` }}>
          {history.loading && <div style={{ padding: 12, color: colors.textSecondary }}>Loading…</div>}
          {!history.loading && history.entries.length === 0 && (
            <div style={{ padding: 12, color: colors.textSecondary }}>No history yet.</div>
          )}
          {history.entries.map((entry) => {
            const badge = SOURCE_BADGES[entry.source]
            return (
              <div
                key={entry.id}
                onClick={() => setSelectedId(entry.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 10px',
                  cursor: 'pointer',
                  background: entry.id === selectedId ? colors.fill : 'transparent',
                  borderBottom: `1px solid ${colors.border}`,
                }}
              >
                <span style={{ color: colors.textSecondary, fontFamily: font.mono, fontSize: 11 }}>{formatTime(entry.timestamp)}</span>
                <span style={{ fontFamily: font.mono, fontSize: 11, fontWeight: 700, color: methodColor(entry.method), minWidth: 42 }}>
                  {entry.method}
                </span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={entry.displayUrl}>
                  {entry.displayUrl}
                </span>
                <span
                  style={{
                    fontSize: 10,
                    padding: '1px 6px',
                    borderRadius: 8,
                    border: `1px solid ${badge.color}`,
                    color: badge.color,
                  }}
                >
                  {badge.label}
                </span>
              </div>
            )
          })}
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: 14 }}>
          {selected === undefined && <div style={{ color: colors.textSecondary }}>Select an entry to inspect the redacted snapshot.</div>}
          {selected !== undefined && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span style={{ fontFamily: font.mono, fontWeight: 700, color: methodColor(selected.method) }}>{selected.method}</span>
                <span style={{ fontFamily: font.mono }}>{selected.displayUrl}</span>
                <button
                  type="button"
                  disabled={selected.requestId === undefined || execute.executing}
                  title={
                    selected.requestId === undefined
                      ? '此条目未关联已保存请求，无法经 SecretRef 链重放'
                      : '经 requestId + SecretRef 链重新执行（不回读任何 secret）'
                  }
                  onClick={() => void rerun(selected)}
                  style={{ ...navButtonStyle, marginLeft: 'auto', opacity: selected.requestId === undefined ? 0.5 : 1 }}
                >
                  {execute.executing ? 'Executing…' : '重新执行'}
                </button>
                {selected.requestId === undefined && (
                  // disabled 按钮不触发 mouse 事件，title 提示在主流浏览器不可见——
                  // 禁用原因必须内联可见（sweep 遗留 #2：按钮可点但静默空转）。
                  <span style={{ color: colors.textSecondary, fontSize: 11 }}>未关联已保存请求，不可重放</span>
                )}
              </div>
              <DetailSection title={`Response — ${selected.responseSnapshot.status} ${selected.responseSnapshot.statusText} · ${selected.responseSnapshot.durationMs} ms · ${selected.responseSnapshot.size} B`}>
                {selected.responseSnapshot.bodyPreview !== undefined && <pre style={preStyle}>{selected.responseSnapshot.bodyPreview}</pre>}
                <pre style={preStyle}>{selected.responseSnapshot.headers.map((h) => `${h.key}: ${h.value}`).join('\n') || '(no headers)'}</pre>
              </DetailSection>
              <DetailSection title={`Request — auth: ${selected.requestSnapshot.auth.type}`}>
                <pre style={preStyle}>{selected.requestSnapshot.headers.map((h) => `${h.key}: ${h.value}`).join('\n') || '(no headers)'}</pre>
                {selected.requestSnapshot.bodyPreview !== undefined && <pre style={preStyle}>{selected.requestSnapshot.bodyPreview}</pre>}
              </DetailSection>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

const navButtonStyle: CSSProperties = {
  background: 'transparent',
  border: `1px solid ${colors.borderStrong}`,
  borderRadius: 4,
  color: colors.text,
  cursor: 'pointer',
  fontSize: font.size,
  padding: '3px 10px',
}
