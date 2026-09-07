/**
 * Profile service（§3.4；由 M0 profile-probe 演进，§3.5 处置：探针文件删除、
 * 四级探测逻辑沉淀于此）：
 *
 * §19.1 四级优先级探测（WP0 V-15 实测 loader-metadata 命中）：
 *   1. runtime metadata（launcher 的 launchEnvironment.DSH_PROFILE）；
 *   2. loader metadata——`$DSH_HOME/profiles/<name>/package.json` 中唯一安装
 *      本包的 profile（dependencies 或 dsh.profile.bundles）；
 *   3. 环境变量（DSH_PROFILE / DSH_PROFILE_NAME）；
 *   4. 显式 plugin config（profileId）。
 *
 * fail-closed（§4.4，D19）：四路均失败 → profileId = 'unresolved'，
 * profile-scoped 写入（history/settings/audit）一律 assertResolved() 显式报错；
 * shared scope 不受影响。严禁猜测 profile 名（D19）。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type ProfileSource = 'runtime-metadata' | 'loader-metadata' | 'env' | 'config' | 'unresolved'

export interface ProfileDetection {
  profileId: string
  source: ProfileSource
  levels: Array<{ level: ProfileSource; hit: boolean; detail?: string }>
}

export const UNRESOLVED_PROFILE_ID = 'unresolved'

/**
 * §4.4 fail-closed 的 UI 提示文案常量（TC-S-05）：profile-scoped 写入被拒时
 * 经 API 错误 payload（ProfileUnresolvedError.message 内含本文案）送达 client；
 * 具体展示形态（History 入口停用提示等）由 WP3 负责。
 */
export const PROFILE_UNRESOLVED_HINT = 'profile 未识别，History 已停用'

/** 本包名——loader-metadata 级按它搜索 profile manifest。 */
const SELF_PACKAGE_NAME = 'dsh-api-client'

interface ProfileManifestShape {
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
}

/** Level 2 辅助：安装了这个包的 profile 名列表（纯函数，可测）。 */
export function findProfilesCarryingPackage(home: string, packageName: string = SELF_PACKAGE_NAME): string[] {
  const profilesDir = join(home, 'profiles')
  let names: string[]
  try {
    names = readdirSync(profilesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
  const matches: string[] = []
  for (const name of names) {
    try {
      const manifest = JSON.parse(readFileSync(join(profilesDir, name, 'package.json'), 'utf8')) as ProfileManifestShape
      const inDependencies = manifest.dependencies !== undefined && packageName in manifest.dependencies
      const inBundles = manifest.dsh?.profile?.bundles?.includes(packageName) === true
      if (inDependencies || inBundles) matches.push(name)
    } catch {
      // profile 无可读 manifest = 无任何方向证据
    }
  }
  return matches
}

/** Level 1 的 launcher 服务形态（dsh-launch-environment，结构化类型避免运行时依赖）。 */
export interface LaunchEnvironmentLike {
  get(name: string): { value: string; source: string } | undefined
}

export interface ProfileDetectOptions {
  launchEnvironment?: LaunchEnvironmentLike
  config?: { profileId?: string }
  env?: NodeJS.ProcessEnv
  /** $DSH_HOME（level 2 搜索根）；调用方负责解析（index.ts 用 resolveDshHome）。 */
  home?: string
  packageName?: string
}

/** profile-scoped 写入在 unresolved 时的 fail-closed 错误（§4.4）。 */
export class ProfileUnresolvedError extends Error {
  readonly code = 'profile-unresolved'
  /** router 统一错误映射（§5.1 错误格式）。 */
  readonly httpStatus = 503
  /** UI 提示文案（= PROFILE_UNRESOLVED_HINT；client 从错误 payload 读取）。 */
  readonly hint = PROFILE_UNRESOLVED_HINT

  constructor(scope: string) {
    super(`profile unresolved: ${scope} is disabled (fail-closed, D19/§4.4) — ${PROFILE_UNRESOLVED_HINT}`)
    this.name = 'ProfileUnresolvedError'
  }
}

export class ProfileService {
  private constructor(readonly detection: ProfileDetection) {}

  /** 跑四级探测；任何一路命中即返回，全部失败 → unresolved 哨兵（D19，严禁猜测）。 */
  static detect(options: ProfileDetectOptions = {}): ProfileService {
    const env = options.env ?? process.env
    const home = options.home
    const levels: ProfileDetection['levels'] = []

    // Level 1 — runtime metadata（可选 launcher 服务）。
    const fromRuntime = options.launchEnvironment?.get('DSH_PROFILE')?.value
    if (fromRuntime !== undefined && fromRuntime.trim() !== '') {
      levels.push({ level: 'runtime-metadata', hit: true, detail: 'launchEnvironment.DSH_PROFILE' })
      return new ProfileService({ profileId: fromRuntime, source: 'runtime-metadata', levels })
    }
    levels.push({
      level: 'runtime-metadata',
      hit: false,
      detail: options.launchEnvironment === undefined ? 'launchEnvironment service absent' : 'DSH_PROFILE unset',
    })

    // Level 2 — loader metadata：唯一安装本包的 profile。
    if (home !== undefined) {
      const carriers = findProfilesCarryingPackage(home, options.packageName ?? SELF_PACKAGE_NAME)
      if (carriers.length === 1) {
        levels.push({ level: 'loader-metadata', hit: true, detail: `profiles/${carriers[0]}/package.json` })
        return new ProfileService({ profileId: carriers[0]!, source: 'loader-metadata', levels })
      }
      levels.push({
        level: 'loader-metadata',
        hit: false,
        detail: carriers.length === 0 ? 'no profile manifest carries this package' : `ambiguous: ${carriers.join(', ')}`,
      })
    } else {
      levels.push({ level: 'loader-metadata', hit: false, detail: 'DSH home unknown' })
    }

    // Level 3 — 环境变量。
    const fromEnv = env.DSH_PROFILE ?? env.DSH_PROFILE_NAME
    if (fromEnv !== undefined && fromEnv.trim() !== '') {
      levels.push({ level: 'env', hit: true, detail: env.DSH_PROFILE !== undefined ? 'DSH_PROFILE' : 'DSH_PROFILE_NAME' })
      return new ProfileService({ profileId: fromEnv, source: 'env', levels })
    }
    levels.push({ level: 'env', hit: false, detail: 'DSH_PROFILE / DSH_PROFILE_NAME unset' })

    // Level 4 — 显式 plugin config。
    if (typeof options.config?.profileId === 'string' && options.config.profileId.trim() !== '') {
      levels.push({ level: 'config', hit: true, detail: 'plugin config profileId' })
      return new ProfileService({ profileId: options.config.profileId, source: 'config', levels })
    }
    levels.push({ level: 'config', hit: false, detail: 'no profileId in plugin config' })

    return new ProfileService({ profileId: UNRESOLVED_PROFILE_ID, source: 'unresolved', levels })
  }

  get profileId(): string {
    return this.detection.profileId
  }

  get source(): ProfileSource {
    return this.detection.source
  }

  get resolved(): boolean {
    return this.detection.source !== 'unresolved'
  }

  /** fail-closed 闸（§4.4）：profile-scoped 写入前必须调用。 */
  assertResolved(scope: string): void {
    if (!this.resolved) throw new ProfileUnresolvedError(scope)
  }
}
