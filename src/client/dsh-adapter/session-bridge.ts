/**
 * Session Bridge（WP7 正式链路，V01 §5.3 / DESIGN §14.3，M0 Q4 = FALLBACK 路线）。
 *
 * （§3.5 探针退役：本文件的 WP0 探针面 probeSessionBridgePaths / runSessionBridge /
 * SPIKE_SAMPLE_CONTEXT 已随 WP8 移除；以下为唯一保留的正式实现。）
 *
 * sendToAgent(safeContext)：
 *   sessions.create({ workspaceId })（workspaceId 取 workspaces.list.getSnapshot().items
 *   首个有效项——ui-workspace navigation 同款，spike 修 #12b；裸 create() 会得到
 *   composer 禁用的无工作区会话）
 *   → sessions.open(id) 激活（选择变化经 slot-adapter yield 路径让面板让位，
 *   官方 Conversation 恢复，composer 挂载）
 *   → composer 轮询等待（新会话异步挂载，≤ pollAttempts × pollIntervalMs，spike 修 #12）
 *   → execCommand('insertText') 注入 Safe context 的 Markdown 渲染（composer 是
 *   Lexical：裸 textContent+input 事件会被 reconciliation 清除，修 #12c；textarea
 *   形态走 value+input 事件）
 *   → 停手：只预填不发送（§14.3），最终发送由用户在会话中确认。
 *
 * 安全面：注入文本只来自 renderSafeApiDebugContextMarkdown —— 其输入必须是
 * buildSafeApiDebugContext 的输出（唯一允许出域形态），本模块不接触任何原始
 * request/response/environment 数据。
 */

import type { SafeApiDebugContext } from '@dsh-api-client/shared'
import { renderSafeApiDebugContextMarkdown } from '../../../packages/core/src/security/redactor.ts'

interface SessionsServiceLike {
  create?: (options?: unknown) => Promise<{ id?: string } | string | undefined>
  open?: (id: string) => unknown
  list?: { getSnapshot?: () => unknown; subscribe?: (fn: () => void) => () => void }
}

interface WorkspacesServiceLike {
  list?: { getSnapshot?: () => { items?: Array<{ workspaceId?: string }> } }
}

interface ContextLike {
  get?: (name: string) => unknown
}

/** sendToAgent 的终止/降级步骤（路径记录，Toast 与 TC-UI-17 证据共用）。 */
export type SendToAgentStage = 'create-session' | 'activate-session' | 'composer-mount' | 'prefill' | 'done'

export interface SendToAgentResult {
  ok: boolean
  /** ok=false 时为降级点；'done' 表示预填完成（仍未发送）。 */
  stage: SendToAgentStage
  sessionId?: string
  /** 人类可读路径记录（创建成功 / prefill 成功 / 降级原因）。 */
  detail: string
}

export interface SessionBridgeDeps {
  /** 服务面只取 sessions/workspaces（WP0 冻结契约面）；由 client entry 注入。 */
  ctx: ContextLike
  document?: Document
  /** composer 轮询参数（默认 10 × 250ms = 2.5s 上限，spike 修 #12 实测窗口）。 */
  pollAttempts?: number
  pollIntervalMs?: number
  log?: (event: string, detail?: unknown) => void
}

export interface SessionBridge {
  /** 永不 throw：每一步失败都落入 result.stage/detail（出域流程错误必须可见而非崩面板）。 */
  sendToAgent(context: SafeApiDebugContext): Promise<SendToAgentResult>
  /** 卸载义务：中止进行中的 composer 轮询。 */
  dispose(): void
}

export function createSessionBridge(deps: SessionBridgeDeps): SessionBridge {
  const doc = deps.document ?? document
  const pollAttempts = deps.pollAttempts ?? 10
  const pollIntervalMs = deps.pollIntervalMs ?? 250
  const log = deps.log ?? (() => {})
  let disposed = false
  let pollTimer: ReturnType<typeof setTimeout> | undefined

  const fail = (stage: SendToAgentStage, detail: string, sessionId?: string): SendToAgentResult => {
    log('session-bridge.degraded', { stage, detail, sessionId: sessionId ?? null })
    return { ok: false, stage, detail, ...(sessionId !== undefined ? { sessionId } : {}) }
  }

  const waitForComposer = (): Promise<HTMLElement | null> =>
    new Promise((resolve) => {
      let attempt = 0
      const poll = (): void => {
        if (disposed) {
          resolve(null)
          return
        }
        const el = doc.querySelector<HTMLElement>('textarea, [contenteditable="true"]')
        if (el !== null) {
          resolve(el)
          return
        }
        attempt += 1
        if (attempt >= pollAttempts) {
          resolve(null)
          return
        }
        pollTimer = setTimeout(poll, pollIntervalMs)
      }
      poll()
    })

  const sendToAgent = async (context: SafeApiDebugContext): Promise<SendToAgentResult> => {
    // 渲染在 create 之前完成：出域文本只此一份，后续步骤不再接触 context 字段。
    const text = renderSafeApiDebugContextMarkdown(context)

    // 1. Create Session（公开 API，V-13；workspaceId 绑定见文件头）。
    const sessions = deps.ctx.get?.('sessions') as SessionsServiceLike | undefined
    if (typeof sessions?.create !== 'function') {
      return fail('create-session', 'sessions.create 不可用（ctx.get("sessions") 缺面）')
    }
    const workspaces = deps.ctx.get?.('workspaces') as WorkspacesServiceLike | undefined
    const workspaceId = workspaces?.list?.getSnapshot?.().items?.find(
      (item) => typeof item?.workspaceId === 'string' && item.workspaceId !== '',
    )?.workspaceId
    let sessionId: string | undefined
    try {
      const created = await sessions.create(workspaceId === undefined ? undefined : { workspaceId })
      sessionId = typeof created === 'string' ? created : created?.id
    } catch (error) {
      return fail('create-session', `sessions.create 抛错: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (sessionId === undefined) {
      return fail('create-session', 'sessions.create 未返回 session id')
    }
    log('session-bridge.created', { sessionId, workspaceId: workspaceId ?? null })

    // 2. Activate Session（公开 API，V-13）。
    if (typeof sessions.open !== 'function') {
      return fail('activate-session', 'sessions.open 不可用；会话已创建但未激活，请在侧边栏手动打开', sessionId)
    }
    try {
      sessions.open(sessionId)
    } catch (error) {
      return fail(
        'activate-session',
        `sessions.open 抛错: ${error instanceof Error ? error.message : String(error)}；会话已创建，请手动打开`,
        sessionId,
      )
    }

    // 3. Composer 轮询等待（异步挂载）→ 4. prefill（只预填不发送）。
    const composerEl = await waitForComposer()
    if (disposed) {
      return fail('composer-mount', 'bridge 在等待 composer 期间被 dispose（插件卸载）', sessionId)
    }
    if (composerEl === null) {
      return fail('composer-mount', `composer 未在 ${pollAttempts * pollIntervalMs}ms 轮询窗口内挂载；上下文未注入`, sessionId)
    }
    if (composerEl instanceof HTMLTextAreaElement) {
      composerEl.value = text
      composerEl.dispatchEvent(new Event('input', { bubbles: true }))
      log('session-bridge.prefilled', { sessionId, via: 'textarea' })
      return { ok: true, stage: 'done', sessionId, detail: '已预填到新会话 composer（textarea；未发送）' }
    }
    composerEl.focus()
    let inserted = false
    try {
      inserted = doc.execCommand?.('insertText', false, text) === true
    } catch {
      inserted = false
    }
    if (!inserted) {
      return fail('prefill', 'execCommand(insertText) 被拒；Lexical 下裸写会被清除，未做兜底写入', sessionId)
    }
    log('session-bridge.prefilled', { sessionId, via: 'execCommand(insertText)' })
    return { ok: true, stage: 'done', sessionId, detail: '已预填到新会话 composer（contenteditable；未发送）' }
  }

  return {
    sendToAgent,
    dispose() {
      disposed = true
      if (pollTimer !== undefined) {
        clearTimeout(pollTimer)
        pollTimer = undefined
      }
    },
  }
}
