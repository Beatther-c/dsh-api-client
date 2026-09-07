/**
 * CollectionTree（§6）：Collection/Folder/Request 三级树 + 搜索 + 按钮组操作。
 *
 * Host API 提供面的诚实映射（§5.1 端点表）：
 * - Collection：新建/重命名/删除/Duplicate/排序（reorder 作用于顶层 requests）；
 * - Request：打开/重命名/删除/Duplicate/上下移动（顶层 reorder）；
 * - Folder：仅渲染与展开（V0.1 端点表无 folder CRUD——导入结构原样呈现，
 *   请求跨 folder 移动经 requests/:id/move 在编辑器 Save 流程中选择 folder）。
 *
 * 搜索复用 core collection/ops 的纯函数 searchRequests（客户端过滤投影，
 * Host 仍是权威状态源）。
 */
import { useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import type { ApiRequest, Collection, Folder } from '@dsh-api-client/shared'
import { searchRequests } from '../../../../packages/core/src/collection/ops.ts'
import { colors, font } from '../common/theme.ts'
import { TreeItem } from './TreeItem.tsx'
import type { TreeItemAction } from './TreeItem.tsx'

export interface CollectionTreeHandlers {
  onOpenRequest: (request: ApiRequest) => void
  onNewCollection: () => void
  onNewRequest: (collectionId: string) => void
  onRenameCollection: (collection: Collection) => void
  onDeleteCollection: (collection: Collection) => void
  onDuplicateCollection: (collection: Collection) => void
  onRenameRequest: (request: ApiRequest) => void
  onDeleteRequest: (request: ApiRequest) => void
  onDuplicateRequest: (request: ApiRequest) => void
  /** 顶层排序：把 request 在 collection.requests 内上移/下移一位。 */
  onReorderRequest: (collection: Collection, request: ApiRequest, direction: -1 | 1) => void
}

export interface CollectionTreeProps {
  collections: Collection[]
  loading: boolean
  selectedRequestId?: string
  handlers: CollectionTreeHandlers
}

export function CollectionTree(props: CollectionTreeProps): ReactElement {
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const { handlers } = props

  const toggle = (id: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const trimmed = query.trim()
  const matches = useMemo(() => {
    if (trimmed === '') return null
    const set = new Set<string>()
    for (const collection of props.collections) {
      for (const request of searchRequests(collection, trimmed)) set.add(request.id)
    }
    return set
  }, [props.collections, trimmed])

  const requestActions = (collection: Collection, request: ApiRequest, topLevel: boolean): TreeItemAction[] => {
    const actions: TreeItemAction[] = [
      { label: '✎', title: 'Rename', onClick: () => handlers.onRenameRequest(request) },
      { label: '⧉', title: 'Duplicate', onClick: () => handlers.onDuplicateRequest(request) },
    ]
    if (topLevel) {
      actions.push(
        { label: '↑', title: 'Move up', onClick: () => handlers.onReorderRequest(collection, request, -1) },
        { label: '↓', title: 'Move down', onClick: () => handlers.onReorderRequest(collection, request, 1) },
      )
    }
    actions.push({ label: '🗑', title: 'Delete', danger: true, onClick: () => handlers.onDeleteRequest(request) })
    return actions
  }

  const renderRequest = (collection: Collection, request: ApiRequest, depth: number, topLevel: boolean): ReactElement | null => {
    if (matches !== null && !matches.has(request.id)) return null
    return (
      <TreeItem
        key={request.id}
        kind="request"
        name={request.name}
        method={request.method}
        depth={depth}
        selected={props.selectedRequestId === request.id}
        actions={requestActions(collection, request, topLevel)}
        onSelect={() => handlers.onOpenRequest(request)}
      />
    )
  }

  const renderFolder = (collection: Collection, folder: Folder, depth: number): ReactElement | null => {
    const isCollapsed = matches === null && collapsed.has(folder.id)
    const children = [
      ...folder.folders.map((child) => renderFolder(collection, child, depth + 1)),
      ...folder.requests.map((request) => renderRequest(collection, request, depth + 1, false)),
    ].filter((child): child is ReactElement => child !== null)
    if (matches !== null && children.length === 0) return null
    return (
      <div key={folder.id}>
        <TreeItem
          kind="folder"
          name={folder.name}
          depth={depth}
          hasChildren
          expanded={!isCollapsed}
          onToggleExpand={() => toggle(folder.id)}
        />
        {!isCollapsed && children}
      </div>
    )
  }

  return (
    <div data-dsh-api-client="collection-tree" style={{ display: 'flex', flexDirection: 'column', height: '100%', fontSize: font.size }}>
      <div style={{ display: 'flex', gap: 4, padding: '6px 6px 4px' }}>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search requests"
          style={{
            flex: 1,
            background: colors.bgLayer1,
            border: `1px solid ${colors.border}`,
            borderRadius: 4,
            color: colors.text,
            font: 'inherit',
            fontSize: font.size,
            padding: '3px 8px',
            outline: 'none',
          }}
        />
        <button
          type="button"
          title="New collection"
          onClick={handlers.onNewCollection}
          style={{
            background: 'transparent',
            border: `1px solid ${colors.borderStrong}`,
            borderRadius: 4,
            color: colors.textSecondary,
            cursor: 'pointer',
            padding: '2px 8px',
          }}
        >
          +
        </button>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '0 4px 8px' }}>
        {props.loading && <div style={{ padding: 8, color: colors.textSecondary }}>Loading…</div>}
        {!props.loading && props.collections.length === 0 && (
          <div style={{ padding: 8, color: colors.textSecondary }}>No collections yet. Click + to create one.</div>
        )}
        {props.collections.map((collection) => {
          const isCollapsed = matches === null && collapsed.has(collection.id)
          const topRequests = collection.requests
            .map((request) => renderRequest(collection, request, 1, true))
            .filter((child): child is ReactElement => child !== null)
          const folders = collection.folders
            .map((folder) => renderFolder(collection, folder, 1))
            .filter((child): child is ReactElement => child !== null)
          if (matches !== null && topRequests.length === 0 && folders.length === 0) return null
          return (
            <div key={collection.id}>
              <TreeItem
                kind="collection"
                name={collection.name}
                depth={0}
                hasChildren
                expanded={!isCollapsed}
                onToggleExpand={() => toggle(collection.id)}
                actions={[
                  { label: '+req', title: 'New request', onClick: () => handlers.onNewRequest(collection.id) },
                  { label: '✎', title: 'Rename', onClick: () => handlers.onRenameCollection(collection) },
                  { label: '⧉', title: 'Duplicate', onClick: () => handlers.onDuplicateCollection(collection) },
                  { label: '🗑', title: 'Delete', danger: true, onClick: () => handlers.onDeleteCollection(collection) },
                ]}
              />
              {!isCollapsed && folders}
              {!isCollapsed && topRequests}
            </div>
          )
        })}
      </div>
    </div>
  )
}
