/**
 * V-03/V-04/V-17 probe: sidebar DOM injection below the New Session button.
 *
 * Runtime facts (0.1.2-rc.1 + the shipped task-board sample):
 * - The sidebar has NO additive slot below New Session — the only official
 *   additive sidebar seat is `sidebar.footer.action` (list, at the foot). The
 *   entry row is therefore plain DOM injected between the shell's New Session
 *   row and the workspace browser (task-board precedent).
 * - Anchor selectors (task-board, verified against this shell): the sidebar
 *   column matches `[data-pane="sidebar"], [class*="sidebarCol"]`; the New
 *   Session button matches `button[class*="newSession"]` nested in the logo
 *   row (`[class*="logoRow"]`), falling back to the root's first direct
 *   BUTTON child on legacy shells.
 * - Self-heal: a MutationObserver on the sidebar root re-inserts the row in
 *   the same frame when a React re-render displaces it; a body-level watcher
 *   covers whole-pane rebuilds (the root observer dies with the old tree).
 * - The row is plain DOM (never React) so it cannot disturb the shell's
 *   reconciliation; it carries the semantic attribute `data-dsh-api-client`
 *   (idempotency key) plus `data-dsh-plugin` / `data-dsh-part`.
 *
 * Guarantees: unique entry (dedup guard before mount and inside place),
 * wide/collapsed two-state label (wide: icon + text; collapsed rail: icon
 * only), and a dispose() that removes the row, both observers, and every
 * listener — leaving zero residue (TC-M0-03…06).
 */

export const ROW_ATTRIBUTE = 'data-dsh-api-client'
export const ROW_SELECTOR = `[${ROW_ATTRIBUTE}]`
export const PLUGIN_ATTRIBUTE_VALUE = 'dsh-api-client'

const SIDEBAR_COLUMN_SELECTOR = '[data-pane="sidebar"], [class*="sidebarCol"]'
const LOGO_ROW_SELECTOR = '[class*="logoRow"]'
const NEW_SESSION_BUTTON_SELECTOR = 'button[class*="newSession"]'

const ICON_SVG =
  '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" ' +
  'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M5.5 3.5 2.5 8l3 4.5M10.5 3.5 13.5 8l-3 4.5"/></svg>'

export interface SidebarInjectionOptions {
  /** Document override (tests); defaults to the global document. */
  document?: Document
  /** Click handler (panel toggle). */
  onToggle?: () => void
  /** Row label; defaults to 'API Client'. */
  label?: () => string
  /** Active-state bridge: highlights the row while the panel is open. */
  isActive?: () => boolean
  subscribeActive?: (listener: () => void) => () => void
  /** Probe-log sink (console-compatible). */
  log?: (event: string, detail?: unknown) => void
}

export interface SidebarInjection {
  /** False when the dedup guard found an existing row (this call mounted nothing). */
  readonly attached: boolean
  /** Times the self-heal observer rebuilt the row (V-04 evidence). */
  readonly healCount: () => number
  /** Remove the row, disconnect both observers, remove every listener. */
  dispose(): void
}

/** Find the sidebar shell root element, or undefined while not yet mounted. */
export function findSidebarRoot(doc: Document): HTMLElement | undefined {
  const column = doc.querySelector<HTMLElement>(SIDEBAR_COLUMN_SELECTOR)
  if (column === null) return undefined
  const logoOwner = column.querySelector<HTMLElement>(LOGO_ROW_SELECTOR)?.parentElement
  return logoOwner ?? (column.firstElementChild as HTMLElement | null) ?? undefined
}

/** The New Session button: nested in the logo row, else the root's first direct BUTTON. */
export function findNewSessionButton(root: HTMLElement): HTMLButtonElement | undefined {
  const nested = root.querySelector<HTMLButtonElement>(NEW_SESSION_BUTTON_SELECTOR)
  if (nested !== null) return nested
  for (const child of root.children) {
    if (child.tagName === 'BUTTON') return child as HTMLButtonElement
  }
  return undefined
}

/** Collapsed-rail detection: semantic attribute first, class fallback. */
function isSidebarCollapsed(root: HTMLElement): boolean {
  const column = root.closest(SIDEBAR_COLUMN_SELECTOR) ?? root
  if (column.getAttribute('data-collapsed') === 'true') return true
  if (/\bcollapsed\b/.test(column.className)) return true
  // Runtime shape (0.1.2-rc.1, spike fix #7): the FRAME-level ancestor
  // carries `data-sidebar-collapsed="true"` in rail mode — the column
  // itself keeps an unmarked class, so the column-only heuristic missed it.
  const carrier = column.closest('[data-sidebar-collapsed]')
  if (carrier !== null) return carrier.getAttribute('data-sidebar-collapsed') === 'true'
  return false
}

function createEntry(options: SidebarInjectionOptions): { entry: HTMLButtonElement; labelSpan: HTMLSpanElement } {
  const entry = (options.document ?? document).createElement('button')
  entry.type = 'button'
  entry.setAttribute(ROW_ATTRIBUTE, '')
  entry.setAttribute('data-dsh-plugin', PLUGIN_ATTRIBUTE_VALUE)
  entry.setAttribute('data-dsh-part', 'sidebar-entry')
  const label = options.label?.() ?? 'API Client'
  entry.setAttribute('aria-label', label)
  entry.title = label
  entry.style.cssText =
    'display:flex;align-items:center;gap:8px;width:100%;padding:6px 10px;margin:2px 0;' +
    'background:transparent;border:none;border-radius:6px;cursor:pointer;color:inherit;' +
    'font:inherit;font-size:inherit;text-align:left;line-height:16px;'
  const iconSpan = (options.document ?? document).createElement('span')
  iconSpan.setAttribute('data-dsh-part', 'sidebar-entry-icon')
  iconSpan.style.cssText = 'display:inline-flex;flex:0 0 16px;'
  iconSpan.innerHTML = ICON_SVG
  const labelSpan = (options.document ?? document).createElement('span')
  labelSpan.setAttribute('data-dsh-part', 'sidebar-entry-label')
  labelSpan.textContent = label
  entry.append(iconSpan, labelSpan)
  if (options.onToggle !== undefined) entry.addEventListener('click', options.onToggle)
  return { entry, labelSpan }
}

/** Insert the row right after the New Session row. Returns false while the anchor is missing. */
function placeEntry(root: HTMLElement, entry: HTMLButtonElement): boolean {
  const button = findNewSessionButton(root)
  if (button === undefined) return false
  if (entry.parentElement === root) return true
  const row = button.closest(LOGO_ROW_SELECTOR)
  const base = row !== null && row.parentElement === root ? row : button
  root.insertBefore(entry, base.nextElementSibling)
  return true
}

/**
 * Mount the sidebar entry with dedup guard + self-heal observers.
 * DOM-level idempotency: if a row already exists (duplicated apply, HMR
 * re-injection, stale module), this call mounts nothing and disposes to a
 * no-op — the entry count can never exceed one.
 */
export function attachSidebarEntry(options: SidebarInjectionOptions = {}): SidebarInjection {
  const doc = options.document ?? document
  const log = options.log ?? (() => {})
  const noopResult: SidebarInjection = { attached: false, healCount: () => 0, dispose: () => {} }
  if (doc.querySelector(ROW_SELECTOR) !== null) {
    log('sidebar-injection.dedup', { reason: 'entry already present' })
    return noopResult
  }

  const { entry, labelSpan } = createEntry(options)
  let root: HTMLElement | undefined
  let placed = false
  let everPlaced = false
  let heals = 0
  let disposed = false

  const syncState = (): void => {
    if (root !== undefined) labelSpan.style.display = isSidebarCollapsed(root) ? 'none' : ''
    if (options.isActive !== undefined && options.isActive()) entry.dataset.active = 'true'
    else delete entry.dataset.active
  }

  const tryPlace = (): void => {
    if (disposed) return
    if (root !== undefined && !root.isConnected) {
      // Whole-pane rebuild: the root observer died with the old tree.
      rootObserver.disconnect()
      root = undefined
      placed = false
    }
    if (placed) {
      if (doc.body.contains(entry)) return
      rootObserver.disconnect()
      root = undefined
      placed = false
    }
    root ??= findSidebarRoot(doc)
    if (root === undefined) return
    placed = placeEntry(root, entry)
    if (placed) {
      // Every successful placement after the first is a self-heal (V-04 evidence).
      if (everPlaced) heals += 1
      everPlaced = true
      syncState()
      rootObserver.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-collapsed'] })
      log('sidebar-injection.attached', { heal: heals > 0 })
    }
  }

  // Body-level watcher: notices the sidebar pane (re)mounting; cheap
  // short-circuit while the row is alive (one contains check per mutation).
  // Also watches the frame-level collapse attribute (lives on an ANCESTOR of
  // the observed sidebar root, spike fix #7) so the two-state label syncs.
  const waitObserver = new MutationObserver(() => {
    tryPlace()
    syncState()
  })
  waitObserver.observe(doc.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-sidebar-collapsed', 'data-collapsed'],
  })

  // Self-heal: a React re-render that displaces the row re-inserts it in the
  // same frame (microtask before paint → no visible flicker).
  const rootObserver = new MutationObserver(() => {
    if (disposed) return
    if (root === undefined || !root.isConnected) {
      placed = false
      tryPlace()
      return
    }
    if (!root.contains(entry)) {
      const rePlaced = placeEntry(root, entry)
      placed = rePlaced
      if (rePlaced) {
        if (everPlaced) heals += 1
        everPlaced = true
        log('sidebar-injection.heal', {})
      }
    }
    syncState()
  })

  const unsubscribeActive = options.subscribeActive?.(() => {
    syncState()
  })

  tryPlace()

  return {
    attached: placed,
    healCount: () => heals,
    dispose() {
      if (disposed) return
      disposed = true
      waitObserver.disconnect()
      rootObserver.disconnect()
      unsubscribeActive?.()
      if (options.onToggle !== undefined) entry.removeEventListener('click', options.onToggle)
      entry.remove()
      log('sidebar-injection.dispose', {})
    },
  }
}
