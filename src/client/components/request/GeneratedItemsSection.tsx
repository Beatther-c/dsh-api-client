/**
 * GeneratedItemsSection（P0 WP7；实施设计 §5.9/§4.1.2、UX §6.2–§6.4）：
 * canonical buildRequestPlan preview 的只读渲染层——Headers 页「自动生成」组与
 * Params 页「Auth 自动参数」组共用本文件的折叠外壳与行渲染。
 *
 * 纪律（全部消费 plan 输出，绝不重新实现合并/优先级算法）：
 * - 行内容 = name / valuePreview / 来源标签 / 状态；敏感项 valuePreview 恒
 *   '••••••••'（plan 已保证），真实值绝不出现在 DOM 文本/aria-label/title/
 *   tooltip（PROJECT.md 红线 3）——本组件对 valuePreview 不做任何二次加工，
 *   也不把它写进任何属性；
 * - suppression checkbox 仅 suppressible 行（body/client-default，§5.8）；
 *   auth 行给「前往认证设置」式跳转说明，runtime 行只读说明，均无 checkbox；
 * - 勾选变化回调产出规范化数组：读取侧宽容（sanitizeSuppressedGeneratedHeaders
 *   与写入侧 normalize 同产出但不抛错——client 对脏输入静默规范化，不抛异常）；
 * - 来源点击：body → onNavigate('body')、auth → onNavigate('auth')；
 *   client-default/runtime 只显示说明，不伪装成可编辑链接（UX §6.2）；
 * - Query 组（§5.6）：行恒 '••••••••'，status 仅 active/「被用户参数覆盖」，
 *   无 checkbox；无 Auth Query 贡献时整组不渲染；
 * - 默认折叠（§5.9）；标题「自动生成 N 项」+ 拆分计数「发送前 N 项 · 运行时 M 项」。
 *
 * 表格视觉沿用 common/KeyValueTable 的单元格风格（KeyValueTable 的契约是
 * 可编辑 KeyValue 行 + onChange，无法承载只读的来源/状态/checkbox 列，故此处
 * 按同一 style token 自绘只读表格，不修改共享组件）。
 */
import type { CSSProperties, ReactElement } from 'react'
import { useState } from 'react'
import type {
  GeneratedHeaderPreview,
  GeneratedItemSource,
  GeneratedItemStatus,
  GeneratedQueryPreview,
  RequestPlanPreview,
  SuppressedGeneratedHeader,
  SuppressibleGeneratedHeaderSource,
} from '@dsh-api-client/shared'
import { sanitizeSuppressedGeneratedHeaders } from '../../../../packages/core/src/request/plan.ts'
import { colors, font } from '../common/theme.ts'

/** 来源跳转目标：body → Body 编辑区、auth → 认证编辑区（§5.9 点击语义）。 */
export type GeneratedNavigateTarget = 'body' | 'auth'

export const GENERATED_SOURCE_LABELS: Readonly<Record<GeneratedItemSource, string>> = {
  body: '来自 Body',
  auth: '来自 Auth',
  'client-default': '来自客户端默认值',
  runtime: '来自运行时',
}

/** Generated Header 状态中文文案（§5.9「状态可见」+ UX §6.3 无效覆盖标注）。 */
export const GENERATED_HEADER_STATUS_LABELS: Readonly<Record<GeneratedItemStatus, string>> = {
  active: '启用',
  suppressed: '已停用',
  overridden: '被用户值覆盖',
  'runtime-pending': '发送时计算',
  'invalid-user-override': '用户覆盖无效',
}

/** Query API Key 状态中文文案（UX §6.3：「被用户参数覆盖」）。 */
export const GENERATED_QUERY_STATUS_LABELS: Readonly<Record<GeneratedQueryPreview['status'], string>> = {
  active: '启用',
  overridden: '被用户参数覆盖',
}

/** 状态补充说明（title 提示；不含任何值材料——红线 3）。 */
const STATUS_TITLES: Readonly<Partial<Record<GeneratedItemStatus, string>>> = {
  suppressed: '已停用：发送时不会追加；以后即使删除同名用户 Header，本停用记录仍继续生效',
  overridden: '存在启用的同名用户 Header，发送时以用户值优先，本自动项不追加',
  'invalid-user-override': '该运行时项由网络栈最终决定，用户同名 Header 无法覆盖；保留同名用户 Header 将在发送前得到清晰错误',
}

/** 来源补充说明（client-default = 停用说明；runtime = 只读说明，§5.8/UX §6.2）。 */
const SOURCE_TITLES: Readonly<Record<GeneratedItemSource, string>> = {
  body: '前往 Body 编辑区修改；或在下方取消勾选停用本自动项',
  auth: 'Auth 生成项不能在此停用，请前往认证设置修改或关闭认证',
  'client-default': '客户端默认值：取消勾选即可停用，不提供编辑跳转',
  runtime: '由网络运行时在发送时自动计算，只读、不可停用；如需覆盖请按运行时能力添加同名用户 Header',
}

// ---- 样式（沿用 KeyValueTable/theme token 的视觉语言）----

const sectionStyle: CSSProperties = {
  marginTop: 10,
  paddingTop: 6,
  borderTop: `1px solid ${colors.border}`,
  fontSize: font.size,
}

const toggleStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'baseline',
  gap: 6,
  background: 'transparent',
  border: 'none',
  color: colors.textSecondary,
  cursor: 'pointer',
  fontSize: font.size,
  padding: '2px 0',
}

const countStyle: CSSProperties = { color: colors.textSecondary, fontWeight: 'normal' }

const tableStyle: CSSProperties = { width: '100%', borderCollapse: 'collapse', marginTop: 4 }

const cellStyle: CSSProperties = {
  borderBottom: `1px solid ${colors.border}`,
  padding: '4px 6px',
  textAlign: 'left',
  verticalAlign: 'middle',
}

const headStyle: CSSProperties = { ...cellStyle, color: colors.textSecondary }

const nameStyle: CSSProperties = { fontFamily: font.mono }

const linkStyle: CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: colors.brand,
  cursor: 'pointer',
  fontSize: 'inherit',
  padding: 0,
  textDecoration: 'underline',
}

function statusColor(status: GeneratedItemStatus): string | undefined {
  if (status === 'invalid-user-override') return colors.danger
  if (status === 'suppressed' || status === 'overridden') return colors.textSecondary
  return undefined
}

// ---- suppression 切换（normalize 语义、client 侧永不抛错）----

/** plan §5.8 保证 suppressible ⇒ source ∈ {body, client-default}；防御性窄化，非法组合不渲染 checkbox。 */
function suppressibleSource(item: GeneratedHeaderPreview): SuppressibleGeneratedHeaderSource | undefined {
  if (!item.suppressible) return undefined
  if (item.source === 'body' || item.source === 'client-default') return item.source
  return undefined
}

/**
 * 勾选变化 → 规范化数组（§3.3 写入形态：name trim+lowercase、source 仅
 * body/client-default、(name, source) 去重）。读取侧先用 sanitize 宽容清理
 * 脏存量（与 normalize 对合法输入同产出，但静默丢弃非法条目而不抛错）。
 */
function nextSuppression(
  current: readonly unknown[],
  name: string,
  source: SuppressibleGeneratedHeaderSource,
  suppressed: boolean,
): SuppressedGeneratedHeader[] {
  const normalized = sanitizeSuppressedGeneratedHeaders(current)
  const lower = name.trim().toLowerCase()
  const rest = normalized.filter((entry) => !(entry.name === lower && entry.source === source))
  return suppressed ? [...rest, { name: lower, source }] : rest
}

// ---- 行渲染 ----

function SourceCell(props: {
  source: GeneratedItemSource
  onNavigate: (target: GeneratedNavigateTarget) => void
}): ReactElement {
  const label = GENERATED_SOURCE_LABELS[props.source]
  if (props.source === 'body' || props.source === 'auth') {
    const target: GeneratedNavigateTarget = props.source
    return (
      <button
        type="button"
        data-dsh-api-client="generated-source-link"
        data-target={target}
        onClick={() => props.onNavigate(target)}
        style={linkStyle}
        title={SOURCE_TITLES[props.source]}
      >
        {label}
      </button>
    )
  }
  // client-default 显示停用说明、runtime 只显示说明——均不可点击跳转（§5.9）。
  return <span title={SOURCE_TITLES[props.source]}>{label}</span>
}

export interface GeneratedHeadersSectionProps {
  /** canonical plan 的安全投影（唯一算法来源；本组件只读渲染）。 */
  preview: RequestPlanPreview
  /** 当前 draft 的 suppression 清单（读取侧宽容：脏条目静默规范化）。 */
  suppressed?: readonly unknown[]
  /** 勾选变化回调：产出 §3.3 规范化数组，由调用方写回 draft 并经 Host 持久化。 */
  onSuppressedChange: (next: SuppressedGeneratedHeader[]) => void
  onNavigate: (target: GeneratedNavigateTarget) => void
}

/** Headers 页下层：自动生成 Header 组（默认折叠，§5.9）。 */
export function GeneratedHeadersSection(props: GeneratedHeadersSectionProps): ReactElement {
  const [expanded, setExpanded] = useState(false)
  const { preview } = props
  const total = preview.preSendHeaderCount + preview.runtimeHeaderCount
  return (
    <div data-dsh-api-client="generated-headers-section" style={sectionStyle}>
      <button
        type="button"
        data-dsh-api-client="generated-items-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        style={toggleStyle}
      >
        <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        <span data-dsh-api-client="generated-items-title">自动生成 {total} 项</span>
        <span style={countStyle} data-dsh-api-client="generated-items-counts">
          发送前 {preview.preSendHeaderCount} 项 · 运行时 {preview.runtimeHeaderCount} 项
        </span>
      </button>
      {expanded && (
        <table data-dsh-api-client="generated-headers-table" style={tableStyle}>
          <thead>
            <tr>
              <th style={{ ...headStyle, width: 28 }} />
              <th style={headStyle}>名称</th>
              <th style={headStyle}>预览值</th>
              <th style={headStyle}>来源</th>
              <th style={headStyle}>状态</th>
            </tr>
          </thead>
          <tbody>
            {preview.headers.map((item) => {
              const source = suppressibleSource(item)
              return (
                <tr
                  key={`${item.source}\u0000${item.name}`}
                  data-dsh-api-client="generated-header-row"
                  data-name={item.name.toLowerCase()}
                  data-source={item.source}
                  data-status={item.status}
                  style={{ opacity: item.status === 'suppressed' ? 0.55 : 1 }}
                >
                  <td style={{ ...cellStyle, textAlign: 'center' }}>
                    {source !== undefined && (
                      <input
                        type="checkbox"
                        checked={item.status === 'suppressed'}
                        onChange={(event) =>
                          props.onSuppressedChange(
                            nextSuppression(props.suppressed ?? [], item.name, source, event.target.checked),
                          )
                        }
                        aria-label={`停用自动生成的 Header ${item.name}（${GENERATED_SOURCE_LABELS[item.source]}）`}
                      />
                    )}
                  </td>
                  <td style={{ ...cellStyle, ...nameStyle }} data-cell="name">
                    {item.name}
                  </td>
                  {/* 敏感项 valuePreview 恒 '••••••••'（plan 保证）；真实值不进任何属性——红线 3。 */}
                  <td style={{ ...cellStyle, fontFamily: font.mono }} data-cell="value">
                    {item.valuePreview}
                  </td>
                  <td style={cellStyle} data-cell="source">
                    <SourceCell source={item.source} onNavigate={props.onNavigate} />
                  </td>
                  <td
                    style={{ ...cellStyle, color: statusColor(item.status) }}
                    data-cell="status"
                    title={STATUS_TITLES[item.status]}
                  >
                    {GENERATED_HEADER_STATUS_LABELS[item.status]}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}

export interface GeneratedQuerySectionProps {
  /** preview.query（§5.6：apikey in query 的独立投影；恒敏感、恒 '••••••••'）。 */
  items: readonly GeneratedQueryPreview[]
  onNavigate: (target: GeneratedNavigateTarget) => void
}

/** Params 页下层：「Auth 自动参数」组（无 Auth Query 贡献时整组不渲染；默认折叠）。 */
export function GeneratedQuerySection(props: GeneratedQuerySectionProps): ReactElement | null {
  const [expanded, setExpanded] = useState(false)
  if (props.items.length === 0) return null
  return (
    <div data-dsh-api-client="generated-query-section" style={sectionStyle}>
      <button
        type="button"
        data-dsh-api-client="generated-items-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        style={toggleStyle}
      >
        <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        <span data-dsh-api-client="generated-items-title">Auth 自动参数</span>
        <span style={countStyle} data-dsh-api-client="generated-items-counts">
          共 {props.items.length} 项
        </span>
      </button>
      {expanded && (
        <table data-dsh-api-client="generated-query-table" style={tableStyle}>
          <thead>
            <tr>
              <th style={headStyle}>名称</th>
              <th style={headStyle}>预览值</th>
              <th style={headStyle}>来源</th>
              <th style={headStyle}>状态</th>
            </tr>
          </thead>
          <tbody>
            {props.items.map((item) => (
              <tr
                key={item.name}
                data-dsh-api-client="generated-query-row"
                data-name={item.name.toLowerCase()}
                data-source={item.source}
                data-status={item.status}
              >
                <td style={{ ...cellStyle, ...nameStyle }} data-cell="name">
                  {item.name}
                </td>
                {/* 恒 '••••••••'（§5.6）；真实值不进任何属性——红线 3。 */}
                <td style={{ ...cellStyle, fontFamily: font.mono }} data-cell="value">
                  {item.valuePreview}
                </td>
                <td style={cellStyle} data-cell="source">
                  <SourceCell source={item.source} onNavigate={props.onNavigate} />
                </td>
                <td
                  style={{ ...cellStyle, color: statusColor(item.status) }}
                  data-cell="status"
                  title={item.status === 'overridden' ? '存在启用的同名用户参数，发送时以用户值优先，Auth 自动参数不追加' : undefined}
                >
                  {GENERATED_QUERY_STATUS_LABELS[item.status]}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
