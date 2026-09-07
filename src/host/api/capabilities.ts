/**
 * §5.1 端点 1：GET /api-client/capabilities —— health + 能力发现
 * （由 M0 ping 探针演进，§3.5：探针的 200 ok 语义演进为本端点的 health 字段；
 * 探针的鉴权围栏沉淀进 api/auth.ts，本端点与其余端点同围栏）。
 */
import { createRequire } from 'node:module'
import type { ProfileService } from '../services/profile-service.ts'
import type { ApiRouter } from './router.ts'
import { sendJson } from './router.ts'

export interface CapabilitiesMeta {
  /** 插件版本（index.ts 从 package.json 注入）。 */
  version: string
  /** 特性开关（§5.1 features: {...}）。 */
  features: Record<string, unknown>
}

/**
 * DSH 版本探测（best-effort）：从运行时依赖 @deepseek-ai/dsh-host-webserver 的
 * package.json 读取——bundle 内 createRequire 从 dist 位置解析，命中 profile
 * 安装的真实 DSH 版本；不可解析时 'unknown'（不阻塞 capabilities）。
 */
export function detectDshVersion(): string {
  try {
    const require = createRequire(import.meta.url)
    const pkg = require('@deepseek-ai/dsh-host-webserver/package.json') as { version?: string }
    return pkg.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

export function registerCapabilitiesRoutes(api: ApiRouter, profile: ProfileService, meta: CapabilitiesMeta): void {
  api.get('/api-client/capabilities', ({ res }) => {
    sendJson(res, 200, {
      version: meta.version,
      dshVersion: detectDshVersion(),
      profileId: profile.profileId,
      profileResolved: profile.resolved,
      features: meta.features,
    })
  })
}
