/**
 * Migration Report（V01 §3.3 report.ts；DESIGN_V1.1 §15.4 形态）。
 * 从管线产出的 ImportReport 生成人类可读摘要：
 * N Requests / N Folders / 完全兼容 / 部分兼容 / 无法转换 / 发现脚本清单。
 */
import type { ImportReport } from '@dsh-api-client/core'

export interface MigrationReportSummary {
  requests: number
  folders: number
  full: number
  partial: number
  unsupported: number
  /** 发现的脚本清单（kind = script-not-executed 的 findings，含所在 item 路径与 listen 类型）。 */
  scripts: { itemPath: string; listen: string }[]
  /** §15.4 文本形态（逐行）。 */
  lines: string[]
}

export function summarizeImportReport(report: ImportReport): MigrationReportSummary {
  const scripts = report.findings
    .filter((finding) => finding.kind === 'script-not-executed')
    .map((finding) => ({
      itemPath: finding.itemPath,
      listen: /^(\S+) script/.exec(finding.message)?.[1] ?? 'unknown',
    }))

  const lines = [
    '导入完成',
    '',
    `${report.totals.requests} Requests`,
    `${report.totals.folders} Folders`,
    `${report.full} 完全兼容`,
    `${report.partial} 部分兼容`,
    `${report.unsupported} 无法转换`,
  ]
  if (scripts.length > 0) {
    lines.push('', `发现：${scripts.length} 个 Postman Script（V0.1 不执行，仅保留原文）`)
    for (const script of scripts) lines.push(`- ${script.itemPath}: ${script.listen}`)
  }

  return {
    requests: report.totals.requests,
    folders: report.totals.folders,
    full: report.full,
    partial: report.partial,
    unsupported: report.unsupported,
    scripts,
    lines,
  }
}
