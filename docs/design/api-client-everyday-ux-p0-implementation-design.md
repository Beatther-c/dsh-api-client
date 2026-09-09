# dsh-api-client「常用交互优化 P0」完整实施设计

> 状态：定稿（DESIGN_GATE 七项完整性检查通过；用户全程预授权，原话存流水线状态文件）· 更新 2026-09-10 · 关联：docs/DEVLOG.md 本轮条目
> 日期：2026-09-10
> 仓库：`Beatther-c/dsh-api-client`，分支 `main`
> 来源 UX 文档路径：`docs/superpowers/specs/2026-09-10-api-client-everyday-ux-design.md`
> 实施范围：UX §7「P0：本轮核心」+ §11 批次 1–5
> 事实源：《DSH API Client 常用交互优化设计》全文；如本设计与 UX 文档冲突，以 UX 文档冻结语义为准。
> 产出方式：ChatGPT（chatgpt-dev-pipeline solution-design 角色，专用会话）生成；orchestrator 修正元信息区一处生成串行损坏（来源路径），其余内容原样。
>
> 当前仓库基线已核对：`ApiRequest` 尚无 `suppressedGeneratedHeaders`，`PluginSettings` 尚无 `collectionSidebarWidth`；当前请求树以空 `collapsed` 集合作为初始态，因此默认展开，`TreeItem` 在 hover 时动态挂载操作按钮；`ApiClientView` 左栏固定为 `260px`；当前 `applyAuth` 直接追加认证 Header，当前 wire Header 聚合也没有先按大小写不敏感名称归组。上述现状与 UX 文档列出的 P0 痛点一致。

---

## 0. 对 UX 文档的澄清与偏差

本节只处理原 UX 文档中存在的文本损坏、接口与行为间无法同时成立的地方，不改变已冻结的产品语义。

### 0.1 §8.3 clipboard 端点表存在粘贴损坏

附件中 §8.3 在 `POST /tree/clipboard/cut` 与 paste 端点之间发生文本串行错位，但 §4.6、§8.3 后文及附件尾部残片足以恢复唯一合理合同。恢复为：

```
POST   /tree/clipboard/cut
body:  requestId, requestUpdatedAt, sourceCollectionUpdatedAt

POST   /tree/clipboard/:token/paste
body:  targetKind, targetId?, targetCollectionId?,
       expectedTargetCollectionUpdatedAt?

DELETE /tree/clipboard/:token
```

本设计仅按上述路径恢复原合同，不另造 `/tree/mutate`、`/tree/copy`、`/tree/move` 等第二套通用 mutation API。UX 对 Host-authoritative、clipboard token、版本校验的要求保持不变。

### 0.2 “Folder/Collection copy 需要明确端点”与 §8.3 只给 clipboard 端点的关系

处理决定：Collection、Folder、Request 的 P0 “复制/粘贴”统一通过 `POST /tree/clipboard/copy` + `POST /tree/clipboard/:token/paste` 实现。

仓库现有：

```
POST /api-client/collections/:id/duplicate
POST /api-client/requests/:id/duplicate
```

继续保留作为兼容能力，但 P0 请求树不再使用它们模拟 Copy/Paste。现有 Request `move` 也只能在同一 Collection 内切换 `folderId`，不能替代 P0 的跨 Collection 原子 Cut/Paste。

### 0.3 Cut 来源被外部删除时，“打开菜单前禁用粘贴”无法完全实现

UX 同时规定：

- Client 只持有 token、动作类型、节点类型，不持有源节点 ID；
- §8.3 没有 clipboard validate/status 端点；
- Cut 来源已删除时 Paste 应显示不可用原因。

在不新增端点的约束下，Client 无法在菜单打开瞬间主动询问 Host 判断“其他窗口/进程是否刚删除源 Request”。

因此处理为：

- 本 Client 自己删除 Cut 来源：立即清空本地 token，Paste 禁用；
- token 已超过 Host 返回的 `expiresAt`：Paste 禁用，原因“剪贴板已过期”；
- 根据 `kind + operation + targetKind` 可判断目标非法：Paste 禁用；
- 外部删除或版本变化：用户真正执行 Paste 时由 Host 返回 `404` 或 `409`，源节点不移动、token 不消费；
- 不为此新增 clipboard status API。

这是冻结端点合同下唯一不会制造第二套 API 的实现。

### 0.4 compact 下拖到 160–219px 时的持久化语义

UX 同时定义：

- compact 渲染最小可到 `160px`；
- `collectionSidebarWidth` 持久化值加载时钳制到 `220–520px`。

因此：

```
renderedWidth
  可以是 compact 下的 160–219px

preferredWidth / collectionSidebarWidth
  始终属于正常宽度域 220–520px
```

compact 中 pointerup 若最终为 `180px`，当前 viewport 继续渲染 `180px`，但持久化偏好写为 `220px`；回到正常宽屏后渲染 `220px`。

### 0.5 Body §6.5 的能力不进入本轮

附件后部存在段落顺序错位，但 §7 已明确：

- raw 子类型；
- form-data File；
- binary；
- Bulk Edit；
- 多行粘贴；

均属于 P1。

P0 只要求现有 `JSON / raw(Text) / form-data(Text-only) / urlencoded` 回归，以及它们对 Generated Header 的影响。不得顺手实现 P1。

### 0.6 运行时 Header 的“最终值”不伪造

当前 `HttpWireResponse` 不含底层实际发出的 `Host / Content-Length / Accept-Encoding` 快照，`undici` 也没有由现有执行链可靠回传这些自动请求 Header 的接口。

因此 P0：

- 能确定来源但发送时才决定的行显示“发送时计算”；
- 不从 Body 长度自行伪造“undici 最终一定发送了 X”；
- 只有未来 transport 真正回传实际 request wire snapshot 后，才能更新为最终值；
- P0 不增加为了展示这些值而存在的代理服务器、MITM 或网络抓包依赖。

---

# 1. 功能描述

## 1.1 背景与核心痛点

本轮不是“继续堆 Postman 功能”，而是解决现有日常调试链路的高频摩擦。

请求树当前存在 hover 后名称宽度变化、默认全展开、Folder 缺少 CRUD、删除与 tab 生命周期不一致、浏览器 `prompt/confirm` 交互粗糙等问题。主布局固定 `260px`，长 Collection/Folder 名称难以使用。Headers 当前只用一句说明表示自动补 `Content-Type / Accept`，而真实执行链中 Body、Auth、默认 Header 与网络运行时共同决定最终请求，用户很难判断覆盖关系。

此外，当前 `resolveRequest → applyAuth` 是两阶段构建：Body/default Header 先构建，Auth 后直接追加，无法严格保证“启用的用户 Header > Auth/Body/default”这一冻结优先级。

## 1.2 P0 目标

P0 完成后，用户应能够：

1. 以桌面应用习惯稳定操作 Collection / Folder / Request 请求树；
2. 完成新建、重命名、复制、粘贴、Request 剪切移动和强确认删除；
3. 使用完整键盘导航与右键菜单；
4. 调节侧栏宽度，并在窄窗口无损切换 overlay drawer；
5. 删除或关闭时不会无提示丢失 dirty tab；
6. 在发送前看清 Body、Auth、客户端默认值及运行时 Header 的来源和覆盖状态；
7. 确保 Preview 与 Send 共用一套 canonical request-plan 合并算法；
8. 确保任何秘密不会因新预览、clipboard、toast、DOM 或 Agent context 泄漏；
9. 所有持久化 mutation 保持 `hook → Host API → service/core → storage`；
10. 不新增运行时依赖。

UX 的 P0 范围及成功标准以附件 §7 为准。

## 1.3 非目标

本轮明确不实现：

- Folder / Collection Cut；
- Folder move；
- 树节点拖拽；
- Folder/Request 混合排序字段；
- Undo / Trash / 可恢复删除；
- Cookie Jar；
- Bulk Edit；
- raw 子类型；
- form-data 文件字段；
- binary Body；
- cURL/OpenAPI 导入；
- Collection Runner；
- GraphQL / WebSocket / gRPC；
- 完整 OAuth 2.0；
- Postman 平台级协作能力。

现有 `/duplicate`、`requests/:id/move` 可以继续兼容，但不是新树 Copy/Paste 的实现基础。

---

# 2. 总体架构与前后端分工

## 2.1 总体数据流

所有结构性 mutation 严格保持：

```
Tree / Request UI
        │
        ▼
Client Hook
(useCollections / useTreeClipboard)
        │
        ▼
Host API
        │
        ▼
CollectionService / TreeClipboardService
        │
        ▼
Core pure operations
        │
        ▼
FileStore.writeJson()
        │
        ▼
Host authoritative state
        │
        ▼
Client re-fetch projection
```

禁止：

```
UI → 直接改 collections 本地数组 → 假装成功
UI → 直接写文件
UI → 直接 import DSH 包
Client → 保存完整 clipboard snapshot
Client → 保存解析后的 SecretRef 值
```

现有 `FileStore.writeJson()` 已使用同目录 tmp + rename 原子替换，可继续作为单次树 mutation 的持久化原语。

## 2.2 文件级改动总表

### Shared

| 文件 | 类型 | 设计职责 |
| --- | --- | --- |
| `packages/shared/src/types.ts` | 修改 | 增加 suppression、Generated Preview、clipboard、安全结果类型、sidebar setting |
| `packages/shared/src/index.ts` | 不修改 | 当前已统一 export `types.ts`，无需额外汇聚 |

### Core

| 文件 | 类型 | 设计职责 |
| --- | --- | --- |
| `packages/core/src/collection/ops.ts` | 修改 | Folder CRUD/copy、跨 Collection Request copy/move、稳定副本命名、版本辅助纯函数 |
| `packages/core/src/request/plan.ts` | 新增 | canonical `buildRequestPlan`、安全 preview、Generated Header/Query 合并 |
| `packages/core/src/request/build.ts` | 修改 | Header 大小写辅助、用户 Header 分组 primitive |
| `packages/core/src/request/body.ts` | 修改 | plan 可复用 Body contribution；multipart preview 不伪造 boundary |
| `packages/core/src/variables/resolver.ts` | 修改 | 将变量解析能力接入 canonical plan；保留兼容 wrapper |
| `packages/core/src/auth/apply.ts` | 修改 | Auth contribution 不再无条件 append；兼容调用也遵守用户项优先 |
| `packages/core/src/executor/executor.ts` | 修改 | Send 改走 resolved `buildRequestPlan` |
| `packages/core/src/executor/http-client.ts` | 修改 | wire Header 按 lowercase 聚合、保留首个用户拼写 |
| `packages/core/src/index.ts` | 修改 | export `request/plan.ts` |

### Host

| 文件 | 类型 | 设计职责 |
| --- | --- | --- |
| `src/host/services/collection-service.ts` | 修改 | Folder CRUD、单次多 Collection commit、单调 `updatedAt` |
| `src/host/services/tree-clipboard-service.ts` | 新增 | profile-scoped 内存 clipboard、TTL、copy snapshot、cut reference |
| `src/host/services/settings-service.ts` | 修改 | `collectionSidebarWidth` 默认值、校验与持久化 |
| `src/host/services/execution-service.ts` | 修改 | adhoc request 保留 suppression，Send 进入新 plan |
| `src/host/api/folders.ts` | 新增 | 三个冻结 Folder 端点 |
| `src/host/api/tree-clipboard.ts` | 新增 | copy/cut/paste/clear 四个冻结 clipboard 端点 |
| `src/host/api/requests.ts` | 修改 | create/patch 支持 suppression；P0 名称/字段校验 |
| `src/host/index.ts` | 修改 | 装配 `TreeClipboardService` 并注册新 routes |

`src/host/api/router.ts` 不修改。现有 router 已提供统一 `{ error: { code, message } }`、鉴权、CSRF 与错误 redaction 出口。

### Client

| 文件 | 类型 | 设计职责 |
| --- | --- | --- |
| `src/client/hooks/useHostApi.ts` | 修改 | `delete(path, body?)`，继续统一 HostApiError |
| `src/client/hooks/useCollections.ts` | 修改 | mutation 后同步 re-fetch、stale 状态、409 处理 |
| `src/client/hooks/useTreeClipboard.ts` | 新增 | 只保存 token/operation/kind/expiresAt；copy/cut/paste/clear |
| `src/client/hooks/useCollectionSidebarWidth.ts` | 新增 | 读取/持久化 `collectionSidebarWidth` |
| `src/client/hooks/useRequestPlanPreview.ts` | 新增 | 调 canonical safe preview |
| `src/client/components/collection/tree-projection.ts` | 新增 | 搜索投影、可见节点、键盘父子关系、统计 |
| `src/client/components/collection/CollectionTree.tsx` | 修改 | 搜索态、普通展开态、选择、菜单、键盘、全展开 |
| `src/client/components/collection/TreeItem.tsx` | 修改 | 稳定行、整行 toggle、行内 rename、focus |
| `src/client/components/collection/TreeContextMenu.tsx` | 新增 | portal、定位、菜单动作矩阵、焦点 |
| `src/client/components/collection/ResizableCollectionPane.tsx` | 新增 | resize/compact/hidden/drawer |
| `src/client/components/collection/TreeCreateDialog.tsx` | 新增 | 新建 Collection/Folder 的中文输入对话框 |
| `src/client/components/collection/TreeDeleteConfirmDialog.tsx` | 新增 | Folder/Collection/Request 强确认与 dirty 统计 |
| `src/client/components/common/Modal.tsx` | 修改 | 中文 accessibility name、默认焦点能力 |
| `src/client/components/request/GeneratedItemsSection.tsx` | 新增 | Generated Header/Query 统一只读/可 suppression UI |
| `src/client/components/request/HeadersEditor.tsx` | 修改 | 用户 Header + Generated Header 分层 |
| `src/client/components/request/ParamsEditor.tsx` | 修改 | Auth 自动 Query 参数分组 |
| `src/client/components/request/tab-lifecycle.ts` | 新增 | 删除后 tab 集合与 active tab 纯算法 |
| `src/client/components/request/DirtyTabCloseDialog.tsx` | 新增 | dirty tab 关闭确认 |
| `src/client/views/ApiClientView.tsx` | 修改 | 最终汇聚：tab、树 mutation、resize、preview、中文主界面 |

DSH adapter、slot、theme adapter 均不修改。

---

# 3. API 契约

所有路径以下均写完整 Host Base：

```
/api-client
```

Client 仍通过 `useHostApi` 使用相对路径，例如 `/tree/clipboard/copy`。实际路由注册继续遵循当前 `src/host/api/*.ts` 使用完整 `/api-client/...` pattern 的方式。

## 3.1 Folder 与 clipboard 冻结合同

| 方法 | 路径 | 入参（名 / 类型 / 必填 / 语义） | 返回 | 错误码 |
| --- | --- | --- | --- | --- |
| POST | `/api-client/collections/:id/folders` | `name:string` 必填；`parentFolderId?:string`；`expectedCollectionUpdatedAt:number` 必填 | `FolderDescriptor {id,name}` | `400 invalid-input`；`404 collection-not-found/folder-not-found`；`409 version-conflict` |
| PATCH | `/api-client/collections/:id/folders/:folderId` | `name:string` 必填非空；`expectedCollectionUpdatedAt:number` 必填 | `FolderDescriptor` | `400`；`404`；`409 version-conflict` |
| DELETE | `/api-client/collections/:id/folders/:folderId` | JSON body：`expectedCollectionUpdatedAt:number` 必填 | `204` | `400`；`404`；`409 version-conflict` |
| POST | `/api-client/tree/clipboard/copy` | `kind:'collection' | 'folder' | 'request'`；`collectionId`；Folder/Request 时 `nodeId` 必填 | `TreeClipboardDescriptor` | `400 invalid-input`；`404` |
| POST | `/api-client/tree/clipboard/cut` | `requestId:string`；`requestUpdatedAt:number`；`sourceCollectionUpdatedAt:number` | `TreeClipboardDescriptor` | `400 cut-only-request/invalid-input`；`404 request-not-found`；`409 version-conflict` |
| POST | `/api-client/tree/clipboard/:token/paste` | `targetKind:'root' | 'collection' | 'folder' | 'request'`；`targetId?`；`targetCollectionId?`；非 root 时 `expectedTargetCollectionUpdatedAt` | `TreePasteResult` | `400 invalid-paste-target`；`404 clipboard-not-found/collection-not-found/folder-not-found/request-not-found`；`409 version-conflict` |
| DELETE | `/api-client/tree/clipboard/:token` | 无 | `204` | token 已不存在仍按幂等 `204` |

`TreeClipboardDescriptor`：

```
interface TreeClipboardDescriptor {
  token: string
  operation: 'copy' | 'cut'
  kind: 'collection' | 'folder' | 'request'
  expiresAt: number
}
```

不得返回：

```
name
URL
Body
Header
Auth
SecretRef
源节点完整 ID 链
节点 snapshot
```

`TreePasteResult`：

```
interface TreePasteResult {
  operation: 'copy' | 'cut'
  kind: 'collection' | 'folder' | 'request'
  consumed: boolean
}
```

Copy 成功 `consumed=false`；Cut 成功 `consumed=true`。

### 3.1.1 409 的精确定义

以下任一条件不匹配：

```
expectedCollectionUpdatedAt
expectedTargetCollectionUpdatedAt
cut.requestUpdatedAt
cut.sourceCollectionUpdatedAt
```

返回：

```
{
  "error": {
    "code": "version-conflict",
    "message": "数据已被其他操作修改，请刷新后重试"
  }
}
```

必须满足：

- 不写文件；
- 不移动 Cut Request；
- 不消费 clipboard token；
- Copy snapshot 仍保留；
- Client 将树标记为 stale，直到重新成功刷新。

## 3.2 复用/扩展现有 API

| 方法 | 路径 | P0 用途 | P0 扩展 |
| --- | --- | --- | --- |
| GET | `/api-client/collections` | Host-authoritative 树投影 | 无 |
| POST | `/api-client/collections` | 根空白区新建 Collection | 文案/UI 中文化，无合同变化 |
| PATCH | `/api-client/collections/:id` | Collection 行内重命名 | 继续使用现有 `name` |
| DELETE | `/api-client/collections/:id` | Collection 删除 | Host 成功后才更新 tabs |
| POST | `/api-client/collections/:id/requests` | Collection/Folder 新建 Request | 支持 `suppressedGeneratedHeaders`，默认 `[]` |
| PATCH | `/api-client/requests/:id` | Request 重命名/Save | 支持 `suppressedGeneratedHeaders`，并验证 `name` 非空 |
| DELETE | `/api-client/requests/:id` | Request 删除 | Host 成功后才关闭 tab |
| GET | `/api-client/settings` | 读取 sidebar 偏好 | 返回 `collectionSidebarWidth` |
| PATCH | `/api-client/settings` | 保存 sidebar 偏好 | 接受 `collectionSidebarWidth:220..520` |

现有 `/duplicate` 和 `/requests/:id/move` 不删除，但 P0 树菜单不使用。

## 3.3 API 输入校验

`suppressedGeneratedHeaders` 的 Host 校验必须拒绝：

```
source: 'auth'
source: 'runtime'
空 name
非字符串 name
未知 source
非数组
```

写入前规范化：

```
name = name.trim().toLowerCase()
```

同 `(name, source)` 去重。

允许的持久化 source 只有：

```
'body'
'client-default'
```

---

# 4. 数据模型与状态管理

## 4.1 Shared 类型

### 4.1.1 Generated Header suppression

```
export type SuppressibleGeneratedHeaderSource =
  | 'body'
  | 'client-default'

export interface SuppressedGeneratedHeader {
  name: string
  source: SuppressibleGeneratedHeaderSource
}
```

`ApiRequest` 增加：

```
suppressedGeneratedHeaders?: SuppressedGeneratedHeader[]
```

使用 optional 而不是立刻做磁盘全量迁移。

读取语义：

```
request.suppressedGeneratedHeaders ?? []
```

新建/保存过的 Request 写出规范化数组。

这样旧 `collections.json` 无需启动时强制重写，满足向后兼容。

### 4.1.2 Generated Preview

```
export type GeneratedItemSource =
  | 'body'
  | 'auth'
  | 'client-default'
  | 'runtime'

export type GeneratedItemStatus =
  | 'active'
  | 'overridden'
  | 'suppressed'
  | 'runtime-pending'
  | 'invalid-user-override'

export interface GeneratedHeaderPreview {
  name: string
  valuePreview: string
  source: GeneratedItemSource
  status: GeneratedItemStatus
  sensitive: boolean
  suppressible: boolean
}

export interface GeneratedQueryPreview {
  name: string
  valuePreview: string
  source: 'auth'
  status: 'active' | 'overridden'
  sensitive: true
}

export interface RequestPlanPreview {
  headers: GeneratedHeaderPreview[]
  query: GeneratedQueryPreview[]
  preSendHeaderCount: number
  runtimeHeaderCount: number
}
```

任何敏感 Generated Item：

```
valuePreview = ••••••••
```

不得将真实值额外放进隐藏属性或 `title`。

### 4.1.3 Sidebar setting

`PluginSettings` 增加：

```
collectionSidebarWidth: number
```

默认：

```
260
```

Host validator：

```
整数
220 <= value <= 520
```

旧 settings 文件无字段时由 `DEFAULT_PLUGIN_SETTINGS` 自动补齐。

## 4.2 Clipboard Host 内部模型

该类型可以放在 `tree-clipboard-service.ts` 内部，不 export 给 Client：

```
type HostClipboardEntry =
  | {
      token: string
      profileId: string
      operation: 'copy'
      kind: 'collection' | 'folder' | 'request'
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
```

存储：

```
private readonly entries = new Map<string, HostClipboardEntry>()
```

不落：

```
FileStore
localStorage
sessionStorage
IndexedDB
History
console
audit detail
Agent context
```

TTL：

```
30 分钟
```

Host 重启自然清空。

## 4.3 `updatedAt` 作为乐观锁版本

目前 `Collection.updatedAt` 使用毫秒时间；为了让它真正承担版本 token，Host mutation 不能允许连续写入落到同一数值。

`CollectionService` 增加：

```
function nextTimestamp(...entities: { updatedAt: number }[]): number {
  return Math.max(
    Date.now(),
    ...entities.map(x => x.updatedAt + 1),
  )
}
```

P0 所有通过 `CollectionService` 的写操作都统一使用单调时间。

Request mutation 同时保证：

```
request.updatedAt > previous request.updatedAt
collection.updatedAt > previous collection.updatedAt
```

这样 Cut token 才能可靠检测“剪切后 Request 被修改”。

## 4.4 Host 原子跨 Collection move

不能：

```
先 persist 源 Collection
再 persist 目标 Collection
```

虽然物理文件相同，这会产生中间状态。

正确流程：

```
1. 读取权威 collections[]
2. 校验 source/target 全部版本
3. Core 对 structured clone 计算 nextSource/nextTarget
4. 在内存中组成完整 nextCollections[]
5. FileStore.writeJson(collectionsFile, nextCollections) 一次
6. 成功后替换 this.collections
7. 最后消费 Cut token
```

写文件失败：

```
this.collections 不替换
Cut token 不消费
```

## 4.5 Copy 语义

Copy 创建 snapshot 时立刻：

```
structuredClone(authoritative node)
```

后续来源：

- 被重命名；
- 被编辑；
- 被移动；
- 被删除；

均不影响该 Copy。

Paste 时：

### Collection

根空白：

```
追加根 Collection 末尾
```

目标 Collection：

```
插在该 Collection 后
```

全子树生成新 ID。

### Folder

目标 Collection：

```
追加 targetCollection.folders 末尾
```

目标 Folder：

```
追加 targetFolder.folders 末尾
```

### Request

目标 Collection：

```
追加 targetCollection.requests 末尾
```

目标 Folder：

```
追加 targetFolder.requests 末尾
```

目标 Request：

```
插在 targetRequest 后
```

P0 保持：

```
folders[] 独立排序
requests[] 独立排序
Folder 渲染在 Request 前
```

不创建混合 item-order。

## 4.6 Copy 命名

统一纯函数：

```
nextCopyName(originalName, siblingNames)
```

规则：

```
第一次：名称 副本
第二次：名称 副本 2
第三次：名称 副本 3
...
```

冲突范围仅同目标容器、同节点类型的 sibling names。

Cut 保持原名且允许目标已有同名。

## 4.7 搜索和折叠状态

### 普通态

使用：

```
expandedIds: Set<string>
```

而不是当前的 `collapsed`。

首次：

```
expandedIds = empty
```

即默认全部收缩。

页面 reload 后重置，不写 settings。

### 搜索态

单独：

```
searchCollapsed: Set<string>
```

搜索发生时：

```
普通 expandedIds 不变
```

规则：

```
query = query.trim().toLocaleLowerCase()
```

匹配：

- Collection.name；
- Folder.name；
- Request.name；
- Request 原始 URL。

不 URL decode。

Request 命中：

```
祖先 + Request
```

Collection / Folder 自身命中：

```
目标 + 全部后代
```

清除搜索：

```
searchCollapsed 清空
恢复 expandedIds
```

搜索期间全展开按钮 disabled。

## 4.8 Tree focus 模型

`CollectionTree` 生成当前 `visibleNodes[]`：

```
interface VisibleTreeNode {
  key: string
  kind: 'collection' | 'folder' | 'request'
  collectionId: string
  nodeId: string
  parentKey?: string
  firstChildKey?: string
}
```

只维护一个 `focusedKey/selectedKey`。

Arrow/Home/End 均基于 `visibleNodes`，不得通过任意 DOM sibling 猜层级。

## 4.9 mutation 后 refresh 状态

`useCollections` 增加：

```
stale: boolean
refresh(): Promise<boolean>
```

Mutation 流：

```
await Host mutation
      │
      ├─失败────────► 保持旧 UI
      │               409 => stale=true
      │
      ▼
await GET /collections
      │
      ├─成功────────► 替换 projection，stale=false
      │
      └─失败────────► Host 已提交
                      保持旧 projection
                      stale=true
                      toast：
                      “数据已保存，列表刷新失败”
```

stale 时：

- 禁用树 mutation；
- 禁用 Request Save；
- 保留浏览、tab、已有草稿和 Send；
- 显示“重新刷新”；
- 刷新成功才恢复 mutation。

禁止显示“操作已回滚”。

---

# 5. canonical `buildRequestPlan`

## 5.1 目标

不能继续存在：

```
Headers preview 自己 buildHeaders()
Send 自己 resolveRequest()
Auth 再自己 append()
```

必须变成：

```
                     ┌─ preview projection ─► UI
request/config ─────►│
                     └─ resolved plan ──────► executor ─► undici
```

共享的是：

```
贡献来源
优先级
suppression
Header 名称比较
Query API Key 冲突
Body → Content-Type
Auth → Header/Query
default Accept
runtime item catalog
```

两模式唯一差异：

```
变量与 SecretRef 如何 materialize
```

## 5.2 推荐接口

```
export interface BuildRequestPlanOptions {
  mode: 'preview' | 'resolved'
  environment?: Environment
  collection?: Collection
  local?: Record<string, string>
  resolveSecret?: SecretResolver
  boundary?: string
}

export async function buildRequestPlan(
  request: ApiRequest,
  options: BuildRequestPlanOptions,
): Promise<RequestPlan>
```

`resolved`：

```
返回 ResolvedRequest + plan metadata
```

`preview`：

```
返回 RequestPlanPreview
不返回任何可恢复 secret 的材料
```

保留：

```
resolveRequest()
applyAuth()
```

作为向后兼容 wrapper，但内部最终调用同一 primitive，不允许保留第二套优先级算法。

## 5.3 Header 合并优先级

冻结顺序：

```
启用用户 Header
    >
Auth / Body Generated
    >
客户端默认值
    >
网络运行时最终值
```

具体算法：

```
1. 收集所有 enabled user headers
2. 按 lowercase name 建 userHeaderNames
3. 推导 Body contribution
4. 推导 Auth contribution
5. 推导 client-default Accept
6. 应用 suppression
7. 若 userHeaderNames 已存在同名：
      Generated status = overridden
      Generated 不进入 resolved wire
8. 其余 active Generated 进入 wire
9. runtime 只形成 projection，不预造最终 value
```

disabled user Header 不进入步骤 2。

## 5.4 多个同名用户 Header

输入：

```
X-Foo: a
x-foo: b
```

两个都 enabled。

结果：

```
Generated X-Foo 被覆盖
两个用户值都进入 transport
```

`headersToWire` 修改为：

```
case-insensitive group key
保留第一行用户拼写作为 object key
值按原用户顺序 string[]
```

不得由于大小写差异创建两个 wire object keys。

最终 `undici` 对特定 Header 的合并/限制行为以真实 integration test 固化，不在 UI 承诺浏览器/协议本身不支持的重复语义。

## 5.5 Auth

Bearer / Basic：

```
Generated Authorization
source=auth
sensitive=true
suppressible=false
```

Header API Key：

```
Generated <API-Key-Header>
source=auth
sensitive=true
```

用户已有 enabled 同名 Header：

```
Auth Generated status=overridden
Auth 不再追加第二条
```

解决当前 `applyAuth` 无条件 append 的问题。

## 5.6 Query API Key

Auth：

```
{ type:'apikey', in:'query', key:'api_key', ... }
```

Generated Query 只在 Params 区展示。

如果 URL/Params 中存在至少一个 enabled 同名用户参数：

```
Generated status=overridden
不追加 auth query
```

只有 disabled 同名行：

```
仍生成 Auth Query
```

Preview value 永远：

```
••••••••
```

## 5.7 Body 与 Content-Type

当前 P0：

| Body | Generated Content-Type |
| --- | --- |
| none | 无 |
| raw | `text/plain` |
| json | `application/json` |
| urlencoded | `application/x-www-form-urlencoded` |
| form-data | `multipart/form-data; boundary=…` |

form-data preview 不生成一个假的随机最终 boundary 供用户误认为实际 wire 值。

Preview：

```
multipart/form-data; boundary=<发送时生成>
```

Send：

```
同一次 body encoder 创建 boundary
同一 boundary 同时写入 body 和 Content-Type
```

真实 echo test 必须确认二者一致。

## 5.8 suppression

Body Content-Type 和 client-default Accept 可 suppression。

例如：

```
[
  { name:'content-type', source:'body' },
  { name:'accept', source:'client-default' },
]
```

同名用户 Header 出现时：

```
用户 Header 仍最高优先级
suppression 记录不删除
```

以后删除用户 Header：

```
旧 suppression 继续生效
```

Auth/runtime 不提供 checkbox。

## 5.9 Generated Header UI

Headers 页：

```
用户 Header
────────────────────────
现有 KeyValueTable

自动生成 3 项
发送前 2 项 · 运行时 1 项
────────────────────────
Content-Type  application/json     来自 Body
Accept        */*                  客户端默认值
Host          发送时计算           运行时
```

默认折叠。

状态可见：

```
启用
已停用
被用户值覆盖
发送时计算
```

Auth secret：

```
Authorization  ••••••••  来自 Auth
```

其 DOM、`aria-label`、tooltip 都不得包含真实值。

点击：

```
来自 Body       → editorTab='body'
来自 Auth       → editorTab='auth'
来自客户端默认值 → 只说明，不跳
运行时          → 只说明，不跳
```

## 5.10 安全 Copy URL / cURL

### Copy URL

保留普通未解析变量：

```
{{tenant}}
```

secret 环境变量：

```
<redacted>
```

### cURL

POSIX 单引号：

```
'abc'\''def'
```

包含：

- method；
- URL；
- enabled 用户 Header；
- Body；
- active、安全可复制的自动项。

必须 redacted：

- Authorization；
- Cookie；
- API Key；
- SecretRef；
- secret 环境变量；
- 敏感 Header 字面量。

普通非敏感用户 Header / Body 字面量按用户主动复制行为允许进入系统剪贴板。

clipboard write 失败：

```
中文 toast
不改变树选择
```

---

# 6. 请求树与侧栏 UI 详细设计

## 6.1 TreeItem 稳定结构

始终存在的布局槽：

```
[expand-slot 14px]
[type/method-slot]
[name flex-1]
[state-slot fixed]
```

删除：

```
hover => mount buttons
```

所有操作进入 Context Menu。

名称区域 hover 前后宽度差：

```
<= 0.5 CSS px
```

视觉缩进：

```
visualDepth = Math.min(logicalDepth, 6)
```

逻辑嵌套不受限制。

空 Collection/Folder：

```
expand slot 保留宽度
不显示 ▸/▾
```

因此名称仍不跳动。

## 6.2 左键

Collection / Folder：

```
selected = node
toggle
```

Request：

```
selected = node
open/activate tab
```

右键：

```
selected = node
不开 Request
不 toggle
```

空白区：

```
clear selection
close context menu
```

## 6.3 Context Menu

使用：

```
createPortal(..., document.body)
```

这是当前 DSH client runtime 已提供的 `react-dom`，不是新增 runtime dependency；tsup 已将 `react-dom` 列为 runtime external。

定位：

```
position: fixed
API Client visible rect 内至少 4px margin
右/下空间不够则向左/上翻
高度仍不足 => max-height + overflow-y:auto
```

菜单顺序：

```
创建
编辑
复制/粘贴
导出文本
危险操作
```

动作矩阵严格按 UX §4.4。

菜单关闭：

- outside click；
- Esc；
- tree scroll；
- window resize；
- pane switch/unmount；
- action success；
- action fail。

### Menu keyboard

```
ArrowDown / ArrowUp
Home / End
Enter
Esc
```

打开时：

```
focus first enabled item
```

关闭：

```
focus return origin tree row
```

## 6.4 行内重命名

`F2` / Context Menu → TreeItem 本地 editing。

状态：

```
renameDraft
renamePending
renameError
```

Enter：

```
trim 后非空 => await Host
```

Esc：

```
恢复原名
```

blur：

```
非空 => submit
空/纯空格 => 取消并恢复
```

Host fail：

```
保持输入框
保留 renameDraft
显示中文错误
```

同一时间只有一个 TreeItem editing。

## 6.5 Paste enablement

Client 可静态判断：

| clipboard | root | Collection | Folder | Request |
| --- | --- | --- | --- | --- |
| Copy Collection | ✓ | ✓ | × | × |
| Copy Folder | × | ✓ | ✓ | × |
| Copy Request | × | ✓ | ✓ | ✓ |
| Cut Request | × | ✓ | ✓ | ✓ |

禁用 tooltip 使用中文具体原因，例如：

```
当前剪贴板内容只能粘贴到 Collection 或 Folder
```

## 6.6 Resize

### normal：viewport >= 706

```
min = 220
max = min(520, viewportWidth - 480 - 6)
rendered = clamp(preferred, min, max)
```

### compact：526–705

```
min = 160
max = viewportWidth - 360 - 6
rendered = clamp(preferred, min, max)
```

### hidden：<526

docked pane：

```
width=0
不可交互
但 React tree 不卸载
```

显示：

```
“展开请求树”
```

点击后 overlay：

```
width = min(320, viewportWidth - 32)
```

Tree 保持同一 React 实例，以保留：

- query；
- expanded state；
- searchCollapsed；
- selected row；
- rename state。

主编辑器永不因 resize 改变 React key 或条件卸载。

## 6.7 Separator

```
6px hit target
role=separator
aria-orientation=vertical
aria-valuenow
aria-valuemin
aria-valuemax
tabIndex=0
```

Pointer：

```
pointerdown => setPointerCapture
pointermove => rendered only
pointerup/lostcapture => preferred + persist
pointercancel => restore drag start; no persist
```

Double click：

```
260px
立即更新
立即持久化
```

Keyboard：

```
←/→       10px
Shift+←/→ 40px
```

连续键盘操作：

```
300ms debounce persist
```

保存失败：

```
当前会话宽度不回滚
中文非阻断 toast
```

## 6.8 Drawer focus

打开：

```
focus 搜索框
```

Tab/Shift+Tab：

```
限制在 drawer
```

关闭条件：

- Esc；
- backdrop；
- 关闭按钮；
- 打开 Request。

Collection/Folder toggle 不关闭。

关闭：

```
focus “展开请求树”
```

drawer open 时 resize >=526：

```
直接转 docked
不 remount
保留当前 focus
```

docked 缩到 `<526`：

```
drawer 默认关闭
focus 回展开按钮
```

---

# 7. 删除、dirty tab 与一致性

## 7.1 删除统计

### Request

```
“确定删除请求「xxx」？”
```

### Folder

递归计算：

```
descendantFolderCount
requestCount
dirtyTabCount
```

目标 Folder 本身不计入“子 Folder 数”。

### Collection

显示：

```
递归 Request 总数
dirtyTabCount
```

## 7.2 dirty

存在 affected dirty tabs：

按钮：

```
删除并放弃修改
```

否则：

```
删除
```

取消按钮默认 focus。

Esc、X：

```
取消
```

## 7.3 Host 成功后才能更新 tab

禁止：

```
void deleteRequest()
closeTab()
```

当前代码存在该顺序，需要改掉。

正确：

```
const result = await deleteRequest()

if (result.committed && result.refreshed) {
  close affected tabs
}
```

Host fail：

```
tree unchanged
tabs unchanged
activeKey unchanged
```

Host success、refresh fail：

```
Host 数据已删
客户端 tree stale
affected tab 应关闭
```

原因：Host mutation 已确认提交，不能继续让已不存在的 saved tab 假装存在。

同时：

```
toast “数据已保存，列表刷新失败”
tree stale
```

## 7.4 active tab 算法

`tab-lifecycle.ts` 纯函数：

```
removeTabsAndSelectNext(
  tabs,
  activeKey,
  removedKeys
)
```

如果 active 未删：

```
保持 active
```

active 被删：

```
1. old active index 左侧最近的 surviving tab
2. 没有则右侧第一个 surviving tab
3. 都没有 => undefined
```

## 7.5 单独关闭 dirty tab

RequestTabs 的 `onClose` 不直接关闭。

clean：

```
立即关闭
```

dirty：

```
打开 DirtyTabCloseDialog
```

默认 focus：

```
取消
```

确认：

```
关闭并放弃修改
```

P0 不自动 Save。

---

# 8. 测试方案

## 8.1 自动化测试

要求完整覆盖 UX §10.1 的 14 项。

| # | 测试文件 → 用例名 | 断言要点 |
| --- | --- | --- |
| 1 | `tests/p0-collection-tree.spec.ts` → `hover_does_not_change_name_width` | mock `getBoundingClientRect`；hover 前后 name slot 差值 ≤0.5px；DOM 不出现旧 hover action buttons |
| 2 | `tests/p0-collection-tree.spec.ts` → `row_click_semantics` | Collection/Folder 整行 toggle；Request 只调用 open；右键不触发两者 |
| 3 | `tests/p0-collection-tree.spec.ts` → `initially_collapsed_and_global_toggle` | 初始所有可展开节点关闭；全部展开/收缩；空节点无箭头 |
| 4 | `tests/p0-collection-tree.spec.ts` → `search_uses_transient_expansion` | Request 命中显示祖先；Folder 名称命中全后代；搜索 toggle 只改 searchCollapsed；清除后恢复 ordinary state |
| 5 | `tests/p0-context-menu.spec.ts` → `menu_matrix_by_node_kind` | root/collection/folder/request 菜单动作精确；右键只 select |
| 6 | `tests/p0-context-menu.spec.ts` → `menu_close_focus_and_bounds` | Esc/outside/scroll/resize 关闭；4px margin；边缘翻转；超高菜单可滚动；Esc focus 回行 |
| 7 | `tests/p0-collection-tree.spec.ts` → `inline_rename_paths` | Enter、Esc、blur、blank、pending、防重复、Host fail 保持编辑 |
| 8 | `tests/p0-tree-core.spec.ts` + `tests/p0-host-tree-api.spec.ts` → `copy_and_cut_semantics` | Copy 全新 ID；collectionId/folderId 重写；来源删除后 Copy 仍可 paste；Cut 版本过期 409 且源不移动/token 不消费 |
| 9 | `tests/p0-tab-lifecycle.spec.ts` → `delete_statistics_and_failed_delete` | Folder/Collection 递归统计；dirty 数；Host reject 时 tree/tab 不变化 |
| 10 | `tests/p0-tab-lifecycle.spec.ts` → `delete_then_close_tabs_and_dirty_close_confirm` | Host 成功后再移除；active 左优先；dirty tab 单独关闭必须 confirm |
| 11 | `tests/p0-resizable-pane.spec.ts` + `tests/p0-sidebar-settings.spec.ts` → `resize_contract` | normal/compact min/max；pointer capture；cancel；双击 260；键盘 10/40；300ms save；hidden/drawer；reload preference |
| 12 | `tests/p0-request-plan.spec.ts` + `tests/p0-generated-items-ui.spec.ts` → `generated_headers_contract` | source/status/suppression；用户 Header 优先；case-insensitive；Auth mask；Generated 不落 `headers[]` |
| 13 | `tests/p0-request-plan.spec.ts` + `tests/p0-undici-wire.spec.ts` → `current_body_regression` | JSON/raw/form-data Text/urlencoded 切换；Content-Type；真实 multipart boundary 与 body 一致；无 P1 body 类型 |
| 14 | 现有 `tests/architecture-boundary.spec.ts` → 全部现有 case | client view/component/hook 无 DSH import；P0 新文件同样通过 |

### 8.1.1 必增 wire consistency test

`tests/p0-undici-wire.spec.ts` 启动本地 echo HTTP server。

必须至少验证：

```
user Content-Type > body Content-Type
user Authorization > Auth contribution
suppressed Accept 不发送
suppressed Body Content-Type 不发送
Query API Key 被用户同名 query 覆盖
重复用户 Header 的实际 undici 行为
multipart boundary == body 使用的 boundary
```

Preview 与 resolved plan 对比时：

```
普通值逐项一致
secret 值先按 redaction 归一化后比较
```

不得拿 `••••••••` 与 wire secret literal 直接判“不一致”。

### 8.1.2 runtime Header capability test

同一测试文件验证 `undici@^8.10.2` 在当前调用方式对：

```
Host
Content-Length
Accept-Encoding
```

的实际行为。

只有测试证明属于客户端真实运行时行为的条目才能加入 UI runtime catalog。

禁止因为“通常 HTTP 会这样”就硬编码展示。

## 8.2 浏览器验收

使用真实 DSH 运行态，完整覆盖 UX §10.2。

| 验收场景 | 浏览器断言 |
| --- | --- |
| 长 Collection + 深层 Folder hover | 行名称宽度不变化；主编辑器不跳 |
| 左键/右键 | Collection/Folder 左键整行 toggle；右键只出现菜单 |
| Request/Folder copy flow | Copy → Paste → Rename → Delete → reload，数据持久化正确 |
| sidebar resize | 最小/中间/最大；刷新恢复；拖动时编辑草稿、响应对象不丢 |
| narrow viewport | 705/706、525/526 临界值行为正确；overlay drawer 可键盘操作 |
| Body Generated Header | JSON/raw/form-data/urlencoded 即时更新来源与状态 |
| user Content-Type override | 自动行显示“被用户值覆盖”；echo 服务只收到用户值 |
| Auth safety | DOM/ARIA/tooltip/History/host log/Agent context 搜索真实 token 均无命中 |
| menu edges | 左上/右上/左下/右下均完整可操作 |
| theme | 浅色/深色可读，不出现硬编码不可见样式 |
| keyboard tree | ↑↓←→、Home/End、Enter/Space、F2、Shift+F10、Ctrl/Cmd C/X/V、Delete |
| destructive flow | dirty Folder/Collection 删除提示正确；Cancel 默认 focus |
| refresh failure | 模拟 mutation 成功、GET collections 失败，UI 明确 stale 且不谎称 rollback |

---

# 9. 验收标准

以下 AC 连续编号，任何一项失败均不得宣称 P0 完成。

- **AC-01**：hover 前后 TreeItem 名称区宽度差不超过 `0.5 CSS px`，旧 hover action button 不再挂载。
- **AC-02**：Collection/Folder 空节点无伪箭头；深层缩进达到视觉上限后名称区不继续缩窄。
- **AC-03**：首次打开页面所有 Collection/Folder 默认收缩，reload 后恢复默认收缩。
- **AC-04**：Collection/Folder 整行左键先选择再 toggle；Request 左键只打开/激活请求。
- **AC-05**：搜索覆盖 Collection、Folder、Request name 与原始 URL，trim 后 Unicode lowercase 原始子串匹配。
- **AC-06**：搜索祖先临时展开；`searchCollapsed` 与普通展开状态互不污染；清除搜索恢复原状态。
- **AC-07**：搜索期间“全部展开/全部收缩”不可执行，并有中文说明。
- **AC-08**：Context Menu 的 root/Collection/Folder/Request 动作矩阵与 UX §4.4 完全一致。
- **AC-09**：右键不打开 Request、不 toggle Folder；菜单靠四边仍完整位于 API Client 可视区域内至少 4px。
- **AC-10**：菜单满足 role、焦点进入/返回、Arrow/Home/End/Enter/Esc 键盘契约。
- **AC-11**：Tree 行满足完整 ↑↓←→、Home/End、Enter/Space、F2、Shift+F10、Cmd/Ctrl+C/X/V、Delete/Backspace、Esc 契约。
- **AC-12**：行内 rename 空值不提交；失败保持编辑态及输入；同一时间只有一个节点编辑。
- **AC-13**：Client clipboard 仅持 token、operation、kind、expiresAt，不持权威节点 snapshot。
- **AC-14**：Host Copy snapshot 只存在内存，30 分钟 TTL，不写磁盘；源删除后仍能 Paste。
- **AC-15**：Copy Collection/Folder/Request 所有结构 ID 全新，Request `collectionId/folderId` 正确重写。
- **AC-16**：Copy 命名稳定使用“名称 副本”“名称 副本 2”…；Cut 保留原名。
- **AC-17**：Cut 仅支持 Request；Collection/Folder Cut 无入口并有中文原因。
- **AC-18**：Cut Paste 对 source Request/source Collection/target Collection 全部版本校验；冲突返回 409 且不移动、不消费 token。
- **AC-19**：所有 Paste 目标合法性严格遵循 UX §4.6 矩阵。
- **AC-20**：跨 Collection Cut Request 只执行一次 collections 文件原子写入，不存在半移动状态。
- **AC-21**：mutation Host 失败时 tree/tab 保持原状态。
- **AC-22**：mutation 已成功而 refresh 失败时显示“数据已保存，列表刷新失败”，树进入 stale，并禁止后续 mutation 直到 refresh 成功。
- **AC-23**：Request 删除只有 Host 成功后才能关闭对应 tab。
- **AC-24**：Folder/Collection 删除确认显示正确递归统计和 dirty tab 数。
- **AC-25**：dirty affected tabs 时确认按钮为“删除并放弃修改”；取消默认获得焦点。
- **AC-26**：删除 active tab 后优先选择左侧最近存活 tab，无左侧才选择右侧第一个。
- **AC-27**：单独关闭 dirty tab 必须确认；clean tab 可直接关闭。
- **AC-28**：normal sidebar 宽度严格符合 `220..min(520, viewport-486)`。
- **AC-29**：compact 严格为 `160..viewport-366`；`<526px` docked tree 自动隐藏。
- **AC-30**：极窄 drawer 宽度为 `min(320, viewport-32)`，覆盖主区、不重挂载 editor。
- **AC-31**：resize 拖动使用 pointer capture；pointercancel 恢复起点且不持久化。
- **AC-32**：separator 双击恢复 260；键盘 10px/Shift 40px；有正确 separator ARIA。
- **AC-33**：`collectionSidebarWidth` profile 持久化，默认 260；保存失败仅 toast，不回滚内存宽度。
- **AC-34**：拖动/compact/drawer 切换期间 Request draft、response、active tab 不丢失。
- **AC-35**：Headers 页分用户项和 Generated Header，标题显示“发送前 N 项 · 运行时 M 项”。
- **AC-36**：Body/client-default Generated Header 可 suppression，Auth/runtime 不可从 Headers 页 suppression。
- **AC-37**：用户 Header 大小写不敏感地覆盖同名 Generated Header；disabled 用户行不参与覆盖。
- **AC-38**：两个 enabled 同名用户 Header 均交给 transport，wire conversion 按 lowercase 聚合并保留第一行拼写。
- **AC-39**：Header API Key 与 Authorization Preview 恒为 `••••••••`，Auth 来源点击跳到认证区。
- **AC-40**：Query API Key 在 Params 的“Auth 自动参数”中显示，同名 enabled 用户 query 优先。
- **AC-41**：Preview 与 Send 使用同一 canonical `buildRequestPlan` 贡献/优先级/suppression primitive。
- **AC-42**：Authorization、Cookie、API Key、SecretRef、secret 环境变量真实值不进入 DOM、ARIA、tooltip、toast、console、History、Agent context。
- **AC-43**：“复制 URL/安全 cURL”按冻结 redaction 规则处理 secret；cURL 使用 POSIX 单引号转义。
- **AC-44**：无法可靠观测的运行时 Header 只显示“发送时计算”，不得伪造最终值。
- **AC-45**：当前 JSON/raw/Text-only form-data/urlencoded Body 的 Content-Type 与真实 wire 行为回归通过，multipart boundary 与实际 body 一致。
- **AC-46**：P0 新增/扩展 API 只使用 §8.3 指定路径与现有明确资源端点，不引入第二套通用 mutation API。
- **AC-47**：所有 P0 新增用户可见文案为中文。
- **AC-48**：现有 `tests/architecture-boundary.spec.ts` 全绿，任何 client view/component/hook 不直接 import DSH。
- **AC-49**：`pnpm test` 全绿、`pnpm exec tsc --noEmit` 0 错误、`pnpm build` 成功。
- **AC-50**：`package.json` 不增加新的 runtime dependency。
- **AC-51**：P1 的 raw subtype、File form-data、binary、Bulk Edit、Undo、Cookie Jar、drag reorder 均未出现在 P0 UI 或代码合同中。

---

# 10. 并行实施拆分 Plan

物理工作包按“文件所有权绝不相交”划分；实施批次与物理包不是一一对应关系。

## WP0 — Shared P0 Contract Foundation

**复杂度：S**
**Wave：0，必须最先完成**

### 目标

冻结所有后续智能体共同消费的 Shared 类型。

### UX

§4.6、§5、§6、§8.2、§8.3。

### 独占文件

```
packages/shared/src/types.ts
```

### 必须定义

```
SuppressedGeneratedHeader
GeneratedHeaderPreview
GeneratedQueryPreview
RequestPlanPreview
TreeClipboardDescriptor
TreePasteResult
PluginSettings.collectionSidebarWidth
```

### 前置

无。

### 完成定义

- 类型能同时满足 Tree/Host/Header/Resize；
- 不包含 Host snapshot 结构；
- `suppressedGeneratedHeaders` 兼容旧数据。

### 自测

```
pnpm exec tsc --noEmit
```

断言：无新增 TS error。

---

## WP1 — Tree Core Operations

**复杂度：M**
**Wave：1，可与 WP2/WP4/WP6 并行**
**依赖：WP0**

### 目标

完成不含 I/O 的树结构操作。

### UX

§4.6、§4.7、§8.2。

### 独占文件

```
packages/core/src/collection/ops.ts
tests/p0-tree-core.spec.ts
```

### 实现

- Folder create/rename/delete helpers；
- Folder snapshot deep copy；
- Collection snapshot deep copy；
- Request snapshot copy；
- Request 跨 Collection move；
- insert-after-request；
- stable copy name；
- descendant statistics；
- version predicate helper。

### 不负责

- token；
- FileStore；
- API；
- React。

### 自测

```
pnpm test -- tests/p0-tree-core.spec.ts
pnpm exec tsc --noEmit
```

断言：新 ID、引用重写、排序矩阵、copy name、source/target 不被 mutation。

---

## WP2 — Canonical Request Plan + Execution

**复杂度：L**
**Wave：1，可与 WP1/WP4/WP6 并行**
**依赖：WP0**

### 目标

把 Preview/Send 的 Header/Auth/Body/Query 合并统一到 canonical plan。

### UX

§6.2–§6.4、§8.2、§9、§10.1-12/13。

### 独占文件

```
packages/core/src/request/plan.ts
packages/core/src/request/build.ts
packages/core/src/request/body.ts
packages/core/src/variables/resolver.ts
packages/core/src/auth/apply.ts
packages/core/src/executor/executor.ts
packages/core/src/executor/http-client.ts
packages/core/src/index.ts
src/host/services/execution-service.ts
tests/p0-request-plan.spec.ts
tests/p0-undici-wire.spec.ts
```

### 基础汇聚文件

`packages/core/src/index.ts` 只归本包。

WP1 不需要修改 index，因为 `collection/ops.ts` 已被现有 index export。

### 完成定义

- `buildRequestPlan` 唯一合并 primitive；
- executor 不再形成第二套 Auth append；
- user header precedence；
- Query API Key precedence；
- suppression；
- redacted preview；
- real echo wire test；
- runtime Header catalog 经真实 test 固化。

### 自测

```
pnpm test -- tests/p0-request-plan.spec.ts tests/p0-undici-wire.spec.ts
pnpm exec tsc --noEmit
pnpm build
```

---

## WP3 — Host Tree Mutation & Clipboard API

**复杂度：L**
**Wave：2**
**依赖：WP0 + WP1**

### 目标

完成 Folder CRUD、clipboard 与跨 Collection 原子 mutation。

### UX

§4.4–§4.7、§8.3、§9。

### 独占文件

```
src/host/services/collection-service.ts
src/host/services/tree-clipboard-service.ts
src/host/api/folders.ts
src/host/api/tree-clipboard.ts
src/host/api/requests.ts
src/host/index.ts
tests/p0-host-tree-api.spec.ts
```

### `src/host/index.ts` 汇聚责任

本包唯一负责：

```
TreeClipboardService construct
HostServices field
registerFolderRoutes
registerTreeClipboardRoutes
```

其他包禁止编辑 `src/host/index.ts`。

### 完成定义

- 路径完全按 §8.3；
- token random/profile-bound/30m/memory-only；
- copy snapshot；
- cut reference；
- single-write cross collection transaction；
- 400/404/409；
- API response 无 snapshot。

### 自测

```
pnpm test -- tests/p0-host-tree-api.spec.ts
pnpm exec tsc --noEmit
pnpm build
```

---

## WP4 — Sidebar Resize & Settings

**复杂度：M**
**Wave：1，可与 WP1/WP2/WP6 并行**
**依赖：WP0**

### 目标

实现 resize/compact/hidden/drawer 与 settings。

### UX

§5、§8.1。

### 独占文件

```
src/host/services/settings-service.ts
src/client/hooks/useCollectionSidebarWidth.ts
src/client/components/collection/ResizableCollectionPane.tsx
tests/p0-resizable-pane.spec.ts
tests/p0-sidebar-settings.spec.ts
```

### 消费

现有：

```
GET/PATCH /settings
```

不新增 settings API。

### 完成定义

- 所有临界宽度；
- pointer/keyboard/double click；
- drawer focus trap；
- 220–520 preference；
- save failure 非阻断。

### 自测

```
pnpm test -- tests/p0-resizable-pane.spec.ts tests/p0-sidebar-settings.spec.ts
pnpm exec tsc --noEmit
```

---

## WP5 — Tree Client Interaction

**复杂度：L**
**Wave：3**
**依赖：WP0 + WP3**

### 目标

完整请求树桌面交互，不碰最终主页面汇聚。

### UX

§4.1–§4.6、§8.1、§9。

### 独占文件

```
src/client/hooks/useHostApi.ts
src/client/hooks/useCollections.ts
src/client/hooks/useTreeClipboard.ts
src/client/components/collection/tree-projection.ts
src/client/components/collection/CollectionTree.tsx
src/client/components/collection/TreeItem.tsx
src/client/components/collection/TreeContextMenu.tsx
src/client/components/collection/TreeCreateDialog.tsx
tests/p0-collection-tree.spec.ts
tests/p0-context-menu.spec.ts
```

### 完成定义

- default collapse；
- search；
- keyboard；
- inline rename；
- Context Menu；
- clipboard；
- stale；
- no hover actions。

### 自测

```
pnpm test -- tests/p0-collection-tree.spec.ts tests/p0-context-menu.spec.ts
pnpm exec tsc --noEmit
```

---

## WP6 — Destructive & Tab Lifecycle

**复杂度：M**
**Wave：1，可与 WP1/WP2/WP4 并行**
**依赖：WP0**

### 目标

把删除/dirty/active tab 逻辑做成独立可消费模块。

### UX

§4.7、§9。

### 独占文件

```
src/client/components/common/Modal.tsx
src/client/components/collection/TreeDeleteConfirmDialog.tsx
src/client/components/request/tab-lifecycle.ts
src/client/components/request/DirtyTabCloseDialog.tsx
tests/p0-tab-lifecycle.spec.ts
```

### 完成定义

- delete statistics；
- cancel default focus；
- dirty wording；
- active selection pure function；
- Modal accessibility 文案中文。

### 自测

```
pnpm test -- tests/p0-tab-lifecycle.spec.ts
pnpm exec tsc --noEmit
```

---

## WP7 — Generated Header / Params Client

**复杂度：M**
**Wave：2，可与 WP3 并行**
**依赖：WP0 + WP2**

### 目标

消费 canonical preview，在 Headers/Params 显示安全 Generated Items。

### UX

§6、§8.1。

### 独占文件

```
src/client/hooks/useRequestPlanPreview.ts
src/client/components/request/GeneratedItemsSection.tsx
src/client/components/request/HeadersEditor.tsx
src/client/components/request/ParamsEditor.tsx
tests/p0-generated-items-ui.spec.ts
```

### 完成定义

- Header 两层；
- pre-send/runtime count；
- suppression checkbox；
- Auth mask；
- Query API Key；
- preview error 不阻断编辑。

### 自测

```
pnpm test -- tests/p0-generated-items-ui.spec.ts
pnpm exec tsc --noEmit
```

---

## WP8 — Final ApiClientView Integration

**复杂度：L**
**Wave：4，最后执行**
**依赖：WP3 + WP4 + WP5 + WP6 + WP7**

### 目标

只做汇聚，不重新实现子包算法。

### UX

§4.7、§5、§6、§8.1、§9、§10。

### 独占文件

```
src/client/views/ApiClientView.tsx
tests/p0-api-client-integration.spec.ts
```

### 本包负责

- `ResizableCollectionPane` 挂入主布局；
- CollectionTree handlers；
- create dialog；
- delete dialog；
- dirty close；
- saved tab 更新；
- generated preview；
- suppression 写入 draft；
- Body/Auth source navigation；
- Host mutation 后 tab lifecycle；
- 主界面 P0 文案中文化；
- 保证 resize 不改变 editor key。

### 禁止

在 `ApiClientView.tsx` 再实现：

```
paste legality matrix
request-plan priority
tree projection search
sidebar clamp math
tab-selection algorithm
```

这些必须消费前序包。

### 自测

```
pnpm test -- tests/p0-api-client-integration.spec.ts
pnpm test
pnpm exec tsc --noEmit
pnpm build
```

---

## 10.1 Wave 依赖图

```
Wave 0
└── WP0 Shared Contracts

Wave 1
├── WP1 Tree Core
├── WP2 Request Plan + Execution
├── WP4 Sidebar Resize
└── WP6 Destructive / Tab

Wave 2
├── WP3 Host Tree API      ← WP1
└── WP7 Generated UI       ← WP2

Wave 3
└── WP5 Tree Client        ← WP3

Wave 4
└── WP8 ApiClientView Integration
    ← WP4 + WP5 + WP6 + WP7
```

Wave 1 四包可全并行。

Wave 2 两包可并行。

## 10.2 汇聚文件唯一归属

| 汇聚文件 | 唯一所有者 | 其他包如何消费 |
| --- | --- | --- |
| `packages/shared/src/types.ts` | WP0 | 所有包只 import |
| `packages/core/src/index.ts` | WP2 | WP7/WP8 从 `@dsh-api-client/core` import plan |
| `src/host/index.ts` | WP3 | 其他 Host 包不触碰装配 |
| `src/client/hooks/useHostApi.ts` | WP5 | 其他 Client 包直接消费稳定 API |
| `src/client/components/common/Modal.tsx` | WP6 | WP8 只使用 |
| `src/client/views/ApiClientView.tsx` | WP8 | 所有前序包禁止修改 |
| `vitest.config.ts` | 无人修改 | 新测试沿用现有扫描 |
| `tsup.config.ts` | 无人修改 | 不增加 external/runtime 模块 |
| `package.json` | 无人修改 | P0 零新增 runtime dependency |

---

# 11. 运行时依赖预算

当前 root runtime dependency 只有既有的：

```
@deepseek-ai/schemastery
undici
```

React 为 peer；ReactDOM 已在 DSH client runtime module table 中提供。

## 11.1 P0 新增依赖

| 类型 | 新增 |
| --- | --- |
| npm runtime dependency | 0 |
| 原生模块 | 0 |
| 系统包 | 0 |
| 外部数据库 | 0 |
| 第三方 SaaS | 0 |
| 后台 daemon | 0 |
| 新网络服务 | 0 |

## 11.2 使用的已有能力

浏览器：

```
ResizeObserver
Pointer Events
setPointerCapture
navigator.clipboard
document/window events
React portal
```

Node：

```
crypto.randomUUID()
structuredClone()
FileStore
undici
```

均不需要安装新包。

## 11.3 内网/离线部署影响

无：

```
npm 新下载项
CDN
远程字体
远程脚本
云端 clipboard 服务
远程状态存储
```

插件仍可按当前 pnpm/DSH 打包方式离线部署。

`react-dom` portal 不改变 dependency budget，因为当前 client build 已将 `react-dom` 作为 DSH runtime external，而不是本轮新增模块。

## 11.4 不采用的替代方案

不引入：

```
react-resizable-panels
floating-ui
radix context-menu
zustand/redux
zod
clipboard library
uuid library
focus-trap library
```

原因：现有 P0 行为可用浏览器/React 原语完整实现，引入依赖会增加内网包供应、离线安装和 bundle 风险。

---

# 12. 实施批次与验收门禁

工作包按文件隔离，批次按用户可见行为验收。

## 批次 1：树稳定行、默认状态、全局展开、Resize

范围：

```
稳定 TreeItem
默认全收缩
普通展开状态
全部展开/收缩
ResizableCollectionPane
collectionSidebarWidth
```

完成定义：

- AC-01～AC-07；
- AC-28～AC-34；
- 无 editor remount。

门禁：

```
pnpm test -- tests/p0-collection-tree.spec.ts tests/p0-resizable-pane.spec.ts tests/p0-sidebar-settings.spec.ts
pnpm exec tsc --noEmit
```

## 批次 2：Context Menu、Rename、Keyboard

范围：

```
右键菜单
focus
edge flip
键盘树
行内 rename
create dialogs
```

完成定义：

- AC-08～AC-12；
- 浏览器四边菜单；
- Shift+F10 可用。

门禁：

```
pnpm test -- tests/p0-context-menu.spec.ts tests/p0-collection-tree.spec.ts
pnpm exec tsc --noEmit
```

## 批次 3：Folder/跨容器 Host Mutation + Clipboard

范围：

```
Folder CRUD
Copy
Cut Request
Paste
跨 Collection move
409
stale refresh
```

完成定义：

- AC-13～AC-22；
- 一次 paste 一次原子写；
- snapshot 不出 Host。

门禁：

```
pnpm test -- tests/p0-tree-core.spec.ts tests/p0-host-tree-api.spec.ts
pnpm exec tsc --noEmit
pnpm build
```

## 批次 4：删除与 Tab 一致性

范围：

```
delete statistics
dirty confirm
success-before-close
active selection
dirty tab close
```

完成定义：

- AC-23～AC-27；
- Host fail 零 UI destructive update。

门禁：

```
pnpm test -- tests/p0-tab-lifecycle.spec.ts tests/p0-api-client-integration.spec.ts
pnpm exec tsc --noEmit
```

## 批次 5：Generated Header Plan + UI + 总验收

范围：

```
buildRequestPlan
Auth precedence
suppression
Generated Header
Auth Query
safe cURL
wire integration
security
```

完成定义：

- AC-35～AC-51；
- UX §10.1 14 项全部覆盖；
- §10.2 浏览器验收全部完成。

最终门禁：

```
pnpm test
pnpm exec tsc --noEmit
pnpm build
```

基线 19 spec / 209 tests 必须保持全绿，并新增本轮测试；禁止通过删除或放宽原测试换取通过。

---

# 13. 关键事件流

## 13.1 Copy → Paste

```
右键 Request → 复制
  ↓
POST /tree/clipboard/copy
  ↓
Host 从 CollectionService 读取权威 Request
  ↓
structuredClone
  ↓
Host memory Map[token]
  ↓
Client 得到 token/kind/expiresAt
  ↓
右键目标 Folder → 粘贴
  ↓
Client 检查矩阵 + expiresAt
  ↓
POST /tree/clipboard/:token/paste
  ↓
Host 验 target updatedAt
  ↓
Core deep-copy + new ids
  ↓
一次 FileStore.writeJson
  ↓
200
  ↓
GET /collections
  ↓
刷新 tree
```

## 13.2 Cut Request 跨 Collection

```
Ctrl+X
  ↓
POST /tree/clipboard/cut
(requestId + source versions)
  ↓
Host 不移动任何数据
  ↓
token
  ↓
Paste target
  ↓
Host 再验证：
request.updatedAt
sourceCollection.updatedAt
targetCollection.updatedAt
  ↓
一次性生成 nextSource + nextTarget
  ↓
一次 FileStore.writeJson
  ↓
成功后消费 token
```

## 13.3 Delete

```
Delete
  ↓
Client 根据当前 projection 统计 subtree + dirty tabs
  ↓
Confirm
  ↓
await DELETE Host
  ├─ fail → 什么都不动
  └─ success
       ↓
     移除 affected tabs
       ↓
     active tab pure selection
       ↓
     await refresh tree
       ├─ success → normal
       └─ fail → stale
```

## 13.4 Header Preview → Send

```
Request draft
  ↓
buildRequestPlan(mode=preview)
  ↓
safe GeneratedHeaderPreview
  ↓
Headers/Params UI


同一 Request
  ↓
buildRequestPlan(mode=resolved)
  ↓
ResolvedRequest
  ↓
permission
  ↓
network policy
  ↓
undici
```

不允许：

```
HeadersEditor 自己重新推导一遍 Auth/Header precedence
```

---

# 14. 实施智能体须知

每个 ZCode 子代理拿到本设计后，必须严格遵守自己的工作包文件所有权。

仓库标准命令：

```
pnpm test
pnpm exec tsc --noEmit
pnpm build
```

各包先跑本包指定 targeted test，完成后再跑 `tsc`。最终集成包跑全量三门禁。

严禁：

```
commit
push
修改其他工作包独占文件
删除既有测试
skip/only 屏蔽失败测试
降低 architecture-boundary 门禁
在 client view/component/hook import DSH 包
为了方便新增第二套通用 tree mutation API
把 Host clipboard snapshot 下发给 Client
把 SecretRef 解析值写进浏览器状态或日志
用 optimistic delete/move 后再等待 Host
为了 P0 顺手实现 P1/P2
新增 runtime dependency
```

遇到实现与 UX 冲突时：

```
停止自行改需求语义
记录冲突
以本设计第 0 节 + 原 UX 冻结条款为依据处理
```

特别注意：当前仓库 `CollectionTree`、`TreeItem`、`ApiClientView`、`applyAuth`、`http-client` 的现状均只是“待改基线”，不得因为已有实现方便而降低 P0 语义。现有 Client/Host 分层与安全 redaction 边界则必须继续保持。

**最终完成判定只有一个：AC-01～AC-51 全部通过 + 全量 **`pnpm test`** / **`tsc --noEmit`** / **`pnpm build`** 三门禁通过，才可进入用户验收。**
