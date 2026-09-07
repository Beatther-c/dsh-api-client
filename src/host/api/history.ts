/**
 * §5.1 端点 22–24：History 列表 / 单条 / 清空（全部脱敏快照）。
 * 响应形态按契约字面：list 返回 ExecutionHistory[]（limit/cursor 切片，§6.5 TC-API-06）。
 */
import type { HistoryService } from '../services/history-service.ts'
import type { ApiRouter } from './router.ts'
import { ApiError, sendJson, sendNoContent } from './router.ts'

export function registerHistoryRoutes(api: ApiRouter, history: HistoryService): void {
  // 22. GET /api-client/history?limit&cursor —— 脱敏快照列表。
  api.get('/api-client/history', (ctx) => {
    const limitRaw = ctx.query.get('limit')
    const cursor = ctx.query.get('cursor') ?? undefined
    let limit: number | undefined
    if (limitRaw !== null) {
      limit = Number.parseInt(limitRaw, 10)
      if (Number.isNaN(limit) || limit < 1) throw new ApiError(400, 'invalid-input', 'limit must be a positive integer')
    }
    sendJson(ctx.res, 200, history.list({ ...(limit !== undefined ? { limit } : {}), ...(cursor !== undefined ? { cursor } : {}) }))
  })

  // 23. GET /api-client/history/:id —— 单条。
  api.get('/api-client/history/:id', (ctx) => {
    const entry = history.get(ctx.params.id!)
    if (entry === undefined) throw new ApiError(404, 'history-not-found', `history entry not found: ${ctx.params.id}`)
    sendJson(ctx.res, 200, entry)
  })

  // 24. DELETE /api-client/history —— 清空（human-only；agent 无此工具，§5.1）。
  api.delete('/api-client/history', (ctx) => {
    history.clear()
    sendNoContent(ctx.res)
  })
}
