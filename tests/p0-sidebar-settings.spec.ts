// @vitest-environment node
/**
 * WP4：`collectionSidebarWidth` 设置的 Host 半契约（实施设计 §4.1.3 / AC-33 后端面）。
 *
 * 覆盖：
 * - 默认值 260（DEFAULT_PLUGIN_SETTINGS）；
 * - PATCH 合法值通过（含边界 220/520）并原子落盘、其余字段保留（mergeSettings）；
 * - 219/521/非整数/非数字 → SettingsValidationError（httpStatus 400 / code invalid-settings，
 *   TC-API-12 语义），且失败不触碰内存与磁盘状态；
 * - 旧 settings 文件缺字段 → 构造时由 DEFAULT_PLUGIN_SETTINGS 自动补齐（mergeSettings 路径）。
 *
 * 注：P0 该字段只走 Host API（GET/PATCH /settings），不进 DSH 设置卡片——
 * declareNamespace 的 schemastery schema 刻意不含 collectionSidebarWidth（WP4 任务书约定）。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { PluginSettings } from '@dsh-api-client/shared'
import { profileLayout, resolveStorageLayout } from '@dsh-api-client/shared'
import { FileStore } from '../src/host/services/storage/file-store.ts'
import { ProfileService } from '../src/host/services/profile-service.ts'
import {
  DEFAULT_PLUGIN_SETTINGS,
  SettingsService,
  SettingsValidationError,
} from '../src/host/services/settings-service.ts'

const PROFILE_ID = 'wp4-sidebar-test'
const homes: string[] = []

afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true })
})

function makeEnv(): { service: SettingsService; store: FileStore; settingsFile: string } {
  const home = mkdtempSync(join(tmpdir(), 'dsh-api-client-wp4-settings-'))
  homes.push(home)
  const profile = ProfileService.detect({ env: { DSH_PROFILE: PROFILE_ID }, home })
  const store = new FileStore(resolveStorageLayout(home))
  store.initLayout()
  store.initProfileDir(PROFILE_ID)
  const service = new SettingsService(store, profile)
  return { service, store, settingsFile: profileLayout(store.layout, PROFILE_ID).settingsFile }
}

function readSettingsFile(file: string): Partial<PluginSettings> {
  return JSON.parse(readFileSync(file, 'utf8')) as Partial<PluginSettings>
}

describe('WP4 settings：collectionSidebarWidth 默认值（§4.1.3）', () => {
  it('DEFAULT_PLUGIN_SETTINGS 为 260；全新 profile 无 settings 文件时 get() 即 260', () => {
    expect(DEFAULT_PLUGIN_SETTINGS.collectionSidebarWidth).toBe(260)
    const { service } = makeEnv()
    expect(service.get().collectionSidebarWidth).toBe(260)
  })
})

describe('WP4 settings：合法值 PATCH 通过并落盘', () => {
  it('边界 220/520 与中间值 300 均通过；返回值与磁盘一致；其余字段保留', () => {
    const { service, settingsFile } = makeEnv()
    for (const value of [220, 520, 300]) {
      const patched = service.patch({ collectionSidebarWidth: value })
      expect(patched.collectionSidebarWidth).toBe(value)
      expect(service.get().collectionSidebarWidth).toBe(value)
      expect(readSettingsFile(settingsFile).collectionSidebarWidth).toBe(value)
    }
    // mergeSettings：标量替换不破坏其他配置项
    const withTimeout = service.patch({ defaultTimeoutMs: 5000 })
    expect(withTimeout.defaultTimeoutMs).toBe(5000)
    expect(withTimeout.collectionSidebarWidth).toBe(300)
    const onDisk = readSettingsFile(settingsFile)
    expect(onDisk.defaultTimeoutMs).toBe(5000)
    expect(onDisk.collectionSidebarWidth).toBe(300)
    expect(onDisk.followRedirects).toBe(DEFAULT_PLUGIN_SETTINGS.followRedirects)
  })
})

describe('WP4 settings：非法值 → SettingsValidationError（400 语义，TC-API-12）', () => {
  const invalid: Array<{ label: string; value: unknown }> = [
    { label: '219（低于下界）', value: 219 },
    { label: '521（高于上界）', value: 521 },
    { label: '250.5（非整数）', value: 250.5 },
    { label: '"300"（非数字）', value: '300' },
    { label: 'null（非数字）', value: null },
    { label: 'NaN（非数字）', value: Number.NaN },
  ]

  it.each(invalid)('$label → 抛 SettingsValidationError 且状态不落盘', ({ value }) => {
    const { service, settingsFile } = makeEnv()
    service.patch({ collectionSidebarWidth: 300 })
    try {
      service.patch({ collectionSidebarWidth: value })
      expect.unreachable('非法值必须抛 SettingsValidationError')
    } catch (error) {
      expect(error).toBeInstanceOf(SettingsValidationError)
      const validationError = error as SettingsValidationError
      expect(validationError.httpStatus).toBe(400)
      expect(validationError.code).toBe('invalid-settings')
      expect(validationError.message).toContain('collectionSidebarWidth')
      expect(validationError.issues.length).toBeGreaterThan(0)
    }
    // 失败不改变内存与磁盘（Host 权威状态不被非法 patch 污染）
    expect(service.get().collectionSidebarWidth).toBe(300)
    expect(readSettingsFile(settingsFile).collectionSidebarWidth).toBe(300)
  })
})

describe('WP4 settings：旧 settings 文件缺字段自动补齐（mergeSettings 路径）', () => {
  it('存量文件无 collectionSidebarWidth → 加载补 260；存量字段保留；patch 后一并落盘', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-api-client-wp4-legacy-'))
    homes.push(home)
    const profile = ProfileService.detect({ env: { DSH_PROFILE: PROFILE_ID }, home })
    const store = new FileStore(resolveStorageLayout(home))
    store.initLayout()
    store.initProfileDir(PROFILE_ID)
    const settingsFile = profileLayout(store.layout, PROFILE_ID).settingsFile
    // V0.1 时代的存量 settings：没有任何 P0 新字段
    writeFileSync(
      settingsFile,
      JSON.stringify({ defaultTimeoutMs: 8000, followRedirects: false, saveHistory: false }, null, 2),
      'utf8',
    )

    const service = new SettingsService(store, profile)
    const loaded = service.get()
    expect(loaded.collectionSidebarWidth).toBe(260) // 缺字段 → DEFAULT_PLUGIN_SETTINGS 补齐
    expect(loaded.defaultTimeoutMs).toBe(8000) // 存量字段不被默认值覆盖
    expect(loaded.followRedirects).toBe(false)
    expect(loaded.saveHistory).toBe(false)

    const patched = service.patch({ collectionSidebarWidth: 480 })
    expect(patched.collectionSidebarWidth).toBe(480)
    const onDisk = readSettingsFile(settingsFile)
    expect(onDisk.collectionSidebarWidth).toBe(480)
    expect(onDisk.defaultTimeoutMs).toBe(8000)
    expect(onDisk.followRedirects).toBe(false)
  })
})
