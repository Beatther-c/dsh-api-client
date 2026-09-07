/**
 * V-05 probe: panel activation state machine + the "Open API Client"
 * deep-link activation contract (REVIEW_NOTES 中级待办 #3).
 *
 * Deep-link token: placeholder form `#api-client` (U-3 — the final form is
 * decided by the V-05 deep-link runtime probe against the DSH router). The
 * parser is total: empty/missing hash → 'none', the exact token (case-
 * insensitive, trimmed) → 'activate', anything else → 'unknown' (never an
 * exception, never an activation).
 *
 * The state machine is the single source of truth for panel visibility; both
 * mount paths (slot replacement / CSS takeover) and the mutual-exclusion
 * probe subscribe to it. Programmatic activation (`activate()`) is the entry
 * point external callers (e.g. Workbench later) use.
 */

/** Placeholder deep-link token (U-3). */
export const DEEP_LINK_TOKEN = '#api-client'

export type DeepLinkParse = 'activate' | 'none' | 'unknown'

/**
 * Parse one hash string against the deep-link contract. Total function.
 * @param hash - `location.hash` or an equivalent raw token; undefined/null/'' → 'none'.
 */
export function parseDeepLink(hash: string | null | undefined): DeepLinkParse {
  if (hash === null || hash === undefined) return 'none'
  const normalized = hash.trim().toLowerCase()
  if (normalized === '' || normalized === '#') return 'none'
  if (normalized === DEEP_LINK_TOKEN) return 'activate'
  return 'unknown'
}

export type ActivationListener = (active: boolean) => void

export interface PanelActivation {
  /** Activate the panel (idempotent). `source` is recorded for the probe log. */
  activate(source?: string): void
  /** Deactivate the panel (idempotent) — the yield path lands here. */
  deactivate(source?: string): void
  /** Toggle (sidebar entry click). */
  toggle(source?: string): void
  isActive(): boolean
  /** Source of the last transition (diagnostics). */
  lastSource(): string | undefined
  /** Subscribe to transitions; returns unsubscribe. */
  subscribe(listener: ActivationListener): () => void
}

/** Create the activation state machine (starts inactive). */
export function createPanelActivation(options?: {
  onChange?: (active: boolean, source: string) => void
}): PanelActivation {
  let active = false
  let source: string | undefined
  const listeners = new Set<ActivationListener>()
  const transition = (next: boolean, transitionSource: string): void => {
    if (active === next) return
    active = next
    source = transitionSource
    options?.onChange?.(active, transitionSource)
    for (const listener of [...listeners]) listener(active)
  }
  return {
    activate(transitionSource = 'programmatic') {
      transition(true, transitionSource)
    },
    deactivate(transitionSource = 'programmatic') {
      transition(false, transitionSource)
    },
    toggle(transitionSource = 'toggle') {
      transition(!active, transitionSource)
    },
    isActive() {
      return active
    },
    lastSource() {
      return source
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/**
 * Apply one deep-link hash to the state machine: 'activate' activates and any
 * other parse leaves the machine untouched (TC-M0-07).
 * @returns the parse outcome, so callers can log cold-start vs runtime hits.
 */
export function applyDeepLink(
  activation: Pick<PanelActivation, 'activate'>,
  hash: string | null | undefined,
  source = 'deep-link',
): DeepLinkParse {
  const parsed = parseDeepLink(hash)
  if (parsed === 'activate') activation.activate(source)
  return parsed
}
