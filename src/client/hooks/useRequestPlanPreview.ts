/**
 * useRequestPlanPreview（P0 WP7；实施设计 §5.2/§5.9、UX §6.4/§9）：
 * 对「当前编辑中的 request draft」持续计算 canonical buildRequestPlan 的
 * mode='preview' 安全投影，供 Headers/Params 两层展示的自动项区域消费。
 *
 * 纪律：
 * - 自动项算法唯一来源 = core plan（§5.3 冻结优先级），本 hook 不重新推导
 *   任何合并/优先级/suppression 逻辑，只做「调用 + 竞态守卫 + 错误投影」；
 * - preview 模式零变量/SecretRef 解析（绝不调用 resolveSecret——红线 3），
 *   environment/collection 仅作为与 buildRequestPlan 相同的解析上下文透传
 *   （preview 阶段 collection 参与 inherit auth 链，environment 不参与取值）；
 * - draft 快速变化时的竞态：effect cleanup 取消 + 序号守卫双保险，只有最后
 *   一次调用的结果允许落 state（迟到结果静默丢弃）；
 * - preview 失败不阻断编辑（UX §9）：error 时 preview=undefined，error 为
 *   中文失败描述，UI 显示失败原因区域，用户表格照常可编辑；实际 Send 仍走
 *   Host 的权威构建链，与此预览无关。
 *
 * core import 走深路径（与既有 client 组件一致）：包索引 `@dsh-api-client/core`
 * 会连带 executor/http-client → undici，进不了浏览器 client bundle；plan.ts 的
 * 传递依赖（variables/parser、request/build、request/body、security/redactor、
 * security/sensitive-headers）零 undici、零 DSH，深路径 bundle 安全。
 */
import { useEffect, useRef, useState } from 'react'
import type {
  ApiRequest,
  AuthConfig,
  BodyConfig,
  Collection,
  Environment,
  HttpMethod,
  KeyValue,
  RequestPlanPreview,
  SuppressedGeneratedHeader,
} from '@dsh-api-client/shared'
import { buildRequestPlan } from '../../../packages/core/src/request/plan.ts'

/**
 * 编辑中 request draft 中被 preview 消费的字段投影（§5.9：method/url/params/
 * headers/auth/body/suppressedGeneratedHeaders）。ApiClientView 的 tab draft 是
 * 完整 ApiRequest，结构化满足本类型，可直接传入。
 */
export interface RequestPlanDraft {
  method: HttpMethod
  url: string
  params: KeyValue[]
  headers: KeyValue[]
  auth: AuthConfig
  body: BodyConfig
  /** 读取语义 `?? []`（§4.1.1）；缺省视为无 suppression。 */
  suppressedGeneratedHeaders?: SuppressedGeneratedHeader[]
}

export interface UseRequestPlanPreviewInput {
  draft: RequestPlanDraft
  /** 变量解析上下文（由调用方传入）；preview 模式不解析任何值。 */
  environment?: Environment
  /** inherit auth 链 + collection 变量上下文（由调用方传入）。 */
  collection?: Collection
}

export interface RequestPlanPreviewState {
  /** 最新一次成功计算的安全投影；计算中/失败时为 undefined。 */
  preview: RequestPlanPreview | undefined
  /** 失败原因（中文）；成功时为 undefined。绝不阻断编辑。 */
  error: string | undefined
}

/** 失败文案统一前缀（测试与 UI 断言用）。 */
export const PREVIEW_FAILED_PREFIX = '自动生成项预览失败'

export function useRequestPlanPreview(input: UseRequestPlanPreviewInput): RequestPlanPreviewState {
  const { draft, environment, collection } = input
  const { method, url, params, headers, auth, body, suppressedGeneratedHeaders } = draft
  const [state, setState] = useState<RequestPlanPreviewState>({ preview: undefined, error: undefined })
  // 序号守卫：与 cleanup cancelled 双保险，杜绝迟到结果覆盖最新 draft 的投影。
  const sequence = useRef(0)

  useEffect(() => {
    const current = ++sequence.current
    let cancelled = false
    // id/name/collectionId/时间戳不参与 plan 计算（preview 只读上面解构的字段），
    // 以空值合成完整 ApiRequest 供 canonical primitive 消费。
    const request: ApiRequest = {
      id: '',
      name: '',
      collectionId: '',
      createdAt: 0,
      updatedAt: 0,
      method,
      url,
      params,
      headers,
      auth,
      body,
      ...(suppressedGeneratedHeaders !== undefined ? { suppressedGeneratedHeaders } : {}),
    }
    buildRequestPlan(request, {
      mode: 'preview',
      ...(environment !== undefined ? { environment } : {}),
      ...(collection !== undefined ? { collection } : {}),
    })
      .then((plan) => {
        if (cancelled || current !== sequence.current) return
        setState({ preview: plan.preview, error: undefined })
      })
      .catch((err: unknown) => {
        if (cancelled || current !== sequence.current) return
        // preview 模式从不解析 secret，core 错误消息不含秘密材料（红线 3）；
        // 保留技术细节便于排查，前缀中文说明性质（UX §9：显示失败原因）。
        const detail = err instanceof Error ? err.message : String(err)
        setState({ preview: undefined, error: `${PREVIEW_FAILED_PREFIX}: ${detail}` })
      })
    return () => {
      cancelled = true
    }
  }, [method, url, params, headers, auth, body, suppressedGeneratedHeaders, environment, collection])

  return state
}
