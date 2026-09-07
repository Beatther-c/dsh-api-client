// @vitest-environment node
/**
 * TC-S-01…11（§6.4）：Storage Scope 与 Secrets at-rest（WP4）。
 *
 * 形态：tmp 目录注入存储根（createHostServices 与 src/host/index.ts 同一组装点）；
 * 权限位用 stat mode 断言；scope 隔离用「写入前后全量文件快照 diff」断言。
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ApiRequest, Environment, ExecutionHistory, SecretRef, StorageLayout } from '@dsh-api-client/shared'
import { isSecretRef, profileLayout } from '@dsh-api-client/shared'
import { resolveRequest } from '@dsh-api-client/core'
import type { HostServices } from '../src/host/index.ts'
import { createHostServices } from '../src/host/index.ts'
import { PROFILE_UNRESOLVED_HINT, ProfileService, ProfileUnresolvedError } from '../src/host/services/profile-service.ts'
import { DanglingSecretRefError } from '../src/host/services/secret-store-service.ts'

const PROFILE_ID = 'test-profile'
const SECRET_VALUE = 'tc-s-secret-plaintext-7f3a9c2e'
const DAY_MS = 24 * 60 * 60 * 1000

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

interface Fixture {
  home: string
  layout: StorageLayout
  profile: ProfileService
  services: HostServices
}

/** resolved profile（env 级探测命中）的完整服务装配。 */
function setup(profileId: string = PROFILE_ID): Fixture {
  const home = mkdtempSync(join(tmpdir(), 'dsh-api-client-storage-'))
  cleanups.push(() => rmSync(home, { recursive: true, force: true }))
  const profile = ProfileService.detect({ env: { DSH_PROFILE: profileId }, home })
  const services = createHostServices({ dshHome: home, profile })
  return { home, layout: services.store.layout, profile, services }
}

/** 四路探测全失败的 unresolved 装配（fail-closed 测试面）。 */
function setupUnresolved(): Fixture {
  const home = mkdtempSync(join(tmpdir(), 'dsh-api-client-storage-unresolved-'))
  cleanups.push(() => rmSync(home, { recursive: true, force: true }))
  const profile = ProfileService.detect({ env: {}, config: {}, home })
  const services = createHostServices({ dshHome: home, profile })
  return { home, layout: services.store.layout, profile, services }
}

/** 存储根下全部文件的快照（relPath → utf8 内容）；只跟踪文件，不跟踪目录。 */
function listFiles(root: string): Map<string, string> {
  const out = new Map<string, string>()
  if (!existsSync(root)) return out
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else out.set(relative(root, full), readFileSync(full, 'utf8'))
    }
  }
  walk(root)
  return out
}

/** 快照 diff：新增 + 内容变化 + 删除的 relPath 列表（排序）。 */
function diffSnapshots(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed: string[] = []
  for (const [path, content] of after) {
    if (!before.has(path) || before.get(path) !== content) changed.push(path)
  }
  for (const path of before.keys()) {
    if (!after.has(path)) changed.push(path)
  }
  return changed.sort()
}

function makeHistoryEntry(profileId: string, timestamp = Date.now()): ExecutionHistory {
  return {
    id: crypto.randomUUID(),
    timestamp,
    method: 'GET',
    displayUrl: 'https://example.com/api',
    requestSnapshot: { method: 'GET', displayUrl: 'https://example.com/api', headers: [], auth: { type: 'none' } },
    responseSnapshot: { status: 200, statusText: 'OK', headers: [], size: 2, durationMs: 1 },
    duration: 1,
    source: 'human',
    profileId,
  }
}

function makeRequest(url: string): ApiRequest {
  const now = Date.now()
  return {
    id: crypto.randomUUID(),
    name: 'r',
    method: 'GET',
    url,
    params: [],
    headers: [],
    auth: { type: 'none' },
    body: { type: 'none' },
    collectionId: '',
    createdAt: now,
    updatedAt: now,
  }
}

/** fail-closed 错误契约断言：显式错误 + code/httpStatus + 提示文案（TC-S-05）。 */
function expectProfileUnresolved(op: () => unknown, scope: string): void {
  let error: unknown
  try {
    op()
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(ProfileUnresolvedError)
  const err = error as ProfileUnresolvedError
  expect(err.code).toBe('profile-unresolved')
  expect(err.httpStatus).toBe(503)
  expect(err.hint).toBe(PROFILE_UNRESOLVED_HINT)
  expect(err.message).toContain(scope)
  expect(err.message).toContain(PROFILE_UNRESOLVED_HINT)
}

describe('TC-S-01: 首次启动 → §4.2 目录树自动创建', () => {
  it('shared/secrets(0700)/profiles/<pid>/history/profiles/unresolved/imports 全部落地', () => {
    const fx = setup()
    const { layout } = fx
    expect(existsSync(layout.root)).toBe(true)
    expect(existsSync(layout.sharedDir)).toBe(true)
    expect(existsSync(layout.secretsDir)).toBe(true)
    expect(statSync(layout.secretsDir).mode & 0o777).toBe(0o700)
    expect(existsSync(layout.profilesDir)).toBe(true)
    expect(existsSync(layout.unresolvedProfileDir)).toBe(true)
    expect(existsSync(layout.importsDir)).toBe(true)
    const pl = profileLayout(layout, PROFILE_ID)
    expect(existsSync(pl.profileDir)).toBe(true)
    expect(existsSync(join(pl.profileDir, 'history'))).toBe(true)
  })

  it('unresolved 首启：不建任何 <pid> 目录，只落 profiles/unresolved/', () => {
    const fx = setupUnresolved()
    expect(fx.profile.resolved).toBe(false)
    expect(existsSync(fx.layout.unresolvedProfileDir)).toBe(true)
    expect(existsSync(join(fx.layout.profilesDir, fx.profile.profileId, 'history'))).toBe(false)
  })
})

describe('TC-S-02: 写 collection → 仅 shared/collections.json 变化', () => {
  it('文件快照 diff 精确等于 collections.json', () => {
    const fx = setup()
    const before = listFiles(fx.layout.root)
    const collection = fx.services.collections.create('orders')
    const changed = diffSnapshots(before, listFiles(fx.layout.root))
    expect(changed).toEqual(['shared/collections.json'])
    const stored = JSON.parse(readFileSync(fx.layout.collectionsFile, 'utf8')) as Array<{ id: string }>
    expect(stored.map((c) => c.id)).toEqual([collection.id])
  })
})

describe('TC-S-03: 写 history → 仅 profiles/<pid>/history/history.jsonl 变化', () => {
  it('文件快照 diff 精确等于 history.jsonl，且逐行可解析', () => {
    const fx = setup()
    const before = listFiles(fx.layout.root)
    const entry = makeHistoryEntry(PROFILE_ID)
    fx.services.history.append(entry)
    const changed = diffSnapshots(before, listFiles(fx.layout.root))
    expect(changed).toEqual([`profiles/${PROFILE_ID}/history/history.jsonl`])
    const historyFile = profileLayout(fx.layout, PROFILE_ID).historyFile
    const lines = readFileSync(historyFile, 'utf8').split('\n').filter((l) => l.trim() !== '')
    expect(lines).toHaveLength(1)
    expect((JSON.parse(lines[0]!) as ExecutionHistory).id).toBe(entry.id)
  })
})

describe('TC-S-04: 写 settings → 仅 profiles/<pid>/settings.json 变化', () => {
  it('文件快照 diff 精确等于 settings.json', () => {
    const fx = setup()
    const before = listFiles(fx.layout.root)
    fx.services.settings.patch({ defaultTimeoutMs: 5000 })
    const changed = diffSnapshots(before, listFiles(fx.layout.root))
    expect(changed).toEqual([`profiles/${PROFILE_ID}/settings.json`])
    const stored = JSON.parse(readFileSync(profileLayout(fx.layout, PROFILE_ID).settingsFile, 'utf8')) as {
      defaultTimeoutMs: number
    }
    expect(stored.defaultTimeoutMs).toBe(5000)
  })
})

describe('TC-S-05: 四路探测全失败 → profile 写显式错误 + 提示文案 + shared 写不受影响', () => {
  it('fail-closed（D19/§4.4）：history/settings/audit 显式错误，shared scope 正常', () => {
    const fx = setupUnresolved()
    expect(fx.profile.resolved).toBe(false)
    expect(fx.profile.profileId).toBe('unresolved')
    expect(fx.profile.detection.levels).toHaveLength(4)
    expect(fx.profile.detection.levels.every((l) => !l.hit)).toBe(true)

    // 提示语文案常量存在（client 经错误 payload 读取；展示由 WP3 负责）。
    expect(PROFILE_UNRESOLVED_HINT).toBe('profile 未识别，History 已停用')

    // profile-scoped 写一律显式错误（错误码含 profile-unresolved 语义）。
    expectProfileUnresolved(() => fx.services.history.append(makeHistoryEntry('unresolved')), 'history')
    expectProfileUnresolved(() => fx.services.history.list(), 'history')
    expectProfileUnresolved(() => fx.services.history.clear(), 'history')
    expectProfileUnresolved(() => fx.services.settings.patch({ saveHistory: false }), 'settings')
    expectProfileUnresolved(
      () =>
        fx.services.audit.record({
          timestamp: Date.now(),
          source: 'human',
          method: 'GET',
          host: 'example.com',
          outcome: 'success',
        }),
      'audit',
    )

    // shared scope 写不受影响（collections/environments/secrets 正常落盘）。
    fx.services.collections.create('shared-c')
    const env = fx.services.environments.create('shared-env')
    fx.services.environments.writeSecret(env.id, 'api_key', SECRET_VALUE)
    expect(existsSync(fx.layout.collectionsFile)).toBe(true)
    expect(existsSync(fx.layout.environmentsFile)).toBe(true)
    expect(listFiles(fx.layout.secretsDir).size).toBe(1)
  })
})

describe('TC-S-06: 写 secret → shared/secrets/ 目录 0700、文件 0600', () => {
  it('stat mode 断言（显式 chmod，不依赖 umask）', () => {
    const fx = setup()
    const env = fx.services.environments.create('prod')
    fx.services.environments.writeSecret(env.id, 'api_key', SECRET_VALUE)
    expect(statSync(fx.layout.secretsDir).mode & 0o777).toBe(0o700)
    const files = readdirSync(fx.layout.secretsDir)
    expect(files).toHaveLength(1)
    expect(statSync(join(fx.layout.secretsDir, files[0]!)).mode & 0o777).toBe(0o600)
  })
})

describe('TC-S-07: environments.json 不含明文 + 明文注入被序列化层抛错拒写', () => {
  it('secret 变量保存后 environments.json 只含 SecretRef；secrets/ 之外无任何明文', () => {
    const fx = setup()
    const env = fx.services.environments.create('prod')
    fx.services.environments.writeSecret(env.id, 'api_key', SECRET_VALUE)

    const raw = readFileSync(fx.layout.environmentsFile, 'utf8')
    expect(raw).not.toContain(SECRET_VALUE)
    expect(raw).toContain('"$ref"')

    // secrets/ 目录之外的任何文件都不含明文（唯一明文出口 = secret 文件本身）。
    for (const [path, content] of listFiles(fx.layout.root)) {
      if (path.startsWith('shared/secrets/')) continue
      expect(content, `${path} must not contain plaintext`).not.toContain(SECRET_VALUE)
    }
    const secretFiles = [...listFiles(fx.layout.secretsDir).values()]
    expect(secretFiles).toHaveLength(1)
    expect(secretFiles[0]).toContain(SECRET_VALUE)
  })

  it('patch 路径写 secret 变量被拒（write-only 端点纪律）', () => {
    const fx = setup()
    const env = fx.services.environments.create('prod')
    fx.services.environments.writeSecret(env.id, 'api_key', SECRET_VALUE)
    expect(() => fx.services.environments.patch(env.id, { variables: [{ key: 'api_key', value: 'x' }] })).toThrowError(
      /secret/,
    )
  })

  it('构造明文注入（secret=true 持明文）→ 任何写路径在序列化层抛错拒写，文件不变', () => {
    const fx = setup()
    fx.services.environments.create('clean')
    const before = readFileSync(fx.layout.environmentsFile, 'utf8')

    // 绕过正常入口直接污染权威态（防御纵深断言：persist 的序列化前不变量兜底）。
    const tampered: Environment = {
      id: 'tampered',
      name: 't',
      variables: [{ key: 'leak', currentValue: SECRET_VALUE, secret: true, enabled: true }],
    }
    ;(fx.services.environments as unknown as { environments: Environment[] }).environments.push(tampered)

    expect(() => fx.services.environments.create('trigger-write')).toThrowError(/must hold a SecretRef/)
    expect(readFileSync(fx.layout.environmentsFile, 'utf8')).toBe(before)
    expect(readFileSync(fx.layout.environmentsFile, 'utf8')).not.toContain(SECRET_VALUE)
  })
})

describe('TC-S-08: 解析链到执行期内存且不回写任何存储', () => {
  it('Environment SecretRef → secret-store → 解析值（带 trace）；存储零变化', async () => {
    const fx = setup()
    const env = fx.services.environments.create('prod')
    fx.services.environments.writeSecret(env.id, 'api_key', SECRET_VALUE)

    const before = listFiles(fx.layout.root)
    const environment = fx.services.environments.get(env.id)!
    const resolveSecret = fx.services.environments.createSecretResolver(env.id)
    const resolved = await resolveRequest(makeRequest('https://api.example.com/{{api_key}}/ping'), {
      environment,
      resolveSecret,
    })

    // 解析值只存在于执行期内存（ResolvedRequest），trace 标记 secret 来源。
    expect(resolved.url).toBe(`https://api.example.com/${SECRET_VALUE}/ping`)
    expect(resolved.secretValueTraces).toContainEqual({
      location: 'url',
      key: 'api_key',
      secretRef: expect.any(String),
    })

    // 解析结果不回写任何存储：environments.json / secrets/ 全部字节不变、无新文件。
    expect(diffSnapshots(before, listFiles(fx.layout.root))).toEqual([])
    expect(readFileSync(fx.layout.environmentsFile, 'utf8')).not.toContain(SECRET_VALUE)
  })
})

describe('TC-S-09: 删除 secret 后悬空 SecretRef → 显式报错指明 env key', () => {
  it('不静默置空：DanglingSecretRefError 带 envKey', async () => {
    const fx = setup()
    const env = fx.services.environments.create('prod')
    fx.services.environments.writeSecret(env.id, 'api_key', SECRET_VALUE)

    const variable = fx.services.environments.get(env.id)!.variables.find((v) => v.key === 'api_key')!
    expect(isSecretRef(variable.currentValue)).toBe(true)
    const ref = variable.currentValue as SecretRef

    // 只删 secret 文件（environments.json 中的 SecretRef 悬空）。
    fx.services.secrets.deleteSecret(ref)

    const environment = fx.services.environments.get(env.id)!
    const resolveSecret = fx.services.environments.createSecretResolver(env.id)
    let error: unknown
    try {
      await resolveRequest(makeRequest('https://api.example.com/{{api_key}}'), { environment, resolveSecret })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(DanglingSecretRefError)
    const err = error as DanglingSecretRefError
    expect(err.code).toBe('dangling-secret-ref')
    expect(err.envKey).toBe('api_key')
    expect(err.message).toContain('api_key')
    expect(err.message).not.toContain(SECRET_VALUE)
  })
})

describe('TC-S-10: 并发/中断写入 → 原子写保证无半截 JSON', () => {
  it('kill 模拟（遗留半截 tmp）后文件可解析；连续写入全程可解析、无 tmp 残留', () => {
    const fx = setup()
    const { layout, services } = fx
    services.environments.create('v1')

    // 中断模拟：崩溃遗留的半截 tmp 文件不得影响目标文件。
    const orphanTmp = `${layout.environmentsFile}.tmp-99999-0`
    writeFileSync(orphanTmp, '{"broken":', 'utf8')
    expect(() => JSON.parse(readFileSync(layout.environmentsFile, 'utf8'))).not.toThrow()

    // 后续写入正常，目标文件始终可解析。
    services.environments.create('v2')
    const parsed = JSON.parse(readFileSync(layout.environmentsFile, 'utf8')) as Environment[]
    expect(parsed.map((e) => e.name)).toEqual(['v1', 'v2'])

    // 连续写入（含 JSONL append / 原子重写）：每次写完文件都可解析。
    for (let i = 0; i < 20; i++) {
      services.collections.create(`c-${i}`)
      JSON.parse(readFileSync(layout.collectionsFile, 'utf8'))
    }
    services.history.append(makeHistoryEntry(PROFILE_ID))
    services.history.clear()

    // 全部正式文件可解析（JSON 整文件 / JSONL 逐行）。
    for (const [path, content] of listFiles(layout.root)) {
      if (path.includes('.tmp-')) continue // 崩溃遗物不属于正式文件
      if (path.endsWith('.jsonl')) {
        for (const line of content.split('\n')) {
          if (line.trim() !== '') JSON.parse(line)
        }
      } else {
        JSON.parse(content)
      }
    }

    // 正常写入路径不产生 tmp 残留（清掉手工放置的崩溃遗物后断言）。
    rmSync(orphanTmp)
    for (const path of listFiles(layout.root).keys()) {
      expect(path).not.toMatch(/\.tmp-/)
    }
  })
})

describe('TC-S-11: history 超过 retentionDays → 旧条目被清理', () => {
  it('默认 30 天：31 天前条目在 append 触发 retention 时被清理，新条目保留', () => {
    const fx = setup()
    const { layout, services } = fx
    const historyFile = profileLayout(layout, PROFILE_ID).historyFile
    const now = Date.now()

    // 直接落一条 31 天前的旧记录（模拟 aged 文件；append 前 retention 未触发）。
    const old = makeHistoryEntry(PROFILE_ID, now - 31 * DAY_MS)
    services.store.appendJsonl(historyFile, old)
    expect(services.store.readJsonl<ExecutionHistory>(historyFile)).toHaveLength(1)

    // append 新记录触发 retention：旧条目被原子重写清理。
    const fresh = makeHistoryEntry(PROFILE_ID, now)
    services.history.append(fresh)
    const kept = services.store.readJsonl<ExecutionHistory>(historyFile)
    expect(kept.map((e) => e.id)).toEqual([fresh.id])
  })

  it('retentionDays 经 settings 调小后立即生效（边界：未超龄条目保留）', () => {
    const fx = setup()
    const { layout, services } = fx
    const historyFile = profileLayout(layout, PROFILE_ID).historyFile
    const now = Date.now()

    services.settings.patch({ historyRetentionDays: 7 })
    const aged = makeHistoryEntry(PROFILE_ID, now - 10 * DAY_MS) // 超龄（> 7d）
    const recent = makeHistoryEntry(PROFILE_ID, now - 2 * DAY_MS) // 未超龄（< 7d）
    services.store.appendJsonl(historyFile, aged)
    services.store.appendJsonl(historyFile, recent)

    const fresh = makeHistoryEntry(PROFILE_ID, now)
    services.history.append(fresh)
    const kept = services.store.readJsonl<ExecutionHistory>(historyFile)
    expect(kept.map((e) => e.id).sort()).toEqual([recent.id, fresh.id].sort())
  })
})
