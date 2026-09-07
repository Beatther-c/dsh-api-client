/**
 * Compatibility Scanner（V01 §3.3 compat-scanner.ts；DESIGN_V1.1 §15.2）。
 *
 * 探测三类「部分支持」内容并产出警告文案：
 * - scripts（pre-request / tests）：只 parse/detect/display/warn，**永不执行**（D15）；
 * - dynamic variables（`{{$guid}}` 等）：保留原文，不预解析；
 * - OAuth2 / Digest 等不支持 auth：降级 No Auth 并标记 partial。
 *
 * 本模块只有纯探测函数与文案，不含任何转换逻辑（转换见 normalize.ts）。
 */
import type { ImportFinding } from '@dsh-api-client/core'
import type { PostmanAuth, PostmanAuthAttributes, PostmanCollectionDoc, PostmanEvent, PostmanItem } from './schema.ts'
import { isRecord } from './schema.ts'

/** ScriptConfig.warning 与 findings 共用的标准警告（§8.1 24.7：V0.1 只 parse/detect/display/warn）。 */
export const SCRIPTS_WARNING =
  'V0.1 不执行脚本：Postman pre-request/tests 脚本仅保留原文用于展示，导入与执行链路均不会运行它。'

/** Postman dynamic variable 形态：`{{$guid}}` / `{{$timestamp}}` / `{{$randomInt}}` … */
export const DYNAMIC_VARIABLE_RE = /\{\{\$[a-zA-Z_][a-zA-Z0-9_]*\}\}/g

/** 从文本中提取 dynamic variable 名（含 `$` 前缀，去重）。 */
export function findDynamicVariables(text: string): string[] {
  const names = new Set<string>()
  for (const match of text.matchAll(DYNAMIC_VARIABLE_RE)) {
    names.add(match[0].slice(2, -2))
  }
  return [...names]
}

export interface EventScript {
  listen: string
  code: string
}

/** 提取 event 列表中的脚本原文（exec 数组按行拼接）；不执行、不求值。 */
export function extractEventScripts(events: PostmanEvent[] | undefined): EventScript[] {
  const scripts: EventScript[] = []
  for (const event of events ?? []) {
    const exec = event.script?.exec
    if (exec === undefined) continue
    const code = Array.isArray(exec) ? exec.join('\n') : exec
    if (code === '') continue
    scripts.push({ listen: event.listen ?? 'unknown', code })
  }
  return scripts
}

/** V0.1 完整支持的 auth 类型（§15.1；noauth/inherit 属语义直通）。 */
const FULL_AUTH_TYPES = new Set(['noauth', 'basic', 'bearer', 'apikey', 'inherit'])

export type AuthSupport =
  | { support: 'full'; authType: string }
  | { support: 'downgraded'; authType: string }

/** auth 类型分级：full（§15.1 五项）或 downgraded（oauth2/digest/hawk/awsv4/ntlm 等 → No Auth）。 */
export function classifyAuth(auth: PostmanAuth | undefined): AuthSupport {
  const authType = auth?.type ?? 'noauth'
  return FULL_AUTH_TYPES.has(authType)
    ? { support: 'full', authType }
    : { support: 'downgraded', authType }
}

/** 从 auth 属性块取值：兼容 [{key, value}] 列表与 {key: value} 对象两种形态。 */
export function authAttribute(attributes: PostmanAuthAttributes | undefined, key: string): string {
  if (attributes === undefined) return ''
  if (Array.isArray(attributes)) {
    const hit = attributes.find((row) => row.key === key)
    return typeof hit?.value === 'string' ? hit.value : ''
  }
  if (isRecord(attributes)) {
    const value = attributes[key]
    return typeof value === 'string' ? value : ''
  }
  return ''
}

function dynamicVariableFinding(itemPath: string, names: string[]): ImportFinding {
  return {
    itemPath,
    level: 'info',
    kind: 'dynamic-variable',
    message: `dynamic variable(s) kept verbatim, not pre-resolved: ${names.map((n) => `{{${n}}}`).join(', ')}`,
  }
}

/**
 * 扫描整份文档（管线 Scan 阶段）。
 * 职责分工：dynamic variables 与 collection/folder 级脚本在此产出；
 * request 级脚本与 auth 降级由 normalize 逐项产出（避免重复计数）。
 */
export function scanPostmanCollection(doc: PostmanCollectionDoc): ImportFinding[] {
  const findings: ImportFinding[] = []

  // collection 级：variables / auth / events
  const collectionLevel = JSON.stringify({ variable: doc.variable ?? [], auth: doc.auth ?? null })
  const collectionVars = findDynamicVariables(collectionLevel)
  if (collectionVars.length > 0) findings.push(dynamicVariableFinding('(collection)', collectionVars))
  for (const script of extractEventScripts(doc.event)) {
    findings.push({
      itemPath: '(collection)',
      level: 'warn',
      kind: 'script-not-executed',
      message: `${script.listen} script on collection detected but not imported (request-level scripts only). ${SCRIPTS_WARNING}`,
    })
  }

  const walk = (items: PostmanItem[], trail: string[]): void => {
    for (const item of items) {
      const name = item.name ?? '(unnamed)'
      const path = [...trail, name].join('/')
      if (Array.isArray(item.item)) {
        // folder 级脚本：无 ScriptConfig 落点，仅发现+警告
        for (const script of extractEventScripts(item.event)) {
          findings.push({
            itemPath: path,
            level: 'warn',
            kind: 'script-not-executed',
            message: `${script.listen} script on folder detected but not imported (request-level scripts only). ${SCRIPTS_WARNING}`,
          })
        }
        walk(item.item, [...trail, name])
        continue
      }
      const vars = findDynamicVariables(JSON.stringify({ request: item.request ?? null }))
      if (vars.length > 0) findings.push(dynamicVariableFinding(path, vars))
    }
  }
  walk(doc.item, [])

  return findings
}
