/**
 * P0 WP7：Generated Items UI（实施设计 §5.6/§5.8/§5.9/§4.1.2、§0.6；UX §6.2–§6.4、§9；
 * 8.1 表 #12 的 UI 半边；AC-35/36/37/39/40/42/44/47 的 client 面）。
 *
 * 覆盖：
 * - 来源/状态全枚举渲染与中文文案（含 invalid-user-override 防御性渲染——P0 runtime
 *   catalog 两条均 userOverridable=true，真实 plan 不产出该状态，用合成 preview 覆盖）；
 * - 标题拆分计数「自动生成 N 项」「发送前 N 项 · 运行时 M 项」（AC-35）；
 * - suppression checkbox 仅 suppressible 行（body/client-default）；auth/runtime 无
 *   checkbox，auth 行「前往认证设置」式跳转、runtime 行只读说明（AC-36）；
 * - suppress 切换产出 §3.3 规范化数组回调；脏输入静默规范化（client 不抛错）；
 * - 大小写不敏感覆盖显示 + disabled 用户行不触发覆盖（AC-37，消费真实 plan）；
 * - Auth 敏感行 DOM/aria/title 全文搜索零泄漏（AC-42/红线 3，真实 token 构造）；
 * - Generated 项绝不写回用户 rows（onRowsChange 不被自动项触发）；
 * - preview error 非阻断（中文失败原因区域 + 用户表格照常可编辑，UX §9）；
 * - Query 组「Auth 自动参数」渲染、恒遮罩、active/「被用户参数覆盖」（AC-40）；
 * - 折叠默认态与展开交互；
 * - hook 契约：恒 mode='preview'、绝不传 resolveSecret、environment/collection 透传、
 *   迟到结果不覆盖最新 draft（竞态序号守卫）。
 *
 * plan.ts 以「默认委托真实实现」的方式部分 mock：仅 error/race 两用例注入 Once
 * 行为，其余全部走真实 canonical buildRequestPlan（禁止第二套算法——断言的就是
 * UI 对真实 plan 输出的消费）。
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AuthConfig,
  Collection,
  Environment,
  RequestPlanPreview,
  SuppressedGeneratedHeader,
} from '@dsh-api-client/shared'

const mocks = vi.hoisted(() => ({
  buildRequestPlan: vi.fn(),
  rowsChange: vi.fn(),
  suppressedChange: vi.fn(),
  navigate: vi.fn(),
}))

// 默认委托真实 canonical plan（UI 断言的就是对真实 plan 输出的消费）；
// 仅 error/race 用例注入 Once 行为。
vi.mock('../packages/core/src/request/plan.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../packages/core/src/request/plan.ts')>()
  const real = actual.buildRequestPlan as unknown as (...args: unknown[]) => Promise<unknown>
  mocks.buildRequestPlan.mockImplementation((...args: unknown[]) => real(...args))
  return { ...actual, buildRequestPlan: mocks.buildRequestPlan }
})

import { RUNTIME_VALUE_PREVIEW, SECRET_VALUE_PREVIEW } from '../packages/core/src/request/plan.ts'
import type { RequestPlanDraft } from '../src/client/hooks/useRequestPlanPreview.ts'
import { PREVIEW_FAILED_PREFIX } from '../src/client/hooks/useRequestPlanPreview.ts'
import type { HeadersEditorProps } from '../src/client/components/request/HeadersEditor.tsx'
import { HeadersEditor } from '../src/client/components/request/HeadersEditor.tsx'
import type { ParamsEditorProps } from '../src/client/components/request/ParamsEditor.tsx'
import { ParamsEditor } from '../src/client/components/request/ParamsEditor.tsx'
import type { GeneratedHeadersSectionProps } from '../src/client/components/request/GeneratedItemsSection.tsx'
import {
  GENERATED_HEADER_STATUS_LABELS,
  GENERATED_QUERY_STATUS_LABELS,
  GENERATED_SOURCE_LABELS,
  GeneratedHeadersSection,
} from '../src/client/components/request/GeneratedItemsSection.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ---- 渲染 harness ----

let container: HTMLDivElement
let root: Root

function makeDraft(partial: Partial<RequestPlanDraft> = {}): RequestPlanDraft {
  return {
    method: 'GET',
    url: 'https://api.example.com/x',
    params: [],
    headers: [],
    auth: { type: 'none' },
    body: { type: 'none' },
    ...partial,
  }
}

function makeCollection(auth?: AuthConfig): Collection {
  return {
    id: 'c1',
    name: '示例集合',
    ...(auth !== undefined ? { auth } : {}),
    variables: [],
    folders: [],
    requests: [],
    createdAt: 0,
    updatedAt: 0,
  }
}

const devEnv: Environment = {
  id: 'e1',
  name: 'dev',
  variables: [{ key: 'host', currentValue: 'example.com', secret: false, enabled: true }],
}

interface RenderContext {
  environment?: Environment
  collection?: Collection
}

async function renderHeaders(draft: RequestPlanDraft, context: RenderContext = {}): Promise<void> {
  const props: HeadersEditorProps = {
    draft,
    ...context,
    onRowsChange: mocks.rowsChange,
    onSuppressedChange: mocks.suppressedChange,
    onNavigate: mocks.navigate,
  }
  await act(async () => {
    root.render(createElement(HeadersEditor, props))
  })
  await act(async () => {}) // 排空 buildRequestPlan promise 链的多级 microtask
}

async function renderParams(draft: RequestPlanDraft, context: RenderContext = {}): Promise<void> {
  const props: ParamsEditorProps = {
    draft,
    ...context,
    onRowsChange: mocks.rowsChange,
    onNavigate: mocks.navigate,
  }
  await act(async () => {
    root.render(createElement(ParamsEditor, props))
  })
  await act(async () => {})
}

async function renderSection(preview: RequestPlanPreview, suppressed: readonly unknown[] = []): Promise<void> {
  const props: GeneratedHeadersSectionProps = {
    preview,
    suppressed,
    onSuppressedChange: mocks.suppressedChange,
    onNavigate: mocks.navigate,
  }
  await act(async () => {
    root.render(createElement(GeneratedHeadersSection, props))
  })
}

// ---- 查询助手 ----

function headersSection(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-dsh-api-client="generated-headers-section"]')
}
function querySection(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-dsh-api-client="generated-query-section"]')
}
function errorRegion(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-dsh-api-client="generated-items-error"]')
}
function sectionOrThrow(section: HTMLElement | null): HTMLElement {
  expect(section, '自动项分组应已渲染').not.toBeNull()
  return section!
}
function toggleOf(section: HTMLElement): HTMLButtonElement {
  const toggle = section.querySelector<HTMLButtonElement>('[data-dsh-api-client="generated-items-toggle"]')
  expect(toggle).not.toBeNull()
  return toggle!
}
function titleOf(section: HTMLElement): string {
  return section.querySelector('[data-dsh-api-client="generated-items-title"]')?.textContent ?? ''
}
function countsOf(section: HTMLElement): string {
  return section.querySelector('[data-dsh-api-client="generated-items-counts"]')?.textContent ?? ''
}
function headerRows(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-dsh-api-client="generated-header-row"]')]
}
function queryRows(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-dsh-api-client="generated-query-row"]')]
}
function rowByName(rowsList: HTMLElement[], name: string): HTMLElement {
  const row = rowsList.find((candidate) => candidate.dataset.name === name.toLowerCase())
  expect(row, `应存在自动项行 ${name}`).toBeDefined()
  return row!
}
function cell(row: HTMLElement, key: 'name' | 'value' | 'source' | 'status'): HTMLElement {
  const element = row.querySelector<HTMLElement>(`[data-cell="${key}"]`)
  expect(element).not.toBeNull()
  return element!
}
function checkboxOf(row: HTMLElement): HTMLInputElement | null {
  return row.querySelector<HTMLInputElement>('input[type="checkbox"]')
}
function kvTableInputs(): NodeListOf<HTMLInputElement> {
  return container.querySelectorAll<HTMLInputElement>('[data-dsh-api-client="kv-table"] tbody input')
}

// ---- 事件助手 ----

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}
function typeInto(input: HTMLInputElement, value: string): void {
  act(() => {
    // React 对受控 input 装了 value tracker（own-property setter 会同步 tracker，
    // 直接赋值 + dispatch 会被 updateValueIfChanged 去重吞掉）；用原型 setter
    // 绕过 tracker——testing-library fireEvent.change 的同款机制（本仓实证）。
    const nativeSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set
    expect(nativeSetter).toBeDefined()
    nativeSetter!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** 展开自动项分组（默认折叠——§5.9；同一 root 多轮渲染时组件不重挂载，展开态跨 draft 变化保留——编辑器不因输入而收起，幂等处理）。 */
function expand(section: HTMLElement): void {
  const toggle = toggleOf(section)
  if (toggle.getAttribute('aria-expanded') === 'true') return
  click(toggle)
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
}

/** 敏感泄漏断言（红线 3）：DOM 文本 + 全部属性（aria-label/title/data-*）+ document 级全文搜索。 */
function assertNoLeak(secret: string): void {
  expect(container.innerHTML).not.toContain(secret)
  expect(document.body.innerHTML).not.toContain(secret)
  for (const element of container.querySelectorAll('*')) {
    for (const attribute of element.attributes) {
      expect(attribute.value, `属性 ${attribute.name} 泄漏`).not.toContain(secret)
    }
    expect(element.textContent ?? '').not.toContain(secret)
  }
}

beforeEach(() => {
  mocks.buildRequestPlan.mockClear()
  mocks.rowsChange.mockClear()
  mocks.suppressedChange.mockClear()
  mocks.navigate.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

// ==================================================================
// 来源/状态全枚举渲染（合成 preview 直渲 GeneratedHeadersSection）
// ==================================================================

const syntheticPreview: RequestPlanPreview = {
  headers: [
    { name: 'Content-Type', valuePreview: 'application/json', source: 'body', status: 'active', sensitive: false, suppressible: true },
    { name: 'Authorization', valuePreview: SECRET_VALUE_PREVIEW, source: 'auth', status: 'overridden', sensitive: true, suppressible: false },
    { name: 'Accept', valuePreview: '*/*', source: 'client-default', status: 'suppressed', sensitive: false, suppressible: true },
    { name: 'Host', valuePreview: RUNTIME_VALUE_PREVIEW, source: 'runtime', status: 'runtime-pending', sensitive: false, suppressible: false },
    { name: 'Content-Length', valuePreview: RUNTIME_VALUE_PREVIEW, source: 'runtime', status: 'invalid-user-override', sensitive: false, suppressible: false },
  ],
  query: [],
  preSendHeaderCount: 3,
  runtimeHeaderCount: 2,
}

describe('WP7 全枚举渲染：来源/状态中文文案（AC-35/AC-44/AC-47）', () => {
  it('四种来源、五种状态逐行渲染中文标签；名称保留展示拼写；计数拆分标题', async () => {
    await renderSection(syntheticPreview)
    const section = sectionOrThrow(headersSection())
    // 默认折叠：标题计数可见，行不渲染
    expect(titleOf(section)).toBe('自动生成 5 项')
    expect(countsOf(section)).toBe('发送前 3 项 · 运行时 2 项')
    expect(headerRows()).toHaveLength(0)

    expand(section)
    const rows = headerRows()
    expect(rows).toHaveLength(5)

    const expected: Array<[string, string, string, string]> = [
      // [name, data-source, 来源文案, 状态文案]
      ['Content-Type', 'body', '来自 Body', '启用'],
      ['Authorization', 'auth', '来自 Auth', '被用户值覆盖'],
      ['Accept', 'client-default', '来自客户端默认值', '已停用'],
      ['Host', 'runtime', '来自运行时', '发送时计算'],
      ['Content-Length', 'runtime', '来自运行时', '用户覆盖无效'],
    ]
    for (const [name, source, sourceLabel, statusLabel] of expected) {
      const row = rowByName(rows, name)
      expect(row.dataset.source).toBe(source)
      expect(cell(row, 'name').textContent).toBe(name)
      expect(cell(row, 'source').textContent).toBe(sourceLabel)
      expect(cell(row, 'status').textContent).toBe(statusLabel)
    }
    // 值预览逐行（敏感/runtime 恒占位——§4.1.2/§0.6）
    expect(cell(rowByName(rows, 'Content-Type'), 'value').textContent).toBe('application/json')
    expect(cell(rowByName(rows, 'Authorization'), 'value').textContent).toBe(SECRET_VALUE_PREVIEW)
    expect(cell(rowByName(rows, 'Accept'), 'value').textContent).toBe('*/*')
    expect(cell(rowByName(rows, 'Host'), 'value').textContent).toBe(RUNTIME_VALUE_PREVIEW)
    expect(cell(rowByName(rows, 'Content-Length'), 'value').textContent).toBe(RUNTIME_VALUE_PREVIEW)
    // data-status 契约（后续选择器稳定性）
    expect(rowByName(rows, 'Host').dataset.status).toBe('runtime-pending')
    expect(rowByName(rows, 'Content-Length').dataset.status).toBe('invalid-user-override')
  })

  it('checkbox 仅 suppressible 行（body/client-default）；auth/runtime 行无 checkbox（AC-36）', async () => {
    await renderSection(syntheticPreview)
    expand(sectionOrThrow(headersSection()))
    const rows = headerRows()
    expect(checkboxOf(rowByName(rows, 'Content-Type'))).not.toBeNull()
    expect(checkboxOf(rowByName(rows, 'Accept'))).not.toBeNull()
    expect(checkboxOf(rowByName(rows, 'Authorization'))).toBeNull()
    expect(checkboxOf(rowByName(rows, 'Host'))).toBeNull()
    expect(checkboxOf(rowByName(rows, 'Content-Length'))).toBeNull()
    // checkbox 勾选态跟随 suppressed 状态
    expect(checkboxOf(rowByName(rows, 'Accept'))!.checked).toBe(true)
    expect(checkboxOf(rowByName(rows, 'Content-Type'))!.checked).toBe(false)
    // aria-label 只含名称与来源标签（不含任何值材料）
    expect(checkboxOf(rowByName(rows, 'Accept'))!.getAttribute('aria-label')).toBe('停用自动生成的 Header Accept（来自客户端默认值）')
  })

  it('来源点击：body/auth 是可跳转按钮；client-default 显示停用说明、runtime 只读说明，均不可跳转', async () => {
    await renderSection(syntheticPreview)
    expand(sectionOrThrow(headersSection()))
    const rows = headerRows()

    const bodyLink = cell(rowByName(rows, 'Content-Type'), 'source').querySelector<HTMLButtonElement>('button')
    expect(bodyLink).not.toBeNull()
    expect(bodyLink!.dataset.target).toBe('body')
    click(bodyLink!)
    expect(mocks.navigate).toHaveBeenCalledWith('body')

    const authLink = cell(rowByName(rows, 'Authorization'), 'source').querySelector<HTMLButtonElement>('button')
    expect(authLink).not.toBeNull()
    expect(authLink!.dataset.target).toBe('auth')
    expect(authLink!.getAttribute('title')).toContain('前往认证设置')
    click(authLink!)
    expect(mocks.navigate).toHaveBeenCalledWith('auth')

    // client-default：非按钮 + 停用说明
    const defaultCell = cell(rowByName(rows, 'Accept'), 'source')
    expect(defaultCell.querySelector('button')).toBeNull()
    expect(defaultCell.querySelector('span')?.getAttribute('title')).toContain('取消勾选即可停用')
    // runtime：非按钮 + 只读说明
    const runtimeCell = cell(rowByName(rows, 'Host'), 'source')
    expect(runtimeCell.querySelector('button')).toBeNull()
    expect(runtimeCell.querySelector('span')?.getAttribute('title')).toContain('只读、不可停用')
    // 点击说明文本不触发跳转
    mocks.navigate.mockClear()
    click(defaultCell)
    click(runtimeCell)
    expect(mocks.navigate).not.toHaveBeenCalled()
  })

  it('状态补充说明：suppressed/overridden/invalid-user-override 的 title 中文说明', async () => {
    await renderSection(syntheticPreview)
    expand(sectionOrThrow(headersSection()))
    const rows = headerRows()
    expect(cell(rowByName(rows, 'Accept'), 'status').getAttribute('title')).toContain('仍继续生效')
    expect(cell(rowByName(rows, 'Authorization'), 'status').getAttribute('title')).toContain('用户值优先')
    // invalid-user-override：按 §6.3「标为无效 / 发送前清晰错误」渲染说明，不做虚假覆盖承诺
    const invalidTitle = cell(rowByName(rows, 'Content-Length'), 'status').getAttribute('title') ?? ''
    expect(invalidTitle).toContain('无法覆盖')
    expect(invalidTitle).toContain('清晰错误')
  })

  it('文案常量表全枚举无缺漏（防止未来新增枚举值时漏配中文）', () => {
    expect(Object.values(GENERATED_SOURCE_LABELS)).toEqual(['来自 Body', '来自 Auth', '来自客户端默认值', '来自运行时'])
    expect(GENERATED_HEADER_STATUS_LABELS).toEqual({
      active: '启用',
      suppressed: '已停用',
      overridden: '被用户值覆盖',
      'runtime-pending': '发送时计算',
      'invalid-user-override': '用户覆盖无效',
    })
    expect(GENERATED_QUERY_STATUS_LABELS).toEqual({ active: '启用', overridden: '被用户参数覆盖' })
  })
})

// ==================================================================
// HeadersEditor 集成（真实 canonical plan）
// ==================================================================

describe('WP7 HeadersEditor：两层展示 + 计数标题 + 折叠交互（AC-35）', () => {
  it('POST json：上层用户表格 + 下层「自动生成 4 项 / 发送前 2 项 · 运行时 2 项」；默认折叠、展开/收起交互', async () => {
    await renderHeaders(makeDraft({ method: 'POST', body: { type: 'json', json: '{"a":1}' } }))
    // 上层：用户 KeyValueTable 保留（含中文添加按钮）
    expect(container.querySelector('[data-dsh-api-client="kv-table"]')).not.toBeNull()
    expect(container.textContent).toContain('+ 添加 Header')
    expect(container.textContent).toContain('敏感 Header（Authorization、Cookie 等）在输入时以掩码显示。')

    // 下层：默认折叠——标题计数可见、行不渲染
    const section = sectionOrThrow(headersSection())
    expect(titleOf(section)).toBe('自动生成 4 项')
    expect(countsOf(section)).toBe('发送前 2 项 · 运行时 2 项')
    expect(toggleOf(section).getAttribute('aria-expanded')).toBe('false')
    expect(headerRows()).toHaveLength(0)

    // 展开：Content-Type(body)/Accept(client-default)/Host+Content-Length(runtime)
    expand(section)
    const rows = headerRows()
    expect(rows).toHaveLength(4)
    expect(rows.map((row) => `${row.dataset.name}:${row.dataset.source}:${row.dataset.status}`)).toEqual([
      'content-type:body:active',
      'accept:client-default:active',
      'host:runtime:runtime-pending',
      'content-length:runtime:runtime-pending',
    ])
    expect(cell(rowByName(rows, 'Content-Type'), 'value').textContent).toBe('application/json')
    expect(cell(rowByName(rows, 'Host'), 'value').textContent).toBe(RUNTIME_VALUE_PREVIEW)

    // 收起
    click(toggleOf(section))
    expect(toggleOf(section).getAttribute('aria-expanded')).toBe('false')
    expect(headerRows()).toHaveLength(0)
  })

  it('bearer auth：Authorization 行 来自 Auth、恒遮罩、无 checkbox；GET 无 body 计数 = 发送前 2 · 运行时 1', async () => {
    await renderHeaders(makeDraft({ auth: { type: 'bearer', token: 'x' } }))
    const section = sectionOrThrow(headersSection())
    expect(titleOf(section)).toBe('自动生成 3 项')
    expect(countsOf(section)).toBe('发送前 2 项 · 运行时 1 项')
    expand(section)
    const authRow = rowByName(headerRows(), 'Authorization')
    expect(authRow.dataset.source).toBe('auth')
    expect(authRow.dataset.status).toBe('active')
    expect(cell(authRow, 'value').textContent).toBe(SECRET_VALUE_PREVIEW)
    expect(checkboxOf(authRow)).toBeNull()
    expect(cell(authRow, 'source').querySelector('button')?.dataset.target).toBe('auth')
  })

  it('form-data：Content-Type 预览为占位 boundary，不伪造最终值（§5.7/AC-44）', async () => {
    await renderHeaders(makeDraft({ method: 'POST', body: { type: 'form-data', fields: [] } }))
    expand(sectionOrThrow(headersSection()))
    expect(cell(rowByName(headerRows(), 'Content-Type'), 'value').textContent).toBe('multipart/form-data; boundary=<发送时生成>')
  })
})

describe('WP7 HeadersEditor：大小写不敏感覆盖（AC-37，真实 plan）', () => {
  it('用户 x-api-key（enabled，大小写不同拼写）→ auth 行「被用户值覆盖」；用户 CONTENT-TYPE → Body 行被覆盖', async () => {
    await renderHeaders(
      makeDraft({
        method: 'POST',
        body: { type: 'json', json: '{}' },
        headers: [
          { key: 'x-api-key', value: 'user-literal', enabled: true },
          { key: 'CONTENT-TYPE', value: 'text/csv', enabled: true },
        ],
        auth: { type: 'apikey', key: 'X-API-Key', value: 'auth-material', in: 'header' },
      }),
    )
    expand(sectionOrThrow(headersSection()))
    const rows = headerRows()
    const authRow = rowByName(rows, 'X-API-Key')
    expect(authRow.dataset.status).toBe('overridden')
    expect(cell(authRow, 'status').textContent).toBe('被用户值覆盖')
    const ctRow = rowByName(rows, 'Content-Type')
    expect(ctRow.dataset.status).toBe('overridden')
    expect(cell(ctRow, 'status').textContent).toBe('被用户值覆盖')
    // Accept 不受影响
    expect(rowByName(rows, 'Accept').dataset.status).toBe('active')
  })

  it('disabled 用户行不参与覆盖：同名禁用行存在时自动项仍「启用」', async () => {
    await renderHeaders(
      makeDraft({
        method: 'POST',
        body: { type: 'json', json: '{}' },
        headers: [
          { key: 'X-API-Key', value: 'off', enabled: false },
          { key: 'content-type', value: 'off', enabled: false },
        ],
        auth: { type: 'apikey', key: 'X-API-Key', value: 'auth-material', in: 'header' },
      }),
    )
    expand(sectionOrThrow(headersSection()))
    const rows = headerRows()
    expect(rowByName(rows, 'X-API-Key').dataset.status).toBe('active')
    expect(cell(rowByName(rows, 'X-API-Key'), 'status').textContent).toBe('启用')
    expect(rowByName(rows, 'Content-Type').dataset.status).toBe('active')
  })
})

describe('WP7 HeadersEditor：suppression 切换产出规范化数组（§3.3/§5.8，AC-36）', () => {
  it('勾选 Accept → 回调 [{name:accept,source:client-default}]（name 恒 lowercase）；再渲染已停用态可取消', async () => {
    const draft = makeDraft({ method: 'POST', body: { type: 'json', json: '{}' } })
    await renderHeaders(draft)
    expand(sectionOrThrow(headersSection()))
    const acceptRow = rowByName(headerRows(), 'Accept')
    expect(cell(acceptRow, 'status').textContent).toBe('启用')

    click(checkboxOf(acceptRow)!)
    expect(mocks.suppressedChange).toHaveBeenCalledTimes(1)
    expect(mocks.suppressedChange).toHaveBeenCalledWith([{ name: 'accept', source: 'client-default' }])
    // Generated 项绝不写回用户 rows
    expect(mocks.rowsChange).not.toHaveBeenCalled()

    // 父层写回后的形态：suppressed 生效 → 状态「已停用」+ checkbox 勾选
    mocks.suppressedChange.mockClear()
    await renderHeaders(makeDraft({ ...draft, suppressedGeneratedHeaders: [{ name: 'accept', source: 'client-default' }] }))
    expand(sectionOrThrow(headersSection()))
    const suppressedRow = rowByName(headerRows(), 'Accept')
    expect(suppressedRow.dataset.status).toBe('suppressed')
    expect(cell(suppressedRow, 'status').textContent).toBe('已停用')
    expect(checkboxOf(suppressedRow)!.checked).toBe(true)
    // 同名不同来源互不误伤：Content-Type(body) 仍启用且有独立 checkbox
    expect(rowByName(headerRows(), 'Content-Type').dataset.status).toBe('active')

    // 取消勾选 → 回调 []
    click(checkboxOf(suppressedRow)!)
    expect(mocks.suppressedChange).toHaveBeenCalledWith([])
    expect(mocks.rowsChange).not.toHaveBeenCalled()
  })

  it('追加第二条：已有 accept 停用时勾选 Content-Type → 数组含两条且 (name,source) 精确', async () => {
    await renderHeaders(
      makeDraft({
        method: 'POST',
        body: { type: 'json', json: '{}' },
        suppressedGeneratedHeaders: [{ name: 'accept', source: 'client-default' }],
      }),
    )
    expand(sectionOrThrow(headersSection()))
    click(checkboxOf(rowByName(headerRows(), 'Content-Type'))!)
    expect(mocks.suppressedChange).toHaveBeenCalledWith([
      { name: 'accept', source: 'client-default' },
      { name: 'content-type', source: 'body' },
    ])
  })

  it('脏输入静默规范化：非法条目丢弃、name trim+lowercase、去重——渲染不失败、回调数组合法（client 不抛错）', async () => {
    const dirty = [
      '垃圾条目',
      null,
      { name: ' ACCEPT ', source: 'client-default' },
      { name: 'x-sentinel', source: 'auth' }, // auth 不可 suppression → 丢弃
      { name: 'content-type', source: 'unknown-source' }, // 未知 source → 丢弃
      { name: 'accept', source: 'client-default' }, // 重复 → 去重
    ] as unknown as SuppressedGeneratedHeader[]
    await renderHeaders(makeDraft({ method: 'POST', body: { type: 'json', json: '{}' }, suppressedGeneratedHeaders: dirty }))
    const section = sectionOrThrow(headersSection())
    expand(section)
    // 读取侧宽容：' ACCEPT ' 规范化命中 → Accept 行已停用
    expect(rowByName(headerRows(), 'Accept').dataset.status).toBe('suppressed')
    expect(rowByName(headerRows(), 'Content-Type').dataset.status).toBe('active')

    click(checkboxOf(rowByName(headerRows(), 'Content-Type'))!)
    expect(mocks.suppressedChange).toHaveBeenCalledTimes(1)
    expect(mocks.suppressedChange).toHaveBeenCalledWith([
      { name: 'accept', source: 'client-default' },
      { name: 'content-type', source: 'body' },
    ])
  })
})

describe('WP7 HeadersEditor：Generated 项只读、绝不写回用户 rows（UX §6.2）', () => {
  it('自动项行无可编辑输入；展开/收起与 suppression 切换全程 onRowsChange 零调用', async () => {
    await renderHeaders(
      makeDraft({
        method: 'POST',
        body: { type: 'json', json: '{}' },
        headers: [{ key: 'X-Keep', value: 'v', enabled: true }],
        auth: { type: 'bearer', token: 'tk' },
      }),
    )
    const section = sectionOrThrow(headersSection())
    expand(section)
    for (const row of headerRows()) {
      expect(row.querySelector('input:not([type="checkbox"])')).toBeNull()
    }
    click(toggleOf(section)) // 收起
    expand(section) // 再展开
    click(checkboxOf(rowByName(headerRows(), 'Accept'))!)
    expect(mocks.rowsChange).not.toHaveBeenCalled()
    expect(mocks.suppressedChange).toHaveBeenCalledTimes(1)
    // 用户表格行数不受自动项影响（X-Keep 一行 + 表格自身结构）
    expect(container.querySelectorAll('[data-dsh-api-client="kv-table"] tbody tr')).toHaveLength(1)
  })

  it('用户表格照常可编辑：修改用户 Header 值 → onRowsChange 收到新 rows；敏感行掩码保留', async () => {
    await renderHeaders(
      makeDraft({ headers: [{ key: 'Authorization', value: 'user-literal', enabled: true }] }),
    )
    const inputs = kvTableInputs()
    // 行内输入序：enabled checkbox、key、value、description
    const valueInput = inputs[2]!
    expect(valueInput.type).toBe('password') // §7.4 敏感遮罩保留
    typeInto(valueInput, 'user-literal-2')
    expect(mocks.rowsChange).toHaveBeenCalledTimes(1)
    expect(mocks.rowsChange).toHaveBeenCalledWith([{ key: 'Authorization', value: 'user-literal-2', enabled: true }])
  })
})

describe('WP7 敏感边界（AC-42/AC-39/红线 3）：真实值零泄漏', () => {
  it('bearer 真实 token：DOM 文本/aria-label/title/data-* 全文搜索零命中，遮罩恒在', async () => {
    const TOKEN = 'sk-REAL-BEARER-TOKEN-9x7-DO-NOT-LEAK'
    await renderHeaders(makeDraft({ auth: { type: 'bearer', token: TOKEN } }))
    expand(sectionOrThrow(headersSection()))
    assertNoLeak(TOKEN)
    assertNoLeak('Bearer ')
    expect(cell(rowByName(headerRows(), 'Authorization'), 'value').textContent).toBe(SECRET_VALUE_PREVIEW)
  })

  it('basic 真实密码与 Header API Key 真实值：零泄漏', async () => {
    const PASSWORD = 'PW-SECRET-88-DO-NOT-LEAK'
    await renderHeaders(makeDraft({ auth: { type: 'basic', username: 'user1', password: PASSWORD } }))
    expand(sectionOrThrow(headersSection()))
    assertNoLeak(PASSWORD)
    expect(cell(rowByName(headerRows(), 'Authorization'), 'value').textContent).toBe(SECRET_VALUE_PREVIEW)

    // Header API Key（值 + 派生 Header 名保留展示，值恒遮罩）
    await renderHeaders(makeDraft({ auth: { type: 'apikey', key: 'X-Api-Key', value: 'AK-SECRET-123-DO-NOT-LEAK', in: 'header' } }))
    expand(sectionOrThrow(headersSection()))
    assertNoLeak('AK-SECRET-123-DO-NOT-LEAK')
    const row = rowByName(headerRows(), 'X-Api-Key')
    expect(cell(row, 'name').textContent).toBe('X-Api-Key')
    expect(cell(row, 'value').textContent).toBe(SECRET_VALUE_PREVIEW)
  })

  it('collection inherit 链：集合级 bearer token 零泄漏；无 collection 时 inherit → 无 Authorization 行', async () => {
    const COLL_TOKEN = 'COLL-TOKEN-abc123-DO-NOT-LEAK'
    await renderHeaders(makeDraft({ auth: { type: 'inherit' } }), {
      collection: makeCollection({ type: 'bearer', token: COLL_TOKEN }),
    })
    const section = sectionOrThrow(headersSection())
    expand(section)
    expect(rowByName(headerRows(), 'Authorization').dataset.source).toBe('auth')
    assertNoLeak(COLL_TOKEN)

    await renderHeaders(makeDraft({ auth: { type: 'inherit' } }))
    const section2 = sectionOrThrow(headersSection())
    expect(titleOf(section2)).toBe('自动生成 2 项') // inherit 无 collection → none：Accept + Host
    expect(headerRows().map((row) => row.dataset.name)).toEqual(['accept', 'host'])
  })
})

describe('WP7 preview 失败非阻断（UX §9）', () => {
  it('HeadersEditor：中文失败原因区域渲染、自动项分组缺席、用户表格照常可编辑', async () => {
    mocks.buildRequestPlan.mockRejectedValueOnce(new Error('preview-boom'))
    await renderHeaders(makeDraft({ headers: [{ key: 'X-Foo', value: '', enabled: true }] }))
    const region = errorRegion()
    expect(region).not.toBeNull()
    expect(region!.getAttribute('role')).toBe('alert')
    expect(region!.textContent).toContain(PREVIEW_FAILED_PREFIX) // 自动生成项预览失败
    expect(region!.textContent).toContain('preview-boom')
    expect(region!.textContent).toMatch(/[\u4e00-\u9fff]/)
    expect(headersSection()).toBeNull()
    // 用户表格可编辑（不阻断）
    const valueInput = kvTableInputs()[2]!
    typeInto(valueInput, 'bar')
    expect(mocks.rowsChange).toHaveBeenCalledWith([{ key: 'X-Foo', value: 'bar', enabled: true }])
  })

  it('ParamsEditor：失败原因区域渲染、参数表格照常可编辑、Query 分组缺席', async () => {
    mocks.buildRequestPlan.mockRejectedValueOnce(new Error('preview-boom-2'))
    await renderParams(makeDraft({ params: [{ key: 'a', value: '', enabled: true }] }))
    const region = errorRegion()
    expect(region).not.toBeNull()
    expect(region!.textContent).toContain('preview-boom-2')
    expect(querySection()).toBeNull()
    const valueInput = kvTableInputs()[2]!
    typeInto(valueInput, '1')
    expect(mocks.rowsChange).toHaveBeenCalledWith([{ key: 'a', value: '1', enabled: true }])
  })

  it('失败后 draft 继续变化 → 重新计算成功，错误区域消失、自动项恢复', async () => {
    mocks.buildRequestPlan.mockRejectedValueOnce(new Error('transient'))
    await renderHeaders(makeDraft())
    expect(errorRegion()).not.toBeNull()
    await renderHeaders(makeDraft({ url: 'https://api.example.com/y' }))
    expect(errorRegion()).toBeNull()
    expect(sectionOrThrow(headersSection())).not.toBeNull()
  })
})

describe('WP7 hook 契约：恒 preview 模式、上下文透传、竞态守卫（红线 3/UX §6.4）', () => {
  it('buildRequestPlan 恒以 mode=preview 调用、绝不传 resolveSecret；environment/collection 原样透传', async () => {
    const collection = makeCollection()
    await renderHeaders(makeDraft({ url: 'https://{{host}}/x' }), { environment: devEnv, collection })
    expect(mocks.buildRequestPlan).toHaveBeenCalledTimes(1)
    const call = mocks.buildRequestPlan.mock.calls[0]!
    const request = call[0] as { url: string; suppressedGeneratedHeaders?: unknown }
    const options = call[1] as Record<string, unknown>
    expect(options.mode).toBe('preview')
    expect(options.environment).toBe(devEnv)
    expect(options.collection).toBe(collection)
    expect('resolveSecret' in options).toBe(false)
    // preview 不解析变量：draft URL 原样进入 plan（{{host}} 保留）
    expect(request.url).toBe('https://{{host}}/x')
    expect(request.suppressedGeneratedHeaders).toBeUndefined()
  })

  it('迟到结果不覆盖最新 draft：旧调用晚归时仍显示最新计数（序号守卫 + 取消）', async () => {
    let resolveStale: (value: unknown) => void = () => {}
    mocks.buildRequestPlan.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStale = resolve
        }),
    )
    // 第一次渲染（POST json，若成功应为 4 项）——挂起
    await renderHeaders(makeDraft({ method: 'POST', body: { type: 'json', json: '{}' } }))
    expect(headersSection()).toBeNull() // 计算中：自动项区域缺席，但编辑不阻断
    expect(container.querySelector('[data-dsh-api-client="kv-table"]')).not.toBeNull()

    // 第二次渲染（GET 无 body → 真实 plan 立即成功 = 2 项）
    await renderHeaders(makeDraft())
    const section = sectionOrThrow(headersSection())
    expect(titleOf(section)).toBe('自动生成 2 项')

    // 迟到的第一次结果（伪造 18 项）归航 → 必须被丢弃
    await act(async () => {
      resolveStale({
        mode: 'preview',
        preview: { headers: [], query: [], preSendHeaderCount: 9, runtimeHeaderCount: 9 },
        authType: 'none',
      })
    })
    expect(titleOf(sectionOrThrow(headersSection()))).toBe('自动生成 2 项')
  })
})

// ==================================================================
// ParamsEditor：Auth 自动参数（Query 组）
// ==================================================================

describe('WP7 ParamsEditor：「Auth 自动参数」组（AC-40/§5.6）', () => {
  it('apikey in query：分组默认折叠、行恒遮罩、状态「启用」、无 checkbox、来源可跳转 auth', async () => {
    await renderParams(
      makeDraft({ auth: { type: 'apikey', key: 'api_key', value: 'QUERY-SECRET-k3y-DO-NOT-LEAK', in: 'query' } }),
    )
    // 用户参数表格保留（含 URL 同步提示中文文案）
    expect(container.textContent).toContain('参数行与 URL query 自动双向同步。')

    const section = sectionOrThrow(querySection())
    expect(titleOf(section)).toBe('Auth 自动参数')
    expect(countsOf(section)).toBe('共 1 项')
    expect(toggleOf(section).getAttribute('aria-expanded')).toBe('false')
    expect(queryRows()).toHaveLength(0)

    expand(section)
    const rows = queryRows()
    expect(rows).toHaveLength(1)
    const row = rowByName(rows, 'api_key')
    expect(row.dataset.source).toBe('auth')
    expect(row.dataset.status).toBe('active')
    expect(cell(row, 'value').textContent).toBe(SECRET_VALUE_PREVIEW)
    expect(cell(row, 'status').textContent).toBe('启用')
    expect(row.querySelector('input')).toBeNull() // 无 checkbox、无任何输入
    assertNoLeak('QUERY-SECRET-k3y-DO-NOT-LEAK')

    const authLink = cell(row, 'source').querySelector<HTMLButtonElement>('button')
    expect(authLink).not.toBeNull()
    expect(authLink!.textContent).toBe('来自 Auth')
    click(authLink!)
    expect(mocks.navigate).toHaveBeenCalledWith('auth')
    expect(mocks.rowsChange).not.toHaveBeenCalled()
  })

  it('覆盖状态：enabled 同名用户参数（Params 行或 URL query）→「被用户参数覆盖」；disabled 行仍生成', async () => {
    // Params 表 enabled 同名行
    await renderParams(
      makeDraft({
        params: [{ key: 'api_key', value: 'user-val', enabled: true }],
        auth: { type: 'apikey', key: 'api_key', value: 'q-secret', in: 'query' },
      }),
    )
    expand(sectionOrThrow(querySection()))
    const overridden = rowByName(queryRows(), 'api_key')
    expect(overridden.dataset.status).toBe('overridden')
    expect(cell(overridden, 'status').textContent).toBe('被用户参数覆盖')

    // URL query 同名（恒视为 enabled）
    await renderParams(
      makeDraft({
        url: 'https://api.example.com/x?api_key=url-val',
        auth: { type: 'apikey', key: 'api_key', value: 'q-secret', in: 'query' },
      }),
    )
    expand(sectionOrThrow(querySection()))
    expect(rowByName(queryRows(), 'api_key').dataset.status).toBe('overridden')

    // 仅 disabled 同名行 → 仍生成（启用）
    await renderParams(
      makeDraft({
        params: [{ key: 'api_key', value: 'off', enabled: false }],
        auth: { type: 'apikey', key: 'api_key', value: 'q-secret', in: 'query' },
      }),
    )
    expand(sectionOrThrow(querySection()))
    expect(rowByName(queryRows(), 'api_key').dataset.status).toBe('active')
  })

  it('无 Query API Key 贡献时整组不渲染（none/bearer/apikey-in-header）', async () => {
    await renderParams(makeDraft())
    expect(querySection()).toBeNull()
    await renderParams(makeDraft({ auth: { type: 'bearer', token: 'tk' } }))
    expect(querySection()).toBeNull()
    await renderParams(makeDraft({ auth: { type: 'apikey', key: 'X-Api-Key', value: 'v', in: 'header' } }))
    expect(querySection()).toBeNull()
  })

  it('用户参数编码预览保留（既有能力不回归）', async () => {
    await renderParams(makeDraft({ params: [{ key: 'a', value: '1 2', enabled: true }] }))
    expect(container.textContent).toContain('编码后 query 预览：')
    expect(container.querySelector('code')?.textContent).toBe('?a=1%202')
  })
})
