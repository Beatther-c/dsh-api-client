/**
 * ImportReportView（§15.4 Migration Report）：
 * 汇总（requests/folders + full/partial/unsupported 计数）+ 逐条 findings
 * （itemPath / level / kind / message——message 出场前已经 host redactor）。
 */
import type { CSSProperties, ReactElement } from 'react'
import type { ImportFinding, ImportReport } from '@dsh-api-client/shared'
import { colors, font } from '../components/common/theme.ts'

export interface ImportReportViewProps {
  report: ImportReport
  onClose: () => void
}

const KIND_LABELS: Record<ImportFinding['kind'], string> = {
  'script-not-executed': 'script not executed',
  'dynamic-variable': 'dynamic variable',
  'auth-downgraded': 'auth downgraded',
  'field-dropped': 'field dropped',
}

const cellStyle: CSSProperties = {
  borderBottom: `1px solid ${colors.border}`,
  padding: '4px 8px',
  verticalAlign: 'top',
  fontSize: font.size,
}

export function ImportReportView(props: ImportReportViewProps): ReactElement {
  const report = props.report
  return (
    <div data-dsh-api-client="import-report" style={{ fontSize: font.size, color: colors.text }}>
      <div style={{ marginBottom: 10 }}>
        <strong>{report.sourceName}</strong>{' '}
        <span style={{ color: colors.textSecondary }}>({report.format})</span>
      </div>
      <div style={{ display: 'flex', gap: 16, marginBottom: 12, flexWrap: 'wrap' }}>
        <span>requests: <strong>{report.totals.requests}</strong></span>
        <span>folders: <strong>{report.totals.folders}</strong></span>
        <span style={{ color: colors.success }}>full: <strong>{report.full}</strong></span>
        <span style={{ color: colors.warning }}>partial: <strong>{report.partial}</strong></span>
        <span style={{ color: colors.danger }}>unsupported: <strong>{report.unsupported}</strong></span>
      </div>
      {report.createdCollectionId !== undefined && (
        <div style={{ marginBottom: 12, color: colors.textSecondary }}>
          Imported into collection <code>{report.createdCollectionId}</code> — see the collection tree.
        </div>
      )}
      {report.findings.length === 0 ? (
        <div style={{ color: colors.textSecondary }}>No findings — every item imported cleanly.</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ color: colors.textSecondary, textAlign: 'left' }}>
              <th style={cellStyle}>Item</th>
              <th style={{ ...cellStyle, width: 60 }}>Level</th>
              <th style={{ ...cellStyle, width: 150 }}>Kind</th>
              <th style={cellStyle}>Detail</th>
            </tr>
          </thead>
          <tbody>
            {report.findings.map((finding, index) => (
              <tr key={index}>
                <td style={{ ...cellStyle, fontFamily: font.mono }}>{finding.itemPath}</td>
                <td style={{ ...cellStyle, color: finding.level === 'warn' ? colors.warning : colors.textSecondary }}>{finding.level}</td>
                <td style={cellStyle}>{KIND_LABELS[finding.kind]}</td>
                <td style={cellStyle}>{finding.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div style={{ marginTop: 12, textAlign: 'right' }}>
        <button
          type="button"
          onClick={props.onClose}
          style={{
            background: colors.brand,
            color: colors.brandText,
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
            fontSize: font.size,
            padding: '4px 14px',
          }}
        >
          Done
        </button>
      </div>
    </div>
  )
}
