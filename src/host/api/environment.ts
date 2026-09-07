/**
 * §5.1 端点 15–20：Environment CRUD + secret 写入（write-only）+ secret 删除。
 * 投影纪律：任何 GET 永不返回 secret value——secret 变量只出 `<secret-ref:key>`。
 */
import type { EnvironmentService, EnvironmentPatch, PlainVariablePatch } from '../services/environment-service.ts'
import { EnvironmentNotFoundError } from '../services/environment-service.ts'
import type { RedactionService } from '../services/redaction-service.ts'
import type { ApiRouter } from './router.ts'
import { ApiError, sendJson, sendNoContent } from './router.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toNotFound(error: unknown): never {
  if (error instanceof EnvironmentNotFoundError) throw new ApiError(404, 'environment-not-found', error.message)
  throw error
}

export function registerEnvironmentRoutes(
  api: ApiRouter,
  environments: EnvironmentService,
  redaction: RedactionService,
): void {
  // 15. GET /api-client/environments —— SecretRef 投影列表。
  api.get('/api-client/environments', ({ res }) => {
    sendJson(res, 200, redaction.projectEnvironments(environments.list()))
  })

  // 16. POST /api-client/environments —— { name }。
  api.post('/api-client/environments', async (ctx) => {
    const body = await ctx.json()
    if (!isRecord(body) || typeof body.name !== 'string' || body.name.trim() === '') {
      throw new ApiError(400, 'invalid-input', 'environment name is required')
    }
    sendJson(ctx.res, 200, redaction.projectEnvironment(environments.create(body.name)))
  })

  // 17. PATCH /api-client/environments/:id —— 改名/普通变量（secret 变量拒绝）。
  api.patch('/api-client/environments/:id', async (ctx) => {
    const body = await ctx.json()
    if (!isRecord(body)) throw new ApiError(400, 'invalid-input', 'patch body must be an object')
    const patch: EnvironmentPatch = {}
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || body.name.trim() === '') {
        throw new ApiError(400, 'invalid-input', 'environment name must be a non-empty string')
      }
      patch.name = body.name
    }
    if (body.variables !== undefined) {
      if (!Array.isArray(body.variables)) throw new ApiError(400, 'invalid-input', 'variables must be an array')
      patch.variables = body.variables.map((v): PlainVariablePatch => {
        if (!isRecord(v) || typeof v.key !== 'string' || typeof v.value !== 'string') {
          throw new ApiError(400, 'invalid-input', 'each variable requires { key: string, value: string }')
        }
        return {
          key: v.key,
          value: v.value,
          ...(typeof v.enabled === 'boolean' ? { enabled: v.enabled } : {}),
          ...(typeof v.initialValue === 'string' ? { initialValue: v.initialValue } : {}),
        }
      })
    }
    try {
      sendJson(ctx.res, 200, redaction.projectEnvironment(environments.patch(ctx.params.id!, patch)))
    } catch (error) {
      toNotFound(error)
    }
  })

  // 18. DELETE /api-client/environments/:id —— 204（secret 文件级联删除）。
  api.delete('/api-client/environments/:id', (ctx) => {
    try {
      environments.delete(ctx.params.id!)
    } catch (error) {
      toNotFound(error)
    }
    sendNoContent(ctx.res)
  })

  // 19. PUT /api-client/environments/:id/secrets/:key —— { value } → { secretRef }（write-only）。
  api.put('/api-client/environments/:id/secrets/:key', async (ctx) => {
    const body = await ctx.json()
    if (!isRecord(body) || typeof body.value !== 'string') {
      throw new ApiError(400, 'invalid-input', 'secret write requires { value: string }')
    }
    try {
      sendJson(ctx.res, 200, environments.writeSecret(ctx.params.id!, ctx.params.key!, body.value))
    } catch (error) {
      toNotFound(error)
    }
  })

  // 20. DELETE /api-client/environments/:id/secrets/:key —— 204（删 SecretRef + secret 文件）。
  api.delete('/api-client/environments/:id/secrets/:key', (ctx) => {
    try {
      environments.deleteSecret(ctx.params.id!, ctx.params.key!)
    } catch (error) {
      toNotFound(error)
    }
    sendNoContent(ctx.res)
  })
}
