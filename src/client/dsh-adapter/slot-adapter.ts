/**
 * V-05/V-06 probe: official `conversation` slot replacement/shadow path.
 *
 * Runtime facts (0.1.2-rc.1):
 * - `conversation` is `{ kind: 'single', scope: 'session-maybe', owner: {} }`,
 *   declared by ui-layout's AppFrame, OCCUPIED by ui-conversation's
 *   ConversationRoot. Owner props are EMPTY; session facts arrive through the
 *   `session-maybe` standard kit (`sessionId: string | undefined`,
 *   `useSession`, `useProjection`; global kit adds `useSessions`).
 * - Shadowing: the cell's LOWEST live priority wins; a same-priority second
 *   registration throws. The shipped occupant's priority is read at runtime
 *   (never hardcoded, U-4) and the probe registers below it.
 * - REPLACING this slot removes every child seat the shipped occupant
 *   declares (composer, header, docks…) — that is exactly why the yield
 *   mechanism below exists (REVIEW_NOTES 低级待办 #4): on session selection
 *   the adapter unregisters, restoring the official Conversation.
 *
 * Yield triggers, in order of preference:
 *  1. the sessions service's selection subscription (public client API,
 *     shape feature-checked at runtime — recorded either way);
 *  2. a DOM capture listener on sidebar session rows (task-board precedent).
 */
import { createElement } from 'react'
import type { ReactNode } from 'react'
import type { PanelActivation } from './panel-activation.ts'
import type { SlotsFace, LiveSlotNodeLike } from './feature-detect.ts'
import { createMainViewComponent } from '../slots/main-view.tsx'
import type { SendToAgentFn } from '../views/ApiClientView.tsx'

export const CONVERSATION_SLOT_KEY = 'conversation'

/** What the probe learned about the occupant contract (recorded for UIC). */
export interface ConversationContractRecord {
  declaration: { kind?: string; scope?: string; declaredBy?: string } | 'unavailable'
  ownerProps: 'empty' | 'unknown'
  scopeContract: 'session-maybe: sessionId | undefined via standard kit'
  occupantPriorities: number[]
  replacementPriority: number | 'unregistered'
  sessionIdObserved: string | undefined | 'not-rendered'
}

export interface SlotAdapterDeps {
  slots: SlotsFace
  activation: PanelActivation
  /** Sessions service candidate (ctx.get('sessions')), shape probed at runtime. */
  sessions?: unknown
  /** 「交给 Agent」出域链路（WP7 session-bridge.sendToAgent，由 client entry 装配）。 */
  onSendToAgent?: SendToAgentFn
  document?: Document
  log?: (event: string, detail?: unknown) => void
}

function findConversationNode(nodes: readonly LiveSlotNodeLike[]): LiveSlotNodeLike | undefined {
  for (const node of nodes) {
    if (node.name === CONVERSATION_SLOT_KEY) return node
    const child = node.children === undefined ? undefined : findConversationNode(node.children)
    if (child !== undefined) return child
  }
  return undefined
}

/** Read the live occupant priorities of the conversation cell (runtime fact, U-4). */
export function readOccupantPriorities(slots: SlotsFace): number[] {
  try {
    if (typeof slots.snapshot === 'function') {
      const node = findConversationNode(slots.snapshot())
      if (node?.occupants !== undefined) {
        return node.occupants
          .map((occupant) => occupant.priority)
          .filter((priority): priority is number => typeof priority === 'number')
      }
    }
  } catch {
    // fall through to the default
  }
  return []
}

interface SessionsLike {
  list?: { subscribe?: (fn: () => void) => () => void; getSnapshot?: () => unknown }
}

/**
 * Extract selection facts from one SessionListState snapshot.
 * Runtime shape (dsh-api-session-controller/client @ 0.1.2-rc.1):
 * `sessions.list.getSnapshot()` = `{ current: SessionId | undefined,
 * phase: 'pending' | 'ready', … }` — selection rides the LIST snapshot, so
 * whole-snapshot identity changes on every list publication (phase, byId,
 * jobs mirror); comparing it false-fires the yield on cold start (spike fix
 * #4: compare only `current`). The persisted selection is ALSO restored
 * asynchronously (pending → ready edge), which still false-fired the
 * deep-link cold start (spike fix #4b: arm on the FIRST ready snapshot —
 * restores happen before it, user gestures only after).
 */
function readListFacts(snapshot: unknown): { current: unknown; ready: boolean } {
  if (snapshot === null || typeof snapshot !== 'object') return { current: undefined, ready: false }
  const record = snapshot as { current?: unknown; phase?: unknown }
  return { current: record.current, ready: record.phase === 'ready' }
}

/**
 * Attach the conversation replacement adapter. Registration follows the
 * activation state machine: active → registered (ApiClientView wins the cell),
 * inactive → unregistered (official Conversation restored).
 */
export function attachSlotAdapter(deps: SlotAdapterDeps): () => void {
  const { slots, activation } = deps
  const log = deps.log ?? (() => {})
  const doc = deps.document ?? document

  const contract: ConversationContractRecord = {
    declaration: 'unavailable',
    ownerProps: 'empty',
    scopeContract: 'session-maybe: sessionId | undefined via standard kit',
    occupantPriorities: [],
    replacementPriority: 'unregistered',
    sessionIdObserved: 'not-rendered',
  }
  try {
    const spec = typeof slots.spec === 'function' ? slots.spec(CONVERSATION_SLOT_KEY) : undefined
    if (spec !== undefined) contract.declaration = { kind: spec.kind, scope: spec.scope }
  } catch (error) {
    log('slot-adapter.spec-error', { message: error instanceof Error ? error.message : String(error) })
  }
  const priorities = readOccupantPriorities(slots)
  contract.occupantPriorities = priorities
  // Lowest live priority wins the cell; register strictly below the current minimum.
  const replacementPriority = (priorities.length > 0 ? Math.min(...priorities) : 0) - 1
  contract.replacementPriority = replacementPriority
  log('slot-adapter.contract', { ...contract })

  let unregister: (() => void) | undefined

  // 正式视图 occupant（slots/main-view 注册层）：session-maybe owner props
  // 原样透传，视图只消费 sessionId；onClose → yield（panel Close 路径）。
  const MainView = createMainViewComponent({
    onClose: () => {
      activation.deactivate('panel-close')
    },
    ...(deps.onSendToAgent !== undefined ? { onSendToAgent: deps.onSendToAgent } : {}),
  })
  const Bridge = (props: Record<string, unknown>): ReactNode => {
    const sessionId = typeof props.sessionId === 'string' ? props.sessionId : undefined
    contract.sessionIdObserved = sessionId
    return createElement(MainView, { ...props, sessionId })
  }

  const syncRegistration = (): void => {
    if (activation.isActive() && unregister === undefined) {
      try {
        unregister = slots.register?.(
          { name: CONVERSATION_SLOT_KEY, priority: replacementPriority, registrant: 'dsh-api-client' },
          Bridge,
        )
        log('slot-adapter.register', { priority: replacementPriority })
      } catch (error) {
        unregister = undefined
        log('slot-adapter.register-error', { message: error instanceof Error ? error.message : String(error) })
      }
    } else if (!activation.isActive() && unregister !== undefined) {
      const disposeRegistration = unregister
      unregister = undefined
      try {
        disposeRegistration()
        log('slot-adapter.yield', { reason: activation.lastSource() ?? 'deactivate' })
      } catch (error) {
        log('slot-adapter.yield-error', { message: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  const unsubscribeActivation = activation.subscribe(() => {
    syncRegistration()
  })
  syncRegistration()

  // Yield path 1: sessions service selection subscription (shape probed).
  // Selection rides the list snapshot as `.current`; the listener arms on
  // the first `phase: 'ready'` snapshot so the persisted-selection restore
  // (pending → ready edge) is never mistaken for a user gesture.
  let unsubscribeSessions: (() => void) | undefined
  const sessions = deps.sessions as SessionsLike | undefined
  if (typeof sessions?.list?.subscribe === 'function') {
    let armed = false
    let lastCurrent: unknown
    const readFacts = (): { current: unknown; ready: boolean } =>
      readListFacts(typeof sessions.list?.getSnapshot === 'function' ? sessions.list.getSnapshot() : undefined)
    const arm = (facts: { current: unknown; ready: boolean }): void => {
      armed = true
      lastCurrent = facts.current
      log('slot-adapter.selection-armed', { current: facts.current ?? null })
    }
    try {
      const initial = readFacts()
      if (initial.ready) arm(initial)
      unsubscribeSessions = sessions.list.subscribe(() => {
        const facts = readFacts()
        if (!facts.ready) return
        if (!armed) {
          arm(facts)
          return
        }
        if (facts.current !== lastCurrent) {
          const previous = lastCurrent
          lastCurrent = facts.current
          log('slot-adapter.selection-change', { from: previous ?? null, to: facts.current ?? null })
          if (activation.isActive()) activation.deactivate('session-selection')
        }
      })
      log('slot-adapter.yield-path', { path: 'sessions.list.subscribe(.current,armed-at-ready)', publicApi: true })
    } catch (error) {
      log('slot-adapter.yield-path-error', { path: 'sessions.list.subscribe', message: error instanceof Error ? error.message : String(error) })
    }
  } else {
    log('slot-adapter.yield-path', { path: 'sessions.list.subscribe', publicApi: false, detail: 'service/shape unavailable; DOM capture fallback armed' })
  }

  // Yield path 2: DOM capture on sidebar session rows (always armed as the
  // fallback; task-board precedent for selection listening).
  const onSidebarClick = (event: Event): void => {
    if (!activation.isActive()) return
    const target = event.target
    if (!(target instanceof Element)) return
    if (target.closest('[data-dsh-api-client]') !== null) return
    if (target.closest('[data-pane="sidebar"], [class*="sidebarCol"]') === null) return
    if (target.closest('[class*="session"]') !== null && target.closest('[class*="newSession"]') === null) {
      activation.deactivate('session-selection-dom')
    }
  }
  doc.addEventListener('click', onSidebarClick, true)

  return () => {
    unsubscribeActivation()
    unsubscribeSessions?.()
    doc.removeEventListener('click', onSidebarClick, true)
    if (unregister !== undefined) {
      const disposeRegistration = unregister
      unregister = undefined
      try {
        disposeRegistration()
      } catch {
        // teardown must complete regardless
      }
    }
    log('slot-adapter.dispose', { contract: { ...contract } })
  }
}
