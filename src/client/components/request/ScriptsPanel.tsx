/**
 * ScriptsPanel（D15）：只读展示导入的 Postman 脚本 + 「V0.1 不执行脚本」标准警告。
 * 不做任何执行/sandbox（警告文案来自 host 侧 ScriptConfig.warning，与导入管线一致）。
 */
import type { CSSProperties, ReactElement } from 'react'
import type { ScriptConfig } from '@dsh-api-client/shared'
import { colors, font } from '../common/theme.ts'

export interface ScriptsPanelProps {
  scripts: ScriptConfig | undefined
}

const preStyle: CSSProperties = {
  margin: '6px 0 12px',
  padding: 8,
  maxHeight: 220,
  overflow: 'auto',
  background: colors.bgLayer1,
  border: `1px solid ${colors.border}`,
  borderRadius: 4,
  fontFamily: font.mono,
  fontSize: font.size,
  lineHeight: 1.5,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
}

export function ScriptsPanel(props: ScriptsPanelProps): ReactElement {
  const scripts = props.scripts
  return (
    <div data-dsh-api-client="scripts-panel" style={{ fontSize: font.size }}>
      <div
        style={{
          padding: '6px 10px',
          marginBottom: 8,
          border: `1px solid ${colors.warning}`,
          borderRadius: 4,
          color: colors.warning,
        }}
      >
        ⚠ {scripts?.warning ?? 'V0.1 不执行脚本（D15）：脚本仅展示，不会在请求前后运行。'}
      </div>
      {scripts === undefined && <div style={{ color: colors.textSecondary }}>No scripts on this request.</div>}
      {scripts?.preRequest !== undefined && scripts.preRequest !== '' && (
        <>
          <div style={{ color: colors.textSecondary }}>Pre-request script (read-only, source: {scripts.source})</div>
          <pre style={preStyle}>{scripts.preRequest}</pre>
        </>
      )}
      {scripts?.tests !== undefined && scripts.tests !== '' && (
        <>
          <div style={{ color: colors.textSecondary }}>Tests script (read-only, source: {scripts.source})</div>
          <pre style={preStyle}>{scripts.tests}</pre>
        </>
      )}
    </div>
  )
}
