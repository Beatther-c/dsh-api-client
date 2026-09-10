/**
 * Tree clipboard service（P0 实施设计 §4.2/§4.4–§4.6、§3.1/§3.1.1、§13.1–§13.2；
 * UX spec §4.6/§8.3/§9 冻结语义）。
 *
 * 红线（§4.2「不落」清单 + PROJECT.md 秘密边界）：
 * - Copy 的权威快照（structuredClone）只存在于本服务的内存 Map——FileStore/
 *   localStorage/sessionStorage/IndexedDB/History/console/audit detail/Agent
 *   context 绝不出现 snapshot；API 响应只回 TreeClipboardDescriptor
 *   （token/operation/kind/expiresAt 四字段，绝不含 name/URL/Body/Header/Auth/
 *   SecretRef/源节点完整 ID 链）；
 * - token = crypto.randomUUID()（随机不可猜）、绑定 profileId（跨 profile 视为
 *   不存在）、30 分钟 TTL 惰性清理（访问时判定 + 每次操作前清扫）、绝不落盘，
 *   Host 重启自然清空；
 * - Copy 永远使用复制时点快照：源随后被重命名/编辑/移动/删除均不影响 paste
 *   （§4.5）；token 可重复使用直到清空/过期/重启（consumed=false）；
 * - Cut 不保存快照，只存 requestId + requestUpdatedAt + sourceCollectionUpdatedAt
 *   前置版本（§4.2 cut 形态）；paste 前 request/sourceCollection/targetCollection
 *   三者版本严格相等（WP1 §4.3 谓词），任一不符 → 409 且不写盘、不移动、不消费 token；
 * - Cut paste 走 §4.4 七步原子流程：读权威 collections[] → 校验全部版本 →
 *   core 计算 nextSource/nextTarget → 内存组装完整 nextCollections[] →
 *   CollectionService.commitCollections **一次**写盘 → 成功后替换内存权威态 →
 *   最后消费 token（consumed=true，一次性）；写盘失败时内存不替换、token 不消费。
 */
import type { ApiRequest, Collection, Folder, TreeClipboardDescriptor, TreePasteResult } from '@dsh-api-client/shared'
import type { MoveRequestTarget } from '@dsh-api-client/core'
import {
  collectionVersionMatches,
  copyCollectionTree,
  copyFolderTree,
  copyRequestSnapshot,
  findFolder,
  findRequest,
  insertRequestAt,
  moveRequestAcrossCollections,
  nextCopyName,
  requestVersionMatches,
} from '@dsh-api-client/core'
import type { CollectionService } from './collection-service.ts'
import { CollectionNotFoundError, FolderNotFoundError, RequestNotFoundError, VersionConflictError } from './collection-service.ts'
import type { ProfileService } from './profile-service.ts'

/** clipboard token TTL：30 分钟（§4.2；Host 重启自然清空）。 */
export const CLIPBOARD_TTL_MS = 30 * 60 * 1000

export type ClipboardNodeKind = 'collection' | 'folder' | 'request'

export type PasteTargetKind = 'root' | 'collection' | 'folder' | 'request'

/** §4.2 Host 内部条目（刻意不 export 给 Client——copy 形态含权威快照，绝不出域）。 */
type HostClipboardEntry =
  | {
      token: string
      profileId: string
      operation: 'copy'
      kind: ClipboardNodeKind
      sourceCollectionId: string
      sourceNodeId?: string
      createdAt: number
      expiresAt: number
      snapshot: Collection | Folder | ApiRequest
    }
  | {
      token: string
      profileId: string
      operation: 'cut'
      kind: 'request'
      sourceCollectionId: string
      sourceRequestId: string
      requestUpdatedAt: number
      sourceCollectionUpdatedAt: number
      createdAt: number
      expiresAt: number
    }

/** token 不存在/已过期/跨 profile → 统一 404（不向调用方泄露存在性差异，§0.3）。 */
export class ClipboardNotFoundError extends Error {
  readonly code = 'clipboard-not-found'
  readonly httpStatus = 404
  constructor(token: string) {
    super(`剪贴板内容不存在或已过期: ${token}`)
    this.name = 'ClipboardNotFoundError'
  }
}

/** §6.5/UX §4.6 矩阵外的目标、或 paste 入参缺失/矛盾 → 400 invalid-paste-target。 */
export class InvalidPasteTargetError extends Error {
  readonly code = 'invalid-paste-target'
  readonly httpStatus = 400
  constructor(reason: string) {
    super(reason)
    this.name = 'InvalidPasteTargetError'
  }
}

/** copy 入参（folder/request 必带 nodeId——API 边界校验后用 union 表达，服务层无需再判空）。 */
export type CopyInput =
  | { kind: 'collection'; collectionId: string }
  | { kind: 'folder'; collectionId: string; nodeId: string }
  | { kind: 'request'; collectionId: string; nodeId: string }

/** paste 入参（§3.1：targetId?/targetCollectionId?/非 root 时 expectedTargetCollectionUpdatedAt 必填——服务层校验）。 */
export interface PasteInput {
  targetKind: PasteTargetKind
  targetId?: string
  targetCollectionId?: string
  expectedTargetCollectionUpdatedAt?: number
}

/** paste 目标定位结果（folder/anchorRequest 按 targetKind 出现其一或皆无）。 */
interface LocatedTarget {
  targetCollection: Collection
  folder?: Folder
  anchorRequest?: ApiRequest
}

/** §6.5/UX §4.6 冻结合法矩阵：未列出的组合一律 400 invalid-paste-target。 */
const PASTE_MATRIX: Record<string, readonly PasteTargetKind[]> = {
  'copy-collection': ['root', 'collection'],
  'copy-folder': ['collection', 'folder'],
  'copy-request': ['collection', 'folder', 'request'],
  'cut-request': ['collection', 'folder', 'request'],
}

export class TreeClipboardService {
  /** §4.2 唯一存储形态：内存 Map（绝不落盘；Host 重启自然清空）。 */
  private readonly entries = new Map<string, HostClipboardEntry>()

  constructor(
    private readonly collections: CollectionService,
    private readonly profile: ProfileService,
    private readonly ttlMs: number = CLIPBOARD_TTL_MS,
  ) {}

  /** 过期条目惰性清理（§4.2：访问时判定；每次公开操作前顺带清扫防 Map 增长）。 */
  private sweep(): void {
    const now = Date.now()
    for (const [token, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(token)
    }
  }

  /**
   * POST /tree/clipboard/copy 的服务实现：从 CollectionService 读当前权威对象并
   * structuredClone 为快照（§4.5：快照创建后源被改/删不影响 paste）。
   */
  copy(input: CopyInput): TreeClipboardDescriptor {
    this.sweep()
    const collection = this.collections.get(input.collectionId)
    if (collection === undefined) throw new CollectionNotFoundError(input.collectionId)
    let snapshot: Collection | Folder | ApiRequest
    let sourceNodeId: string | undefined
    if (input.kind === 'collection') {
      snapshot = structuredClone(collection)
    } else {
      sourceNodeId = input.nodeId
      snapshot =
        input.kind === 'folder'
          ? this.requireFolderSnapshot(collection, input.nodeId)
          : this.requireRequestSnapshot(collection, input.nodeId)
    }
    const createdAt = Date.now()
    const entry: HostClipboardEntry = {
      token: crypto.randomUUID(),
      profileId: this.profile.profileId,
      operation: 'copy',
      kind: input.kind,
      sourceCollectionId: collection.id,
      ...(sourceNodeId !== undefined ? { sourceNodeId } : {}),
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      snapshot,
    }
    this.entries.set(entry.token, entry)
    return this.descriptor(entry)
  }

  private requireFolderSnapshot(collection: Collection, folderId: string): Folder {
    const folder = findFolder(collection, folderId)
    if (folder === undefined) throw new FolderNotFoundError(folderId)
    return structuredClone(folder)
  }

  private requireRequestSnapshot(collection: Collection, requestId: string): ApiRequest {
    const hit = findRequest(collection, requestId)
    if (hit === undefined) throw new RequestNotFoundError(requestId)
    return structuredClone(hit.request)
  }

  /**
   * POST /tree/clipboard/cut 的服务实现（§13.2：Cut 阶段不移动任何数据）：
   * 校验前置版本后只登记 requestId + 两个版本；409 时不创建条目。
   */
  cut(input: { requestId: string; requestUpdatedAt: number; sourceCollectionUpdatedAt: number }): TreeClipboardDescriptor {
    this.sweep()
    const { collection, request } = this.collections.requireRequest(input.requestId)
    if (!requestVersionMatches(request, input.requestUpdatedAt)) throw new VersionConflictError()
    if (!collectionVersionMatches(collection, input.sourceCollectionUpdatedAt)) throw new VersionConflictError()
    const createdAt = Date.now()
    const entry: HostClipboardEntry = {
      token: crypto.randomUUID(),
      profileId: this.profile.profileId,
      operation: 'cut',
      kind: 'request',
      sourceCollectionId: collection.id,
      sourceRequestId: request.id,
      requestUpdatedAt: request.updatedAt,
      sourceCollectionUpdatedAt: collection.updatedAt,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
    }
    this.entries.set(entry.token, entry)
    return this.descriptor(entry)
  }

  /** §3.1 唯一返回形态：恰好四字段（token/operation/kind/expiresAt）。 */
  private descriptor(entry: HostClipboardEntry): TreeClipboardDescriptor {
    return { token: entry.token, operation: entry.operation, kind: entry.kind, expiresAt: entry.expiresAt }
  }

  /**
   * POST /tree/clipboard/:token/paste 的服务实现：矩阵校验（§6.5）→ 目标定位 →
   * 版本校验（§3.1.1：任何计算/写盘之前）→ 原子提交 → cut 成功才消费 token。
   */
  paste(token: string, input: PasteInput): TreePasteResult {
    this.sweep()
    const entry = this.entries.get(token)
    // 不存在 / 已过期（sweep 后双保险）/ 跨 profile → 一律 404 clipboard-not-found。
    if (entry === undefined || entry.expiresAt <= Date.now() || entry.profileId !== this.profile.profileId) {
      this.entries.delete(token)
      throw new ClipboardNotFoundError(token)
    }
    const matrixKey = entry.operation === 'cut' ? 'cut-request' : `copy-${entry.kind}`
    if (!PASTE_MATRIX[matrixKey]!.includes(input.targetKind)) {
      throw new InvalidPasteTargetError('当前剪贴板内容不能粘贴到该目标')
    }
    if (input.targetKind === 'root') {
      // 矩阵保证：能到 root 的只有 Copy Collection（追加根末尾，无目标版本可校验）。
      return this.pasteCopyCollectionToRoot(entry as Extract<HostClipboardEntry, { operation: 'copy' }>)
    }
    const expected = input.expectedTargetCollectionUpdatedAt
    if (typeof expected !== 'number' || !Number.isFinite(expected)) {
      throw new InvalidPasteTargetError('非 root 目标必须提供 expectedTargetCollectionUpdatedAt（有限数字）')
    }
    const target = this.locateTarget(input)
    if (entry.operation === 'cut') return this.pasteCut(entry, target, expected)
    return this.pasteCopy(entry, target, expected)
  }

  /** paste 目标的权威定位（§3.1 targetId/targetCollectionId 语义）；找不到 → 对应 404。 */
  private locateTarget(input: PasteInput): LocatedTarget {
    if (input.targetKind === 'collection') {
      const collectionId = this.resolveCollectionTargetId(input)
      const targetCollection = this.collections.get(collectionId)
      if (targetCollection === undefined) throw new CollectionNotFoundError(collectionId)
      return { targetCollection }
    }
    const targetId = input.targetId
    if (typeof targetId !== 'string' || targetId === '') {
      throw new InvalidPasteTargetError('非 root 目标必须提供非空 targetId')
    }
    if (input.targetKind === 'folder') {
      // targetCollectionId 给出时以其为权威容器；缺省时跨 collection 扫描（Host 是权威）。
      if (input.targetCollectionId !== undefined) {
        const targetCollection = this.collections.get(input.targetCollectionId)
        if (targetCollection === undefined) throw new CollectionNotFoundError(input.targetCollectionId)
        const folder = findFolder(targetCollection, targetId)
        if (folder === undefined) throw new FolderNotFoundError(targetId)
        return { targetCollection, folder }
      }
      const hit = this.collections.findFolderLocation(targetId)
      if (hit === undefined) throw new FolderNotFoundError(targetId)
      return { targetCollection: hit.collection, folder: hit.folder }
    }
    // targetKind === 'request'（after-request 锚点）。
    if (input.targetCollectionId !== undefined) {
      const targetCollection = this.collections.get(input.targetCollectionId)
      if (targetCollection === undefined) throw new CollectionNotFoundError(input.targetCollectionId)
      const hit = findRequest(targetCollection, targetId)
      if (hit === undefined) throw new RequestNotFoundError(targetId)
      return { targetCollection, anchorRequest: hit.request }
    }
    const located = this.collections.findRequestLocation(targetId)
    if (located === undefined) throw new RequestNotFoundError(targetId)
    return { targetCollection: located.collection, anchorRequest: located.request }
  }

  private resolveCollectionTargetId(input: PasteInput): string {
    const { targetId, targetCollectionId } = input
    const hasTargetId = typeof targetId === 'string' && targetId !== ''
    const hasCollectionId = typeof targetCollectionId === 'string' && targetCollectionId !== ''
    if (hasTargetId && hasCollectionId && targetId !== targetCollectionId) {
      throw new InvalidPasteTargetError('targetId 与 targetCollectionId 不一致')
    }
    if (hasTargetId) return targetId!
    if (hasCollectionId) return targetCollectionId!
    throw new InvalidPasteTargetError('targetKind 为 collection 时必须提供 targetId')
  }

  // ---- Copy paste（§4.5 插入矩阵 + §4.6 副本命名；consumed=false，token 可重复用）----

  private pasteCopy(
    entry: Extract<HostClipboardEntry, { operation: 'copy' }>,
    target: LocatedTarget,
    expectedTargetCollectionUpdatedAt: number,
  ): TreePasteResult {
    // §3.1.1：版本先于任何计算/写盘校验；不符 → 409（不写文件、不消费 token、快照保留）。
    if (!collectionVersionMatches(target.targetCollection, expectedTargetCollectionUpdatedAt)) {
      throw new VersionConflictError()
    }
    switch (entry.kind) {
      case 'collection':
        this.commitCopyCollection(entry.snapshot as Collection, target.targetCollection)
        break
      case 'folder':
        this.commitCopyFolder(entry.snapshot as Folder, target.targetCollection, target.folder)
        break
      case 'request':
        this.commitCopyRequest(entry.snapshot as ApiRequest, target.targetCollection, target)
        break
    }
    return { operation: 'copy', kind: entry.kind, consumed: false }
  }

  /** Copy Collection → root 空白区：追加根 Collection 末尾（§4.5；root 无版本校验对象）。 */
  private pasteCopyCollectionToRoot(entry: Extract<HostClipboardEntry, { operation: 'copy' }>): TreePasteResult {
    const snapshot = entry.snapshot as Collection
    const list = this.collections.list()
    const now = this.collections.nextTimestamp()
    const copy = copyCollectionTree(snapshot, now)
    // §4.6：冲突范围 = 同目标容器（根列表）同类型（Collection）的 sibling names。
    copy.name = nextCopyName(snapshot.name, list.map((c) => c.name))
    this.collections.commitCollections([...list, copy])
    return { operation: 'copy', kind: 'collection', consumed: false }
  }

  /** Copy Collection → 目标 Collection：作为新根级 Collection 插在其后（§4.5；目标 Collection 自身不被修改）。 */
  private commitCopyCollection(snapshot: Collection, targetCollection: Collection): void {
    const list = this.collections.list()
    const now = this.collections.nextTimestamp()
    const copy = copyCollectionTree(snapshot, now)
    copy.name = nextCopyName(snapshot.name, list.map((c) => c.name))
    const index = list.findIndex((c) => c.id === targetCollection.id)
    this.collections.commitCollections([...list.slice(0, index + 1), copy, ...list.slice(index + 1)])
  }

  /** Copy Folder → 目标 Collection（folders 末尾追加）或目标 Folder（子 folders 末尾追加）（§4.5）。 */
  private commitCopyFolder(snapshot: Folder, targetCollection: Collection, parentFolder: Folder | undefined): void {
    const now = this.collections.nextTimestamp(targetCollection)
    const copy = copyFolderTree(snapshot, targetCollection.id, now)
    const siblings = parentFolder === undefined ? targetCollection.folders : parentFolder.folders
    copy.name = nextCopyName(snapshot.name, siblings.map((f) => f.name))
    const nextTarget = structuredClone(targetCollection)
    if (parentFolder === undefined) {
      nextTarget.folders.push(copy)
    } else {
      findFolder(nextTarget, parentFolder.id)!.folders.push(copy)
    }
    nextTarget.updatedAt = now
    this.commitReplace(targetCollection.id, nextTarget)
  }

  /** Copy Request → Collection 顶层末尾 / Folder 末尾 / 锚点 Request 之后（§4.5）；命名按 §4.6。 */
  private commitCopyRequest(snapshot: ApiRequest, targetCollection: Collection, target: LocatedTarget): void {
    const now = this.collections.nextTimestamp(targetCollection)
    let moveTarget: MoveRequestTarget
    let folderId: string | undefined
    let siblings: readonly ApiRequest[]
    if (target.folder !== undefined) {
      moveTarget = { kind: 'folder', folderId: target.folder.id }
      folderId = target.folder.id
      siblings = target.folder.requests
    } else if (target.anchorRequest !== undefined) {
      moveTarget = { kind: 'after-request', requestId: target.anchorRequest.id }
      const anchorHit = findRequest(targetCollection, target.anchorRequest.id)!
      folderId = anchorHit.folder?.id
      siblings = (anchorHit.folder ?? targetCollection).requests
    } else {
      moveTarget = { kind: 'collection-top' }
      siblings = targetCollection.requests
    }
    const copy = copyRequestSnapshot(snapshot, targetCollection.id, folderId, now)
    copy.name = nextCopyName(snapshot.name, siblings.map((r) => r.name))
    this.commitReplace(targetCollection.id, insertRequestAt(targetCollection, copy, moveTarget, now))
  }

  // ---- Cut paste（§4.4 七步原子流程；§13.2 事件流；consumed=true 一次性）----

  private pasteCut(
    entry: Extract<HostClipboardEntry, { operation: 'cut' }>,
    target: LocatedTarget,
    expectedTargetCollectionUpdatedAt: number,
  ): TreePasteResult {
    // 步骤 1/2：读权威对象并校验**全部**版本（request/sourceCollection/targetCollection
    // 三者严格相等，§4.3 谓词）；任一不符 → 409，且不写文件、不移动、不消费 token。
    const sourceCollection = this.collections.get(entry.sourceCollectionId)
    if (sourceCollection === undefined) throw new CollectionNotFoundError(entry.sourceCollectionId)
    const sourceHit = findRequest(sourceCollection, entry.sourceRequestId)
    // 源 Request 已被外部删除/移走（§0.3）：404，源节点与 token 均不动。
    if (sourceHit === undefined) throw new RequestNotFoundError(entry.sourceRequestId)
    if (!requestVersionMatches(sourceHit.request, entry.requestUpdatedAt)) throw new VersionConflictError()
    if (!collectionVersionMatches(sourceCollection, entry.sourceCollectionUpdatedAt)) throw new VersionConflictError()
    if (!collectionVersionMatches(target.targetCollection, expectedTargetCollectionUpdatedAt)) throw new VersionConflictError()

    const moveTarget: MoveRequestTarget =
      target.folder !== undefined
        ? { kind: 'folder', folderId: target.folder.id }
        : target.anchorRequest !== undefined
          ? { kind: 'after-request', requestId: target.anchorRequest.id }
          : { kind: 'collection-top' }
    // 锚点 = 被移动请求自身（WP1 风险注记②：core 会抛错）→ API 层归 400 invalid-paste-target。
    const sameCollection = sourceCollection.id === target.targetCollection.id
    if (sameCollection && moveTarget.kind === 'after-request' && moveTarget.requestId === entry.sourceRequestId) {
      throw new InvalidPasteTargetError('不能把剪切的请求粘贴到其自身之后')
    }
    // §4.3：now 单调——request 与两个 collection 的 updatedAt 都严格递增。
    const now = this.collections.nextTimestamp(sourceCollection, target.targetCollection, sourceHit.request)
    // 步骤 3：core 对 structured clone 计算 nextSource/nextTarget（权威对象不动）。
    const { nextSource, nextTarget } = moveRequestAcrossCollections(
      sourceCollection,
      target.targetCollection,
      entry.sourceRequestId,
      moveTarget,
      now,
    )
    // 步骤 4：内存组装完整 nextCollections[]（同 Collection 时 nextSource === nextTarget，只计一次）。
    const list = this.collections.list()
    const nextCollections =
      nextSource === nextTarget
        ? list.map((c) => (c.id === nextSource.id ? nextSource : c))
        : list.map((c) => (c.id === nextSource.id ? nextSource : c.id === nextTarget.id ? nextTarget : c))
    // 步骤 5/6：一次写盘；抛错则内存权威态不替换、token 不消费（§4.4）。
    this.collections.commitCollections(nextCollections)
    // 步骤 7：写盘成功后才消费 token（Cut 一次性）。
    this.entries.delete(entry.token)
    return { operation: 'cut', kind: 'request', consumed: true }
  }

  /** 单 Collection 变更也要经完整列表一次性提交（一次动作恰好一次 writeJson，AC-20 口径）。 */
  private commitReplace(collectionId: string, updated: Collection): void {
    this.collections.commitCollections(this.collections.list().map((c) => (c.id === collectionId ? updated : c)))
  }

  /** DELETE /tree/clipboard/:token：主动清空；幂等——token 不存在也静默成功（§3.1）。 */
  clear(token: string): void {
    this.entries.delete(token)
  }
}
