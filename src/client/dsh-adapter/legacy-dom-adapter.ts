/**
 * V-07 probe: legacy CSS takeover fallback.
 *
 * Contract (DESIGN §3.2): the Conversation DOM STAYS MOUNTED — the takeover
 * only sets `visibility: hidden` on the conversation column and overlays the
 * API Client view in an absolutely-positioned container on top. Restore reverses
 * both exactly (original inline style values are captured and written back),
 * so composer drafts / scroll position / view state survive (V-06/V-07).
 *
 * Column discovery is a selector fallback list (the shell's exact column
 * marker is a runtime fact); the matched selector is recorded for the UI
 * Adapter Contract.
 */
import { createElement } from 'react'
import type { PanelActivation } from './panel-activation.ts'
import { createMainViewComponent } from '../slots/main-view.tsx'
import type { SendToAgentFn } from '../views/ApiClientView.tsx'

export const PANEL_CONTAINER_ATTRIBUTE = 'data-dsh-api-client-panel'

/** Conversation column candidate selectors, most semantic first. */
export const CONVERSATION_COLUMN_SELECTORS = [
  '[data-pane="conversation"]',
  '[class*="conversationCol"]',
  '[class*="centerCol"]',
  'main [class*="conversation"]',
] as const

export interface LegacyDomAdapterDeps {
  activation: PanelActivation
  /** 「交给 Agent」出域链路（WP7 session-bridge.sendToAgent，由 client entry 装配）。 */
  onSendToAgent?: SendToAgentFn
  document?: Document
  log?: (event: string, detail?: unknown) => void
}

interface ReactRootLike {
  render(node: ReturnType<typeof createElement>): void
  unmount(): void
}

/** react-dom/client is a baseline module-table word; resolved lazily so this module stays jsdom-test-safe. */
type CreateRoot = (container: Element | DocumentFragment) => ReactRootLike

export function findConversationColumn(doc: Document): { element: HTMLElement; selector: string } | undefined {
  for (const selector of CONVERSATION_COLUMN_SELECTORS) {
    const element = doc.querySelector<HTMLElement>(selector)
    if (element !== null) return { element, selector }
  }
  return undefined
}

export interface LegacyDomAdapter {
  /** Which selector matched at takeover time; undefined until first takeover. */
  readonly matchedSelector: () => string | undefined
  dispose(): void
}

/**
 * Attach the CSS takeover probe. `createRoot` is injected by the caller
 * (client entry passes the runtime react-dom/client) so the adapter itself
 * never hard-requires react-dom — unit tests can substitute a stub.
 */
export function attachLegacyDomAdapter(deps: LegacyDomAdapterDeps, createRoot?: CreateRoot): LegacyDomAdapter {
  const { activation } = deps
  const log = deps.log ?? (() => {})
  const doc = deps.document ?? document

  let matched: string | undefined
  let taken = false
  let savedVisibility = ''
  let savedPosition = ''
  let column: HTMLElement | undefined
  let container: HTMLDivElement | undefined
  let root: ReactRootLike | undefined
  let retryObserver: MutationObserver | undefined

  const disarmRetry = (): void => {
    retryObserver?.disconnect()
    retryObserver = undefined
  }
  /** Activation can race the conversation mount (cold-start deep link): retry
   * on the next DOM mutation instead of giving up permanently (spike fix #10). */
  const armRetry = (): void => {
    if (retryObserver !== undefined) return
    retryObserver = new MutationObserver(() => {
      if (taken || !activation.isActive()) {
        disarmRetry()
        return
      }
      takeover()
    })
    retryObserver.observe(doc.body, { childList: true, subtree: true })
  }

  const MainView = createMainViewComponent({
    onClose: () => {
      activation.deactivate('panel-close')
    },
    ...(deps.onSendToAgent !== undefined ? { onSendToAgent: deps.onSendToAgent } : {}),
  })
  const Panel = (): ReturnType<typeof createElement> => {
    return createElement(MainView, {})
  }

  const takeover = (): void => {
    if (taken) return
    const found = findConversationColumn(doc)
    if (found === undefined) {
      log('legacy-dom.no-column', { selectors: [...CONVERSATION_COLUMN_SELECTORS] })
      armRetry()
      return
    }
    disarmRetry()
    column = found.element
    matched = found.selector
    savedVisibility = column.style.visibility
    savedPosition = column.style.position
    // Hide without unmounting: the whole conversation subtree stays in the DOM.
    column.style.visibility = 'hidden'
    if (getComputedStyle(column).position === 'static') column.style.position = 'relative'

    container = doc.createElement('div')
    container.setAttribute(PANEL_CONTAINER_ATTRIBUTE, '')
    // The overlay lives INSIDE the hidden column, so it must explicitly reset
    // visibility — `visibility` inherits and would hide the panel too (spike fix #10).
    container.style.cssText = 'visibility:visible;position:absolute;inset:0;z-index:10;overflow:auto;background:inherit;color:inherit;'
    column.append(container)

    if (createRoot !== undefined) {
      try {
        root = createRoot(container)
        root.render(createElement(Panel))
      } catch (error) {
        log('legacy-dom.render-error', { message: error instanceof Error ? error.message : String(error) })
      }
    }
    taken = true
    log('legacy-dom.takeover', { selector: matched, conversationMounted: doc.contains(column) })
  }

  const restore = (): void => {
    disarmRetry()
    if (!taken) return
    try {
      root?.unmount()
    } catch (error) {
      log('legacy-dom.unmount-error', { message: error instanceof Error ? error.message : String(error) })
    }
    root = undefined
    container?.remove()
    container = undefined
    if (column !== undefined) {
      column.style.visibility = savedVisibility
      column.style.position = savedPosition
      log('legacy-dom.restore', { conversationMounted: doc.contains(column) })
    }
    column = undefined
    taken = false
  }

  const unsubscribe = activation.subscribe((active) => {
    if (active) takeover()
    else restore()
  })
  if (activation.isActive()) takeover()

  return {
    matchedSelector: () => matched,
    dispose() {
      unsubscribe()
      disarmRetry()
      restore()
      log('legacy-dom.dispose', {})
    },
  }
}
