/**
 * dsh-api-client — Cordis host plugin entry (exports["."])。
 *
 * WP8 终态：装配 services → api router → tools（§5.2 定稿 6 个 + Approval 挂接）
 * → announcement（M0 探针全部退役，见 §3.5：probe-log 移至 tools/spike/ 不再装配）。
 * 生命周期沿用 WP0 实测语义：
 * - Cordis loader 以 ESM 导入包根，具名 `apply(ctx, config?)` / `inject`；
 * - `ctx.effect(fn)` 的返回 disposer 在卸载时执行——逆序清理（V-17 热插拔轴）；
 * - 运行时日志走 console 最小面（host-log.ts），无落盘义务。
 *
 * Host Remote API（WP0 U-7 实测机制）：单条 prefix 路由 `/api-client` 挂到
 * `ctx.webServer.register`；统一鉴权中间件见 api/auth.ts。
 *
 * **Plugin token 发放（同源 bootstrap，§24.4/WP3 useHostApi 依赖契约）**：
 * 激活期生成随机 token（内存持有，不落盘）；经 webServer 的
 * `webserver/index-inject` 结构化注入把 `{ base, token }` 发布为 index.html
 * 全局 `window.__DSH_API_CLIENT_BOOTSTRAP__`——只有能加载 SPA 的同源页面拿得到；
 * client 半（WP3）读该全局值并以 `Authorization: Bearer` 发送。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { resolveStorageLayout } from '@dsh-api-client/shared'
import pkg from '../../package.json'
import { resolveDshHome } from './dsh-home.ts'
import { createConsoleHostLog } from './host-log.ts'
import { FileStore } from './services/storage/file-store.ts'
import { ProfileService } from './services/profile-service.ts'
import type { LaunchEnvironmentLike } from './services/profile-service.ts'
import { SecretStoreService } from './services/secret-store-service.ts'
import { RedactionService } from './services/redaction-service.ts'
import { EnvironmentService } from './services/environment-service.ts'
import { CollectionService } from './services/collection-service.ts'
import { HistoryService } from './services/history-service.ts'
import { SettingsService } from './services/settings-service.ts'
import { NetworkPolicyService } from './services/network-policy-service.ts'
import { AuditService } from './services/audit-service.ts'
import { ImportService } from './services/import-service.ts'
import { ExecutionService } from './services/execution-service.ts'
import { ApiRouter } from './api/router.ts'
import type { WebServerLike } from './api/router.ts'
import { authenticateRequest } from './api/auth.ts'
import type { PluginAuthConfig } from './api/auth.ts'
import { registerCapabilitiesRoutes } from './api/capabilities.ts'
import { registerCollectionRoutes } from './api/collections.ts'
import { registerRequestRoutes } from './api/requests.ts'
import { registerEnvironmentRoutes } from './api/environment.ts'
import { registerExecuteRoutes } from './api/execute.ts'
import { registerHistoryRoutes } from './api/history.ts'
import { registerImportRoutes } from './api/import.ts'
import { registerSettingsRoutes } from './api/settings.ts'
import { registerApiClientTools } from './tools/register.ts'
import { attachApiClientAnnouncement } from './tools/announcement.ts'

export const name = 'api-client'

/** Required host services; all three are present in the shipped web composition. */
export const inject = ['webServer', 'tools', 'systemPrompt']

/** Host API 挂载前缀（§5.1 Base）。 */
export const API_BASE = '/api-client'

/** 同源 bootstrap 的 index.html 全局名（WP3 useHostApi 读取契约）。 */
export const TOKEN_GLOBAL_NAME = '__DSH_API_CLIENT_BOOTSTRAP__'

export const PLUGIN_VERSION: string = pkg.version

/** Optional plugin config（§19.1 level 4 / §24.4 / 测试注入面）。 */
export interface Config {
  /** profile identity override（四级探测 level 4）。 */
  profileId?: string
  /** 固定 plugin token（缺省激活期随机生成；测试与高级部署用）。 */
  pluginToken?: string
  /** Workbench 反代 trusted-proxy token（缺省读 env DSH_API_CLIENT_TRUSTED_PROXY_TOKEN）。 */
  trustedProxyToken?: string
  /** 存储根覆盖（缺省 resolveDshHome()；测试注入 tmp 目录）。 */
  dshHome?: string
}

export interface HostServices {
  store: FileStore
  profile: ProfileService
  redaction: RedactionService
  secrets: SecretStoreService
  environments: EnvironmentService
  collections: CollectionService
  settings: SettingsService
  networkPolicy: NetworkPolicyService
  history: HistoryService
  audit: AuditService
  imports: ImportService
  execution: ExecutionService
}

/**
 * 服务装配（index.ts 与 tests/host-api.spec.ts 共用此唯一组装点）：
 * §4.2 目录树初始化 + 全 service 按依赖序构造。
 */
export function createHostServices(options: { dshHome: string; profile: ProfileService }): HostServices {
  const store = new FileStore(resolveStorageLayout(options.dshHome))
  store.initLayout()
  const profile = options.profile
  const redaction = new RedactionService()
  const secrets = new SecretStoreService(store)
  const environments = new EnvironmentService(store, secrets)
  const collections = new CollectionService(store)
  const settings = new SettingsService(store, profile)
  const networkPolicy = new NetworkPolicyService(store, settings)
  const history = new HistoryService(store, profile, redaction, () => settings.get().historyRetentionDays)
  const audit = new AuditService(store, profile)
  const imports = new ImportService(store, collections, redaction)
  const execution = new ExecutionService({
    collections,
    environments,
    secrets,
    history,
    audit,
    networkPolicy,
    settings,
    profile,
  })
  return { store, profile, redaction, secrets, environments, collections, settings, networkPolicy, history, audit, imports, execution }
}

/** §5.1 全部 28 端点注册（index.ts 与 tests 共用此唯一注册点）。 */
export function registerHostApi(api: ApiRouter, services: HostServices): void {
  registerCapabilitiesRoutes(api, services.profile, {
    version: PLUGIN_VERSION,
    features: {
      collections: true,
      environments: true,
      secrets: true,
      execute: true,
      history: true,
      import: { postman: 'v2.1-inline-minimal' },
      agentTools: 'api-client-full',
    },
  })
  registerCollectionRoutes(api, services.collections, services.redaction)
  registerRequestRoutes(api, services.collections, services.redaction)
  registerEnvironmentRoutes(api, services.environments, services.redaction)
  registerExecuteRoutes(api, services.execution)
  registerHistoryRoutes(api, services.history)
  registerImportRoutes(api, services.imports)
  registerSettingsRoutes(api, services.settings)
}

/** 构造带统一鉴权中间件的 API router（§24.4；index.ts 与 tests 共用）。 */
export function createHostApiRouter(services: HostServices, auth: PluginAuthConfig): ApiRouter {
  const api = new ApiRouter({
    base: API_BASE,
    authenticate: (req) => authenticateRequest(req, auth),
    redactError: (error) => services.redaction.errorMessage(error),
  })
  registerHostApi(api, services)
  return api
}

export function apply(ctx: Context, config?: Config): void {
  const log = createConsoleHostLog()
  log.log('lifecycle', 'install', { name, inject })

  ctx.effect(() => {
    log.log('lifecycle', 'mount')
    const disposers: Array<() => void> = []

    // ---- services 装配（四级 profile 探测；unresolved → fail-closed 由 service 层执行）----
    const dshHome = config?.dshHome ?? resolveDshHome()
    let launchEnvironment: LaunchEnvironmentLike | undefined
    try {
      launchEnvironment = (ctx as { launchEnvironment?: LaunchEnvironmentLike }).launchEnvironment
    } catch {
      launchEnvironment = undefined
    }
    const profile = ProfileService.detect({ ...(launchEnvironment !== undefined ? { launchEnvironment } : {}), config, home: dshHome })
    log.log('profile', 'detect', profile.detection)
    const services = createHostServices({ dshHome, profile })

    // ---- Host API（U-7 实测注册机制；单条 prefix 路由 + 统一鉴权）----
    const pluginToken = config?.pluginToken ?? crypto.randomUUID()
    const trustedProxyToken = config?.trustedProxyToken ?? process.env.DSH_API_CLIENT_TRUSTED_PROXY_TOKEN
    const api = createHostApiRouter(services, {
      pluginToken,
      ...(trustedProxyToken !== undefined ? { trustedProxyToken } : {}),
    })
    const webServer = (ctx as { webServer?: WebServerLike }).webServer
    if (webServer !== undefined && typeof webServer.register === 'function') {
      const unregister = api.attach(webServer)
      log.log('remote-api', 'register', { path: API_BASE, kind: 'prefix' })
      disposers.push(() => {
        unregister()
        log.log('remote-api', 'dispose', { path: API_BASE })
      })

      // Plugin token 同源 bootstrap：index.html 注入全局行（见文件头契约）。
      const offIndexInject = ctx.on('webserver/index-inject', (table: IndexInjection[]) => {
        table.push({ kind: 'global', name: TOKEN_GLOBAL_NAME, value: { base: API_BASE, token: pluginToken } })
      })
      disposers.push(() => offIndexInject())
    } else {
      log.log('remote-api', 'unavailable', { reason: 'ctx.webServer missing' })
    }

    // ---- settings 命名空间声明（M0 settings-namespace-probe 折叠进 service）----
    services.settings.declareNamespace(ctx, log)

    // ---- WP5 正式装配（§3.5：M0 tool-probe/announcement-probe 已删除）----
    // tools：§5.2 定稿 6 个 + tools/pre-execute Approval 挂接（§24.5）；dispose 注销全部（TC-T-10）。
    disposers.push(
      registerApiClientTools(
        ctx,
        {
          execution: services.execution,
          collections: services.collections,
          history: services.history,
          redaction: services.redaction,
          settings: services.settings,
        },
        log,
      ).dispose,
    )
    disposers.push(attachApiClientAnnouncement(ctx, log).dispose)

    log.log('lifecycle', 'start', {
      assembled: ['services', 'api-router', 'settings-namespace', 'tools', 'announcement'],
      profileId: profile.profileId,
    })

    return () => {
      log.log('lifecycle', 'stop')
      // Reverse-order teardown; one faulty disposer cannot block the rest.
      for (const dispose of disposers.slice().reverse()) {
        try {
          dispose()
        } catch (error) {
          log.log('lifecycle', 'dispose-error', { message: error instanceof Error ? error.message : String(error) })
        }
      }
      log.log('lifecycle', 'unmount')
    }
  }, 'api-client: host services + api')
}
