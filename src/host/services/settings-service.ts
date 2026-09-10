/**
 * Settings service（§3.4）：profile-scoped `settings.json` 读写 + §25 配置项
 * schema 校验（非法值 400，TC-API-12）。
 *
 * 同时吸收 M0 settings-namespace-probe 的 Host 命名空间声明（§3.5 处置：
 * 探针文件删除，installSection/register 双路径 + schemastery 裸说明符/file-URL
 * 双路径逻辑折叠进 declareNamespace）。双重门控（V-09 实测）：client keyed
 * 注册必要不充分，Host 须在 describe 镜声明同名命名空间，设置卡片才渲染。
 *
 * profile unresolved → settings 读写 fail-closed 显式报错（§4.4）。
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentPermissionPolicy, NetworkPolicy, PluginSettings } from '@dsh-api-client/shared'
import { profileLayout } from '@dsh-api-client/shared'
import { DEFAULT_NETWORK_POLICY } from '@dsh-api-client/core'
import { FileStore } from './storage/file-store.ts'
import { ProfileService } from './profile-service.ts'
import { resolveDshHome } from '../dsh-home.ts'
import type { HostLog } from '../host-log.ts'

/** Host settings 命名空间（client 卡片 key 必须同名，V-09 双重门控）。 */
export const SETTINGS_NAMESPACE = 'api-client'

/** §25 配置项默认值（profile scope；networkPolicy 默认即 §24.3 fail-closed 基线）。 */
export const DEFAULT_PLUGIN_SETTINGS: PluginSettings = {
  defaultTimeoutMs: DEFAULT_NETWORK_POLICY.timeoutMs,
  followRedirects: true,
  saveHistory: true,
  maxResponseBytes: DEFAULT_NETWORK_POLICY.maxResponseBytes,
  historyRetentionDays: 30,
  networkPolicy: DEFAULT_NETWORK_POLICY,
  agentPermission: { highRiskMethodsRequireApproval: true, hostRules: [] },
  secretsDisplayPolicy: 'masked',
  postmanCompatibility: 'lenient',
  collectionSidebarWidth: 260,
}

/** settings patch 校验失败（api 层转 400，TC-API-12）。 */
export class SettingsValidationError extends Error {
  readonly code = 'invalid-settings'
  /** router 统一错误映射（§5.1 错误格式）。 */
  readonly httpStatus = 400
  readonly issues: string[]

  constructor(issues: string[]) {
    super(`invalid settings: ${issues.join('; ')}`)
    this.name = 'SettingsValidationError'
    this.issues = issues
  }
}

// ---- §25 配置项校验器（手写，零依赖；host 半不引入 schema 库）----

type Validator = (value: unknown, path: string, issues: string[]) => void

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateBoolean(value: unknown, path: string, issues: string[]): void {
  if (typeof value !== 'boolean') issues.push(`${path} must be a boolean`)
}

function validateString(value: unknown, path: string, issues: string[]): void {
  if (typeof value !== 'string') issues.push(`${path} must be a string`)
}

function rangedNumber(min: number, max: number, integer = false): Validator {
  return (value, path, issues) => {
    if (typeof value !== 'number' || Number.isNaN(value) || (integer && !Number.isInteger(value))) {
      issues.push(`${path} must be a${integer ? 'n integer' : ' number'}`)
      return
    }
    if (value < min || value > max) issues.push(`${path} must be between ${min} and ${max}`)
  }
}

function enumValue(allowed: readonly string[]): Validator {
  return (value, path, issues) => {
    if (typeof value !== 'string' || !allowed.includes(value)) {
      issues.push(`${path} must be one of: ${allowed.join(', ')}`)
    }
  }
}

const NETWORK_POLICY_VALIDATORS: Record<keyof NetworkPolicy, Validator> = {
  allowLocalhost: validateBoolean,
  allowPrivateNetwork: validateBoolean,
  allowPublicNetwork: validateBoolean,
  blockedHosts: (value, path, issues) => validateStringArray(value, path, issues),
  allowedHosts: (value, path, issues) => validateStringArray(value, path, issues),
  blockedPorts: (value, path, issues) => {
    if (!Array.isArray(value) || value.some((p) => typeof p !== 'number' || !Number.isInteger(p) || p < 0 || p > 65535)) {
      issues.push(`${path} must be an array of integer ports (0..65535)`)
    }
  },
  redirectPolicy: enumValue(['follow', 'manual-block', 'none']),
  maxResponseBytes: rangedNumber(1, 1024 * 1024 * 1024, true),
  timeoutMs: rangedNumber(1, 600_000, true),
  dnsRebindingProtection: validateBoolean,
}

function validateStringArray(value: unknown, path: string, issues: string[]): void {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    issues.push(`${path} must be an array of strings`)
  }
}

function validateObjectFields(
  value: unknown,
  path: string,
  validators: Record<string, Validator>,
  issues: string[],
): void {
  if (!isPlainObject(value)) {
    issues.push(`${path} must be an object`)
    return
  }
  for (const key of Object.keys(value)) {
    const validator = validators[key]
    if (validator === undefined) {
      issues.push(`${path}.${key} is not a known setting`)
      continue
    }
    validator(value[key], `${path}.${key}`, issues)
  }
}

const AGENT_PERMISSION_VALIDATORS: Record<string, Validator> = {
  highRiskMethodsRequireApproval: validateBoolean,
  hostRules: (value, path, issues) => {
    if (!Array.isArray(value)) {
      issues.push(`${path} must be an array`)
      return
    }
    value.forEach((rule, index) => {
      validateObjectFields(
        rule,
        `${path}[${index}]`,
        { host: validateString, action: enumValue(['allow', 'approval', 'deny']) },
        issues,
      )
    })
  },
}

/** §25 顶层配置项校验表（未知键拒绝——严格形态）。 */
const SETTINGS_VALIDATORS: Record<keyof PluginSettings, Validator> = {
  defaultTimeoutMs: rangedNumber(1, 600_000, true),
  followRedirects: validateBoolean,
  saveHistory: validateBoolean,
  maxResponseBytes: rangedNumber(1, 1024 * 1024 * 1024, true),
  historyRetentionDays: rangedNumber(1, 3650, true),
  networkPolicy: (value, path, issues) => validateObjectFields(value, path, NETWORK_POLICY_VALIDATORS, issues),
  agentPermission: (value, path, issues) => validateObjectFields(value, path, AGENT_PERMISSION_VALIDATORS, issues),
  secretsDisplayPolicy: enumValue(['masked']),
  postmanCompatibility: enumValue(['strict', 'lenient']),
  collectionSidebarWidth: rangedNumber(220, 520, true),
  activeEnvironmentId: validateString,
}

/** patch 合并：嵌套对象（networkPolicy/agentPermission）字段级合并，标量替换。 */
function mergeSettings(base: PluginSettings, patch: Partial<PluginSettings>): PluginSettings {
  const merged = { ...base, ...patch }
  if (patch.networkPolicy !== undefined) merged.networkPolicy = { ...base.networkPolicy, ...patch.networkPolicy }
  if (patch.agentPermission !== undefined) merged.agentPermission = { ...base.agentPermission, ...patch.agentPermission }
  return merged
}

/** 校验 patch 对象；全部问题一次抛出（TC-API-12 的 400 + 校验消息）。 */
export function validateSettingsPatch(patch: unknown): asserts patch is Partial<PluginSettings> {
  const issues: string[] = []
  validateObjectFields(patch, 'settings', SETTINGS_VALIDATORS, issues)
  if (issues.length > 0) throw new SettingsValidationError(issues)
}

// ---- schemastery 运行时解析（M0 修 #9b 双路径，裸说明符优先）----

interface Schemastery {
  object: (shape: Record<string, unknown>) => unknown
  boolean: () => { default: (value: boolean) => unknown }
  number: () => { default: (value: number) => unknown }
  string: () => { default: (value: string) => unknown }
}

/**
 * 裸说明符从插件自身目录链解析（M0 实证可用）；失败回退 profile 安装副本的
 * file-URL 直导（绕过进程级 package.json miss 缓存，修 #9b）。
 */
async function importSchemastery(): Promise<{ z: Schemastery; via: string }> {
  try {
    const z = ((await import('@deepseek-ai/schemastery')) as { default: Schemastery }).default
    return { z, via: 'bare-specifier' }
  } catch {
    const profilesDir = join(resolveDshHome(), 'profiles')
    for (const profile of readdirSync(profilesDir)) {
      const candidate = join(profilesDir, profile, 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs')
      if (existsSync(candidate)) {
        const z = ((await import(pathToFileURL(candidate).href)) as { default: Schemastery }).default
        return { z, via: `profile-file-url:${profile}` }
      }
    }
    throw new Error('schemastery not resolvable from plugin or any profile')
  }
}

interface SettingsHostLike {
  installSection?: (
    owner: Context,
    ns: string,
    schema: unknown,
    entry: unknown,
    hooks: { setSource?: (source: () => unknown) => void; onChange?: () => void },
  ) => void
  register?: (ns: string, schema: unknown, options: { base: unknown }) => unknown
}

export class SettingsService {
  private settings: PluginSettings

  constructor(
    private readonly store: FileStore,
    private readonly profile: ProfileService,
  ) {
    this.settings = this.load()
  }

  private file(): string {
    return profileLayout(this.store.layout, this.profile.profileId).settingsFile
  }

  private load(): PluginSettings {
    if (!this.profile.resolved) return DEFAULT_PLUGIN_SETTINGS
    const stored = this.store.readJson<Partial<PluginSettings>>(this.file())
    return mergeSettings(DEFAULT_PLUGIN_SETTINGS, stored ?? {})
  }

  get(): PluginSettings {
    return this.settings
  }

  /** §5.1 端点 28：schema 校验后合并落盘；非法值 → SettingsValidationError（400）。 */
  patch(patch: unknown): PluginSettings {
    validateSettingsPatch(patch)
    this.profile.assertResolved('settings')
    this.settings = mergeSettings(this.settings, patch)
    this.store.initProfileDir(this.profile.profileId)
    this.store.writeJson(this.file(), this.settings)
    return this.settings
  }

  /**
   * Host settings 命名空间声明（折叠自 M0 settings-namespace-probe）：
   * installSection（首选）/ register（旧版回退）；缺失 settings 服务或
   * schemastery 不可解析时降级为日志记录（host-log console 面），绝不炸宿主。
   */
  declareNamespace(ctx: Context, log: HostLog): void {
    ctx.inject(['settings'], (settingsCtx: Context) => {
      void (async () => {
        try {
          const { z, via } = await importSchemastery()
          const settings = (settingsCtx as unknown as { settings?: SettingsHostLike }).settings
          const current = this.settings
          // §25 标量项进 describe 文档；嵌套项（networkPolicy/agentPermission）
          // 经 Host API settings 端点管理（schema 声明保持标量面，见 WP2 报告）。
          const schema = z.object({
            defaultTimeoutMs: z.number().default(current.defaultTimeoutMs),
            followRedirects: z.boolean().default(current.followRedirects),
            saveHistory: z.boolean().default(current.saveHistory),
            maxResponseBytes: z.number().default(current.maxResponseBytes),
            historyRetentionDays: z.number().default(current.historyRetentionDays),
            secretsDisplayPolicy: z.string().default(current.secretsDisplayPolicy),
            postmanCompatibility: z.string().default(current.postmanCompatibility),
          })
          const entry = {
            defaultTimeoutMs: current.defaultTimeoutMs,
            followRedirects: current.followRedirects,
            saveHistory: current.saveHistory,
            maxResponseBytes: current.maxResponseBytes,
            historyRetentionDays: current.historyRetentionDays,
            secretsDisplayPolicy: current.secretsDisplayPolicy,
            postmanCompatibility: current.postmanCompatibility,
          }
          if (typeof settings?.installSection === 'function') {
            // hooks 契约（settings/src/index.ts）：setSource + onChange 必选。
            settings.installSection(ctx, SETTINGS_NAMESPACE, schema, entry, {
              setSource: () => {},
              onChange: () => {},
            })
            log.log('settings', 'namespace-declared', { ns: SETTINGS_NAMESPACE, via: 'installSection', schemastery: via })
          } else if (typeof settings?.register === 'function') {
            settings.register(SETTINGS_NAMESPACE, schema, { base: {} })
            log.log('settings', 'namespace-declared', { ns: SETTINGS_NAMESPACE, via: 'register' })
          } else {
            log.log('settings', 'namespace-unavailable', { reason: 'no installSection/register on settings service' })
          }
        } catch (error) {
          log.log('settings', 'namespace-error', { message: error instanceof Error ? error.message : String(error) })
        }
      })()
    })
  }
}
