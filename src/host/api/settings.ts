/**
 * §5.1 端点 27–28：Plugin settings get/patch（§25 配置项）。
 * patch 经 settings-service schema 校验——非法值 400 + 校验消息（TC-API-12）。
 */
import type { SettingsService } from '../services/settings-service.ts'
import type { ApiRouter } from './router.ts'
import { sendJson } from './router.ts'

export function registerSettingsRoutes(api: ApiRouter, settings: SettingsService): void {
  // 27. GET /api-client/settings —— PluginSettings。
  api.get('/api-client/settings', ({ res }) => {
    sendJson(res, 200, settings.get())
  })

  // 28. PATCH /api-client/settings —— 部分字段（schema 校验；非法 → SettingsValidationError → 400）。
  api.patch('/api-client/settings', async (ctx) => {
    const body = await ctx.json()
    sendJson(ctx.res, 200, settings.patch(body))
  })
}
