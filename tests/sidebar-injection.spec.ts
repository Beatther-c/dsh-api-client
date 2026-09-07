/**
 * TC-M0-03…06: sidebar DOM injection under jsdom — attach, dedup,
 * MutationObserver self-heal, dispose (AC-M0-03/04/17).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachSidebarEntry, ROW_SELECTOR } from '../src/client/dsh-adapter/sidebar-injection.ts'
import type { SidebarInjection } from '../src/client/dsh-adapter/sidebar-injection.ts'

/** Live injections are always disposed, even when an assertion fails mid-test. */
const live: SidebarInjection[] = []
const attach: typeof attachSidebarEntry = (options) => {
  const injection = attachSidebarEntry(options)
  live.push(injection)
  return injection
}

/** Shell-matching mock sidebar: column > wrapper > root(logoRow > newSession button). */
function mountMockSidebar(): { root: HTMLElement } {
  document.body.innerHTML = `
    <div data-pane="sidebar">
      <div class="sidebarWrapper">
        <div class="sidebarRoot">
          <div class="logoRow"><button class="newSessionBtn">New Session</button></div>
          <div class="workspaceBrowser"></div>
        </div>
      </div>
    </div>`
  const root = document.querySelector<HTMLElement>('.sidebarRoot')
  if (root === null) throw new Error('test fixture broken')
  return { root }
}

const entryCount = (): number => document.querySelectorAll(ROW_SELECTOR).length

afterEach(() => {
  for (const injection of live.splice(0)) injection.dispose()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('sidebar-injection (TC-M0-03…06)', () => {
  it('TC-M0-03: attach → unique entry with the semantic attribute below New Session', () => {
    const { root } = mountMockSidebar()
    const injection = attach()
    expect(injection.attached).toBe(true)
    expect(entryCount()).toBe(1)
    const entry = document.querySelector<HTMLElement>(ROW_SELECTOR)
    expect(entry).not.toBeNull()
    expect(entry!.getAttribute('data-dsh-plugin')).toBe('dsh-api-client')
    // Placed directly after the logo row that holds the New Session button.
    expect(entry!.previousElementSibling?.className).toContain('logoRow')
    expect(root.contains(entry)).toBe(true)
    injection.dispose()
  })

  it('TC-M0-04: re-attach while the entry exists (self-heal race) → still exactly one node', () => {
    mountMockSidebar()
    const first = attach()
    const second = attach()
    expect(second.attached).toBe(false)
    expect(entryCount()).toBe(1)
    first.dispose()
    second.dispose()
  })

  it('TC-M0-05: removing the entry triggers the observer → the node is rebuilt', async () => {
    mountMockSidebar()
    const injection = attach()
    expect(entryCount()).toBe(1)
    document.querySelector(ROW_SELECTOR)!.remove()
    expect(entryCount()).toBe(0)
    await vi.waitFor(() => {
      expect(entryCount()).toBe(1)
    })
    expect(injection.healCount()).toBeGreaterThan(0)
    injection.dispose()
  })

  it('TC-M0-06: dispose → entry removed; later DOM mutations do not rebuild it', async () => {
    mountMockSidebar()
    const injection = attach()
    expect(entryCount()).toBe(1)
    injection.dispose()
    expect(entryCount()).toBe(0)
    // Stir the DOM (sidebar re-render simulation): no rebuild may follow.
    const root = document.querySelector<HTMLElement>('.sidebarRoot')!
    root.append(document.createElement('div'))
    document.body.append(document.createElement('div'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(entryCount()).toBe(0)
  })
})
