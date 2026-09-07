/**
 * §4.2 存储布局常量与权限基线（REVIEW 中级 #1）。
 * 仅定义路径片段/权限常量与纯拼接函数；零 I/O，落盘与 chmod 由 host file-store 负责。
 */

/** $DSH_HOME 下的插件数据根目录名。 */
export const API_CLIENT_DIR = 'api-client'

export const SHARED_DIR = 'shared'
export const COLLECTIONS_FILE = 'collections.json'
export const ENVIRONMENTS_FILE = 'environments.json'
export const SECRETS_DIR = 'secrets'
export const SECRET_FILE_SUFFIX = '.json'
export const NETWORK_POLICY_DEFAULT_FILE = 'network-policy.default.json'

export const PROFILES_DIR = 'profiles'
export const HISTORY_DIR = 'history'
export const HISTORY_FILE = 'history.jsonl'
export const SETTINGS_FILE = 'settings.json'
export const AUDIT_FILE = 'audit.jsonl'
/** profile 自省失败时的隔离目录（§4.4 fail-closed 证据）。 */
export const UNRESOLVED_PROFILE_DIR = 'unresolved'

export const IMPORTS_DIR = 'imports'

/** 权限基线（§4.2 / AC-42）：secrets 目录 0700、secret 文件 0600，显式 chmod，不依赖 umask。 */
export const SECRETS_DIR_MODE = 0o700
export const SECRET_FILE_MODE = 0o600

/** 默认 scope（§19 表，D18）。 */
export const STORAGE_SCOPES = {
  collections: 'shared',
  environments: 'shared',
  secrets: 'shared',
  history: 'profile',
  settings: 'profile',
  audit: 'profile',
  /** profile 可继承 shared default。 */
  networkPolicy: 'profile-inherits-shared',
  imports: 'shared',
} as const

export type StorageScope = (typeof STORAGE_SCOPES)[keyof typeof STORAGE_SCOPES]

/** §4.2 目录树的纯路径解析（给定 $DSH_HOME，返回全部布局路径；不触碰文件系统）。 */
export interface StorageLayout {
  root: string
  sharedDir: string
  collectionsFile: string
  environmentsFile: string
  secretsDir: string
  networkPolicyDefaultFile: string
  profilesDir: string
  unresolvedProfileDir: string
  importsDir: string
}

export function resolveStorageLayout(dshHome: string): StorageLayout {
  const root = `${dshHome}/${API_CLIENT_DIR}`
  const sharedDir = `${root}/${SHARED_DIR}`
  return {
    root,
    sharedDir,
    collectionsFile: `${sharedDir}/${COLLECTIONS_FILE}`,
    environmentsFile: `${sharedDir}/${ENVIRONMENTS_FILE}`,
    secretsDir: `${sharedDir}/${SECRETS_DIR}`,
    networkPolicyDefaultFile: `${sharedDir}/${NETWORK_POLICY_DEFAULT_FILE}`,
    profilesDir: `${root}/${PROFILES_DIR}`,
    unresolvedProfileDir: `${root}/${PROFILES_DIR}/${UNRESOLVED_PROFILE_DIR}`,
    importsDir: `${root}/${IMPORTS_DIR}`,
  }
}

/** profile scope 子路径（纯拼接）。 */
export function profileLayout(layout: StorageLayout, profileId: string): {
  profileDir: string
  historyFile: string
  settingsFile: string
  auditFile: string
} {
  const profileDir = `${layout.profilesDir}/${profileId}`
  return {
    profileDir,
    historyFile: `${profileDir}/${HISTORY_DIR}/${HISTORY_FILE}`,
    settingsFile: `${profileDir}/${SETTINGS_FILE}`,
    auditFile: `${profileDir}/${AUDIT_FILE}`,
  }
}

/** secret 落盘路径：shared/secrets/<secretId>.json（纯拼接）。 */
export function secretRecordFile(layout: StorageLayout, secretId: string): string {
  return `${layout.secretsDir}/${secretId}${SECRET_FILE_SUFFIX}`
}

/** ImportReport 持久化路径：imports/<importId>.json（纯拼接）。 */
export function importReportFile(layout: StorageLayout, importId: string): string {
  return `${layout.importsDir}/${importId}.json`
}
