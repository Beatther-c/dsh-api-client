/**
 * ParamsEditor（§7.3）：重复 Key / 空值提示、启停、URL 编码预览；
 * URL 双向同步由父视图用 core request/build 的 urlToParams / paramsToUrl
 * 互逆纯函数完成（本组件是受控表格）。
 */
import type { ReactElement } from 'react'
import type { KeyValue } from '@dsh-api-client/shared'
import { serializeParams } from '../../../../packages/core/src/request/build.ts'
import { colors, font } from '../common/theme.ts'
import { KeyValueTable } from '../common/KeyValueTable.tsx'

export interface ParamsEditorProps {
  rows: KeyValue[]
  onChange: (rows: KeyValue[]) => void
}

function warnDuplicateOrEmpty(row: KeyValue, index: number, rows: KeyValue[]): string | undefined {
  if (row.key === '') return undefined
  if (rows.some((other, otherIndex) => otherIndex !== index && other.key === row.key)) {
    return `duplicate key "${row.key}" — all rows are kept and sent in order`
  }
  if (row.value === '') return 'empty value — sent as `key=`'
  return undefined
}

export function ParamsEditor(props: ParamsEditorProps): ReactElement {
  const preview = serializeParams(props.rows)
  return (
    <div data-dsh-api-client="params-editor">
      <KeyValueTable
        rows={props.rows}
        onChange={props.onChange}
        keyPlaceholder="param"
        valuePlaceholder="value"
        withDescription
        warn={warnDuplicateOrEmpty}
        addLabel="+ Add param"
      />
      <div style={{ marginTop: 6, color: colors.textSecondary, fontSize: font.size }}>
        {preview === '' ? 'No enabled params — the URL query is left untouched.' : (
          <>
            Encoded query preview: <code style={{ fontFamily: font.mono }}>?{preview}</code>
          </>
        )}
        {' '}Rows sync into the URL query and back automatically.
      </div>
    </div>
  )
}
