/**
 * DSH home 路径解析（运行时副本；源自 M0 probe-log，§3.5 探针退役时拆分）。
 *
 * Runtime facts (dsh-home-paths @ 0.1.2-rc.1)：
 * - `$DSH_HOME` 覆盖 Harness home；缺省 `~/.dsh`；
 * - 空白 `$DSH_HOME` 视为未设置（绝不解析到 cwd）。
 */
import { join } from 'node:path'
import { homedir } from 'node:os'

/** Resolve the Harness home: `$DSH_HOME` first, then `~/.dsh`. */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.DSH_HOME
  if (override !== undefined && override.trim() !== '') return override
  return join(homedir(), '.dsh')
}
