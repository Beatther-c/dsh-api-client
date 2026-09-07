/**
 * §4.1 实体 TS 接口（逐字段照抄 V01_IMPLEMENTATION_DESIGN §4.1）。
 * 纯类型定义，零运行时依赖，零 DSH/React import（AC-40 / TC-A-02）。
 */

// ---- 基础 ----
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'

export interface KeyValue {
  key: string
  value: string
  description?: string
  enabled: boolean // §7.3/§7.4 启停
}

// ---- Auth（§7.5 V0.1 五项）----
export type AuthConfig =
  | { type: 'none' }
  | { type: 'bearer'; token: string | SecretRef }
  | { type: 'basic'; username: string; password: string | SecretRef }
  | { type: 'apikey'; key: string; value: string | SecretRef; in: 'header' | 'query' }
  | { type: 'inherit' } // Inherit Auth From Parent：folder → collection 链向上

// ---- Body（§7.6 V0.1）----
export type BodyConfig =
  | { type: 'none' }
  | { type: 'raw'; raw: string } // Text
  | { type: 'json'; json: string }
  | { type: 'form-data'; fields: KeyValue[] }
  | { type: 'urlencoded'; fields: KeyValue[] }

// ---- Scripts（D15：只 parse/detect/display/warn，不执行）----
export interface ScriptConfig {
  preRequest?: string // Postman 导入保留原文，仅展示
  tests?: string
  source: 'postman' | 'manual'
  warning: string // 「V0.1 不执行脚本」标准警告
}

// ---- Request / Collection（§17）----
export interface ApiRequest {
  id: string
  name: string
  method: HttpMethod
  url: string // 可含 {{var}}
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

export interface Folder {
  id: string
  name: string
  folders: Folder[] // 任意嵌套（§6 层级）
  requests: ApiRequest[]
}

export interface Collection {
  id: string
  name: string
  auth?: AuthConfig // 供 inherit 链
  variables: CollectionVariable[] // 优先级链最低层
  folders: Folder[]
  requests: ApiRequest[] // 顶层请求
  createdAt: number
  updatedAt: number
}

export interface CollectionVariable {
  key: string
  value: string
  enabled: boolean
}

// ---- Environment / Variable（§9 + REVIEW 中级 #1 修订）----
export interface Environment {
  id: string
  name: string
  variables: Variable[]
}

export interface Variable {
  key: string
  initialValue?: string
  /** secret=true 时只持 SecretRef，明文绝不进入本结构（AC-42） */
  currentValue: string | SecretRef
  secret: boolean
  enabled: boolean
}

// ---- SecretRef（REVIEW 中级 #1）----
export interface SecretRef {
  $ref: string // 稳定不透明 id（uuid），不编码任何明文信息
}

export interface SecretRecord {
  // shared/secrets/<id>.json 的落盘格式
  id: string
  value: string // 仅此文件含明文；0600
  createdAt: number
  updatedAt: number
}

// ---- 执行（§12）----
export interface ResolvedRequest {
  // 仅执行期内存；可含解析后的 secret
  method: HttpMethod
  url: string // 变量已解析
  headers: KeyValue[]
  body?: Uint8Array | string
  secretValueTraces: SecretTrace[] // 记录哪些位置的值来自 secret（供 redactor）
}

export interface SecretTrace {
  location: 'header' | 'query' | 'url' | 'body' | 'auth'
  key: string
  secretRef: string // SecretRef.$ref
}

export interface HttpExecutionResult {
  status: number
  statusText: string
  headers: KeyValue[]
  cookies: KeyValue[]
  bodyText: string
  bodyKind: 'json' | 'text' | 'html' | 'xml' | 'binary'
  size: number
  durationMs: number
  redirected: boolean
  finalUrl: string
}

// ---- History（§10；只存脱敏快照）----
export interface RedactedRequestSnapshot {
  method: HttpMethod
  displayUrl: string // secret 已替换为 <redacted> / <secret-ref:key>
  headers: KeyValue[] // 敏感头值 = '<redacted>'
  bodyPreview?: string // secret 变量值已脱敏
  auth: { type: AuthConfig['type'] } // 只留类型，不留材料
}

export interface RedactedResponseSnapshot {
  status: number
  statusText: string
  headers: KeyValue[] // Set-Cookie 脱敏
  bodyPreview?: string // 用户声明敏感字段已脱敏；可整体省略
  size: number
  durationMs: number
}

export interface ExecutionHistory {
  id: string
  requestId?: string
  timestamp: number
  method: HttpMethod
  displayUrl: string
  requestSnapshot: RedactedRequestSnapshot
  responseSnapshot: RedactedResponseSnapshot
  duration: number
  source: 'human' | 'agent' | 'runner'
  environmentId?: string
  profileId: string // §10 有 profileId 字段；profile scope 强制
}

// ---- Import（§15.4）----
export interface ImportReport {
  id: string
  format: 'postman-v2.1'
  sourceName: string
  totals: { requests: number; folders: number }
  full: number
  partial: number
  unsupported: number
  findings: ImportFinding[]
  createdCollectionId?: string
  createdAt: number
}

export interface ImportFinding {
  itemPath: string // 「Folder/Request」路径
  level: 'warn' | 'info'
  kind: 'script-not-executed' | 'dynamic-variable' | 'auth-downgraded' | 'field-dropped'
  message: string // 出场前经 redactor
}

// ---- Agent Context（§14）----
export interface CollectionSummary {
  id: string
  name: string
  requestCount: number
}

export interface ExecutionMetadata {
  historyId: string
  durationMs: number
  source: 'human' | 'agent'
}

export interface ApiDebugContext {
  // 原始上下文，禁止直接出域
  collection?: CollectionSummary
  request: ApiRequest
  resolvedRequest: ResolvedRequest
  response?: HttpExecutionResult
  environment?: Environment
  execution?: ExecutionMetadata
}

export interface SafeApiDebugContext {
  // Context Redactor 输出；唯一允许出域形态
  collection?: CollectionSummary
  request: RedactedRequestSnapshot & { name: string }
  response?: RedactedResponseSnapshot
  environmentName?: string // 只给名字，不给变量
  execution?: ExecutionMetadata
  redactionSummary: string[] // §14.4 确认弹窗 ✓/✗ 清单的数据源
}

// ---- Network Policy（§24.3）----
export interface NetworkPolicy {
  allowLocalhost: boolean // 默认 false（fail-closed）
  allowPrivateNetwork: boolean // 默认 false
  allowPublicNetwork: boolean // 默认 true
  blockedHosts: string[] // 支持通配 *.example.com
  allowedHosts: string[] // 非空时白名单模式
  blockedPorts: number[] // 默认含常见敏感端口基线（见 §8.1）
  redirectPolicy: 'follow' | 'manual-block' | 'none' // 默认 follow 且每跳再评估
  maxResponseBytes: number // 默认 10 MiB
  timeoutMs: number // 默认 30_000
  dnsRebindingProtection: boolean // 默认 true
}

// ---- Plugin Settings（§25，profile scope）----
export interface PluginSettings {
  defaultTimeoutMs: number
  followRedirects: boolean
  saveHistory: boolean
  maxResponseBytes: number
  historyRetentionDays: number
  networkPolicy: NetworkPolicy // profile 层，可继承 shared default
  agentPermission: AgentPermissionPolicy
  secretsDisplayPolicy: 'masked' // V0.1 仅此值；reveal 见 §8.1
  postmanCompatibility: 'strict' | 'lenient'
  activeEnvironmentId?: string // Human UI 当前环境（client 选择状态的持久化）
}

export interface AgentPermissionPolicy {
  highRiskMethodsRequireApproval: boolean // 默认 true（POST/PUT/PATCH/DELETE）
  hostRules: { host: string; action: 'allow' | 'approval' | 'deny' }[]
}
