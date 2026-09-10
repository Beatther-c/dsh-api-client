/**
 * HeadersEditor（P0 两层展示；实施设计 §5.9、UX §6.2/§6.3/§9）：
 *
 * 上层 = 用户 Header KeyValueTable（启停 / 重复告警 / 敏感遮罩全部保留，§7.4 基线）；
 * 下层 = GeneratedHeadersSection（canonical buildRequestPlan preview 的只读投影，
 * 经 useRequestPlanPreview 消费）。自动项算法唯一来源 = core plan——本组件不再
 * import buildHeaders/findHeader 深路径推导「将自动追加什么」，也不再接收
 * impliedContentType prop（Body → Content-Type 贡献由 plan preview 给出）。
 *
 * preview 失败不阻断编辑（UX §9）：用户表格照常可编辑，自动项区域显示中文失败原因。
 * 敏感行 valuePreview 恒 '••••••••'，真实值绝不进 DOM/aria/title（红线 3）。
 */
import type { ReactElement } from 'react'
import type { Collection, Environment, KeyValue, SuppressedGeneratedHeader } from '@dsh-api-client/shared'
import { isSensitiveHeader } from '../../../../packages/core/src/security/sensitive-headers.ts'
import type { RequestPlanDraft } from '../../hooks/useRequestPlanPreview.ts'
import { useRequestPlanPreview } from '../../hooks/useRequestPlanPreview.ts'
import { colors, font } from '../common/theme.ts'
import { KeyValueTable } from '../common/KeyValueTable.tsx'
import type { GeneratedNavigateTarget } from './GeneratedItemsSection.tsx'
import { GeneratedHeadersSection } from './GeneratedItemsSection.tsx'

export interface HeadersEditorProps {
  /**
   * 编辑中的 request draft（preview 消费 method/url/params/headers/auth/body/
   * suppressedGeneratedHeaders；ApiClientView 的 ApiRequest draft 结构化满足）。
   * 用户 Header 行 = draft.headers。
   */
  draft: RequestPlanDraft
  /** 变量解析上下文（调用方传入；preview 模式不解析值、绝不触碰 secret）。 */
  environment?: Environment
  /** inherit auth 链 + collection 变量上下文（调用方传入）。 */
  collection?: Collection
  /** 用户 Header 行变化（原 onChange，改名以区别 suppression 回调）。 */
  onRowsChange: (rows: KeyValue[]) => void
  /** suppression 清单变化（本组件产出 §3.3 规范化数组；调用方写回 draft 并经 Host 持久化）。 */
  onSuppressedChange: (next: SuppressedGeneratedHeader[]) => void
  /** 来源跳转：body → Body 编辑区、auth → 认证编辑区（WP8 接 editorTab）。 */
  onNavigate: (target: GeneratedNavigateTarget) => void
}

function warnDuplicate(row: KeyValue, index: number, rows: KeyValue[]): string | undefined {
  if (row.key === '') return undefined
  if (rows.some((other, otherIndex) => otherIndex !== index && other.key.toLowerCase() === row.key.toLowerCase())) {
    return `重复 Header「${row.key}」—— 全部保留并按用户顺序发送`
  }
  return undefined
}

export function HeadersEditor(props: HeadersEditorProps): ReactElement {
  const plan = useRequestPlanPreview({
    draft: props.draft,
    ...(props.environment !== undefined ? { environment: props.environment } : {}),
    ...(props.collection !== undefined ? { collection: props.collection } : {}),
  })
  return (
    <div data-dsh-api-client="headers-editor">
      <KeyValueTable
        rows={props.draft.headers}
        onChange={props.onRowsChange}
        keyPlaceholder="header"
        valuePlaceholder="value"
        withDescription
        maskValue={(row) => isSensitiveHeader(row.key)}
        warn={warnDuplicate}
        addLabel="+ 添加 Header"
      />
      <div style={{ marginTop: 6, color: colors.textSecondary, fontSize: font.size }}>
        敏感 Header（Authorization、Cookie 等）在输入时以掩码显示。
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
        <GeneratedHeadersSection
          preview={plan.preview}
          suppressed={props.draft.suppressedGeneratedHeaders ?? []}
          onSuppressedChange={props.onSuppressedChange}
          onNavigate={props.onNavigate}
        />
      ) : null}
    </div>
  )
}
