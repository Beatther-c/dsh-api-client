/**
 * system-prompt announcement（§3.4；由 M0 announcement-probe 演进，§3.5）：
 * 告知 agent `api_client_*` 命名空间的 6 个工具用途、per-call `environment`
 * 参数用法，并明确**不存在**全局环境切换工具（§5.2 D-D1）。
 *
 * 注册形态沿用 WP0 实测：`ctx.systemPrompt.section({name, order, text})` 返回
 * disposer；同名重复注册会抛错，故随插件生命周期注册一次、dispose 摘除。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { HostLog } from '../host-log.ts'

export const ANNOUNCEMENT_SECTION_NAME = 'plugin:api-client'
export const ANNOUNCEMENT_ORDER = 900

export const ANNOUNCEMENT_TEXT = [
  '本机已安装 dsh-api-client 插件：Agent 可通过 api_client_* 命名空间的 6 个工具操作 API Client——',
  'api_client_request（执行临时 HTTP 请求：{method,url,headers?,query?,body?,environment?}）；',
  'api_client_run_request（执行 Collection 中已保存的请求：{requestId} 或 {collection,request}，可加 environment?）；',
  'api_client_list_collections / api_client_list_requests / api_client_get_request（只读查询集合与请求，auth/secret 已脱敏）；',
  'api_client_get_last_response（读取最近一次执行的请求/响应快照，{historyId?} 缺省取最后一条，永远脱敏、无明文开关）。',
  '环境选择只走每次调用显式传 environment 参数（环境 id 或唯一名称）；本插件不提供全局环境切换工具，不存在 api_client_switch_environment。',
  '执行结果永远为脱敏投影（已解析的 secret 不会出现在返回中）；POST/PUT/PATCH/DELETE 等高风险方法可能触发用户 Approval，被拒绝时请向用户说明。',
].join('\n')

interface SystemPromptLike {
  section(options: { name: string; order: number; text: string }): () => void
}

export interface AnnouncementRegistration {
  status: 'registered' | 'unavailable' | 'error'
  dispose: () => void
}

/** 贡献 announcement section。永不向宿主抛错；dispose 摘除 section（幂等）。 */
export function attachApiClientAnnouncement(ctx: Context, log: HostLog): AnnouncementRegistration {
  const systemPrompt = (ctx as { systemPrompt?: SystemPromptLike }).systemPrompt
  if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') {
    log.log('announcement', 'unavailable', { reason: 'ctx.systemPrompt missing' })
    return { status: 'unavailable', dispose: () => {} }
  }
  try {
    const disposeSection = systemPrompt.section({
      name: ANNOUNCEMENT_SECTION_NAME,
      order: ANNOUNCEMENT_ORDER,
      text: ANNOUNCEMENT_TEXT,
    })
    log.log('announcement', 'register', { name: ANNOUNCEMENT_SECTION_NAME, order: ANNOUNCEMENT_ORDER })
    let disposed = false
    return {
      status: 'registered',
      dispose() {
        if (disposed) return
        disposed = true
        disposeSection()
        log.log('announcement', 'dispose', { name: ANNOUNCEMENT_SECTION_NAME })
      },
    }
  } catch (error) {
    log.log('announcement', 'error', { message: error instanceof Error ? error.message : String(error) })
    return { status: 'error', dispose: () => {} }
  }
}
