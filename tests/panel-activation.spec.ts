/**
 * TC-M0-07: deep-link token parsing (three states) + activation state
 * machine (AC-M0-05 深链子项).
 */
import { describe, expect, it } from 'vitest'
import { applyDeepLink, createPanelActivation, parseDeepLink } from '../src/client/dsh-adapter/panel-activation.ts'

describe('panel-activation (TC-M0-07)', () => {
  it('deep-link token "#api-client" → activates', () => {
    const activation = createPanelActivation()
    expect(parseDeepLink('#api-client')).toBe('activate')
    expect(applyDeepLink(activation, '#api-client')).toBe('activate')
    expect(activation.isActive()).toBe(true)
  })

  it('no token (empty/missing hash) → none, does not activate', () => {
    const activation = createPanelActivation()
    expect(parseDeepLink('')).toBe('none')
    expect(parseDeepLink(undefined)).toBe('none')
    expect(parseDeepLink('#')).toBe('none')
    expect(applyDeepLink(activation, '')).toBe('none')
    expect(applyDeepLink(activation, undefined)).toBe('none')
    expect(activation.isActive()).toBe(false)
  })

  it('unknown token → unknown, does not activate, no exception', () => {
    const activation = createPanelActivation()
    expect(() => parseDeepLink('#something-else')).not.toThrow()
    expect(parseDeepLink('#something-else')).toBe('unknown')
    expect(applyDeepLink(activation, '#task-board')).toBe('unknown')
    expect(activation.isActive()).toBe(false)
  })

  it('state machine: activate/deactivate/toggle are idempotent and notify', () => {
    const seen: boolean[] = []
    const activation = createPanelActivation()
    activation.subscribe((active) => seen.push(active))
    activation.activate('test')
    activation.activate('test') // idempotent — no second notification
    expect(activation.isActive()).toBe(true)
    activation.deactivate('test')
    expect(activation.isActive()).toBe(false)
    activation.toggle('test')
    expect(activation.isActive()).toBe(true)
    expect(seen).toEqual([true, false, true])
    expect(activation.lastSource()).toBe('test')
  })
})
