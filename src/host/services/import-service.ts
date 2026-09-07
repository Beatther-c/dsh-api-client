/**
 * Import service（§3.4）：import 管线宿主——core import/pipeline + 落库 +
 * 报告持久化（`imports/<importId>.json`）。
 *
 * 格式适配器默认注入 `@dsh-api-client/postman-adapter` 的正式实现
 * （WP6 交付，替换 WP2 的内联最小适配器）；注入点仍为构造参数 adapter，
 * 管线/落库/持久化结构不变。
 */
import type { ImportReport } from '@dsh-api-client/shared'
import type { ImportAdapter } from '@dsh-api-client/core'
import { runImportPipeline, ImportPipelineError } from '@dsh-api-client/core'
import { PostmanV21Adapter } from '@dsh-api-client/postman-adapter'
import { importReportFile } from '@dsh-api-client/shared'
import { FileStore } from './storage/file-store.ts'
import { CollectionService } from './collection-service.ts'
import { RedactionService } from './redaction-service.ts'

export class ImportService {
  constructor(
    private readonly store: FileStore,
    private readonly collections: CollectionService,
    private readonly redaction: RedactionService,
    private readonly adapter: ImportAdapter = new PostmanV21Adapter(),
  ) {}

  /**
   * §5.1 端点 25：跑管线 → 落库 → 报告持久化（imports/<id>.json）→
   * 回填 createdCollectionId。管线失败（detect/parse）→ ImportPipelineError，
   * 零落库（TC-P-13 语义）。
   */
  importPostman(input: unknown, name?: string): ImportReport {
    const { report, collection } = runImportPipeline(this.adapter, input, {
      sourceName: name ?? 'postman-import',
      redactText: (text) => this.redaction.redactText(text),
    })
    if (name !== undefined) collection.name = name
    const created = this.collections.importCollection(collection)
    const finalReport: ImportReport = { ...report, createdCollectionId: created.id }
    this.store.writeJson(importReportFile(this.store.layout, finalReport.id), finalReport)
    return finalReport
  }

  /** §5.1 端点 26。 */
  getReport(id: string): ImportReport | undefined {
    return this.store.readJson<ImportReport>(importReportFile(this.store.layout, id))
  }
}

export { ImportPipelineError }
