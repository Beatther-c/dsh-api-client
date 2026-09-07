/**
 * dsh-api-client — client entry (exports["./client"])。
 *
 * Runtime contract (dsh-client-modules @ 0.1.2-rc.1):
 * - This bundle is served under /plugins and registered through
 *   `window.__ModuleLoader__.load({id, factory})`; the loader consumes the
 *   module's exports as one object plugin: `apply(ctx)` + `inject` (kept EMPTY
 *   so the plugin activates unconditionally and feature-detect decides the
 *   mount path; slot-dependent assembly uses `ctx.inject(['slots'], cb)`).
 * - Baseline modules (react, react/jsx-runtime, react-dom, react-dom/client,
 *   @deepseek-ai/cordis, …) come from the shell's frozen module table — hence
 *   `dsh.client.inject: []` in package.json.
 *
 * Assembly order (WP3 正式形态): feature-detect → capability matrix (slot
 * replacement vs CSS takeover) → adapters + slots registration (main-view /
 * settings-item) → unified dispose(). Failure policy (task-board precedent):
 * DOM mounting problems are logged, never thrown — a plugin apply that throws
 * fails the whole web shell boot.
 *
 * `__DSH_API_CLIENT_PROBE__` 保留为最小调试面（internal dev only，非对外契约；
 * 无 secret、无 host token）：features / mount mode / activation state，
 * 是 TC-UI 系列手工验证的证据来源（§3.5 未要求拆除）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { createRoot } from 'react-dom/client'
import { detectFeatures } from './dsh-adapter/feature-detect.ts'
import type { FeatureDetectResult, SlotsFace } from './dsh-adapter/feature-detect.ts'
import { createPanelActivation, applyDeepLink } from './dsh-adapter/panel-activation.ts'
import { attachSidebarEntry } from './dsh-adapter/sidebar-injection.ts'
import { attachSlotAdapter } from './dsh-adapter/slot-adapter.ts'
import { attachLegacyDomAdapter } from './dsh-adapter/legacy-dom-adapter.ts'
import { attachPanelMutualExclusion } from './dsh-adapter/panel-mutual-exclusion.ts'
import { createSessionBridge } from './dsh-adapter/session-bridge.ts'
import { attachSettingsItem } from './slots/settings-item.tsx'

/** No hard service requirements: the plugin must boot even in a degraded shell. */
export const inject: string[] = []

/** Grace period for the slots service before the DOM fallback commits. */
const SLOTS_GRACE_MS = 3000

let teardown: (() => void) | undefined

function safeGet(ctx: Context, name: string): unknown {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

export function apply(ctx: Context): void {
  // A duplicated client injection (module factory materialized twice in one
  // page lifetime) must not double-mount: the later application tears the
  // earlier one down first (task-board apply-guard precedent).
  teardown?.()

  const log = (event: string, detail?: unknown): void => {
    console.debug('[dsh-api-client]', event, detail ?? '')
  }

  const disposers: Array<() => void> = []
  let features: FeatureDetectResult = detectFeatures({ slots: safeGet(ctx, 'slots') as SlotsFace | undefined })
  let mode: 'slot' | 'dom' | 'none' = 'none'
  const activation = createPanelActivation({
    onChange: (active, source) => {
      log('activation', { active, source })
    },
  })
  log('feature-detect.initial', features)

  // 最小调试面（internal dev only，无 secret）：能力矩阵 / 挂载路径 / 激活状态。
  ;(globalThis as Record<string, unknown>).__DSH_API_CLIENT_PROBE__ = {
    features: () => features,
    mode: () => mode,
    active: () => activation.isActive(),
    lastSource: () => activation.lastSource() ?? null,
  }
  disposers.push(() => {
    delete (globalThis as Record<string, unknown>).__DSH_API_CLIENT_PROBE__
  })

  // 1. Deep link（#api-client；冷启动 + 运行时 hash 导航均直达）。
  applyDeepLink(activation, globalThis.location?.hash, 'deep-link-cold-start')
  const onHashChange = (): void => {
    applyDeepLink(activation, globalThis.location?.hash, 'deep-link-runtime')
  }
  globalThis.addEventListener?.('hashchange', onHashChange)
  disposers.push(() => {
    globalThis.removeEventListener?.('hashchange', onHashChange)
  })

  // 2. Sidebar 入口（DOM 路径，与 slot 系统无关）——点击 → panel toggle。
  disposers.push(
    attachSidebarEntry({
      onToggle: () => {
        activation.toggle('sidebar-entry')
      },
      isActive: activation.isActive,
      subscribeActive: (listener) => activation.subscribe(() => listener()),
      log,
    }).dispose,
  )

  // 3. Mutual exclusion（社区 panel 协议）——两条挂载路径共用。
  disposers.push(
    attachPanelMutualExclusion({
      activation,
      mode: () => mode,
      slots: safeGet(ctx, 'slots') as SlotsFace | undefined,
      log,
    }),
  )

  // 3b. Session bridge（WP7 §5.3 正式化）：「交给 Agent」出域链路——
  //     sessions.create({workspaceId}) + open → composer 轮询 → execCommand prefill
  //     （Q4 FALLBACK 路线，只预填不发送）；服务面经 safeGet 冻结在 WP0 契约内。
  const sessionBridge = createSessionBridge({
    ctx: { get: (name: string) => safeGet(ctx, name) },
    log,
  })
  disposers.push(sessionBridge.dispose)
  const onSendToAgent = (context: Parameters<typeof sessionBridge.sendToAgent>[0]) => sessionBridge.sendToAgent(context)

  // 4. Mount-path commit: prefer the official slot replacement once the slots
  //    service is up; commit to CSS takeover when the grace period expires.
  let committed = false
  const commitDomPath = (reason: string): void => {
    if (committed) return
    committed = true
    mode = 'dom'
    log('mount-path', { mode, reason })
    disposers.push(
      attachLegacyDomAdapter({ activation, onSendToAgent, log }, (container) => createRoot(container)).dispose,
    )
  }

  const commitSlotPath = (slots: SlotsFace): void => {
    if (committed) return
    committed = true
    features = detectFeatures({ slots })
    const conversation = features.slots.find((slot) => slot.key === 'conversation')
    if (conversation?.declared !== true) {
      log('mount-path.slot-declaration-missing', { key: 'conversation' })
      committed = false // allow the grace-period fallback to commit DOM
      return
    }
    mode = 'slot'
    log('mount-path', { mode })
    // conversation replacement occupant（slots/main-view → ApiClientView）。
    disposers.push(
      attachSlotAdapter({
        slots,
        activation,
        sessions: safeGet(ctx, 'sessions'),
        onSendToAgent,
        log,
      }),
    )
    // settings.plugin.item keyed 注册正式配置页（同一 slots face）。
    disposers.push(attachSettingsItem({ slots, log }))
  }

  let slotsArrived = false
  let declarationPoll: ReturnType<typeof setTimeout> | undefined
  const graceDeadline = Date.now() + SLOTS_GRACE_MS
  try {
    ctx.inject(['slots'], (slotsCtx: Context) => {
      slotsArrived = true
      const slots = (slotsCtx as unknown as { slots: SlotsFace }).slots
      // The slots SERVICE arriving does not imply the DECLARATIONS are
      // installed: ui-layout installs `conversation` when its frame mounts,
      // which races plugin apply. Poll the declaration until the grace
      // deadline before conceding the DOM fallback (SLOTS_GRACE_MS 宽限轮询).
      const pollDeclaration = (): void => {
        if (committed) return
        let declared = false
        try {
          declared = typeof slots.spec === 'function' && slots.spec('conversation') !== undefined
        } catch {
          declared = false
        }
        if (declared) {
          commitSlotPath(slots)
          return
        }
        if (Date.now() < graceDeadline) {
          declarationPoll = setTimeout(pollDeclaration, 200)
          return
        }
        commitDomPath('conversation slot not declared within grace')
      }
      pollDeclaration()
    })
  } catch (error) {
    log('slots.inject-error', { message: error instanceof Error ? error.message : String(error) })
  }
  const graceTimer = setTimeout(() => {
    if (!slotsArrived) commitDomPath(`slots service not up within ${SLOTS_GRACE_MS}ms`)
  }, SLOTS_GRACE_MS)
  disposers.push(() => {
    clearTimeout(graceTimer)
    if (declarationPoll !== undefined) clearTimeout(declarationPoll)
  })

  teardown = () => {
    teardown = undefined
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose()
      } catch (error) {
        console.error('[dsh-api-client] dispose error:', error)
      }
    }
    if (activation.isActive()) activation.deactivate('dispose')
    log('dispose', {})
  }
}

/** Unified teardown for hot unload / HMR re-application. */
export function dispose(): void {
  teardown?.()
}
