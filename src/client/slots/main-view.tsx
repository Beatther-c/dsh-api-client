/**
 * 极薄注册层（§3.6）：把 ApiClientView 注册为 conversation replacement occupant。
 *
 * session-maybe owner props 标准套件（UI_ADAPTER_CONTRACT：sessionId +
 * useSession + useProjection）——接收但不依赖：视图数据全部来自 Host API
 * （Host 为权威状态源，D16），sessionId 仅透传给视图作展示/诊断用途。
 *
 * 本文件属于允许触碰 DSH 契约的 slots/ 层（TC-A-01），但视图本体在 views/。
 */
import { createElement as h } from 'react'
import type { ReactElement } from 'react'
import { ApiClientView } from '../views/ApiClientView.tsx'
import type { SendToAgentFn } from '../views/ApiClientView.tsx'

export interface MainViewOwnerProps {
  /** session-maybe 标准套件：无会话时为 undefined（契约实测 V-05）。 */
  sessionId?: string | undefined
  /** 其余 owner props（useSession/useProjection 等）原样到达但不消费。 */
  [key: string]: unknown
}

export interface MainViewDeps {
  /** 面板关闭（yield 回官方 Conversation，adapter 注入 activation.deactivate）。 */
  onClose: () => void
  /** 「交给 Agent」出域链路（WP7：client entry 装配的 session-bridge.sendToAgent）。 */
  onSendToAgent?: SendToAgentFn
}

/** 生成可注册进 conversation slot 的 occupant 组件。 */
export function createMainViewComponent(deps: MainViewDeps): (props: MainViewOwnerProps) => ReactElement {
  return function MainViewOccupant(ownerProps: MainViewOwnerProps): ReactElement {
    return h(ApiClientView, {
      onClose: deps.onClose,
      sessionId: typeof ownerProps.sessionId === 'string' ? ownerProps.sessionId : undefined,
      ...(deps.onSendToAgent !== undefined ? { onSendToAgent: deps.onSendToAgent } : {}),
    })
  }
}
