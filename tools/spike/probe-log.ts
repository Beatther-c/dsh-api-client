/**
 * Probe result sink: one JSON Lines file under the Harness home.
 *
 * INTERNAL DEV TOOL ONLY (M0 spike 遗产，V01 §3.5 处置)：
 * WP0–WP8 用于生命周期/热插拔回归记录；WP8 起不再由 `src/host/index.ts`
 * 默认装配，移出运行时 dist 装配图。需要手动做生命周期/热插拔时序记录时，
 * 在本地开发副本中临时 import 本文件（运行时等价物是 src/host/host-log.ts
 * 的 console 日志面；resolveDshHome 的运行时副本在 src/host/dsh-home.ts）。
 *
 * Runtime facts (dsh-home-paths @ 0.1.2-rc.1):
 * - `$DSH_HOME` overrides the Harness home; the default is `~/.dsh`
 *   (`DSH_HOME_ENV` / `DSH_HOME_DIR_NAME` / `resolveDshHome`).
 * - A blank `$DSH_HOME` is treated as unset (whitespace-only never resolves
 *   to the cwd).
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** One probe-log line. `ts` is added by the sink at write time. */
export interface ProbeLogEntry {
  /** Emitting probe ('lifecycle' for the plugin entry itself). */
  probe: string
  /** Event name (e.g. install/mount/start/stop/unmount, register, dispose). */
  event: string
  /** Optional structured payload (must be JSON-safe). */
  detail?: unknown
}

/** Resolve the Harness home: `$DSH_HOME` first, then `~/.dsh`. */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.DSH_HOME
  if (override !== undefined && override.trim() !== '') return override
  return join(homedir(), '.dsh')
}

/** The M0 spike probe-log path contract: `$DSH_HOME/api-client/spike/probe-log.jsonl`. */
export function probeLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveDshHome(env), 'api-client', 'spike', 'probe-log.jsonl')
}

export interface ProbeLog {
  /** Absolute path of the JSONL sink. */
  readonly path: string
  /** Append one entry; creates the directory lazily. Never throws into the host. */
  log(probe: string, event: string, detail?: unknown): void
}

/**
 * Create the probe-log sink. Writes are synchronous appends: the M0 probes
 * are low-frequency lifecycle events, and a synchronous write survives an
 * abrupt host teardown better than a buffered one.
 */
export function createProbeLog(path: string = probeLogPath()): ProbeLog {
  return {
    path,
    log(probe, event, detail) {
      try {
        mkdirSync(dirname(path), { recursive: true })
        const line = JSON.stringify({ ts: new Date().toISOString(), probe, event, ...(detail === undefined ? {} : { detail }) })
        appendFileSync(path, line + '\n', 'utf8')
      } catch (error) {
        // The probe sink must never take the host down; surface on stderr only.
        console.error('[dsh-api-client] probe-log write failed:', error)
      }
    },
  }
}
