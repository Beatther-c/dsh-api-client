/**
 * ConfirmSendToAgent（§14.4 / V01 §5.3）：「交给 Agent」出域确认弹窗。
 *
 * - ✓/✗ 清单的数据源 = SafeApiDebugContext.redactionSummary（core 动态生成，
 *   非硬编码文案）；✓ 行 success 色、✗ 行 danger 色，按行首符号分流。
 * - 敏感 response body 存在时给「包含 response body」勾选框（默认不勾，§14.4）；
 *   勾选态由父组件持有并重建 context，清单随勾选实时翻转 ✗→✓。
 * - 确认 = 创建/激活 Session 并 prefill composer（FALLBACK 路线，M0 Q4）——
 *   只预填不发送，最终发送由用户在会话 composer 里确认。
 *
 * 分层纪律（TC-A-03）：本文件不 import 任何 DSH 包；context 由调用方构建注入。
 */
import type { CSSProperties, ReactElement } from 'react'
import type { SafeApiDebugContext } from '@dsh-api-client/shared'
import { colors, font } from './theme.ts'
import { Modal } from './Modal.tsx'

export interface ConfirmSendToAgentProps {
  /** 当前勾选态下构建的 Safe context（清单数据源；默认态 body 已排除）。 */
  context: SafeApiDebugContext
  /** 响应存在非空 body → 显示「包含 response body」勾选框。 */
  hasResponseBody: boolean
  /** 当前勾选态（父组件持有；切换触发 context 重建）。 */
  includeResponseBody: boolean
  /** 确认后 session-bridge 进行中去重。 */
  sending: boolean
  onToggleResponseBody: (include: boolean) => void
  onConfirm: () => void
  onCancel: () => void
}

const listItemStyle: CSSProperties = {
  padding: '3px 0',
  fontSize: font.size,
  lineHeight: 1.6,
}

export function ConfirmSendToAgent(props: ConfirmSendToAgentProps): ReactElement {
  return (
    <Modal title="交给 Agent — 出域确认" width={600} onClose={props.onCancel}>
      <div style={{ color: colors.textSecondary, marginBottom: 8 }}>
        以下内容将预填到新 Session 的 composer（仅预填，不发送；发送由你在会话中确认）：
      </div>
      <div
        data-dsh-api-client="send-to-agent-summary"
        style={{
          border: `1px solid ${colors.border}`,
          borderRadius: 4,
          padding: '6px 12px',
          marginBottom: 10,
        }}
      >
        {props.context.redactionSummary.map((item, index) => (
          <div
            key={index}
            style={{
              ...listItemStyle,
              color: item.startsWith('✗') ? colors.danger : colors.success,
            }}
          >
            {item}
          </div>
        ))}
      </div>
      {props.hasResponseBody && (
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            cursor: 'pointer',
            marginBottom: 10,
            fontSize: font.size,
          }}
        >
          <input
            type="checkbox"
            checked={props.includeResponseBody}
            onChange={(event) => props.onToggleResponseBody(event.target.checked)}
          />
          包含 response body（已脱敏投影；默认不发送，勾选后随本次纳入）
        </label>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
        <button
          type="button"
          onClick={props.onCancel}
          disabled={props.sending}
          style={{
            background: 'transparent',
            border: `1px solid ${colors.borderStrong}`,
            borderRadius: 4,
            color: colors.text,
            cursor: 'pointer',
            fontSize: font.size,
            padding: '4px 16px',
          }}
        >
          取消
        </button>
        <button
          type="button"
          data-dsh-api-client="send-to-agent-confirm"
          onClick={props.onConfirm}
          disabled={props.sending}
          style={{
            background: colors.brand,
            color: colors.brandText,
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
            fontSize: font.size,
            padding: '4px 16px',
            opacity: props.sending ? 0.6 : 1,
          }}
        >
          {props.sending ? '预填中…' : '确认并预填'}
        </button>
      </div>
    </Modal>
  )
}
