/**
 * TC-M0-01/02: feature-detect pure-function tests — mock ctx with and
 * without the slots API (AC-M0-01).
 */
import { describe, expect, it } from 'vitest'
import { detectFeatures } from '../src/client/dsh-adapter/feature-detect.ts'
import type { SlotsFace } from '../src/client/dsh-adapter/feature-detect.ts'

function mockSlotsFace(): SlotsFace {
  return {
    register: () => () => {},
    inject: () => () => {},
    spec: (key: string) =>
      key === 'conversation'
        ? { kind: 'single', scope: 'session-maybe' }
        : key === 'settings.plugin.item'
          ? { kind: 'keyed', scope: 'root' }
          : undefined,
    snapshot: () => [
      {
        name: 'root',
        kind: 'single',
        scope: 'root',
        children: [
          {
            name: 'conversation',
            kind: 'single',
            scope: 'session-maybe',
            declaredBy: 'ui-layout',
            occupants: [{ registrant: 'ui-conversation', priority: 0, active: true }],
            children: [],
          },
        ],
      },
    ],
  }
}

describe('feature-detect (TC-M0-01/02)', () => {
  it('TC-M0-01: ctx with slots.register/inject → slotsAvailable true with declaration/kind/scope', () => {
    const result = detectFeatures({ slots: mockSlotsFace() })
    expect(result.slotsAvailable).toBe(true)
    expect(result.registerAvailable).toBe(true)
    expect(result.injectAvailable).toBe(true)
    expect(result.degraded).toBe(false)

    const conversation = result.slots.find((slot) => slot.key === 'conversation')
    expect(conversation).toBeDefined()
    expect(conversation!.declared).toBe(true)
    expect(conversation!.kind).toBe('single')
    expect(conversation!.scope).toBe('session-maybe')
    expect(conversation!.declaredBy).toBe('ui-layout')
    expect(conversation!.occupants).toHaveLength(1)
    expect(conversation!.occupants[0]).toMatchObject({ registrant: 'ui-conversation', priority: 0 })
  })

  it('TC-M0-02: ctx without slots → slotsAvailable false, degraded, no throw', () => {
    expect(() => detectFeatures({})).not.toThrow()
    const result = detectFeatures({})
    expect(result.slotsAvailable).toBe(false)
    expect(result.registerAvailable).toBe(false)
    expect(result.injectAvailable).toBe(false)
    expect(result.degraded).toBe(true)
    expect(result.slots.every((slot) => !slot.declared)).toBe(true)
    expect(result.notes.length).toBeGreaterThan(0)
  })

  it('TC-M0-02 (variant): slots object without register/inject → unavailable + notes, no throw', () => {
    const result = detectFeatures({ slots: {} })
    expect(result.slotsAvailable).toBe(false)
    expect(result.degraded).toBe(true)
    expect(result.notes.join(' ')).toMatch(/register/)
    expect(result.notes.join(' ')).toMatch(/inject/)
  })
})
