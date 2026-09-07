// @vitest-environment node
/**
 * TC-A-01…03：架构边界静态 import 扫描（§6.8，AC-39/AC-40，全 WP 门禁）。
 *
 * 规则：
 * - TC-A-01：src/client/** 的运行时 import 中，DSH 包（@deepseek-ai/*）只允许出现在
 *   dsh-adapter/ 与 slots/。type-only import 在编译期擦除、不构成运行时契约耦合，
 *   不计违规（当前探针 src/client/index.ts 的 cordis Context 即此形态，见报告）。
 * - TC-A-02：packages/**（core/shared/postman-adapter）零 DSH import、零 React import——
 *   runtime 与 type-only 全计（AC-40 最严解释）。
 * - TC-A-03：src/client/views|components|hooks 不得 import 任何 DSH 包（runtime + type）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

function listSourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue
      const full = join(current, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
      } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith('.d.ts')) {
        out.push(full)
      }
    }
  }
  walk(dir)
  return out.sort()
}

/** 轻量注释剥离：跟踪字符串/模板串状态，避免把 'https://…' 当行注释。 */
function stripComments(source: string): string {
  let out = ''
  let i = 0
  let state: 'code' | 'single' | 'double' | 'template' | 'line' | 'block' = 'code'
  while (i < source.length) {
    const ch = source[i] ?? ''
    const next = source[i + 1] ?? ''
    if (state === 'code') {
      if (ch === '/' && next === '/') {
        state = 'line'
        i += 2
        continue
      }
      if (ch === '/' && next === '*') {
        state = 'block'
        i += 2
        continue
      }
      if (ch === "'") state = 'single'
      else if (ch === '"') state = 'double'
      else if (ch === '`') state = 'template'
      out += ch
      i += 1
      continue
    }
    if (state === 'line') {
      if (ch === '\n') {
        out += '\n'
        state = 'code'
      }
      i += 1
      continue
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') {
        state = 'code'
        i += 2
        continue
      }
      out += ch === '\n' ? '\n' : ' '
      i += 1
      continue
    }
    // 字符串内：原样保留，处理转义与收尾
    out += ch
    if (ch === '\\') {
      out += next
      i += 2
      continue
    }
    if (
      (state === 'single' && ch === "'") ||
      (state === 'double' && ch === '"') ||
      (state === 'template' && ch === '`')
    ) {
      state = 'code'
    }
    i += 1
  }
  return out
}

interface ImportRef {
  specifier: string
  typeOnly: boolean
}

function scanImports(source: string): ImportRef[] {
  const code = stripComments(source)
  const refs: ImportRef[] = []

  const fromPattern = /\b(import|export)(\s+type\b)?[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/g
  for (const match of code.matchAll(fromPattern)) {
    refs.push({ specifier: match[3] ?? '', typeOnly: match[2] !== undefined })
  }
  const sideEffectPattern = /\bimport\s*['"]([^'"]+)['"]/g
  for (const match of code.matchAll(sideEffectPattern)) {
    refs.push({ specifier: match[1] ?? '', typeOnly: false })
  }
  const dynamicPattern = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const match of code.matchAll(dynamicPattern)) {
    refs.push({ specifier: match[1] ?? '', typeOnly: false })
  }
  const requirePattern = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const match of code.matchAll(requirePattern)) {
    refs.push({ specifier: match[1] ?? '', typeOnly: false })
  }
  return refs
}

const isDshPackage = (specifier: string): boolean => specifier.startsWith('@deepseek-ai/')
const isReactPackage = (specifier: string): boolean =>
  specifier === 'react' ||
  specifier === 'react-dom' ||
  specifier.startsWith('react/') ||
  specifier.startsWith('react-dom/')

function scanTree(
  dir: string,
  violationOf: (ref: ImportRef, relPath: string) => string | undefined,
): string[] {
  const violations: string[] = []
  for (const file of listSourceFiles(dir)) {
    const relPath = relative(REPO_ROOT, file)
    for (const ref of scanImports(readFileSync(file, 'utf8'))) {
      const violation = violationOf(ref, relPath)
      if (violation !== undefined) violations.push(violation)
    }
  }
  return violations
}

describe('TC-A-01: src/client/** 仅 dsh-adapter/ 与 slots/ 允许运行时 import DSH client 包', () => {
  it('静态扫描无违规', () => {
    const violations = scanTree(join(REPO_ROOT, 'src/client'), (ref, relPath) => {
      if (!isDshPackage(ref.specifier)) return undefined
      if (ref.typeOnly) return undefined // 编译期擦除，不构成运行时契约
      const inAdapter = relPath.includes('dsh-adapter/')
      const inSlots = relPath.includes('slots/')
      return inAdapter || inSlots
        ? undefined
        : `${relPath}: runtime import of DSH package "${ref.specifier}" outside dsh-adapter/ and slots/`
    })
    expect(violations).toEqual([])
  })
})

describe('TC-A-02: packages/** 零 DSH import、零 React import（runtime + type-only 全计）', () => {
  it('静态扫描无违规', () => {
    const violations = scanTree(join(REPO_ROOT, 'packages'), (ref, relPath) => {
      if (isDshPackage(ref.specifier)) {
        return `${relPath}: ${ref.typeOnly ? 'type-only' : 'runtime'} import of DSH package "${ref.specifier}"`
      }
      if (isReactPackage(ref.specifier)) {
        return `${relPath}: ${ref.typeOnly ? 'type-only' : 'runtime'} import of React package "${ref.specifier}"`
      }
      return undefined
    })
    expect(violations).toEqual([])
  })
})

describe('TC-A-03: src/client/views|components|hooks 不直接 import 任何 DSH 包', () => {
  it('静态扫描无违规（目录尚不存在时按 vacuous pass 处理）', () => {
    const layers = ['views', 'components', 'hooks']
    const scanned: string[] = []
    const violations: string[] = []
    for (const layer of layers) {
      const dir = join(REPO_ROOT, 'src/client', layer)
      if (!existsSync(dir)) continue
      scanned.push(layer)
      violations.push(
        ...scanTree(dir, (ref, relPath) =>
          isDshPackage(ref.specifier)
            ? `${relPath}: ${ref.typeOnly ? 'type-only' : 'runtime'} import of DSH package "${ref.specifier}" in ${layer}/`
            : undefined,
        ),
      )
    }
    // WP3 落地 views/components/hooks 后本扫描自动生效
    expect(violations).toEqual([])
  })
})
