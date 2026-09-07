/**
 * Postman Collection v2.1 适配器入口（V01 §3.3 index.ts）。
 * 实现 core `ImportAdapter` 接口，注入 `runImportPipeline` / host import-service。
 *
 * 安全边界（D15 / §8.1 24.7 / TC-P-09）：本包对 Postman Script 只
 * parse/detect/display/warn——全包禁止任何形式的动态代码执行
 * （eval、Function 构造器等），导入过程对脚本原文零求值、零执行。
 */
import type { ImportAdapter, NormalizedImport } from '@dsh-api-client/core'
import type { ImportFinding } from '@dsh-api-client/shared'
import { detectPostmanV21 } from './detect.ts'
import { parsePostmanCollection } from './parse.ts'
import { scanPostmanCollection } from './compat-scanner.ts'
import { normalizePostmanCollection } from './normalize.ts'
import type { PostmanCollectionDoc } from './schema.ts'

export class PostmanV21Adapter implements ImportAdapter<PostmanCollectionDoc> {
  readonly format = 'postman-v2.1' as const

  detect(input: unknown): boolean {
    return detectPostmanV21(input)
  }

  parse(input: unknown): PostmanCollectionDoc {
    return parsePostmanCollection(input)
  }

  scan(doc: PostmanCollectionDoc): ImportFinding[] {
    return scanPostmanCollection(doc)
  }

  normalize(doc: PostmanCollectionDoc): NormalizedImport {
    return normalizePostmanCollection(doc)
  }
}

export function createPostmanV21Adapter(): PostmanV21Adapter {
  return new PostmanV21Adapter()
}

export * from './schema.ts'
export { detectPostmanV21 } from './detect.ts'
export { parsePostmanCollection, PostmanParseError } from './parse.ts'
export {
  SCRIPTS_WARNING,
  DYNAMIC_VARIABLE_RE,
  authAttribute,
  classifyAuth,
  extractEventScripts,
  findDynamicVariables,
  scanPostmanCollection,
} from './compat-scanner.ts'
export type { AuthSupport, EventScript } from './compat-scanner.ts'
export { normalizePathVariables, normalizePostmanCollection } from './normalize.ts'
export { summarizeImportReport } from './report.ts'
export type { MigrationReportSummary } from './report.ts'
