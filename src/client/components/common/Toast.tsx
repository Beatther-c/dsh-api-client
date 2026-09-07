/**
 * 通用 Toast（错误/通知展示）：
 * - `toast` 为模块级总线（hooks 层错误统一出口，§5.1 错误 message 已经 host 脱敏）；
 * - `<ToastHost/>` 由面板根视图挂载一次，订阅总线渲染浮层。
 */
import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { colors, font } from './theme.ts'

export interface ToastItem {
  id: number
  kind: 'error' | 'info'
  message: string
}

type ToastListener = (items: ToastItem[]) => void

let nextId = 1
let items: ToastItem[] = []
const listeners = new Set<ToastListener>()
const timers = new Map<number, ReturnType<typeof setTimeout>>()

function emit(): void {
  for (const listener of [...listeners]) listener(items)
}

function dismiss(id: number): void {
  const timer = timers.get(id)
  if (timer !== undefined) clearTimeout(timer)
  timers.delete(id)
  items = items.filter((item) => item.id !== id)
  emit()
}

export const toast = {
  push(kind: 'error' | 'info', message: string): void {
    const id = nextId++
    items = [...items.slice(-4), { id, kind, message }]
    timers.set(id, setTimeout(() => dismiss(id), kind === 'error' ? 8000 : 4000))
    emit()
  },
  error(message: string): void {
    toast.push('error', message)
  },
  info(message: string): void {
    toast.push('info', message)
  },
  dismiss,
}

const hostStyle: CSSProperties = {
  position: 'fixed',
  right: 16,
  bottom: 16,
  zIndex: 1000,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  maxWidth: 380,
  pointerEvents: 'none',
}

/** 挂载一次的面板级 Toast 浮层。 */
export function ToastHost(): React.ReactElement | null {
  const [current, setCurrent] = useState<ToastItem[]>(items)
  useEffect(() => {
    const listener: ToastListener = (next) => setCurrent([...next])
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])
  if (current.length === 0) return null
  return (
    <div style={hostStyle} data-dsh-api-client="toast-host">
      {current.map((item) => (
        <div
          key={item.id}
          role={item.kind === 'error' ? 'alert' : 'status'}
          onClick={() => dismiss(item.id)}
          style={{
            pointerEvents: 'auto',
            cursor: 'pointer',
            padding: '8px 12px',
            borderRadius: 6,
            fontSize: font.size,
            lineHeight: 1.5,
            color: colors.text,
            background: colors.bgLayer2,
            border: `1px solid ${item.kind === 'error' ? colors.danger : colors.border}`,
            boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
            wordBreak: 'break-all',
          }}
        >
          {item.kind === 'error' ? '⚠ ' : ''}
          {item.message}
        </div>
      ))}
    </div>
  )
}
