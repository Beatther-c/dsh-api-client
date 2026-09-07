/**
 * V-10 probe: theme token reading (official context first, CSS variables
 * fallback), dark-mode detection, and sidebar collapse two-state readout.
 *
 * Runtime facts (0.1.2-rc.1): the layout plugin seats a theme presenter that
 * projects `ctx.theme` snapshots onto `document.body` (ui-layout); the exact
 * service face and token names are runtime-discovered, so every read here is
 * a guarded candidate probe — never an assumption. Nothing throws; an
 * unreadable source degrades to 'unknown' / an empty token table.
 */

export type ThemeMode = 'dark' | 'light' | 'unknown'
export type ThemeSource = 'context' | 'css-vars' | 'none'

export interface ThemeSnapshot {
  mode: ThemeMode
  source: ThemeSource
  /** Resolved custom properties (candidate list below; only non-empty values land here). */
  tokens: Record<string, string>
  /** Sidebar collapse state; 'unknown' when the sidebar column is not found. */
  sidebarCollapsed: boolean | 'unknown'
  notes: string[]
}

/**
 * Candidate theme custom properties probed in order.
 * Runtime shape (dsh-client-ui-theme @ 0.1.2-rc.1, spike fix #8): the token
 * family is `--dsw-alias-*` projected onto `body` by design-platform.css
 * (dark overrides alongside); the service snapshot's `active.tokens` carries
 * only alias-override layers (empty for the built-in light/dark themes), so
 * the CSS-variable read is the primary token source. The earlier `--dsh-*`
 * guesses matched nothing on the live shell.
 */
export const THEME_TOKEN_CANDIDATES = [
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-brand-primary',
  '--dsw-alias-brand-text',
  '--dsw-alias-fill-primary',
] as const

/** Minimal context face: the official theme service is probed by name. */
export interface ThemeContextLike {
  get?: (name: string) => unknown
}

interface ThemeServiceLike {
  getSnapshot?: () => unknown
  mode?: unknown
  dark?: unknown
  /** Runtime shape (dsh-client-ui-theme @ 0.1.2-rc.1): frozen service snapshot. */
  snapshot?: {
    preference?: unknown
    active?: { id?: unknown; colorScheme?: unknown; tokens?: unknown }
  }
  /** Runtime inspection export (same package): full active token table. */
  exportInspectTokens?: () => unknown
}

function modeFromUnknown(value: unknown): ThemeMode {
  if (value === 'dark' || value === 'light') return value
  if (typeof value === 'boolean') return value ? 'dark' : 'light'
  return 'unknown'
}

/** Read one theme snapshot. Pure probe: reads only, never throws. */
export function readThemeSnapshot(ctx?: ThemeContextLike, doc: Document = document): ThemeSnapshot {
  const notes: string[] = []
  let mode: ThemeMode = 'unknown'
  let source: ThemeSource = 'none'
  const tokens: Record<string, string> = {}

  // Level 1 — official theme context/service (face discovered at runtime).
  try {
    const service = ctx?.get?.('theme') as ThemeServiceLike | undefined
    if (service !== undefined && service !== null) {
      // Runtime shape first (dsh-client-ui-theme @ 0.1.2-rc.1): the frozen
      // `snapshot` own property carries active.colorScheme + active.tokens.
      const runtime = service.snapshot
      if (runtime !== undefined && typeof runtime === 'object') {
        const scheme = modeFromUnknown(runtime.active?.colorScheme)
        if (scheme !== 'unknown') {
          mode = scheme
          source = 'context'
        }
        if (runtime.active?.tokens !== undefined && typeof runtime.active.tokens === 'object' && runtime.active.tokens !== null) {
          for (const [key, value] of Object.entries(runtime.active.tokens as Record<string, unknown>)) {
            if (typeof value === 'string' && value !== '') tokens[key] = value
          }
          if (Object.keys(tokens).length > 0) source = 'context'
        }
      }
      // Generic candidate shapes (kept as fallback for other runtime versions).
      if (source === 'none') {
        const snapshot = typeof service.getSnapshot === 'function' ? service.getSnapshot() : service
        if (typeof snapshot === 'object' && snapshot !== null) {
          const record = snapshot as Record<string, unknown>
          const contextMode = modeFromUnknown(record.mode) !== 'unknown' ? modeFromUnknown(record.mode) : modeFromUnknown(record.dark)
          if (contextMode !== 'unknown') {
            mode = contextMode
            source = 'context'
          }
          if (typeof record.tokens === 'object' && record.tokens !== null) {
            for (const [key, value] of Object.entries(record.tokens as Record<string, unknown>)) {
              if (typeof value === 'string' && value !== '') tokens[key] = value
            }
            if (Object.keys(tokens).length > 0) source = 'context'
          }
        }
      }
      if (source === 'none') notes.push('ctx theme service present but exposed no mode/tokens; face recorded for catalog')
    } else {
      notes.push('no theme service on ctx; CSS-variable fallback active')
    }
  } catch (error) {
    notes.push(`theme context probe failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  // Level 2 — CSS custom-property fallback on the shell body.
  try {
    const style = getComputedStyle(doc.body)
    for (const name of THEME_TOKEN_CANDIDATES) {
      const value = style.getPropertyValue(name).trim()
      if (value !== '' && tokens[name] === undefined) tokens[name] = value
    }
    if (source === 'none' && Object.keys(tokens).length > 0) source = 'css-vars'
  } catch (error) {
    notes.push(`css-var probe failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  // Dark mode from DOM markers when the context gave none.
  if (mode === 'unknown') {
    const bodyTheme = doc.body.dataset.theme ?? doc.documentElement.dataset.theme
    if (bodyTheme === 'dark' || bodyTheme === 'light') mode = bodyTheme
    else if (/\bdark\b/.test(doc.body.className) || /\bdark\b/.test(doc.documentElement.className)) mode = 'dark'
    else if (/\blight\b/.test(doc.body.className) || /\blight\b/.test(doc.documentElement.className)) mode = 'light'
  }

  // Sidebar collapse two-state. Runtime shape (0.1.2-rc.1, spike fix #7):
  // the frame-level ancestor carries `data-sidebar-collapsed`; the column
  // itself is unmarked.
  let sidebarCollapsed: boolean | 'unknown' = 'unknown'
  const column = doc.querySelector<HTMLElement>('[data-pane="sidebar"], [class*="sidebarCol"]')
  if (column !== null) {
    const carrier = column.closest('[data-sidebar-collapsed]')
    if (carrier !== null) {
      sidebarCollapsed = carrier.getAttribute('data-sidebar-collapsed') === 'true'
    } else {
      sidebarCollapsed = column.getAttribute('data-collapsed') === 'true' || /\bcollapsed\b/.test(column.className)
    }
  }

  return { mode, source, tokens, sidebarCollapsed, notes }
}

/**
 * Observe theme-relevant DOM mutations (body class / data-theme, sidebar
 * collapse attribute) and re-notify. Returns the disposer.
 */
export function attachThemeObserver(onChange: () => void, doc: Document = document): () => void {
  const observer = new MutationObserver(() => {
    onChange()
  })
  observer.observe(doc.body, { attributes: true, attributeFilter: ['class', 'data-theme'] })
  observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] })
  const column = doc.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]')
  if (column !== null) {
    observer.observe(column, { attributes: true, attributeFilter: ['class', 'data-collapsed'] })
  }
  // Frame-level collapse carrier (spike fix #7).
  const carrier = doc.querySelector('[data-sidebar-collapsed]')
  if (carrier !== null) {
    observer.observe(carrier, { attributes: true, attributeFilter: ['data-sidebar-collapsed'] })
  }
  return () => {
    observer.disconnect()
  }
}
