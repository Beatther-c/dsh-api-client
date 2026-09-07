/**
 * V-01/V-02 probe: capability feature-detect for the DSH client runtime.
 *
 * Runtime facts (0.1.2-rc.1):
 * - `ctx.slots` is the renderer-owned `SlotRegistry` (dsh-client-ui-renderer):
 *   `register(options, component)`, `inject(key, callback)`, `entries(key)`,
 *   `entriesOfSlot(key)`, `spec(key)`, `subscribe(key, fn)`,
 *   `getVersion(key)`, `snapshot(root?)`.
 * - Shadowing semantics (SlotCore): entries sharing one cell coexist at
 *   distinct priorities, sorted ascending; the cell's LOWEST live entry
 *   renders. A second registration at an occupied cell's exact priority
 *   throws. Chain keys do not shadow (election consumes every entry).
 * - SlotMap declarations (from the shipped packages' type contracts):
 *   `conversation`         { kind: 'single', scope: 'session-maybe', owner: {} }   (declared by ui-layout AppFrame)
 *   `settings.plugin.item` { kind: 'keyed',  scope: 'root',          owner: {} }   (declared by ui-settings-plugins)
 *   `sidebar.footer.action`{ kind: 'list',   scope: 'root',          owner: { collapsed, width } }
 *   No additive seat exists below New Session — the sidebar entry is DOM.
 *
 * This module is a pure probe: no DSH imports, no side effects, jsdom-free —
 * the DSH contract surface is the structural `SlotsFace` below, and every
 * read is guarded so a missing capability degrades into the result instead of
 * throwing (TC-M0-01/02).
 */

/** Structural face of the runtime SlotRegistry, as consumed by this plugin. */
export interface SlotsFace {
  register?: (options: Record<string, unknown>, component: unknown) => () => void
  inject?: (key: string, callback: () => (() => void) | Iterable<() => void>) => () => void
  entries?: (key: string) => readonly unknown[]
  entriesOfSlot?: (key: string) => readonly unknown[]
  spec?: (key: string) => { kind?: string; scope?: string } | undefined
  subscribe?: (key: string, fn: () => void) => () => void
  getVersion?: (key: string) => number
  snapshot?: (root?: string) => readonly LiveSlotNodeLike[]
}

/** JSON-safe live slot tree node, mirroring SlotCore's LiveSlotNode. */
export interface LiveSlotNodeLike {
  name: string
  kind?: string
  scope?: string
  declaredBy?: string
  occupants?: readonly LiveSlotOccupantLike[]
  children?: readonly LiveSlotNodeLike[]
}

export interface LiveSlotOccupantLike {
  registrant?: string
  key?: string
  id?: string
  order?: number
  priority?: number
  active?: boolean
}

/** Minimal context shape the detector reads (the real client Context satisfies it). */
export interface FeatureDetectContext {
  slots?: SlotsFace | null
}

export interface SlotOccupantInfo {
  registrant?: string
  key?: string
  id?: string
  order?: number
  priority?: number
  active?: boolean
}

export interface SlotDeclarationProbe {
  key: string
  declared: boolean
  kind?: string
  scope?: string
  declaredBy?: string
  occupants: SlotOccupantInfo[]
  /** Set when probing this key failed; the probe never throws. */
  error?: string
}

export interface FeatureDetectResult {
  /** ctx.slots exists AND register/inject are callable. */
  slotsAvailable: boolean
  registerAvailable: boolean
  injectAvailable: boolean
  /** True when the slot path is unusable and adapters must fall back to DOM. */
  degraded: boolean
  slots: SlotDeclarationProbe[]
  notes: string[]
}

/** Target slots probed by default (DESIGN §3.5 runtime catalog seed). */
export const PROBE_SLOT_KEYS = ['conversation', 'settings.plugin.item', 'sidebar.footer.action'] as const

function findNode(nodes: readonly LiveSlotNodeLike[], key: string): LiveSlotNodeLike | undefined {
  for (const node of nodes) {
    if (node.name === key) return node
    const child = node.children === undefined ? undefined : findNode(node.children, key)
    if (child !== undefined) return child
  }
  return undefined
}

function probeOccupant(occupant: LiveSlotOccupantLike): SlotOccupantInfo {
  const info: SlotOccupantInfo = {}
  if (occupant.registrant !== undefined) info.registrant = occupant.registrant
  if (occupant.key !== undefined) info.key = occupant.key
  if (occupant.id !== undefined) info.id = occupant.id
  if (occupant.order !== undefined) info.order = occupant.order
  if (occupant.priority !== undefined) info.priority = occupant.priority
  if (occupant.active !== undefined) info.active = occupant.active
  return info
}

function probeOneSlot(slots: SlotsFace, key: string, notes: string[]): SlotDeclarationProbe {
  const probe: SlotDeclarationProbe = { key, declared: false, occupants: [] }
  try {
    const spec = typeof slots.spec === 'function' ? slots.spec(key) : undefined
    if (spec !== undefined) {
      probe.declared = true
      if (typeof spec.kind === 'string') probe.kind = spec.kind
      if (typeof spec.scope === 'string') probe.scope = spec.scope
    }
  } catch (error) {
    probe.error = `spec: ${error instanceof Error ? error.message : String(error)}`
  }
  try {
    if (typeof slots.snapshot === 'function') {
      const node = findNode(slots.snapshot(), key)
      if (node !== undefined) {
        probe.declared = true
        if (probe.kind === undefined && typeof node.kind === 'string') probe.kind = node.kind
        if (probe.scope === undefined && typeof node.scope === 'string') probe.scope = node.scope
        if (typeof node.declaredBy === 'string') probe.declaredBy = node.declaredBy
        probe.occupants = (node.occupants ?? []).map(probeOccupant)
      }
    } else if (typeof slots.entriesOfSlot === 'function' && probe.declared) {
      notes.push(`${key}: snapshot() unavailable, occupant detail limited`)
    }
  } catch (error) {
    probe.error = `snapshot: ${error instanceof Error ? error.message : String(error)}`
  }
  return probe
}

/**
 * Detect the slot-system capability of one client context. Pure: reads only,
 * never registers, never throws (TC-M0-02).
 */
export function detectFeatures(
  ctx: FeatureDetectContext,
  keys: readonly string[] = PROBE_SLOT_KEYS,
): FeatureDetectResult {
  const notes: string[] = []
  const slots = ctx.slots ?? undefined
  const registerAvailable = typeof slots?.register === 'function'
  const injectAvailable = typeof slots?.inject === 'function'
  const slotsAvailable = slots !== undefined && registerAvailable && injectAvailable

  if (!slotsAvailable) {
    if (slots === undefined) notes.push('ctx.slots absent: slot path unusable, DOM fallback required')
    else {
      if (!registerAvailable) notes.push('ctx.slots.register missing or not callable')
      if (!injectAvailable) notes.push('ctx.slots.inject missing or not callable')
    }
    return {
      slotsAvailable: false,
      registerAvailable,
      injectAvailable,
      degraded: true,
      slots: keys.map((key) => ({ key, declared: false, occupants: [] })),
      notes,
    }
  }

  const probed = keys.map((key) => probeOneSlot(slots, key, notes))
  for (const probe of probed) {
    if (!probe.declared) notes.push(`${probe.key}: declaration not found at detect time`)
  }
  return {
    slotsAvailable: true,
    registerAvailable: true,
    injectAvailable: true,
    degraded: false,
    slots: probed,
    notes,
  }
}
