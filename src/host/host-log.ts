/**
 * 宿主运行时的最小日志面（M0 probe-log 退役后的替代，§3.5）：
 * 结构化事件（scope/event/detail）输出到宿主 console——不落盘、不装配
 * 任何额外 I/O。与探针的区别：probe-log 是 WP0–WP8 的时序记录义务
 * （已随探针退役终止，移 tools/spike/），本面只是常规运行时日志。
 */
export interface HostLog {
  log(scope: string, event: string, detail?: unknown): void
}

/** console 实现：生命周期/装配事件在宿主日志中可见，卸载无残留。 */
export function createConsoleHostLog(prefix = '[dsh-api-client]'): HostLog {
  return {
    log(scope, event, detail) {
      if (detail === undefined) {
        console.debug(prefix, scope, event)
      } else {
        console.debug(prefix, scope, event, detail)
      }
    },
  }
}

/** 测试用静音实现（断言只需要调用形状，不需要输出）。 */
export function createSilentHostLog(): HostLog {
  return { log: () => {} }
}
