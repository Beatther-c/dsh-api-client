/**
 * 请求树侧栏宽度偏好（P0 UX §5 / 实施设计 §4.1.3、§6.7）：
 * - 初始 `GET /settings` 读 `collectionSidebarWidth`；缺省/异常一律回落默认 260，
 *   加载值恒钳制到正常宽度域 220–520 的整数（§0.4：compact 渲染可低于 220，
 *   但持久化偏好永远属于正常域）；
 * - `persist(width)`：立即持久化（双击分隔条 / pointerup 收敛）；
 * - `persistDebounced(width)`：300ms debounce 持久化（键盘连续调整），内存偏好同样立即更新；
 * - PATCH 失败：中文非阻断 toast，当前会话继续使用内存宽度，不回滚（AC-33）。
 *
 * 数据流纪律：hook → Host API → service → storage，禁止直接 fetch；
 * 本文件不 import 任何 DSH 包（TC-A-03）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PluginSettings } from '@dsh-api-client/shared'
import { toast } from '../components/common/Toast.tsx'
import { useHostApi } from './useHostApi.ts'

/** 默认偏好宽度（与 host DEFAULT_PLUGIN_SETTINGS.collectionSidebarWidth 一致）。 */
export const SIDEBAR_WIDTH_DEFAULT = 260
/** 持久化偏好正常域下界（实施设计 §4.1.3）。 */
export const SIDEBAR_WIDTH_MIN = 220
/** 持久化偏好正常域上界（实施设计 §4.1.3）。 */
export const SIDEBAR_WIDTH_MAX = 520
/** 键盘连续调整的持久化 debounce（UX §5：300ms）。 */
export const SIDEBAR_PERSIST_DEBOUNCE_MS = 300

/** 保存失败的中文非阻断提示（AC-33；文案不含英文错误细节，避免泄露原始响应）。 */
export const SIDEBAR_SAVE_FAILED_MESSAGE = '侧栏宽度保存失败，本次会话继续使用当前宽度'

/**
 * 把任意宽度收敛到持久化偏好域：四舍五入取整并钳制 220–520；
 * 非有限数（NaN/Infinity）回落默认 260。
 */
export function clampSidebarPreference(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_WIDTH_DEFAULT
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(width)))
}

/** 从 settings 响应安全读取偏好宽度：缺失/非数字/非有限 → 默认值，再钳制。 */
function readPreferredFromSettings(settings: PluginSettings | undefined | null): number {
  const raw = settings?.collectionSidebarWidth
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return SIDEBAR_WIDTH_DEFAULT
  return clampSidebarPreference(raw)
}

export interface CollectionSidebarWidthState {
  /** 正常宽度域（220–520 整数）的偏好宽度；初始加载完成前为默认 260。 */
  preferredWidth: number
  /** 初始 GET /settings 是否已 settle（成功应用或失败回落）。 */
  loaded: boolean
  /** 立即持久化：内存偏好即刻更新并立刻 PATCH（双击 / pointerup 用）。 */
  persist: (width: number) => void
  /** 300ms debounce 持久化：内存偏好即刻更新，PATCH 合并到停顿后一次（键盘连按用）。 */
  persistDebounced: (width: number) => void
}

export function useCollectionSidebarWidth(): CollectionSidebarWidthState {
  const api = useHostApi()
  const [preferredWidth, setPreferredWidth] = useState<number>(SIDEBAR_WIDTH_DEFAULT)
  const [loaded, setLoaded] = useState(false)

  /** debounce 定时器与待落盘值（unmount 时 flush，避免丢失最后一次键盘调整）。 */
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pendingRef = useRef<number | null>(null)
  /** 用户已在本会话调整过：迟到的初始加载结果不得覆盖用户新值。 */
  const touchedRef = useRef(false)

  // 初始加载：GET /settings → 钳制应用；任何异常静默回落默认值（不阻断渲染）。
  useEffect(() => {
    let cancelled = false
    api
      .get<PluginSettings>('/settings')
      .then((settings) => {
        if (cancelled) return
        if (!touchedRef.current) setPreferredWidth(readPreferredFromSettings(settings))
      })
      .catch(() => {
        if (cancelled || touchedRef.current) return
        setPreferredWidth(SIDEBAR_WIDTH_DEFAULT)
      })
      .finally(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [api])

  /** api 经 ref 读取：写队列函数身份恒稳（防 client 引用变化误触发 effect 重跑/假 flush）。 */
  const apiRef = useRef(api)
  apiRef.current = api

  // ---- PATCH 单写队列（last-write-wins sequencer，review R-10/P1）----
  // 根问题：persist（立即）与 persistDebounced（300ms 定时器）可能并发发出两个 PATCH，
  // 响应乱序时磁盘落旧值（会话内显示新值，reload 才暴露）。
  // 合同：空闲时同步直发（保持「双击/pointerup 立即持久化」语义）；in-flight 期间的新值
  // 只覆盖待发值（仅保留最新一个）；前一 PATCH settle（成败均算）后再发待发值；
  // 失败仍走中文非阻断 toast + 内存不回滚（AC-33）。不改 Host 合同。
  const writingRef = useRef(false)
  const queuedWriteRef = useRef<number | null>(null)

  const dispatchPatch = useCallback((value: number): void => {
    writingRef.current = true
    // settle（成败均算）后泵队列：单跳 then(onOk, onErr)——避免 catch+finally 双跳
    // 拉长乱序窗口，也便于测试确定性排空。
    const pump = (): void => {
      const next = queuedWriteRef.current
      if (next !== null) {
        queuedWriteRef.current = null
        dispatchPatch(next) // 串行续发最新待发值
      } else {
        writingRef.current = false
      }
    }
    void apiRef.current.patch<PluginSettings>('/settings', { collectionSidebarWidth: value }).then(pump, () => {
      // 非阻断：内存宽度不回滚，仅中文 toast（AC-33）；失败后续发队列不受影响。
      toast.error(SIDEBAR_SAVE_FAILED_MESSAGE)
      pump()
    })
  }, [])

  const enqueuePatch = useCallback(
    (value: number): void => {
      if (writingRef.current) {
        queuedWriteRef.current = value // last-write-wins：待发值被最新覆盖
        return
      }
      dispatchPatch(value)
    },
    [dispatchPatch],
  )

  const cancelTimer = useCallback((): void => {
    if (timerRef.current !== undefined) {
      clearTimeout(timerRef.current)
      timerRef.current = undefined
    }
  }, [])

  const persist = useCallback(
    (width: number): void => {
      const next = clampSidebarPreference(width)
      touchedRef.current = true
      cancelTimer()
      pendingRef.current = null // 取消的 debounce 值不再参与 unmount flush
      setPreferredWidth(next)
      enqueuePatch(next)
    },
    [cancelTimer, enqueuePatch],
  )

  const persistDebounced = useCallback(
    (width: number): void => {
      const next = clampSidebarPreference(width)
      touchedRef.current = true
      setPreferredWidth(next) // 内存立即更新（设计 §6.7「键盘调整后立即更新内存」）
      cancelTimer()
      pendingRef.current = next
      timerRef.current = setTimeout(() => {
        timerRef.current = undefined
        const value = pendingRef.current
        pendingRef.current = null
        if (value !== null) enqueuePatch(value)
      }, SIDEBAR_PERSIST_DEBOUNCE_MS)
    },
    [cancelTimer, enqueuePatch],
  )

  // unmount：清定时器并把未落盘的 debounce 值送入写队列（in-flight 时排队续发，
  // 不丢最后一次键盘调整；fire-and-forget，不 setState）。deps 经 enqueuePatch 恒稳。
  useEffect(() => {
    return () => {
      if (timerRef.current !== undefined) clearTimeout(timerRef.current)
      const pending = pendingRef.current
      pendingRef.current = null
      if (pending !== null) enqueuePatch(pending)
    }
  }, [enqueuePatch])

  return { preferredWidth, loaded, persist, persistDebounced }
}
