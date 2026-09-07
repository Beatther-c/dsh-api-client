/**
 * §15.3 通用 Import Pipeline 骨架（§3.2 import/pipeline）：
 * Detect → Parse → Validate → Scan → Normalize → Report → Import。
 *
 * - 格式适配器以接口注入（WP6 postman-adapter 实现 ImportAdapter）；
 * - 不兼容内容不阻塞整体导入：单项 unsupported 只进报告（§15.4）；
 * - findings 文本出场前经 redactor（TC-R-11）；
 * - 「Import」一步只产出内存中的 Collection 与报告——落库由 host import-service 负责。
 */
import type { Collection, ImportFinding, ImportReport } from '@dsh-api-client/shared'
import type { ImportAdapter, NormalizedImport } from './types.ts'
import { ImportPipelineError } from './types.ts'

export interface ImportPipelineOptions {
  sourceName: string
  /** findings/message 出场前的 redactor 注入（缺省为恒等——调用方负责给出安全闭包）。 */
  redactText?: (text: string) => string
  id?: string
  now?: number
}

export interface ImportPipelineResult {
  report: ImportReport
  collection: Collection
}

function redactFindings(findings: ImportFinding[], redact: (text: string) => string): ImportFinding[] {
  return findings.map((f) => ({ ...f, message: redact(f.message) }))
}

function countFolders(collection: Collection): number {
  const walk = (folders: Collection['folders']): number =>
    folders.reduce((acc, folder) => acc + 1 + walk(folder.folders), 0)
  return walk(collection.folders)
}

function countRequests(collection: Collection): number {
  const walk = (folders: Collection['folders']): number =>
    folders.reduce((acc, folder) => acc + folder.requests.length + walk(folder.folders), 0)
  return collection.requests.length + walk(collection.folders)
}

/**
 * 跑通用管线。Detect/Parse 失败 → ImportPipelineError（message 已脱敏），零产出；
 * 成功 → ImportReport（findings 已脱敏）+ 内部 Collection。
 */
export function runImportPipeline(
  adapter: ImportAdapter,
  input: unknown,
  options: ImportPipelineOptions,
): ImportPipelineResult {
  const redact = options.redactText ?? ((text: string) => text)

  // Detect
  if (!adapter.detect(input)) {
    throw new ImportPipelineError('detect', redact(`input is not a ${adapter.format} collection`))
  }

  // Parse + Schema Validation（适配器内部完成 validate，失败显式抛错）
  let doc: unknown
  try {
    doc = adapter.parse(input)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ImportPipelineError('parse', redact(message))
  }

  // Compatibility Scanner
  const scanFindings = redactFindings(adapter.scan(doc), redact)

  // Normalize（→ 内部 Collection 模型；单项失败在 items 中标记，不整体失败）
  let normalized: NormalizedImport
  try {
    normalized = adapter.normalize(doc)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ImportPipelineError('normalize', redact(message))
  }

  // Migration Report（§15.4 形态：totals + full/partial/unsupported + findings）
  const itemFindings = redactFindings(
    normalized.items.flatMap((item) => item.findings),
    redact,
  )
  const report: ImportReport = {
    id: options.id ?? crypto.randomUUID(),
    format: adapter.format,
    sourceName: options.sourceName,
    totals: { requests: countRequests(normalized.collection), folders: countFolders(normalized.collection) },
    full: normalized.items.filter((i) => i.compatibility === 'full').length,
    partial: normalized.items.filter((i) => i.compatibility === 'partial').length,
    unsupported: normalized.items.filter((i) => i.compatibility === 'unsupported').length,
    findings: [...scanFindings, ...itemFindings],
    createdAt: options.now ?? Date.now(),
  }

  // Import（内存产出；持久化由 host import-service 负责并回填 createdCollectionId）
  return { report, collection: normalized.collection }
}
