/**
 * 树投影纯函数（P0 实施设计 §4.7 搜索/折叠状态模型、§4.8 focus 模型、
 * §6.1 视觉缩进，UX §4.3/§4.6，WP5）。零 React、零运行时依赖——只吃
 * Collection[] + 两个折叠状态集合，产出可见行序列。
 *
 * 搜索（§4.7 逐字）：
 * - `query.trim().toLocaleLowerCase()` 后做原始子串匹配（不 URL decode）；
 * - 命中面 = Collection.name / Folder.name / Request.name / Request 原始 url；
 * - Request 命中 → 只显示祖先 + 自身；Collection/Folder 自身命中 → 显示完整后代；
 * - 空 query = 未搜索。
 *
 * 双折叠状态模型（§4.7）：
 * - 普通态 `expandedIds`（初始空集 = 全收缩，AC-03；不持久化，reload 即重置）；
 * - 搜索态 `searchCollapsed`（命中路径初始展开，用户 toggle 只改它；清除搜索丢弃）。
 * - 两个集合的值都是节点 key（`kind:id`），互不读写（AC-06 互不污染）。
 *
 * 可见行（§4.8）：`VisibleTreeNode` 接口逐字（key/kind/collectionId/nodeId/
 * parentKey?/firstChildKey?）供键盘导航——Arrow/Home/End 全部基于本序列，
 * 不经 DOM sibling 猜层级。渲染顺序遵循两组兄弟顺序（UX §4.6）：同一容器内
 * Folder 在前、Request 在后。视觉缩进 visualDepth = min(logicalDepth, 6)
 * （§6.1：达到上限后名称区不再压缩，逻辑层级不受限）。
 *
 * 空 Collection/Folder：expandable=false（无箭头但 expand-slot 占位保留，§6.1）。
 */
import type { ApiRequest, Collection, Folder, HttpMethod } from '@dsh-api-client/shared'

/** §4.8 接口逐字。 */
export interface VisibleTreeNode {
  key: string
  kind: 'collection' | 'folder' | 'request'
  collectionId: string
  nodeId: string
  parentKey?: string
  firstChildKey?: string
}

/** 渲染行 = 导航节点 + 展示/动作所需的只读投影字段。 */
export interface ProjectedTreeNode extends VisibleTreeNode {
  name: string
  /** kind='request' 时的 HTTP method（type/method-slot 徽标）。 */
  method?: HttpMethod
  /** 逻辑层级（collection=0），aria-level = logicalDepth+1；不受视觉上限影响。 */
  logicalDepth: number
  /** 视觉缩进层级 = min(logicalDepth, MAX_VISUAL_DEPTH)（§6.1）。 */
  visualDepth: number
  /** 数据上有直接子节点（空 Collection/Folder 为 false → 无箭头，占位保留）。 */
  expandable: boolean
  /** 当前状态模型下的展开态（普通态 expandedIds / 搜索态 !searchCollapsed）。 */
  expanded: boolean
  /** 原始节点引用（只读消费：菜单动作、重命名、WP8 删除统计）。 */
  collection: Collection
  /** kind='folder' 时存在。 */
  folder?: Folder
  /** kind='request' 时存在。 */
  request?: ApiRequest
}

export interface TreeProjectionInput {
  collections: readonly Collection[]
  query: string
  /** 普通态展开集合（节点 key）。 */
  expandedIds: ReadonlySet<string>
  /** 搜索态临时收缩集合（节点 key）；仅搜索时消费。 */
  searchCollapsed: ReadonlySet<string>
}

export interface TreeProjectionResult {
  /** 可见行（渲染顺序 = 键盘导航顺序）。 */
  rows: ProjectedTreeNode[]
  /** trim 后 query 非空。 */
  searching: boolean
  /** 数据上全部可展开节点 key（不论当前可见性）——「全部展开」用。 */
  allExpandableKeys: string[]
  /** 普通态下全部可展开节点均已展开（双态按钮：true → 显示「全部收缩」）。 */
  allExpanded: boolean
}

/** §6.1 视觉缩进上限。 */
export const MAX_VISUAL_DEPTH = 6

export function treeNodeKey(kind: VisibleTreeNode['kind'], id: string): string {
  return `${kind}:${id}`
}

/** §4.7：trim + Unicode 小写；空串 = 未搜索。 */
export function normalizeQuery(query: string): string {
  return query.trim().toLocaleLowerCase()
}

function textMatches(text: string, normalizedQuery: string): boolean {
  return text.toLocaleLowerCase().includes(normalizedQuery)
}

/** Request 命中面：name + 原始 url（不 URL decode，§4.7）。 */
function requestMatches(request: ApiRequest, normalizedQuery: string): boolean {
  return textMatches(request.name, normalizedQuery) || textMatches(request.url, normalizedQuery)
}

interface FlatEntry {
  row: Omit<ProjectedTreeNode, 'expanded' | 'firstChildKey'> & { firstChildKey?: string }
  childKeys: string[]
  selfMatch: boolean
  descendantMatch: boolean
}

/**
 * 把一棵 Collection 摊平（folders 前、requests 后的两组兄弟顺序），计算每个节点
 * 的 selfMatch / descendantMatch（自底向上），随后按状态模型裁剪出可见行。
 */
function projectCollection(
  collection: Collection,
  normalizedQuery: string,
  searching: boolean,
  expandedIds: ReadonlySet<string>,
  searchCollapsed: ReadonlySet<string>,
  rows: ProjectedTreeNode[],
  allExpandableKeys: string[],
): void {
  const entries = new Map<string, FlatEntry>()
  const order: string[] = []

  const register = (
    kind: VisibleTreeNode['kind'],
    nodeId: string,
    name: string,
    logicalDepth: number,
    parentKey: string | undefined,
    selfMatch: boolean,
    extras: { method?: HttpMethod; folder?: Folder; request?: ApiRequest },
  ): string => {
    const key = treeNodeKey(kind, nodeId)
    entries.set(key, {
      row: {
        key,
        kind,
        collectionId: collection.id,
        nodeId,
        ...(parentKey !== undefined ? { parentKey } : {}),
        name,
        logicalDepth,
        visualDepth: Math.min(logicalDepth, MAX_VISUAL_DEPTH),
        expandable: false,
        collection,
        ...extras,
      },
      childKeys: [],
      selfMatch,
      descendantMatch: false,
    })
    order.push(key)
    if (parentKey !== undefined) entries.get(parentKey)!.childKeys.push(key)
    return key
  }

  const collectionKey = register('collection', collection.id, collection.name, 0, undefined, textMatches(collection.name, normalizedQuery), {})

  const walkFolder = (folder: Folder, depth: number, parentKey: string): boolean => {
    const key = register('folder', folder.id, folder.name, depth, parentKey, textMatches(folder.name, normalizedQuery), { folder })
    let descendantMatch = false
    for (const child of folder.folders) {
      if (walkFolder(child, depth + 1, key)) descendantMatch = true
    }
    for (const request of folder.requests) {
      const requestKey = register('request', request.id, request.name, depth + 1, key, requestMatches(request, normalizedQuery), {
        method: request.method,
        request,
      })
      if (entries.get(requestKey)!.selfMatch) descendantMatch = true
    }
    const entry = entries.get(key)!
    entry.descendantMatch = descendantMatch
    return entry.selfMatch || descendantMatch
  }

  for (const folder of collection.folders) {
    if (walkFolder(folder, 1, collectionKey)) entries.get(collectionKey)!.descendantMatch = true
  }
  for (const request of collection.requests) {
    const requestKey = register('request', request.id, request.name, 1, collectionKey, requestMatches(request, normalizedQuery), {
      method: request.method,
      request,
    })
    if (entries.get(requestKey)!.selfMatch) entries.get(collectionKey)!.descendantMatch = true
  }

  // 可展开性 + firstChildKey 需要孩子信息，先补 expandable。
  for (const key of order) {
    const entry = entries.get(key)!
    entry.row.expandable = entry.childKeys.length > 0
    if (entry.row.expandable) allExpandableKeys.push(key)
  }

  // 搜索态的「祖先命中 → 完整后代」传递标记。
  const inheritedMatch = new Set<string>()
  const markInherited = (key: string, ancestorMatched: boolean): void => {
    const entry = entries.get(key)!
    const passDown = ancestorMatched || entry.selfMatch
    if (passDown) inheritedMatch.add(key)
    for (const childKey of entry.childKeys) markInherited(childKey, passDown)
  }
  markInherited(collectionKey, false)

  const isExpanded = (key: string): boolean => (searching ? !searchCollapsed.has(key) : expandedIds.has(key))

  const emit = (key: string, ancestorChainVisible: boolean): void => {
    const entry = entries.get(key)!
    // 可见性：非搜索 = 祖先链全展开；搜索 = (self || descendant || 祖先命中传递) 且祖先链在搜索态展开。
    const included = searching ? entry.selfMatch || entry.descendantMatch || inheritedMatch.has(key) : true
    const isVisible = ancestorChainVisible && included
    const expanded = isVisible && entry.row.expandable && isExpanded(key)
    if (isVisible) {
      const firstVisibleChildKey = expanded
        ? entry.childKeys.find((childKey) => {
            const child = entries.get(childKey)!
            return searching ? child.selfMatch || child.descendantMatch || inheritedMatch.has(childKey) : true
          })
        : undefined
      rows.push({
        ...entry.row,
        expanded,
        ...(firstVisibleChildKey !== undefined ? { firstChildKey: firstVisibleChildKey } : {}),
      })
    }
    for (const childKey of entry.childKeys) emit(childKey, expanded)
  }
  emit(collectionKey, true)
}

/**
 * 主入口：投影当前可见行。数据刷新/重命名/增删后按当前 query 重新调用即得
 * 「立即按当前查询重新计算」（§4.3）——纯函数，无内部缓存。
 */
export function projectTree(input: TreeProjectionInput): TreeProjectionResult {
  const normalizedQuery = normalizeQuery(input.query)
  const searching = normalizedQuery !== ''
  const rows: ProjectedTreeNode[] = []
  const allExpandableKeys: string[] = []
  for (const collection of input.collections) {
    projectCollection(collection, normalizedQuery, searching, input.expandedIds, input.searchCollapsed, rows, allExpandableKeys)
  }
  const allExpanded = allExpandableKeys.length > 0 && allExpandableKeys.every((key) => input.expandedIds.has(key))
  return { rows, searching, allExpandableKeys, allExpanded }
}

/** 按 key 查行（键盘导航/菜单目标定位）。 */
export function findRowByKey(rows: readonly ProjectedTreeNode[], key: string): ProjectedTreeNode | undefined {
  return rows.find((row) => row.key === key)
}

/**
 * 子树 Request id 收集（「统计」面）：WP8 删除 Folder/Collection 成功后调
 * `notifyLocalRequestsDeleted`（§0.3 Cut 源级联清空）与 tab 清理时使用；
 * 与 core listAllRequests/countFolderDescendants 同语义的轻量本地实现
 * （保持本模块零运行时依赖）。
 */
export function collectSubtreeRequestIds(target: { collection: Collection } | { folder: Folder } | { request: ApiRequest }): string[] {
  if ('request' in target) return [target.request.id]
  if ('folder' in target) {
    const out: string[] = []
    const walkFolder = (folder: Folder): void => {
      for (const request of folder.requests) out.push(request.id)
      for (const child of folder.folders) walkFolder(child)
    }
    walkFolder(target.folder)
    return out
  }
  const out: string[] = []
  const walkFolder = (folder: Folder): void => {
    for (const request of folder.requests) out.push(request.id)
    for (const child of folder.folders) walkFolder(child)
  }
  for (const request of target.collection.requests) out.push(request.id)
  for (const folder of target.collection.folders) walkFolder(folder)
  return out
}
