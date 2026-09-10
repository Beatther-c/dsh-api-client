/**
 * ParamsEditor（§7.3 基线 + P0「Auth 自动参数」分组；实施设计 §5.6/§5.9、UX §6.2/§6.3）：
 * 上层 = 用户 params 表格（重复 Key / 空值提示、启停、URL 编码预览全部保留；
 * URL 双向同步由父视图用 core request/build 的 urlToParams / paramsToUrl 完成）；
 * 下层 = GeneratedQuerySection（canonical plan preview 的 query 投影——apikey in
 * query 的 Auth 自动参数，恒 '••••••••'，无 checkbox；冲突判定唯一来源 = plan）。
 *
 * preview 失败不阻断编辑（UX §9）：参数表格照常可编辑，自动参数区域显示中文失败原因。
 */
import type { ReactElement } from 'react'
import type { Collection, Environment, KeyValue } from '@dsh-api-client/shared'
import { serializeParams } from '../../../../packages/core/src/request/build.ts'
import type { RequestPlanDraft } from '../../hooks/useRequestPlanPreview.ts'
import { useRequestPlanPreview } from '../../hooks/useRequestPlanPreview.ts'
import { colors, font } from '../common/theme.ts'
import { KeyValueTable } from '../common/KeyValueTable.tsx'
import type { GeneratedNavigateTarget } from './GeneratedItemsSection.tsx'
import { GeneratedQuerySection } from './GeneratedItemsSection.tsx'

export interface ParamsEditorProps {
  /**
   * 编辑中的 request draft（preview 消费 method/url/params/headers/auth/body/
   * suppressedGeneratedHeaders——Query API Key 冲突判定需要 url + params + auth）。
   * 用户参数行 = draft.params。
   */
  draft: RequestPlanDraft
  /** 变量解析上下文（调用方传入；preview 模式不解析值、绝不触碰 secret）。 */
  environment?: Environment
  /** inherit auth 链 + collection 变量上下文（调用方传入）。 */
  collection?: Collection
  /** 用户参数行变化（原 onChange，改名以对齐 HeadersEditor 契约）。 */
  onRowsChange: (rows: KeyValue[]) => void
  /** 来源跳转：auth → 认证编辑区（WP8 接 editorTab）。 */
  onNavigate: (target: GeneratedNavigateTarget) => void
}

function warnDuplicateOrEmpty(row: KeyValue, index: number, rows: KeyValue[]): string | undefined {
  if (row.key === '') return undefined
  if (rows.some((other, otherIndex) => otherIndex !== index && other.key === row.key)) {
    return `重复参数「${row.key}」—— 全部保留并按顺序发送`
  }
  if (row.value === '') return '空值 —— 发送时形如 `key=`'
  return undefined
}

export function ParamsEditor(props: ParamsEditorProps): ReactElement {
  const plan = useRequestPlanPreview({
    draft: props.draft,
    ...(props.environment !== undefined ? { environment: props.environment } : {}),
    ...(props.collection !== undefined ? { collection: props.collection } : {}),
  })
  const preview = serializeParams(props.draft.params)
  return (
    <div data-dsh-api-client="params-editor">
      <KeyValueTable
        rows={props.draft.params}
        onChange={props.onRowsChange}
        keyPlaceholder="param"
        valuePlaceholder="value"
        withDescription
        warn={warnDuplicateOrEmpty}
        addLabel="+ 添加参数"
      />
      <div style={{ marginTop: 6, color: colors.textSecondary, fontSize: font.size }}>
        {preview === '' ? '无启用参数 —— URL 自带的 query 原样保留。' : (
          <>
            编码后 query 预览：<code style={{ fontFamily: font.mono }}>?{preview}</code>
          </>
        )}
        {' '}参数行与 URL query 自动双向同步。
      </div>
      {plan.error !== undefined ? (
        <div
          data-dsh-api-client="generated-items-error"
          role="alert"
          style={{ marginTop: 10, color: colors.danger, fontSize: font.size }}
        >
          {plan.error}（不影响继续编辑；发送时以 Host 的权威构建为准）
        </div>
      ) : plan.preview !== undefined ? (
        <GeneratedQuerySection items={plan.preview.query} onNavigate={props.onNavigate} />
      ) : null}
    </div>
  )
}
