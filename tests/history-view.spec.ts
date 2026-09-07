/**
 * HistoryView「重新执行」禁用回归（sweep 遗留 #2 / WP8 小修 C-2）。
 *
 * 背景：WP3 头注契约即「无 requestId 的条目（未关联已保存请求）不可重放，
 * 按钮 disabled 并注明原因」，但 sweep 实测按钮可点却静默空转（rerun 早退
 * 是唯一防线，disabled 未生效）。本 spec 用真实 DOM 渲染钉死终态：
 * - 无 requestId 条目：按钮 disabled + title 说明 + 内联可见提示（disabled
 *   按钮不触发 mouse 事件，title 不可靠，必须内联）；
 * - 有 requestId 条目：按钮可用，点击经 requestId 链重新执行（AC-32）。
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHistory } from '@dsh-api-client/shared'

const mocks = vi.hoisted(() => ({
  entries: [] as ExecutionHistory[],
  execute: vi.fn((_input: { requestId?: string; environment?: string }) => Promise.resolve(undefined)),
}))

vi.mock('../src/client/hooks/useHistory.ts', () => ({
  useHistory: () => ({
    entries: mocks.entries,
    loading: false,
    error: undefined,
    refresh: () => {},
    getEntry: () => Promise.resolve(undefined),
    clear: () => Promise.resolve(),
  }),
}))
vi.mock('../src/client/hooks/useExecute.ts', () => ({
  useExecute: () => ({ executing: false, execute: mocks.execute }),
}))

import { HistoryView } from '../src/client/views/HistoryView.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function entry(partial: Partial<ExecutionHistory> & { id: string }): ExecutionHistory {
  return {
    timestamp: 1_700_000_000_000,
    method: 'GET',
    displayUrl: 'http://example.com/draft-only',
    requestSnapshot: { method: 'GET', displayUrl: 'http://example.com/draft-only', headers: [], auth: { type: 'none' } },
    responseSnapshot: { status: 200, statusText: 'OK', headers: [], size: 2, durationMs: 5 },
    duration: 5,
    source: 'human',
    profileId: 'test-profile',
    ...partial,
  }
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  mocks.execute.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function renderAndSelect(displayUrl: string): Promise<void> {
  await act(async () => {
    root.render(createElement(HistoryView, { onBack: () => {} }))
  })
  const urlSpan = container.querySelector(`[title="${displayUrl}"]`)
  expect(urlSpan).not.toBeNull()
  const row = urlSpan!.closest('div')
  expect(row).not.toBeNull()
  await act(async () => {
    row!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function rerunButton(): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((b) => b.textContent === '重新执行')
  expect(button).toBeDefined()
  return button as HTMLButtonElement
}

describe('HistoryView 重新执行禁用（sweep 遗留 #2）', () => {
  it('无 requestId 条目：按钮 disabled + title 说明 + 内联可见提示，点击不触发执行', async () => {
    mocks.entries = [entry({ id: 'h-draft' })]
    await renderAndSelect('http://example.com/draft-only')

    const button = rerunButton()
    expect(button.disabled).toBe(true)
    expect(button.title).toContain('无法经 SecretRef 链重放')
    expect(container.textContent).toContain('未关联已保存请求，不可重放')

    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('有 requestId 条目：按钮可用，点击走 requestId 链重新执行（AC-32）', async () => {
    mocks.entries = [entry({ id: 'h-saved', requestId: 'req-1', displayUrl: 'http://example.com/saved' })]
    await renderAndSelect('http://example.com/saved')

    const button = rerunButton()
    expect(button.disabled).toBe(false)
    expect(button.title).toContain('SecretRef 链')
    expect(container.textContent).not.toContain('不可重放')

    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(mocks.execute).toHaveBeenCalledWith({ requestId: 'req-1' })
  })
})
