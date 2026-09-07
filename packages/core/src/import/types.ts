/**
 * ImportReport / ImportFinding / 管线适配器接口（§3.2 import/types；§15.3/§15.4）。
 * 报告实体定义于 packages/shared/src/types.ts（§4.1 冻结），此处定义管线注入面。
 */
import type { Collection, ImportFinding, ImportReport } from '@dsh-api-client/shared'

export type { ImportFinding, ImportReport }

/** 兼容度分级（§15.1/§15.2：full / partial / unsupported）。 */
export type ImportCompatibility = 'full' | 'partial' | 'unsupported'

export interface ImportItemResult {
  itemPath: string
  compatibility: ImportCompatibility
  findings: ImportFinding[]
}

/** Normalize 阶段产物：内部 Collection 模型 + 逐项结果。 */
export interface NormalizedImport {
  collection: Collection
  items: ImportItemResult[]
}

/**
 * 格式适配器接口（WP6 postman-adapter 实现本接口并注入管线）。
 * 各阶段抛出即整体失败（Detect/Parse/Validate 失败零落库，TC-P-13）；
 * 单项不可转换不阻塞——由 Normalize 在 items 中标记 unsupported（TC-P-12）。
 */
export interface ImportAdapter<TDoc = unknown> {
  readonly format: ImportReport['format']
  /** Detect：输入是否本格式。 */
  detect(input: unknown): boolean
  /** Parse + Schema Validation：失败显式抛错。 */
  parse(input: unknown): TDoc
  /** Compatibility Scanner：scripts / dynamic variables / 不支持 auth 等。 */
  scan(doc: TDoc): ImportFinding[]
  /** Normalize：→ 内部 Collection 模型 + 逐项兼容度。 */
  normalize(doc: TDoc): NormalizedImport
}

/** 管线失败（detect/parse/validate 阶段），message 出场前经 redactor。 */
export class ImportPipelineError extends Error {
  readonly stage: 'detect' | 'parse' | 'validate' | 'normalize'

  constructor(stage: ImportPipelineError['stage'], message: string) {
    super(message)
    this.name = 'ImportPipelineError'
    this.stage = stage
  }
}
