/**
 * HeadersEditor（§7.4）：CRUD / 启停 / 重复 Header 提示 / secret masking /
 * 自动 Content-Type·Accept 提示（core request/build 的 buildHeaders 语义投影——
 * 实际补头发生在 host 执行链，这里只展示将自动追加什么）。
 *
 * masking：命中 §24.6 默认敏感头（authorization/cookie/…）的行以 password 形态
 * 展示输入（core security/sensitive-headers 纯函数）。
 */
import type { ReactElement } from 'react'
import type { KeyValue } from '@dsh-api-client/shared'
import { buildHeaders, findHeader } from '../../../../packages/core/src/request/build.ts'
import { isSensitiveHeader } from '../../../../packages/core/src/security/sensitive-headers.ts'
import { colors, font } from '../common/theme.ts'
import { KeyValueTable } from '../common/KeyValueTable.tsx'

export interface HeadersEditorProps {
  rows: KeyValue[]
  onChange: (rows: KeyValue[]) => void
  /** body 形态隐含的 Content-Type（BodyEditor 计算后传入），用于自动补头提示。 */
  impliedContentType?: string
}

function warnDuplicate(row: KeyValue, index: number, rows: KeyValue[]): string | undefined {
  if (row.key === '') return undefined
  if (rows.some((other, otherIndex) => otherIndex !== index && other.key.toLowerCase() === row.key.toLowerCase())) {
    return `duplicate header "${row.key}" — all rows are kept and sent in order`
  }
  return undefined
}

export function HeadersEditor(props: HeadersEditorProps): ReactElement {
  const auto = buildHeaders([], props.impliedContentType).filter((header) => findHeader(props.rows.filter((r) => r.enabled), header.key) === undefined)
  return (
    <div data-dsh-api-client="headers-editor">
      <KeyValueTable
        rows={props.rows}
        onChange={props.onChange}
        keyPlaceholder="header"
        valuePlaceholder="value"
        withDescription
        maskValue={(row) => isSensitiveHeader(row.key)}
        warn={warnDuplicate}
        addLabel="+ Add header"
      />
      <div style={{ marginTop: 6, color: colors.textSecondary, fontSize: font.size }}>
        {auto.length === 0
          ? 'Content-Type / Accept explicitly set.'
          : (
            <>
              Auto-added at send time unless set above:{' '}
              {auto.map((header) => (
                <code key={header.key} style={{ fontFamily: font.mono, marginRight: 8 }}>
                  {header.key}: {header.value}
                </code>
              ))}
            </>
          )}
        {' '}Sensitive headers (Authorization, Cookie, …) are masked while typing.
      </div>
    </div>
  )
}
