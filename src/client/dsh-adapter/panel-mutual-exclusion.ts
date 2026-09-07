/**
 * V-08 probe: mutual exclusion with other community plugin panels
 * (DESIGN §3.4). At most one plugin panel may be visible at a time.
 *
 * De-facto community protocol (runtime-verified against the shipped
 * @linxin666/dsh-client-ui-task-board @ 0.1.2-rc.1 — spike fix #6: the
 * DESIGN-guessed `dsh:plugin-panel-activated` + `{plugin}` detail was WRONG;
 * task-board neither dispatches nor honors it):
 * - event: `dsh-panel-activate`, `detail` = the activating panel's NAME
 *   STRING (task-board uses 'taskboard'); any listener whose own name
 *   differs closes its panel;
 * - html attribute mirror: the active panel sets
 *   `data-dsh-<name>-active` on documentElement (task-board:
 *   `data-dsh-taskboard-active`, sibling `data-dsh-ssh-active`) and removes
 *   it on close.
 *
 * Two paths, matching the two mount paths:
 * - Slot path: linked to the slot lifecycle — subscribe to the `conversation`
 *   cell; when its winning occupant is no longer this plugin's entry while
 *   the panel is active, the panel was shadowed/replaced and deactivates.
 * - DOM path: the event/attribute protocol above (outbound dispatch +
 *   inbound yield), plus (c) capture-phase clicks on other plugins' semantic
 *   sidebar rows (`[data-dsh-plugin]` ≠ ours, the task-board attribute
 *   convention) deactivate this panel before their panel opens.
 */
import type { PanelActivation } from './panel-activation.ts'
import type { SlotsFace } from './feature-detect.ts'
import { CONVERSATION_SLOT_KEY } from './slot-adapter.ts'

/** Community cross-plugin activation event (task-board precedent, verified). */
export const PANEL_EVENT = 'dsh-panel-activate'
/** This panel's protocol name (detail string) and html active attribute. */
export const OWN_PANEL_NAME = 'api-client'
export const OWN_ACTIVE_ATTRIBUTE = 'data-dsh-apiclient-active'
export const OWN_PLUGIN_ID = 'dsh-api-client'

export interface MutualExclusionDeps {
  activation: PanelActivation
  /** Current mount path; slot-specific watching only arms in 'slot' mode. */
  mode: () => 'slot' | 'dom' | 'none'
  slots?: SlotsFace | null
  document?: Document
  log?: (event: string, detail?: unknown) => void
}

interface StoredEntryLike {
  options?: { priority?: number }
  registrant?: string
}

/** The cell winner's registrant (lowest live priority renders), when readable. */
function winnerRegistrant(slots: SlotsFace): string | undefined {
  try {
    if (typeof slots.entriesOfSlot !== 'function') return undefined
    const winners = slots.entriesOfSlot(CONVERSATION_SLOT_KEY) as readonly StoredEntryLike[]
    const first = winners[0]
    return first?.registrant
  } catch {
    return undefined
  }
}

export function attachPanelMutualExclusion(deps: MutualExclusionDeps): () => void {
  const { activation } = deps
  const log = deps.log ?? (() => {})
  const doc = deps.document ?? document
  const disposers: Array<() => void> = []

  // (a) outbound protocol announcement + html active-attribute mirror.
  disposers.push(
    activation.subscribe((active) => {
      if (active) {
        doc.documentElement.setAttribute(OWN_ACTIVE_ATTRIBUTE, '')
        doc.dispatchEvent(new CustomEvent(PANEL_EVENT, { detail: OWN_PANEL_NAME }))
      } else {
        doc.documentElement.removeAttribute(OWN_ACTIVE_ATTRIBUTE)
      }
    }),
  )
  disposers.push(() => {
    doc.documentElement.removeAttribute(OWN_ACTIVE_ATTRIBUTE)
  })

  // (b) inbound protocol: another plugin's panel claimed the stage.
  //     detail is the activating panel's name STRING (task-board precedent).
  const onPanelEvent = (event: Event): void => {
    const detail = (event as CustomEvent<string>).detail
    if (typeof detail === 'string' && detail !== OWN_PANEL_NAME && activation.isActive()) {
      log('mutual-exclusion.yield', { to: detail, via: 'event' })
      activation.deactivate('mutual-exclusion:event')
    }
  }
  doc.addEventListener(PANEL_EVENT, onPanelEvent)
  disposers.push(() => {
    doc.removeEventListener(PANEL_EVENT, onPanelEvent)
  })

  // (c) DOM path: capture clicks on other plugins' semantic sidebar rows.
  const onForeignEntryClick = (event: Event): void => {
    if (!activation.isActive()) return
    const target = event.target
    if (!(target instanceof Element)) return
    const row = target.closest('[data-dsh-plugin]')
    if (row === null) return
    const plugin = row.getAttribute('data-dsh-plugin')
    if (plugin !== null && plugin !== OWN_PLUGIN_ID) {
      log('mutual-exclusion.yield', { to: plugin, via: 'dom-entry-click' })
      activation.deactivate('mutual-exclusion:dom')
    }
  }
  doc.addEventListener('click', onForeignEntryClick, true)
  disposers.push(() => {
    doc.removeEventListener('click', onForeignEntryClick, true)
  })

  // Slot path: shadowed-out detection, linked to the slot lifecycle.
  const slots = deps.slots ?? undefined
  if (slots !== undefined && typeof slots.subscribe === 'function') {
    try {
      disposers.push(
        slots.subscribe(CONVERSATION_SLOT_KEY, () => {
          if (deps.mode() !== 'slot' || !activation.isActive()) return
          const winner = winnerRegistrant(slots)
          if (winner !== undefined && winner !== OWN_PLUGIN_ID && winner !== 'dsh-api-client') {
            log('mutual-exclusion.yield', { to: winner, via: 'slot-shadowed' })
            activation.deactivate('mutual-exclusion:slot')
          }
        }),
      )
    } catch (error) {
      log('mutual-exclusion.slot-watch-error', { message: error instanceof Error ? error.message : String(error) })
    }
  }

  return () => {
    for (const dispose of disposers.splice(0)) dispose()
    log('mutual-exclusion.dispose', {})
  }
}
