/**
 * §5.1 端点 25–26：Postman 导入 → ImportReport + collectionId；报告回读。
 * 管线失败（detect/parse）→ 400 且零落库（ImportPipelineError，TC-P-13 语义）。
 */
import { ImportPipelineError } from '@dsh-api-client/core'
import type { ImportService } from '../services/import-service.ts'
import type { ApiRouter } from './router.ts'
import { ApiError, sendJson } from './router.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function registerImportRoutes(api: ApiRouter, imports: ImportService): void {
  // 25. POST /api-client/import/postman —— { collection, name? } → ImportReport（含 createdCollectionId）。
  api.post('/api-client/import/postman', async (ctx) => {
    const body = await ctx.json()
    if (!isRecord(body) || body.collection === undefined) {
      throw new ApiError(400, 'invalid-input', 'import requires { collection: unknown, name? }')
    }
    if (body.name !== undefined && typeof body.name !== 'string') {
      throw new ApiError(400, 'invalid-input', 'name must be a string')
    }
    try {
      sendJson(ctx.res, 200, imports.importPostman(body.collection, body.name as string | undefined))
    } catch (error) {
      if (error instanceof ImportPipelineError) {
        throw new ApiError(400, 'import-failed', error.message)
      }
      throw error
    }
  })

  // 26. GET /api-client/import/reports/:id —— ImportReport。
  api.get('/api-client/import/reports/:id', (ctx) => {
    const report = imports.getReport(ctx.params.id!)
    if (report === undefined) throw new ApiError(404, 'import-report-not-found', `import report not found: ${ctx.params.id}`)
    sendJson(ctx.res, 200, report)
  })
}
