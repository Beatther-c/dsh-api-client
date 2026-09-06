# dsh-api-client 完整设计方案 V1.1（正式修订版）

> 项目：`dsh-api-client`  
> 定位：DeepSeek Harness 原生 API Client 插件  
> 目标：Human UI + Agent Tools 共用同一套 API Client Core  
> 版本：V1.1 正式修订版
> 修订原则：以已核验的 DSH Slot System、社区插件注入实践和 dsh-workbench 已拍板决策为准

---

## 1. 项目目标

`dsh-api-client` 是一个独立、可开源、可安装/卸载的 DSH 原生插件，不属于 dsh-workbench 私有实现。

它的目标不是完整复刻 Postman，而是提供：

- 接近 Postman 的 API 调试体验；
- 一级兼容 Postman Collection v2.1；
- 原生集成 DSH Web UI；
- Human UI；
- Agent HTTP/API Tools；
- Human 与 Agent 共用 Collection、Environment、History、HTTP Executor；
- 后续由 dsh-workbench 像加载其他插件一样加载。

一句话定义：

> **Agent-native API Client for DeepSeek Harness。**

---

## 2. 核心架构原则

```text
                   dsh-api-client
                         │
            ┌────────────┴────────────┐
            │                         │
         Human UI                  Agent Tools
            │                         │
            └────────────┬────────────┘
                         │
                  API Client Core
                         │
        ┌────────────────┼─────────────────┐
        │                │                 │
   Collection       Environment      HTTP Executor
        │                │                 │
        └────────────────┼─────────────────┘
                         │
                      History
                         │
                         ▼
                    Target API
```

### 冻结原则

1. DSH 原生优先；
2. 不重画 DSH 外壳；
3. 不 iframe 嵌入完整第三方 API Client；
4. UI 信息架构参考 Postman；
5. 视觉风格跟随 DSH；
6. Human 与 Agent 共用 Core；
7. 自行实现 HTTP Executor；
8. 不依赖 `dsh-http`；
9. Host 为权威状态源；
10. DSH Adapter 单独隔离。

---

## 3. 与真实 DSH Web UI 的集成方式

DSH Web Client 已存在官方 Slot System。目标版本中 `ctx.slots.register(...)`、`ctx.slots.inject(...)`、`single/list/keyed/chain` cardinality 以及 `conversation.*`、`settings.plugin.item` 等能力应视为正式优先路径。

但 **并非所有我们需要的 UI 位置都有官方 Slot**。因此 `dsh-api-client` 的 UI 集成不按 DSH 版本做硬编码分支，而是按“能力是否存在”做 feature-detect。

### 3.1 Sidebar 导航区入口

目标位置：

```text
DSH Sidebar
│
├── 新建会话
│
├── API Client      ← dsh-api-client
│
├── Workspace / Sessions
│
└── Settings
```

当前核验结论：

- DSH Sidebar 本身属于官方 Layout；
- 但“New Session 下方的一级导航入口”当前没有对应的官方可增量 Slot；
- 官方可用的 Sidebar 插件席位主要是 footer 类入口，不能满足本产品原型；
- 因此该入口采用 **Legacy DOM Injection**；
- 参考已验证社区插件：纯 DOM 插入 + MutationObserver 自愈；
- React 重渲染造成节点移动/消失时，Adapter 负责恢复；
- 插件卸载时必须彻底移除 DOM 和 Observer。

行为：

- 宽 Sidebar：图标 + `API Client`；
- 折叠 Rail：只显示图标；
- Hover/Active 跟随 DSH Theme；
- 点击 Session 时 API Client active 状态自动取消；
- 与其他插件的同级 Panel 必须处理互斥。

### 3.2 主视图切换

主路径优先使用官方 `conversation` / conversation-family Slot 的替换能力。

```text
Conversation
    ↓ priority shadow / replacement
ApiClientView
```

候选实现：

```ts
ctx.slots.inject('conversation', () =>
  ctx.slots.register(
    { name: 'conversation', priority: API_CLIENT_PRIORITY },
    ApiClientView,
  ),
)
```

> 实际 slot key、owner props 与 priority 必须以目标运行时实时目录为准，不在设计阶段写死。

需要重点验证：

- `single` seat 的 shadow / replacement 是否会导致原 Conversation 子树 unmount；
- Host-authoritative session 能否完整恢复；
- 草稿、滚动位置、当前 view tab 等客户端 UX 状态是否可接受；
- 注销 API Client contribution 后是否立即恢复官方 occupant。

若官方替换路径 UX 不可接受，启用 **LegacyDomAdapter 的 CSS takeover fallback**：

```text
Conversation DOM 保持 mounted
         ↓
CSS hide
         ↓
Plugin panel show
```

这样可以尽量保留：

- Composer 草稿；
- Scroll position；
- 临时 Client state。

### 3.3 Settings / Conversation 增量扩展

以下能力优先使用官方 Slot，不使用 DOM hack：

```text
settings.plugin.item
conversation.session.header.actions
conversation.input.dock
conversation.composer.dock
conversation.input.left
conversation.input.right
conversation.view
```

例如：

- Settings 中注册 API Client 配置项；
- 后续可在 Conversation header 增加“返回 API Client”；
- 可在输入区增加当前 API Context 状态提示。

### 3.4 dsh-ui-adapter 双路径设计

```text
src/client/dsh-adapter/
├── feature-detect.ts
├── slot-adapter.ts
├── legacy-dom-adapter.ts
├── sidebar-injection.ts
├── panel-activation.ts
├── panel-mutual-exclusion.ts
├── theme-adapter.ts
└── session-bridge.ts
```

能力分流：

| 能力 | SlotAdapter | LegacyDomAdapter |
|---|---|---|
| Sidebar New Session 下方入口 | 不可用 | 主路径 |
| 主视图接管 | 主路径，M0 验证 UX | fallback |
| Settings | 主路径 | 不需要 |
| Conversation header/input 扩展 | 主路径 | 不需要 |
| 插件 Panel 互斥 | 与 Slot 生命周期联动 | DOM event / attribute 互斥 |
| Theme | 官方上下文/Token | CSS 变量 fallback |

### 3.5 探测策略

禁止只按 DSH 版本号判断。

采用：

```text
Feature Detect
+
Runtime Slot Catalog
+
Adapter Capability Matrix
```

优先探测：

```ts
ctx.slots?.register
ctx.slots?.inject
目标 slot declaration 是否存在
目标 slot kind/scope
目标 slot 当前 occupant / priority
```

开发与兼容性测试阶段使用 DSH 自带运行时检查能力生成真实 Slot/Client 目录，并把结果固化为 Compatibility Matrix。

### 3.6 不修改 DSH Core

无论 Slot 还是 DOM fallback，均遵守：

> Host-authoritative、out-of-tree plugin、zero DSH source patch。

禁止直接修改 DSH Web UI 源文件。

## 4. API Client 主页面

```text
┌──────────────────────────────────────────────────────────────┐
│ API Client                         History Import Environment│
├────────────────┬─────────────────────────────────────────────┤
│                │ Request Tab                                 │
│ Collections    ├─────────────────────────────────────────────┤
│                │ GET | URL                         Send Save │
│ Project A      ├─────────────────────────────────────────────┤
│ ├ User         │ Params Headers Auth Body Scripts Settings  │
│ │ ├ GET users  ├─────────────────────────────────────────────┤
│ │ ├ POST user  │ Request Editor                              │
│ │ └ DEL user   │                                             │
│ ├ Order        │                                             │
│ └ OpenAI       ├─────────────────────────────────────────────┤
│                │ Response       200 OK | 328ms | 2.1KB      │
│                ├─────────────────────────────────────────────┤
│                │ Body Headers Cookies Tests   Ask Agent     │
└────────────────┴─────────────────────────────────────────────┘
```

---

## 5. UI 风格

### 5.1 设计原则

交互模式参考 Postman：

- Collection Tree
- Request Tabs
- Method Selector
- URL Bar
- Send
- Params
- Headers
- Authorization
- Body
- Scripts
- Response Viewer
- Environment
- History

但视觉壳必须遵循 DSH。

> **信息架构参考 Postman，视觉语言跟随 DSH。**

### 5.2 Method 语义色

```text
GET      green
POST     orange
PUT      blue
PATCH    purple
DELETE   red
```

### 5.3 Theme

第一版优先适配 DSH 默认深色主题，所有 background / border / text / hover / selected / disabled 均由 DSH Theme Token 获取。

---

## 6. Collections

层级：

```text
Collection
├── Folder
│   ├── Folder
│   │   └── Request
│   └── Request
└── Request
```

V0.1 支持：

- Collection CRUD；
- Folder CRUD；
- Request CRUD；
- 重命名；
- 删除；
- 排序；
- 搜索；
- Duplicate；
- Import；
- Export。

---

## 7. Request Editor

### 7.1 HTTP Method

```text
GET
POST
PUT
PATCH
DELETE
HEAD
OPTIONS
```

### 7.2 URL

支持：

```text
https://api.example.com/users
{{base_url}}/users
```

变量优先级：

```text
Local > Environment > Collection
```

### 7.3 Params

| Enabled | Key | Value | Description |
|---|---|---|---|

支持：重复 Key、空值、URL 编码、启停、URL 双向同步。

### 7.4 Headers

支持：

- Header CRUD；
- Enable / Disable；
- 自动 Content-Type；
- 自动 Accept；
- Secret masking；
- 重复 Header。

### 7.5 Authorization

V0.1：

```text
No Auth
Bearer Token
Basic Auth
API Key
Inherit Auth From Parent
```

后续：

```text
OAuth 2.0
Digest
AWS Signature
```

### 7.6 Body

V0.1：

```text
None
raw
JSON
Text
form-data
x-www-form-urlencoded
```

JSON Editor 支持：format、validate、syntax highlight、error line、compact。

---

## 8. Response Viewer

显示：

```text
Status
Latency
Size
Headers
Cookies
Body
Tests
```

Body Mode：

```text
Pretty
Raw
Preview
```

V0.1 支持：JSON / Text / HTML / XML。

---

## 9. Environment

```ts
interface Environment {
  id: string
  name: string
  variables: Variable[]
}

interface Variable {
  key: string
  initialValue?: string
  currentValue: string
  secret: boolean
  enabled: boolean
}
```

典型环境：

```text
Development
Testing
Production
```

---

## 10. History 与审计

Human 与 Agent 共用一套执行历史，但 **History 只能保存脱敏后的执行快照**。

```ts
interface ExecutionHistory {
  id: string
  requestId?: string
  timestamp: number
  method: string
  displayUrl: string
  requestSnapshot: RedactedRequestSnapshot
  responseSnapshot: RedactedResponseSnapshot
  duration: number
  source: 'human' | 'agent' | 'runner'
  environmentId?: string
  profileId?: string
}
```

示例：

```text
10:23 GET  /users       Human
10:24 POST /users       Agent
10:25 GET  /users/1     Human
```

### 10.1 History Redactor

执行链：

```text
Resolved Request（仅执行期可含 secret）
          │
          ├── HTTP Executor
          │
          └── History Redactor
                  ↓
          Persisted History
```

默认脱敏：

```text
Authorization
Cookie
Set-Cookie
X-API-Key
Proxy-Authorization
```

同时必须处理：

- API Key 位于 Query；
- API Key 位于 URL；
- Bearer Token 位于 auth 配置；
- Basic Auth credentials；
- form/json body 中被标记为 secret 的变量；
- response 中被用户配置为敏感的字段。

History 不得成为 secret recovery source。

Agent 的 `api_client_get_last_response` 默认返回脱敏版本。

重新执行请求时应从：

```text
Saved Request
+
Environment secret reference
+
HTTP Executor
```

恢复，而不是从 History 读取密钥。

## 11. API Client Core

建议独立 package：

```text
packages/core
```

结构：

```text
core/
├── collection/
├── environment/
├── variables/
├── auth/
├── request/
├── response/
├── executor/
├── history/
├── import/
├── export/
└── security/
```

Human UI 与 Agent Tools 必须调用同一个 Core。

禁止：

```text
UI HTTP Client
+
Agent HTTP Client
```

---

## 12. HTTP Executor

建议基于 Node Fetch / Undici 能力实现。

接口：

```ts
execute(request, context): Promise<HttpExecutionResult>
```

执行流程：

1. Resolve variables
2. Apply auth
3. Build URL
4. Build headers
5. Build body
6. Permission check
7. Network policy check
8. Execute
9. Measure duration
10. Parse response
11. Persist history
12. Emit events

---

## 13. Agent Tools

所有工具使用 `api_client_*` 命名空间，避免与 `dsh-http` 或其他 HTTP 插件的全局工具名冲突。

### 13.1 `api_client_request`

临时请求。

```json
{
  "method": "GET",
  "url": "https://api.example.com/users",
  "headers": {},
  "query": {},
  "body": null,
  "environment": "Production"
}
```

### 13.2 `api_client_run_request`

运行 Collection 中保存的 Request。

### 13.3 `api_client_list_collections`

### 13.4 `api_client_list_requests`

### 13.5 `api_client_get_request`

### 13.6 `api_client_switch_environment`

### 13.7 `api_client_get_last_response`

默认只返回 redacted response/context。

### 13.8 Agent Tool 共用执行器

```text
Human Send ─────┐
                ├── HTTP Executor
Agent Tool ─────┘
```

不维护第二套 Agent HTTP Client。

### 13.9 与 dsh-http 的关系

`dsh-http` 保持独立社区插件身份，但不再承担 dsh-workbench / dsh-api-client 的核心 HTTP capability。

即使两者同时安装，也因为工具统一采用 `api_client_*` 命名而不发生工具名冲突。

## 14. Agent Context Bridge

Human UI 中保留：

```text
[交给 Agent]
```

插件不创建第二套聊天 UI，而是把当前 API 调试上下文安全地交给 DSH 原生 Session / Conversation。

### 14.1 原始上下文

```ts
interface ApiDebugContext {
  collection?: CollectionSummary
  request: ApiRequest
  resolvedRequest: ResolvedRequest
  response?: HttpExecutionResult
  environment?: Environment
  execution?: ExecutionMetadata
}
```

### 14.2 Context Redactor

**ApiDebugContext 不允许直接发送原始 environment / auth / secret。**

链路：

```text
API Client Runtime Context
          ↓
Context Redactor
          ↓
SafeApiDebugContext
          ↓
DSH Session / Model Provider
```

必须脱敏：

- Environment secret variables；
- Authorization/Cookie/API Key；
- URL/query 中的 secret；
- auth config；
- request/response 中用户声明的敏感字段；
- 任何 SecretRef 的解析值。

推荐输出：

```text
Authorization: Bearer <redacted>
api_key: <secret-ref:prod.api_key>
```

而不是明文。

### 14.3 会话桥接

M0 必须验证以下路径是否存在公开 API：

```text
API Client
 ↓
Create Session
 ↓
Activate Session
 ↓
Inject context / prefill composer
 ↓
Conversation
```

若“程序化上下文注入”不可用，则降级为：

```text
构建 SafeApiDebugContext
↓
创建/打开 Session
↓
Prefill Composer
↓
由用户确认发送
```

### 14.4 安全边界

点击“交给 Agent”属于数据出域动作。

UI 必须明确展示：

```text
将发送：
✓ Request metadata
✓ Response metadata/body（已脱敏）
✓ Environment 名称
✗ Secret 明文
```

对于被标记为敏感的 response body，默认不注入，需用户主动允许。

## 15. Postman Collection Adapter

独立 package：

```text
packages/postman-adapter
```

V0.1 一级支持：

```text
Postman Collection v2.1
```

### 15.1 完整支持

```text
Collection
Folder
Request
Method
URL
Query
Headers
Raw Body
JSON Body
Basic Auth
Bearer Auth
API Key
Variables
```

### 15.2 部分支持

```text
Pre-request Script
Tests
Dynamic Variables
OAuth2
```

V0.1 对 Postman Script：解析、检测、展示、警告，但不执行。

### 15.3 Import Pipeline

```text
postman_collection.json
        ↓
Detect
        ↓
Parse
        ↓
Schema Validation
        ↓
Compatibility Scanner
        ↓
Normalize
        ↓
Internal Collection Model
        ↓
Migration Report
        ↓
Import
```

### 15.4 Migration Report

```text
导入完成

12 Requests
3 Folders
11 完全兼容
1 部分兼容
0 无法转换

发现：1 个 Postman Tests Script
```

不兼容内容不得阻塞整个 Collection 导入。

---

## 16. 后续导入格式

V0.2：

```text
OpenAPI 3.x
Swagger 2
curl
HAR
```

V0.3：

```text
Insomnia
Bruno
```

---

## 17. 核心数据模型

```ts
interface ApiRequest {
  id: string
  name: string
  method: HttpMethod
  url: string
  params: KeyValue[]
  headers: KeyValue[]
  auth: AuthConfig
  body: BodyConfig
  scripts?: ScriptConfig
  collectionId: string
  folderId?: string
  createdAt: number
  updatedAt: number
}
```

核心实体：

```text
Collection
Folder
Request
Environment
Variable
ExecutionHistory
ImportReport
```

---

## 18. Host / Client 分层

```text
Browser Client
│
│ DSH Remote API
▼
Host Plugin
│
├ Collection Service
├ Environment Service
├ History Service
├ HTTP Executor
├ Import Service
└ Security Service
```

Host 负责：authoritative state、persistence、mutation、execution、security。

Client 负责：render、input、projection。

---

## 19. 存储设计与 profile scope

不能简单假设 `$DSH_HOME` 会按 profile 隔离。

推荐目录：

```text
$DSH_HOME/api-client/
├── shared/
│   ├── collections.json
│   ├── environments.json
│   └── secrets/
├── profiles/
│   ├── web/
│   │   ├── history/
│   │   └── settings.json
│   └── workbench/
│       ├── history/
│       └── settings.json
└── imports/
```

默认 scope：

| 数据 | 默认 scope |
|---|---|
| Collections | shared |
| Environments | shared |
| Secret references | shared |
| History | profile |
| UI Settings | profile |
| Network policy | profile，可继承 shared default |

这样可以做到：

- Web profile 和 Workbench profile 共用 API 定义；
- Workbench 批量测试不会污染日常 Web History；
- 不复制 Secret；
- 不把 LocalStorage 作为权威状态。

### 19.1 profileId 获取

M0 必须验证 Host 插件如何获取当前 profile identity。

优先级：

1. DSH runtime 提供的 profile metadata；
2. 插件 context / loader metadata；
3. 启动环境变量；
4. 显式插件配置。

Workbench profile 可由 Workbench 启动 DSH 时显式注入。

若普通 DSH 启动无法可靠自省，V0.1 必须提供安全 fallback，而不是猜 profile 名称。

## 20. 仓库与真实 DSH Manifest 契约

```text
dsh-api-client/
│
├── package.json
├── cordis.patch.yml
├── README.md
├── LICENSE
├── pnpm-workspace.yaml
├── tsconfig.json
│
├── src/
│   ├── host/
│   └── client/
│
├── packages/
│   ├── core/
│   ├── shared/
│   └── postman-adapter/
│
├── tests/
└── docs/
```

### 20.1 package.json 必备契约

示意：

```json
{
  "name": "dsh-api-client",
  "exports": {
    ".": "./dist/index.js",
    "./client": "./dist/client.js",
    "./package.json": "./package.json"
  },
  "dsh": {
    "engines": {
      "dsh": ">=0.1.2-rc.1"
    },
    "bundle": {
      "patch": "./cordis.patch.yml"
    },
    "client": {
      "platform": "web",
      "inject": []
    }
  }
}
```

实际字段以 M0 对目标 DSH 的 manifest scanner 实测为准。

### 20.2 `dsh.client.inject`

它是 **Client package dependency edge**，不是 Host Cordis service inject。

必须只声明客户端 bundle 真正需要的 DSH client package。

禁止：

- 把浏览器 client package 当成 Host service；
- 为“可能会用”而过度 inject；
- 把 runtime service inject 与 `dsh.client.inject` 混为一谈。

### 20.3 Client Export

插件必须正确导出：

```text
./client
./package.json
```

否则 Host Client Module scanner 可能无法把它识别为合法 Client Module。

### 20.4 cordis.patch.yml

负责把 out-of-tree 插件加入实际 bundle tree。

安装/卸载必须能通过 DSH plugin lifecycle 完成，不依赖手改官方配置。

## 21. Client 文件结构

```text
src/client/
├── index.ts
│
├── dsh-adapter/
│   ├── feature-detect.ts
│   ├── slot-adapter.ts
│   ├── legacy-dom-adapter.ts
│   ├── sidebar-injection.ts
│   ├── panel-activation.ts
│   ├── panel-mutual-exclusion.ts
│   ├── theme-adapter.ts
│   └── session-bridge.ts
│
├── slots/
│   ├── main-view.tsx
│   ├── settings-item.tsx
│   └── conversation-actions.tsx
│
├── views/
│   ├── ApiClientView.tsx
│   ├── HistoryView.tsx
│   ├── EnvironmentView.tsx
│   └── ImportReportView.tsx
│
├── components/
│   ├── collection/
│   ├── request/
│   ├── response/
│   ├── environment/
│   └── common/
│
└── hooks/
```

所有 DSH UI 内部契约只允许出现在 `dsh-adapter/` 和极薄的 slot registration 层。

Core、Postman Adapter、HTTP Executor 不得 import DSH Client 包。

## 22. Host 文件结构

```text
src/host/
├── index.ts
├── api/
│   ├── collections.ts
│   ├── requests.ts
│   ├── environment.ts
│   ├── execute.ts
│   ├── history.ts
│   ├── import.ts
│   └── capabilities.ts
│
├── tools/
│   ├── api-client-request.ts
│   ├── api-client-run-request.ts
│   ├── api-client-list-collections.ts
│   ├── api-client-list-requests.ts
│   ├── api-client-get-request.ts
│   ├── api-client-switch-environment.ts
│   └── api-client-get-last-response.ts
│
└── services/
    ├── collection-service.ts
    ├── environment-service.ts
    ├── history-service.ts
    ├── execution-service.ts
    ├── redaction-service.ts
    ├── profile-service.ts
    └── network-policy-service.ts
```

Host API 必须具备明确鉴权边界：

- 默认 loopback / same-host；
- 经 Workbench 反代时要求可信 proxy token 或等价身份校验；
- 不允许无鉴权暴露任意 HTTP Executor；
- 所有 Agent execution 写入 audit source。

## 23. Plugin Lifecycle

必须支持：

```text
install
mount
start
stop
unmount
uninstall
```

卸载后：

- Sidebar Entry 消失；
- 主视图注销；
- Agent Tools 注销；
- Host Controller 注销；
- 数据默认保留。

另外提供显式 `Delete plugin data`。

---

## 24. 安全设计

### 24.1 Secret 生命周期

Secret 分为三种状态：

```text
Secret Reference
Resolved Secret（仅执行期内存）
Redacted Projection（UI/History/Agent）
```

默认 UI：

```text
••••••••
```

Agent 默认不获得 secret 明文。

### 24.2 全链路 Redaction

必须覆盖：

```text
History
Agent Context
Logs
Import Report
Error Message
Telemetry
Debug dump
```

敏感位置包括：

- Headers；
- Cookies；
- Query；
- URL；
- Auth config；
- JSON/Form Body；
- Environment；
- Response 中用户配置的敏感字段。

### 24.3 SSRF / Network Policy

配置项：

```text
allow localhost
allow private network
allow public network
blocked hosts
allowed hosts
blocked ports
redirect policy
DNS rebinding protection
max response size
timeout
```

### 24.4 Host API Auth

Host API 具备任意网络请求能力，必须：

```text
loopback-first
same-origin / trusted-proxy authentication
CSRF-safe mutation contract
audit source identity
```

禁止公开暴露匿名 `/execute`。

### 24.5 Agent Permission

Human 点击 Send：按 Human permission policy 执行。

Agent：

```text
api_client_request
api_client_run_request
```

必须遵循 DSH Permission / Approval 流程。

对以下方法默认提高风险等级：

```text
POST
PUT
PATCH
DELETE
```

此外允许按 host/path/collection 配置 policy。

### 24.6 Sensitive Headers

默认：

```text
Authorization
Cookie
Set-Cookie
X-API-Key
Proxy-Authorization
```

### 24.7 Postman Scripts

V0.1：

```text
Parse
Detect
Display
Warn
```

但不执行。

未来如实现 Scripts Runtime：

- 必须隔离 Sandbox；
- 限制网络/文件/进程；
- 限制 CPU/内存/时间；
- 禁止直接 `eval()` / `new Function()` 执行不可信 Collection Script。

## 25. 插件 Settings

```text
Settings
└── Plugins
    └── API Client
```

配置项：

```text
Default timeout
Follow redirects
Save history
Max response size
History retention
Network policy
Agent permission
Secrets display policy
Postman compatibility
```

---

## 26. 与 dsh-workbench 的关系与交付时序

`dsh-api-client` 是独立插件；`dsh-workbench` 不维护长期第二套 API Client 产品。

但当前 Workbench V1 已处于实现流水线中，因此采用分阶段策略。

### 26.1 Workbench V1

批 5 的 API 能力缩减为 **API Plugin Host / Placeholder**：

```text
API 调试
├── 插件安装状态
├── dsh-api-client 可用性检测
├── Open API Client
└── 未安装 → 引导插件市场 / 本地插件来源
```

不继续在 Workbench 内重复实现：

```text
Collection
Environment
History
Postman Import
完整 Request Editor
```

### 26.2 V1 渲染策略

V1：

```text
Native DSH = Primary Surface
```

Workbench 点击 API 调试：

```text
→ 打开 DSH 原生 dsh-api-client
```

在 `dsh-api-client` 尚未发布 npm 的阶段，验收允许“未安装态”，但必须支持本地插件来源检测/提示。

### 26.3 V1.1

验证：

```text
Workbench
  ↓ same-origin reverse proxy
DSH Web UI
  ↓
Programmatic API Client panel activation
```

只有 M0/Migration Spike 验证以下条件后才启用 iframe/embedded：

- 可程序化激活 API Client；
- 能恢复 panel state；
- routing 稳定；
- theme/height 正常；
- 无跨域问题；
- 不破坏 DSH Session；
- 插件卸载/升级可恢复。

### 26.4 Registry 更新

Workbench Registry 增加：

```text
dsh-api-client.yaml
```

同时：

- `dsh-http.yaml` 不再拥有核心 HTTP capability；
- API 导航项仍可作为 Workbench 内置一级入口；
- 能力来源由 `dsh-api-client` installation/capability 状态推导。

## 27. 与 dsh-http 的边界

`dsh-api-client` 自己提供：

```text
Human API UI
HTTP Executor
Agent API Tools
Collection / Environment / History
Postman Adapter
```

因此：

- 不依赖 `dsh-http`；
- 不等待 `dsh-http` 修复才能完成 Agent HTTP；
- `dsh-http` 可继续安装但禁用/独立使用；
- Workbench AC-23 的 Agent HTTP 缺口由 `dsh-api-client` 接管。

工具命名统一为 `api_client_*`，不与 `http_request` 冲突。

## 28. 开源定位

README 首屏建议：

```text
API Client for DeepSeek Harness

Postman-like API testing UI
+
Agent-native HTTP tools
+
Postman Collection import
```

推荐 License：MIT 或 Apache-2.0。

---

## 29. Roadmap

### V0.1

```text
DSH Sidebar DOM Integration
Official Slot Main View Integration
Legacy CSS Takeover Fallback
Settings Integration
Collections / Folders / Requests
Params / Headers / Auth / Body
HTTP Executor
Response Viewer
Environment
Profile-scoped History
History / Context Redactor
Postman Collection v2.1 Import
api_client_request
api_client_run_request
api_client_list_*
Ask Agent Context
Compatibility Matrix
```

### V0.2

```text
OpenAPI Import
curl Import
HAR Import
Collection Runner
Workbench Embedded Surface Spike
```

### V0.3

```text
OAuth2
Scripts Sandbox
Tests
Agent Test Runner
Advanced Secret Providers
```

### V1.0

```text
GraphQL
WebSocket
gRPC
Mock
Advanced Tests
Documentation
Plugin Marketplace Stable Release
Multi-profile compatibility
```

## 30. 开发阶段

### M0 — DSH Compatibility Spike

正式功能开发前必须完成 16 项：

1. `ctx.slots.register` 在目标运行时可用；
2. runtime slot catalog 能查询目标 declaration / occupant；
3. Sidebar New Session 下方 DOM 注入可稳定工作；
4. MutationObserver 自愈在 React 重渲染后无明显闪烁；
5. 主视图官方 `conversation` replacement/shadow 可工作；
6. 验证 replacement 后 Conversation 草稿/滚动/view 状态恢复质量；
7. Legacy CSS takeover fallback 可工作并保留 Conversation DOM；
8. API Client Panel 与其他社区 plugin panel 的互斥机制；
9. `settings.plugin.item` 或目标 Settings slot 可用；
10. Theme token / dark mode / sidebar collapse；
11. Host Remote API 注册、鉴权、注销；
12. `api_client_request` Agent Tool 注册与注销；
13. Programmatic Session creation；
14. SafeApiDebugContext → Session / Composer 注入；
15. Host 当前 profile identity 自省；
16. `dsh.client.inject`、`exports["./client"]`、bundle patch 的真实 manifest 契约。

M0 输出物：

```text
docs/DSH_COMPATIBILITY_MATRIX.md
docs/M0_SPIKE_REPORT.md
fixtures/runtime-slot-catalog.json
fixtures/client-manifest-contract.json
```

Compatibility Matrix 的行按“能力”组织，而不是简单按 Slot API / DSH 版本组织。

### M1 — Core

Request / Collection / Environment / Variable Resolver / Auth Resolver / HTTP Executor / Redaction。

### M2 — Human UI

Collection / Request / Params / Headers / Auth / Body / Response / Environment editor。

### M3 — Environment + History

shared/profile scope + redacted history。

### M4 — Agent Tools

全部 `api_client_*` 工具。

### M5 — Postman Adapter

v2.1 + Compatibility Scanner + Migration Report。

### M6 — Agent Context Bridge

Session Bridge + Context Redactor。

### M7 — Security

SSRF / Host API Auth / Approval / Secret / Audit。

### M8 — Open Source Release

README / examples / compatibility matrix / package publishing / security scan / marketplace metadata。

## 31. 验收标准

### DSH 集成

- AC-01：安装插件后 New Session 下方出现 API Client；
- AC-02：DSH React 重渲染后入口可自愈且不重复；
- AC-03：卸载插件后入口、Observer、Panel、Tool 全部移除；
- AC-04：点击 API Client 主区域进入 ApiClientView；
- AC-05：优先使用官方 Slot 主视图路径；
- AC-06：若 Slot replacement UX 不可接受，可切换 Legacy CSS takeover；
- AC-07：点击 Session 后恢复 DSH Conversation；
- AC-08：与其他插件 Panel 互斥，不出现双 Panel；
- AC-09：Settings 插件项通过官方 Slot 接入；
- AC-10：Theme / Sidebar collapse 正常。

### API Client

- AC-11：GET 可正常执行；
- AC-12：POST JSON 可正常执行；
- AC-13：HEAD / OPTIONS 可正常配置；
- AC-14：`{{base_url}}` 正确解析；
- AC-15：Bearer / Basic / API Key 正确应用；
- AC-16：请求可保存到 Collection；
- AC-17：Environment 可编辑/切换；
- AC-18：Human 请求进入 profile-scoped History；
- AC-19：Agent 请求进入同一审计体系且 source=agent。

### Agent

- AC-20：`api_client_request` 使用同一 HTTP Executor；
- AC-21：`api_client_run_request` 可执行保存请求；
- AC-22：所有工具使用 `api_client_*` 命名空间；
- AC-23：工具卸载时立即注销；
- AC-24：“交给 Agent”可创建/打开 DSH 原生 Session 或安全降级到 composer prefill。

### Postman

- AC-25：Postman v2.1 Collection 可导入；
- AC-26：不兼容 Script 生成 Migration Report；
- AC-27：部分不兼容不阻断整体导入。

### Security

- AC-28：History 永不持久化 Authorization/Cookie/API Key 明文；
- AC-29：URL/query 中 secret 同样脱敏；
- AC-30：Agent Context 默认不含 Environment secret 明文；
- AC-31：Agent `get_last_response` 返回 redacted projection；
- AC-32：重新执行请求从 SecretRef/Environment 解析，不从 History 恢复 secret；
- AC-33：Host `/execute` 不允许匿名远程调用；
- AC-34：Private network / localhost 行为受 Network Policy 控制；
- AC-35：高风险 Agent mutation 可进入 Approval。

### Workbench

- AC-36：Workbench V1 API 页面只承担插件状态/入口/未安装引导；
- AC-37：V1 不以 dsh-api-client 未发布为整体阻塞条件；
- AC-38：V1.1 embedded surface 只有通过独立 Spike 才启用。

### Compatibility

- AC-39：DSH 内部 UI 变化只修改 `dsh-adapter/`；
- AC-40：Core / HTTP Executor / Postman Adapter 不 import DSH UI 包；
- AC-41：M0 产出可公开的 Capability Compatibility Matrix。

## 32. 风险

### 高风险：DSH UI Extension Contract 快速演进

DSH 仍处于 Developer Preview。

风险不只是“有没有 Slot”，而是：

- slot declaration key 变化；
- owner props 变化；
- Client package 名变化；
- single seat occupant / priority 变化；
- DOM shell selector 变化；
- `dsh.client.inject` 依赖图变化。

措施：

```text
dsh-adapter isolation
feature detect
runtime catalog
compatibility matrix
DOM fallback
CI against supported DSH versions
```

### 高风险：Sidebar DOM 注入

目标导航位当前无正式 Slot。

措施：

- 最小 DOM surface；
- semantic attribute 优先；
- MutationObserver 自愈；
- selector fallback list；
- 自动健康检查；
- 插件卸载彻底 cleanup。

### 高风险：HTTP Executor

具备任意网络请求能力。

必须：

```text
Network Policy
SSRF Protection
Host API Auth
Timeout
Redirect Policy
Response Limit
Audit
```

### 高风险：Secret 泄漏

泄漏面包括：

```text
History
Context Bridge
URL/query
Logs
Import Report
Error stack
Agent Tool result
```

必须统一经过 RedactionService。

### 高风险：Agent 自动调用

Agent 自动 POST / DELETE 等操作需要 Permission / Approval。

### 中风险：Conversation replacement UX

官方 Slot replacement 可能导致 Client-only state 重建。

M0 必测；必要时采用 CSS takeover fallback。

### 中风险：Postman Script

V0.1 不执行，避免把 JS runtime / sandbox 风险提前引入。

## 33. 技术决策冻结

- D1：项目独立命名 `dsh-api-client`；
- D2：不作为 dsh-workbench 私有模块；
- D3：使用 DSH 原生 Shell；
- D4：Sidebar New Session 下方入口采用 DOM Injection，因为目标位置当前无官方增量 Slot；
- D5：主视图优先使用官方 conversation-family Slot replacement/shadow；
- D6：若官方 replacement UX 不可接受，启用 Legacy CSS takeover fallback；
- D7：DSH UI Adapter 按能力 feature-detect，不按版本号嗅探；
- D8：Settings / Conversation 增量扩展优先使用官方 Slot；
- D9：UI 信息架构参考 Postman，视觉主题跟随 DSH；
- D10：Human 和 Agent 共用 Core；
- D11：自行实现 HTTP Executor；
- D12：不依赖 `dsh-http`；
- D13：所有 Agent Tools 使用 `api_client_*` 命名空间；
- D14：Postman Collection v2.1 为 V0.1 一级兼容格式；
- D15：Postman Script V0.1 不执行；
- D16：Host Authority；
- D17：History 与 Agent Context 必须统一脱敏；
- D18：Collections/Environments 默认 shared，History/Settings 默认 profile；
- D19：profile identity 在 M0 实测，不允许猜测；
- D20：Manifest 必须显式验证 `dsh.client.inject` / `./client` export / bundle patch；
- D21：“交给 Agent”使用 DSH 原生 Session；无法直接注入时降级到 composer prefill；
- D22：Workbench V1 批 5 缩减为 API Plugin Host / Placeholder；
- D23：Workbench V1 使用 Native DSH primary surface；
- D24：Workbench V1.1 再验证 iframe/embedded；
- D25：dsh-http 不再拥有 Workbench 核心 HTTP capability；
- D26：按开源项目标准开发并发布 Compatibility Matrix。

## 34. 最终架构

```text
                         DeepSeek Harness
                                │
               ┌────────────────┴────────────────┐
               │                                 │
          DSH Web Client                    DSH Host Runtime
               │                                 │
      ┌────────┴─────────┐                       │
      │                  │                       │
Sidebar DOM Entry   Official Slot Surfaces       │
      │             ├ Main View                  │
      │             ├ Settings                   │
      │             └ Conversation Actions       │
      │                  │                       │
      └────────┬─────────┘                       │
               ▼                                 │
          ApiClientView                          │
               │                                 │
               └──────────────┬──────────────────┘
                              ▼
                      dsh-api-client Host
                              │
                        API Client Core
                              │
    ┌──────────────┬──────────┼──────────┬──────────────┐
    │              │          │          │              │
Collection    Environment   Auth    HTTP Executor    Redaction
    │              │          │          │              │
    └──────────────┴──────────┼──────────┴──────┬───────┘
                              │                 │
                           History          Agent Tools
                              │                 │
                       profile-scoped     api_client_*
                                                │
                                                ▼
                                            DSH Agent
                                                │
                                                ▼
                                           Target APIs

Workbench V1
   │
   └── API Plugin Host / Open Native DSH

Workbench V1.1
   └── optional same-origin embedded DSH surface（独立 Spike 后启用）
```

## 35. 最终产品目标

最终体验应是：

> 人在 DSH 里像使用轻量 Postman 一样调 API；Agent 直接使用同一批 Collection、Environment 和 HTTP Executor 自动调用、验证和复测 API。

它不是单纯的 Postman Clone，而是一个真正面向 Agent Harness 的 API Client。

---

## 36. 下一步

正式进入完整开发前只执行 M0 Compatibility Spike。

本轮不先做完整 Postman UI，而是优先回答 5 个决定工程路线的问题：

1. New Session 下方 DOM 注入能否长期稳定、自愈、正确卸载；
2. `conversation` replacement 是否能在不损害关键 UX 的情况下承担主视图；
3. 若不能，CSS takeover fallback 是否稳定；
4. Session creation + Safe Context injection 是否有公开、可靠的调用路径；
5. profile identity 与 `dsh.client.inject` manifest 契约如何在目标 runtime 中真实表现。

M0 完成后冻结：

```text
DSH_COMPATIBILITY_MATRIX.md
M0_SPIKE_REPORT.md
UI_ADAPTER_CONTRACT.md
CLIENT_MANIFEST_CONTRACT.md
```

再进入 M1 Core。

这样可以避免先投入大量 UI 开发，最后才发现 DSH 宿主挂载、会话桥接或 profile 隔离模型不成立。

---

## 37. 已核验 DSH 事实摘要

本设计 V1.1 基于以下已经交叉核验的事实收敛：

1. DSH Web Client 已具有正式 Slot System；
2. Slot cardinality 包含 `single / list / keyed / chain`；
3. `ctx.slots.register(...)` 是贡献 UI 的核心 API；
4. `ctx.slots.inject(...)` 用于贡献者与声明者独立激活的声明依赖；
5. `conversation.session`、`conversation.view`、`conversation.composer`、`conversation.input.*` 等细粒度 Slot 已存在于上游实现；
6. `single` / keyed / list cell 支持 priority/shadow 语义；
7. `dsh.client.inject` 属于 client module dependency declaration；
8. Browser client package 需要正确 `./client` export；
9. 社区插件已证明：当某个 UI 位置不存在正式 Slot 时，可使用 out-of-tree DOM 注入而无需修改 DSH Core；
10. 因此本插件采用“官方 Slot 优先 + 仅对无 Slot 能力做 DOM fallback”的策略。

> 由于 DSH 仍处于快速演进阶段，最终支持矩阵以 M0 对实际目标 runtime 的实时探测结果为准。

---

## 38. 本次 V1.1 相对 V1.0 的关键变化

| 项目 | V1.0 | V1.1 |
|---|---|---|
| UI 集成判断 | 泛化为全部 Slot | 按能力分流 |
| Sidebar 入口 | 假定 Slot | DOM 注入 |
| 主视图 | Slot | Slot 优先 + CSS takeover fallback |
| Agent Tool | `http_request` | `api_client_*` |
| History | snapshot | 强制 redaction |
| Agent Context | 原始 environment | SafeApiDebugContext |
| Storage | 全局目录 | shared + profile scope |
| Manifest | 简化 | `dsh.client.inject` / exports / bundle patch 明确 |
| Workbench 批 5 | 完整 API 页倾向 | Plugin Host / Placeholder |
| Workbench Surface | 未定义 | V1 Native，V1.1 optional embed |
| M0 | 10 项 | 16 项 |
| Compatibility | 版本导向 | capability matrix |

---

## 39. 最终产品目标

最终产品体验：

> 人在 DSH 中像使用轻量 Postman 一样调试 API；Agent 直接使用同一批 Collection、Environment、HTTP Executor 与审计体系自动调用、验证和复测 API。

它不是单纯的 Postman Clone，而是：

> **Agent-native API Client for DeepSeek Harness。**
