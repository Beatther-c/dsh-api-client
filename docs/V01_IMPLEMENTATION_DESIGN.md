# dsh-api-client V0.1 完整插件 — 可执行实现设计

> 角色：方案设计（feature: m0-dsh-compat-spike，范围已扩大为 V0.1 完整插件）
> 上游契约：docs/DESIGN_V1.1.md（D1–D26 冻结）+ docs/REVIEW_NOTES_V1.1.md（二轮评审）+ docs/M0_SPIKE_DESIGN.md（已接受输入，并入本文 WP0）
> 范围重定义依据：DESIGN_GATE 否决意见「把整个插件完整的前后端都实现出来」
> 目标运行时：DSH 0.1.2-rc.1（`~/.dsh/profiles/web/node_modules`，npm latest；engines 下限依据 REVIEW_NOTES 低级待办 #8）
> 本文不改写 M0_SPIKE_DESIGN.md 与 DESIGN_V1.1.md；与两者冲突处以本文为准的点均在文中显式标注。

---

## 1. 范围与非目标

### 1.1 范围（V0.1 完整插件）

DESIGN_V1.1 §29 V0.1 清单全部条目：

| # | 条目 | 主要交付 WP |
|---|---|---|
| 1 | DSH Sidebar DOM Integration | WP0 验证 / WP3 正式 |
| 2 | Official Slot Main View Integration | WP0 验证 / WP3 正式 |
| 3 | Legacy CSS Takeover Fallback | WP0 验证 / WP3 正式 |
| 4 | Settings Integration | WP3 |
| 5 | Collections / Folders / Requests | WP1 / WP2 / WP3 |
| 6 | Params / Headers / Auth / Body | WP1 / WP3 |
| 7 | HTTP Executor | WP1 / WP2 |
| 8 | Response Viewer | WP3 |
| 9 | Environment | WP1 / WP4 / WP3 |
| 10 | Profile-scoped History | WP4 |
| 11 | History / Context Redactor | WP1 / WP4 / WP7 |
| 12 | Postman Collection v2.1 Import | WP6 |
| 13 | `api_client_request` / `api_client_run_request` / `api_client_list_*` | WP5 |
| 14 | Ask Agent Context | WP7 |
| 15 | Compatibility Matrix | WP0（正式交付物） |

验收主体：DESIGN_V1.1 §31 AC-01…AC-41 + 本文新增 AC-42（secrets at-rest）、AC-43（热插拔不重启 DSH，由 AC-M0-17 晋升）。

REVIEW_NOTES 进入范围的条目及其处置：

- **中级 #1（shared secrets at-rest 保护）**：进入范围。secret 值单独存 `shared/secrets/`（目录 0700、文件 0600），`environments.json` 只存 SecretRef；新增 AC-42 与 TC-S-06…09（见 §4.3、§6、§7）。
- **中级 #2（热插拔第 17 项）与 #3（深链激活契约 panel-activation.ts）**：沿用 M0 设计，作为 WP0 的 V-17 与 V-05 深链子项；AC-M0-17 晋升为正式 AC-43。
- **低级 #5（`api_client_switch_environment`）**：**去除该工具**（本设计决定项 D-D1，见 §5.2 与 §11）。
- **低级 #6（§13.7「默认返回脱敏版本」）**：消除「默认」暗示的明文出口——工具**永远**返回脱敏投影，不存在工具级明文参数；明文 override 只走 Human UI 的 human-present reveal 路径（见 §5.2、§8.1、§11 U-N3 留痕）。
- **低级 #4（yield 机制 + owner props / `session-maybe` 契约）、#7（官方排查工具）、#8（版本实证）**：沿用 M0 设计的已有处置（V-05、V-02、engines 下限）。

AC-36/37/38 按 REVIEW_NOTES 修订理解：本仓库侧义务 = 本插件作为普通第三方插件可被 registry / `dsh plugin --profile workbench add link:` 安装、capability 可由安装状态推导；**本仓库不做任何 Workbench 专用页**。AC-38（embedded surface 独立 Spike）在本仓库无可执行代码义务，按文档级声明处理（见 §7）。

### 1.2 非目标（逐条排除，不得扩大）

- §16 的 V0.2+ 导入格式：OpenAPI 3.x / Swagger 2 / curl / HAR（V0.2），Insomnia / Bruno（V0.3）；
- OAuth2 / Digest / AWS Signature 认证（V0.3；Postman 导入时检测并降级为 No Auth + Migration Report 警告）；
- Scripts 执行：V0.1 对 Postman Script 只 **parse / detect / display / warn**（D15），不实现任何 Sandbox/eval；
- Collection Runner（V0.2）；
- GraphQL / WebSocket / gRPC / Mock（V1.0）；
- Workbench 私有实现：不做专用占位页、不改 dsh-workbench 仓库（registry yaml 归 dsh-workbench 维护，见 §11 U-N5）；
- npm 发布（M8 才做）；
- Collection **Export**：依据 REVIEW_NOTES §四编辑项第 3 条（「§6 V0.1 列了 Export，但 §31 无对应 AC：补 AC 或从 V0.1 移除」），本设计决定**从 V0.1 移除**，留痕 §11 U-N4 待设计评审确认；`packages/core/export/` 目录 V0.1 不创建；
- 不修改 DSH 源码（§3.6 zero DSH source patch）、不依赖 `dsh-http`（D12）；
- secrets 的 at-rest **加密**（对称加密/KMS）：REVIEW_NOTES 中级 #1 只要求权限基线（0600/0700 + SecretRef 分工），V0.1 按此交付；加密属 V0.3 Advanced Secret Providers，留痕 §11 U-N2。

---

## 2. 分阶段实施计划（WP0 → WP8）

WP0 即 M0 设计整体并入（docs/M0_SPIKE_DESIGN.md 全文有效，本文不重复其内容，只定义衔接）。§36 的决策逻辑仍然有效：17 项验证必须在实现早期完成、回答五问、冻结 adapter/manifest 契约后，才大规模铺开 UI 与 Core 开发；但它**不再作为独立流水线关卡**，而是本计划的第一个工作包。

### WP0 — 兼容性验证与脚手架（= M0_SPIKE_DESIGN.md 全文）

- **内容**：仓库脚手架（pnpm workspace / tsup / vitest / tsconfig）、最小可安装探针插件、17 项验证（V-01…V-17）、TC-M0-01…28、6 项输出物（DSH_COMPATIBILITY_MATRIX / M0_SPIKE_REPORT / UI_ADAPTER_CONTRACT / CLIENT_MANIFEST_CONTRACT / fixtures×2）。
- **交付物**：M0 设计 §6 的 6 项输出物 + 脚手架配置全套。
- **依赖**：无。
- **出口标准**：AC-M0-01…20 全部通过；§36 五问各有 GO / NO-GO / FALLBACK 结论；UI_ADAPTER_CONTRACT 与 CLIENT_MANIFEST_CONTRACT 冻结；U-1/U-2/U-3/U-4/U-5/U-7 实测闭环。

### WP1 — Core（`packages/core` + `packages/shared`）

- **内容**：§11 Core 中 V0.1 所需子集——collection / environment / variables / auth / request / response / executor / history / import（通用管线骨架）/ security（redactor + network-policy 评估）。**不含 export/**（§1.2）。全部纯 TypeScript，零 DSH import（AC-40），除 executor 的网络 I/O 外无副作用。
- **交付物**：`packages/shared`（类型 + SecretRef + 存储布局常量）、`packages/core` 全模块、TC-C-01…21、TC-R-01…12 全绿。
- **依赖**：WP0（脚手架 + vitest 就绪）。不依赖 WP0 的 17 项验证结论（Core 与 DSH 运行时解耦，可与 WP0 后半段并行）。
- **出口标准**：`pnpm test` 全绿；TC-A-02（import 边界静态检查）通过。

### WP2 — Host 服务与 API（`src/host/services` + `src/host/api`）

- **内容**：7+4 个 service（§3.2）+ Host API router 与全部端点（§5.1）+ 鉴权中间件（loopback-first + token + CSRF-safe mutation header，具体机制依 WP0 对 U-7 的实测结论）。
- **交付物**：`src/host/`（不含 tools/）、TC-API-01…12 全绿、`/api-client/capabilities` 手工可达。
- **依赖**：WP0（U-7 Host API 注册机制与鉴权原语实测结论、profile-probe 结论 → profile-service）；WP1（Core 模型与 executor）。
- **出口标准**：全部端点带凭证可用、匿名/跨源/缺 CSRF header 被拒（TC-API-08/09/10）；TC-A-01/02 通过。

### WP3 — Human UI（`src/client` views/components/slots/hooks）

- **内容**：M0 的 dsh-adapter 8 文件从探针**硬化为正式实现**（§3.4）；ApiClientView 全量（Collection Tree / Request Tabs / Method Selector / UrlBar / Params / Headers / Auth / Body / JSON Editor / Response Viewer / History 入口 / Import 入口 / Environment 入口）；settings-item 正式配置页；Method 语义色（§5.2）与 DSH Theme Token 适配（§5.3）。
- **交付物**：`src/client/` 全量、TC-A-01/03、手工场景 TC-UI-01…17、19、20 通过。
- **依赖**：WP0（UI_ADAPTER_CONTRACT 冻结：slot key、owner props、priority、深链 token 形态、selector 契约）；WP2（Host API）。
- **出口标准**：AC-01…17 中 UI 相关条全部可手工核验；UI 无任何 DSH 内部契约泄漏到 dsh-adapter/slots 之外。

### WP4 — Environment + History（shared/profile scope + redaction 落地 + secrets at-rest）

- **内容**：`$DSH_HOME/api-client/` 目录布局落地（§4.2）；environments.json 只存 SecretRef + `shared/secrets/` 0600/0700（REVIEW 中级 #1）；profile-scoped history（JSONL）+ 全链路 Redaction 持久化核验；profile unresolved 时 fail-closed（§4.4）。
- **交付物**：secret-store-service / history-service / environment-service 完整实现、TC-S-01…11 全绿。
- **依赖**：WP1（模型）、WP2（service 骨架）。与 WP3 可并行。
- **出口标准**：AC-18/28/29/32/42 对应的自动化用例全绿；`environments.json` 中 grep 不到任何已写入的 secret 明文（TC-S-07）。

### WP5 — Agent Tools（`src/host/tools`，`api_client_*` 全量 6 个）

- **内容**：`api_client_request` / `api_client_run_request` / `api_client_list_collections` / `api_client_list_requests` / `api_client_get_request` / `api_client_get_last_response`（**无** `api_client_switch_environment`，§5.2）；风险等级与 Approval 挂接（§5.3）；system-prompt announcement 正式化（由 M0 announcement-probe 演进）。
- **交付物**：tools/ 全量、TC-T-01…10 全绿。
- **依赖**：WP2（Host API / 执行链）、WP4（redaction + history）。
- **出口标准**：AC-19…23、AC-31、AC-35 的自动化部分全绿；工具结果中无 secret 明文（TC-T-04/05）。

### WP6 — Postman Adapter（`packages/postman-adapter`）

- **内容**：Collection v2.1 一级支持（§15.1 全项）+ 部分支持项的检测/降级（§15.2）+ Import Pipeline（§15.3）+ Migration Report（§15.4）；不兼容内容不阻塞整体导入。
- **交付物**：postman-adapter 全量 + `fixtures/postman/` 样本、TC-P-01…14 全绿、TC-UI-19 手工通过。
- **依赖**：WP1（内部模型 + import 管线骨架）、WP2（import-service 落库）。
- **出口标准**：AC-25/26/27 全绿。

### WP7 — Context Bridge（session-bridge 正式化 + SafeApiDebugContext）

- **内容**：M0 session-bridge 探针 → 正式实现：「交给 Agent」按钮 → Context Redactor → SafeApiDebugContext → Create/Activate Session → 注入或降级 composer prefill（按 WP0 V-13/14 实测路径）；§14.4 出域确认 UI（明确列出将发送/不发送项）。
- **交付物**：session-bridge 正式版 + ConfirmSendToAgent 组件、TC-R 相关项复跑、TC-UI-17 手工通过。
- **依赖**：WP0（V-13/14 路径结论）、WP3（UI 挂点）、WP4（redaction）。
- **出口标准**：AC-24、AC-30 可核验；确认弹窗中 secret 明文标记为「不发送」且实测注入内容不含明文。

### WP8 — Security 收尾（SSRF / Host API Auth / Approval / Audit 硬化 + 探针退役）

- **内容**：Network Policy 完整配置面（§24.3 全项：allow localhost / private / public、blocked/allowed hosts、blocked ports、redirect policy、DNS rebinding protection、max response size、timeout）与 executor 强制执行点复查；Host API Auth 复核（§24.4）；Agent Permission/Approval 全链路复核（§24.5）；audit source identity 落盘复核；**M0 探针退役处置**（§3.5）；WP0→V0.1 回归（TC-M0 中仍适用的手工场景复跑）。
- **交付物**：TC-SEC-01…10 全绿、探针退役完成、最终安装/热插拔/卸载回归记录。
- **依赖**：WP1–WP7 全部。
- **出口标准**：AC-03/23/33/34/35/43 终验；§8.2 高危核查点逐项签字；`pnpm build && pnpm test` 全绿。

### 阶段依赖图

```text
WP0 ──┬── WP2 ──┬── WP3 ──┐
      │         ├── WP5 ──┤
WP1 ──┴── WP4 ──┴── WP7 ──┴── WP8
      └────────── WP6 ──────┘
（WP1 与 WP0 后半段可并行；WP3/WP4 可并行；WP6 只依赖 WP1+WP2）
```

---

## 3. 前后端文件级拆分

仓库骨架沿用 M0 设计 §2.1/§2.2 的脚手架选型（pnpm + tsup 双入口 + vitest + tsconfig strict），WP0 已建立，此处不再重复。以下只列 WP1–WP8 的新增/演进文件。

### 3.1 `packages/shared`（纯类型与常量，零运行时依赖，host/client/core 三方共用）

| 文件 | 职责 |
|---|---|
| `packages/shared/package.json` | workspace package 声明（`@dsh-api-client/shared`） |
| `packages/shared/src/types.ts` | §4.1 全部实体与 DTO 的 TS 接口（ApiRequest / Collection / Environment / ExecutionHistory / ImportReport / HttpExecutionResult 等） |
| `packages/shared/src/secret-ref.ts` | `SecretRef` 类型、生成（uuid）、解析/格式化、展示形态 `<secret-ref:envKey>`（§14.2） |
| `packages/shared/src/storage-layout.ts` | `$DSH_HOME/api-client/` 路径常量与 scope 定义（shared / profiles/&lt;pid&gt; / imports），权限基线常量（dir 0700 / file 0600 for secrets） |
| `packages/shared/src/tool-names.ts` | `api_client_*` 工具名常量（6 个），供 host tools 注册与 TC-T-03 命名空间回归共用 |
| `packages/shared/src/index.ts` | 桶导出 |

### 3.2 `packages/core`（纯逻辑；除 executor 网络 I/O 外无副作用；禁止 import DSH 任何包——AC-40）

| 文件 | 职责 |
|---|---|
| `packages/core/package.json` | `@dsh-api-client/core` |
| `src/collection/model.ts` | Collection / Folder 树模型、id 生成 |
| `src/collection/ops.ts` | CRUD / 重命名 / 删除 / 排序 / 搜索 / Duplicate（纯函数） |
| `src/environment/model.ts` | Environment / Variable 模型（secret 变量 currentValue 只持 SecretRef） |
| `src/environment/ops.ts` | Environment CRUD、变量启停、SecretRef 绑定/解绑 |
| `src/variables/parser.ts` | `{{var}}` 模板解析（URL/headers/body 通用） |
| `src/variables/resolver.ts` | 变量解析与优先级链 **Local > Environment > Collection**（§7.2）；未解析变量显式报错；输出 `ResolvedRequest` 并标记哪些值来自 secret（供 redactor） |
| `src/auth/types.ts` | AuthConfig 判别联合：none / bearer / basic / apikey / inherit |
| `src/auth/apply.ts` | Bearer / Basic（base64）/ API Key（header 或 query）/ Inherit Auth From Parent（folder→collection 链向上查找） |
| `src/request/build.ts` | Build URL（params 编码、重复 key、空值、启停、双向同步纯函数）、build headers（自动 Content-Type / Accept）、build body |
| `src/request/body.ts` | none / raw / JSON / Text / form-data / x-www-form-urlencoded 序列化；JSON validate/format/compact 纯函数（供 JSON Editor） |
| `src/response/parse.ts` | body 类型检测（JSON/Text/HTML/XML）、size 计算、pretty 化 |
| `src/response/cookies.ts` | Set-Cookie 解析（Response Viewer Cookies tab） |
| `src/executor/executor.ts` | §12 十二步执行流编排（resolve→auth→build→permission→network-policy→execute→计时→parse→history→events） |
| `src/executor/http-client.ts` | Node fetch/undici 封装：timeout、redirect policy、max response size、DNS 解析结果固定（rebinding 防护的执行点，见 §8.1） |
| `src/executor/errors.ts` | 执行错误类型；错误消息出场前必经 redactor 的约定入口 |
| `src/history/model.ts` | ExecutionHistory / RedactedRequestSnapshot / RedactedResponseSnapshot |
| `src/history/recorder.ts` | 由 ResolvedRequest + HttpExecutionResult 生成**脱敏**历史记录（调用 security/redactor，不含 I/O） |
| `src/import/types.ts` | ImportReport / ImportItemResult（兼容度：full / partial / unsupported） |
| `src/import/pipeline.ts` | §15.3 通用管线骨架：Detect→Parse→Validate→Scan→Normalize→Report→Import，格式适配器以接口注入（Postman 适配器实现该接口） |
| `src/security/sensitive-headers.ts` | §24.6 默认敏感头清单（大小写不敏感匹配） |
| `src/security/redactor.ts` | 全链路 Redactor：headers/cookies/query/URL/auth config/JSON·Form body 中 secret 标记变量/response 用户声明敏感字段/SecretRef 展示形态；输出 Redacted 投影 |
| `src/security/network-policy.ts` | §24.3 策略模型与**纯评估函数**（host 匹配、端口、localhost/private 网段判定、redirect 目标再评估） |

V0.1 **不创建** `src/export/`（§1.2 非目标）。

### 3.3 `packages/postman-adapter`（禁止 import DSH 任何包——AC-40）

| 文件 | 职责 |
|---|---|
| `packages/postman-adapter/package.json` | `@dsh-api-client/postman-adapter` |
| `src/schema.ts` | Postman Collection v2.1 schema 类型与校验（`info.schema` URL 校验） |
| `src/detect.ts` | 格式探测（v2.1 vs 其他/非法 JSON） |
| `src/parse.ts` | JSON parse + schema validation，失败显式报错不部分落库 |
| `src/compat-scanner.ts` | 兼容性扫描：scripts（pre-request/tests）、dynamic variables（`{{$guid}}` 等）、OAuth2/Digest 等不支持 auth → 标记 partial/unsupported + 警告文案 |
| `src/normalize.ts` | → 内部 Collection 模型：Collection/Folder/Request/Method/URL(host·path·query·variable)/Query/Headers/Raw·JSON·urlencoded·formdata Body/Basic/Bearer/API Key/Collection Variables（§15.1 全项） |
| `src/report.ts` | Migration Report 生成（§15.4 形态：N Requests / N Folders / 完全兼容 / 部分兼容 / 无法转换 / 发现脚本清单） |
| `src/index.ts` | 实现 core/import 管线接口的适配器入口 |

### 3.4 Host 半（`src/host/`）

| 文件 | 职责 |
|---|---|
| `src/host/index.ts` | Cordis 插件入口：装配 services → api router → tools → announcement；生命周期（install/mount/start/stop/unmount）逆序清理（WP0 探针时序记录能力保留至 WP8 回归后移除，见 §3.5） |
| `src/host/api/router.ts` | Host Remote API 注册抽象（注册机制依 WP0 对 U-7 的实测结论）；统一鉴权中间件挂载 |
| `src/host/api/auth.ts` | loopback-first + plugin token 校验 + same-origin/trusted-proxy 判定 + mutation 请求强制自定义 header（CSRF-safe contract）+ audit source identity 提取（human / agent） |
| `src/host/api/capabilities.ts` | `GET /api-client/capabilities`：版本、profileId、特性开关、health（由 M0 ping 探针演进） |
| `src/host/api/collections.ts` | Collection CRUD / duplicate / reorder（§5.1 端点表） |
| `src/host/api/requests.ts` | Request CRUD / duplicate / move |
| `src/host/api/environment.ts` | Environment CRUD + secret 写入端点（write-only）+ secret 删除 |
| `src/host/api/execute.ts` | `POST /api-client/execute`（临时请求或 requestId + per-call environment） |
| `src/host/api/history.ts` | 列表 / 单条 / 清空（均为脱敏投影） |
| `src/host/api/import.ts` | `POST /api-client/import/postman` → ImportReport + collectionId |
| `src/host/api/settings.ts` | Plugin settings get/patch（§25 配置项） |
| `src/host/services/collection-service.ts` | Collection 权威状态 + 持久化（shared scope） |
| `src/host/services/environment-service.ts` | Environment 权威状态；secret 变量只经 secret-store-service，自身绝不持久化明文 |
| `src/host/services/secret-store-service.ts` | **新增**（REVIEW 中级 #1）：`shared/secrets/` 读写，落盘即 chmod 0600、目录 0700；SecretRef ↔ 明文解析链路的唯一出口；解析结果只存在于执行期内存 |
| `src/host/services/history-service.ts` | profile-scoped history 持久化（JSONL append + retention）；写入前必经 redaction-service |
| `src/host/services/execution-service.ts` | Human/Agent 共用执行入口：调 core executor + network-policy-service + history-service + audit-service |
| `src/host/services/redaction-service.ts` | redactor 的服务化封装：History / API 响应 / Agent Context / Import Report / Error / Logs 统一出口 |
| `src/host/services/profile-service.ts` | 由 M0 profile-probe 演进：§19.1 四级探测；unresolved 时 fail-closed（§4.4） |
| `src/host/services/network-policy-service.ts` | profile scope 策略加载（可继承 shared default）+ core 评估函数的宿主接线 |
| `src/host/services/settings-service.ts` | profile-scoped settings.json 读写 + §25 配置项 schema 校验 |
| `src/host/services/import-service.ts` | 调 postman-adapter 管线 + 落库 + 报告持久化（`imports/`） |
| `src/host/services/audit-service.ts` | 执行审计：source identity（human/agent）、时间、目标 host、结论，落 profile 日志；history 即审计视图（§10） |
| `src/host/services/storage/file-store.ts` | 原子写（tmp+rename）、JSON / JSONL 读写、目录初始化与权限设置 |
| `src/host/tools/register.ts` | 工具统一注册/注销 + 风险等级表 + Approval 挂接点（DSH Permission/Approval 流程） |
| `src/host/tools/api-client-request.ts` | §13.1（schema 与 M0 桩一致，实现换真 executor） |
| `src/host/tools/api-client-run-request.ts` | §13.2 |
| `src/host/tools/api-client-list-collections.ts` | §13.3 |
| `src/host/tools/api-client-list-requests.ts` | §13.4 |
| `src/host/tools/api-client-get-request.ts` | §13.5 |
| `src/host/tools/api-client-get-last-response.ts` | §13.7（永远脱敏，§5.2） |
| `src/host/tools/announcement.ts` | system-prompt announcement 贡献（由 M0 announcement-probe 演进）：告知 agent 工具命名空间与 per-call environment 用法 |

**不创建** `src/host/tools/api-client-switch-environment.ts`（§5.2 D-D1）。

### 3.5 M0 探针文件演进处置（逐文件明确）

| M0 文件 | 处置 | 演进目标 / 方式 |
|---|---|---|
| `src/host/probes/probe-log.ts` | **保留为 internal 开发工具** | WP0–WP8 用于生命周期/热插拔回归记录；WP8 起不再由 `index.ts` 默认装配，移至 `tools/spike/probe-log.ts`，不进运行时 dist 装配图 |
| `src/host/probes/remote-api-probe.ts` | **改造** | ping endpoint 演进为 `api/capabilities.ts` 的 health 字段；鉴权结论直接沉淀进 `api/auth.ts`；探针文件 WP2 删除 |
| `src/host/probes/tool-probe.ts` | **改造** | 回显桩 WP5 被正式 `api_client_request` 取代（schema 不变）；探针文件 WP5 删除 |
| `src/host/probes/profile-probe.ts` | **改造** | WP2 演进为 `services/profile-service.ts`（四级探测逻辑保留，加 fail-closed）；探针文件 WP2 删除 |
| `src/host/probes/announcement-probe.ts` | **改造** | WP5 演进为 `tools/announcement.ts`；探针文件 WP5 删除 |
| `src/client/probe-panel.tsx` | **拆除** | WP3 被正式 `ApiClientView` 取代后删除；其挂载位（slot-adapter / legacy-dom-adapter 的 mount 目标）换成正式视图 |
| `src/client/slots/settings-item-probe.tsx` | **改造** | WP3 演进为正式 `slots/settings-item.tsx`（配置页，§25） |
| `src/client/dsh-adapter/` 8 文件 | **保留并硬化为正式实现** | feature-detect / slot-adapter / legacy-dom-adapter / sidebar-injection / panel-activation / panel-mutual-exclusion / theme-adapter / session-bridge 全部即正式架构（§3.4），WP3 按 WP0 冻结的 UI_ADAPTER_CONTRACT 补强错误处理与 dispose 义务；session-bridge 在 WP7 补 SafeApiDebugContext 真实链路 |

### 3.6 Client 半（`src/client/`）

约束（DESIGN §21，AC-39/40）：DSH UI 内部契约只允许出现在 `dsh-adapter/` 与极薄的 `slots/` 注册层；views/components/hooks 不得直接 import DSH client 包（TC-A-01/03 静态强制）。

| 文件 | 职责 |
|---|---|
| `src/client/index.ts` | client 入口：feature-detect → 按能力矩阵装配 adapter + 注册 slots + 挂载视图；导出 `dispose()` |
| `src/client/dsh-adapter/*` | 见 §3.5（8 文件，正式实现） |
| `src/client/slots/main-view.tsx` | 极薄注册层：把 ApiClientView 注册为 conversation replacement occupant（owner props / `session-maybe` 契约按 WP0 冻结结论） |
| `src/client/slots/settings-item.tsx` | `settings.plugin.item` 注册正式配置页（§25 全配置项） |
| `src/client/slots/conversation-actions.tsx` | conversation header 「返回 API Client」+ 输入区 API Context 状态提示（§3.3；若 WP0 目录证明对应 slot 可用，不可用时整体跳过并记入 Matrix） |
| `src/client/views/ApiClientView.tsx` | 主视图（§4 布局）：顶栏（History / Import / Environment）+ Collection Tree + Request Tabs + Request Editor + Response Viewer |
| `src/client/views/HistoryView.tsx` | History 列表（脱敏快照，source 徽标 human/agent）+ 单条详情 + 「重新执行」（走 SecretRef 链路，AC-32） |
| `src/client/views/EnvironmentView.tsx` | Environment 列表/编辑器；secret 变量 UI 恒显示 `••••••••`，reveal 走 human-present 路径（§8.1） |
| `src/client/views/ImportReportView.tsx` | §15.4 Migration Report 展示 + 逐条兼容度明细 |
| `src/client/components/collection/CollectionTree.tsx` | 树：Collection/Folder/Request 三级、右键 CRUD、排序、搜索、Duplicate |
| `src/client/components/collection/TreeItem.tsx` | 节点渲染 + Method 语义色（§5.2：GET 绿 / POST 橙 / PUT 蓝 / PATCH 紫 / DELETE 红） |
| `src/client/components/request/RequestTabs.tsx` | 多请求 Tab |
| `src/client/components/request/MethodSelector.tsx` | 7 方法下拉（§7.1） |
| `src/client/components/request/UrlBar.tsx` | URL 输入 + Send + Save；`{{var}}` 高亮 |
| `src/client/components/request/ParamsEditor.tsx` | §7.3：重复 Key / 空值 / URL 编码 / 启停 / URL 双向同步 |
| `src/client/components/request/HeadersEditor.tsx` | §7.4：CRUD / 启停 / 自动 Content-Type·Accept 提示 / secret masking / 重复 Header |
| `src/client/components/request/AuthEditor.tsx` | §7.5 V0.1 五项（No Auth / Bearer / Basic / API Key / Inherit） |
| `src/client/components/request/BodyEditor.tsx` | §7.6 V0.1 六种 body 类型切换 |
| `src/client/components/request/JsonEditor.tsx` | format / validate / syntax highlight / error line / compact |
| `src/client/components/request/ScriptsPanel.tsx` | **只读展示**导入的 Postman Scripts + 「不执行」警告（D15） |
| `src/client/components/response/ResponseViewer.tsx` | §8：Status / Latency / Size / Headers / Cookies / Body / Tests（Tests tab 仅展示导入脚本警告） |
| `src/client/components/response/BodyViewer.tsx` | Pretty / Raw / Preview 三态，JSON/Text/HTML/XML |
| `src/client/components/environment/EnvironmentSelector.tsx` | 顶栏环境切换（client 侧选择状态，持久化于 profile settings；**不被 agent 工具突变**，§5.2） |
| `src/client/components/environment/VariableTable.tsx` | 变量表格；secret 行 masking + reveal 按钮 |
| `src/client/components/history/HistoryList.tsx` | §10 示例形态列表 |
| `src/client/components/common/KeyValueTable.tsx` | Params/Headers 共用表格 |
| `src/client/components/common/ConfirmSendToAgent.tsx` | §14.4 出域确认弹窗（明确 ✓/✗ 清单） |
| `src/client/components/common/Modal.tsx` `Toast.tsx` | 通用件 |
| `src/client/hooks/useHostApi.ts` | Host API fetch 封装：自动带 token 与 CSRF header、错误规整 |
| `src/client/hooks/useCollections.ts` `useEnvironments.ts` `useHistory.ts` `useExecute.ts` | 各域数据钩子（Host 为权威状态源，client 只做投影——D16） |

### 3.7 tests / fixtures / scripts

| 文件 | 职责 |
|---|---|
| `tests/`（WP0 已有 4 个 spec 保留） | feature-detect / sidebar-injection / panel-activation / fixtures 骨架 |
| `tests/core-variables.spec.ts` | TC-C-01…05 |
| `tests/core-auth.spec.ts` | TC-C-06…09 |
| `tests/core-request.spec.ts` | TC-C-04/05/10、JSON editor 纯函数 |
| `tests/core-executor.spec.ts` | TC-C-11…17（本地 node 回显 server） |
| `tests/core-collection.spec.ts` | TC-C-18/19 |
| `tests/core-history.spec.ts` | TC-C-20/21 |
| `tests/redaction.spec.ts` | TC-R-01…12 |
| `tests/postman-adapter.spec.ts` | TC-P-01…14 |
| `tests/storage-scope.spec.ts` | TC-S-01…11（tmp 目录 + 权限位断言） |
| `tests/host-api.spec.ts` | TC-API-01…12（router + services 集成，mock 注册面） |
| `tests/tools.spec.ts` | TC-T-01…10 |
| `tests/security.spec.ts` | TC-SEC-01…10 |
| `tests/architecture-boundary.spec.ts` | TC-A-01…03（静态 import 扫描） |
| `fixtures/postman/*.json` | TC-P 用样本：minimal / nested-folders / all-auth / scripts / oauth2 / dynamic-vars / invalid-schema |
| `fixtures/runtime-slot-catalog.json` `fixtures/client-manifest-contract.json` | WP0 输出物（保留，V0.1 正式交付物） |
| `scripts/gen-manifest-contract.ts` | WP0 已有，保留 |

---

## 4. 数据模型与存储契约

### 4.1 实体 TS 接口（落于 `packages/shared/src/types.ts`；§17 全实体 + 执行/安全派生类型）

```ts
// ---- 基础 ----
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'

interface KeyValue {
  key: string
  value: string
  description?: string
  enabled: boolean          // §7.3/§7.4 启停
}

// ---- Auth（§7.5 V0.1 五项）----
type AuthConfig =
  | { type: 'none' }
  | { type: 'bearer'; token: string | SecretRef }
  | { type: 'basic'; username: string; password: string | SecretRef }
  | { type: 'apikey'; key: string; value: string | SecretRef; in: 'header' | 'query' }
  | { type: 'inherit' }     // Inherit Auth From Parent：folder → collection 链向上

// ---- Body（§7.6 V0.1）----
type BodyConfig =
  | { type: 'none' }
  | { type: 'raw'; raw: string }                       // Text
  | { type: 'json'; json: string }
  | { type: 'form-data'; fields: KeyValue[] }
  | { type: 'urlencoded'; fields: KeyValue[] }

// ---- Scripts（D15：只 parse/detect/display/warn，不执行）----
interface ScriptConfig {
  preRequest?: string      // Postman 导入保留原文，仅展示
  tests?: string
  source: 'postman' | 'manual'
  warning: string          // 「V0.1 不执行脚本」标准警告
}

// ---- Request / Collection（§17）----
interface ApiRequest {
  id: string
  name: string
  method: HttpMethod
  url: string                       // 可含 {{var}}
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

interface Folder {
  id: string
  name: string
  folders: Folder[]                 // 任意嵌套（§6 层级）
  requests: ApiRequest[]
}

interface Collection {
  id: string
  name: string
  auth?: AuthConfig                 // 供 inherit 链
  variables: CollectionVariable[]   // 优先级链最低层
  folders: Folder[]
  requests: ApiRequest[]            // 顶层请求
  createdAt: number
  updatedAt: number
}

interface CollectionVariable {
  key: string
  value: string
  enabled: boolean
}

// ---- Environment / Variable（§9 + REVIEW 中级 #1 修订）----
interface Environment {
  id: string
  name: string
  variables: Variable[]
}

interface Variable {
  key: string
  initialValue?: string
  /** secret=true 时只持 SecretRef，明文绝不进入本结构（AC-42） */
  currentValue: string | SecretRef
  secret: boolean
  enabled: boolean
}

// ---- SecretRef（REVIEW 中级 #1）----
interface SecretRef {
  $ref: string        // 稳定不透明 id（uuid），不编码任何明文信息
}

interface SecretRecord {              // shared/secrets/<id>.json 的落盘格式
  id: string
  value: string                       // 仅此文件含明文；0600
  createdAt: number
  updatedAt: number
}

// ---- 执行（§12）----
interface ResolvedRequest {           // 仅执行期内存；可含解析后的 secret
  method: HttpMethod
  url: string                         // 变量已解析
  headers: KeyValue[]
  body?: Uint8Array | string
  secretValueTraces: SecretTrace[]    // 记录哪些位置的值来自 secret（供 redactor）
}

interface SecretTrace {
  location: 'header' | 'query' | 'url' | 'body' | 'auth'
  key: string
  secretRef: string                   // SecretRef.$ref
}

interface HttpExecutionResult {
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
interface RedactedRequestSnapshot {
  method: HttpMethod
  displayUrl: string                  // secret 已替换为 <redacted> / <secret-ref:key>
  headers: KeyValue[]                 // 敏感头值 = '<redacted>'
  bodyPreview?: string                // secret 变量值已脱敏
  auth: { type: AuthConfig['type'] }  // 只留类型，不留材料
}

interface RedactedResponseSnapshot {
  status: number
  statusText: string
  headers: KeyValue[]                 // Set-Cookie 脱敏
  bodyPreview?: string                // 用户声明敏感字段已脱敏；可整体省略
  size: number
  durationMs: number
}

interface ExecutionHistory {
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
  profileId: string                   // §10 有 profileId 字段；profile scope 强制
}

// ---- Import（§15.4）----
interface ImportReport {
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

interface ImportFinding {
  itemPath: string                    // 「Folder/Request」路径
  level: 'warn' | 'info'
  kind: 'script-not-executed' | 'dynamic-variable' | 'auth-downgraded' | 'field-dropped'
  message: string                     // 出场前经 redactor
}

// ---- Agent Context（§14）----
interface CollectionSummary { id: string; name: string; requestCount: number }

interface ExecutionMetadata { historyId: string; durationMs: number; source: 'human' | 'agent' }

interface ApiDebugContext {           // 原始上下文，禁止直接出域
  collection?: CollectionSummary
  request: ApiRequest
  resolvedRequest: ResolvedRequest
  response?: HttpExecutionResult
  environment?: Environment
  execution?: ExecutionMetadata
}

interface SafeApiDebugContext {       // Context Redactor 输出；唯一允许出域形态
  collection?: CollectionSummary
  request: RedactedRequestSnapshot & { name: string }
  response?: RedactedResponseSnapshot
  environmentName?: string            // 只给名字，不给变量
  execution?: ExecutionMetadata
  redactionSummary: string[]          // §14.4 确认弹窗 ✓/✗ 清单的数据源
}

// ---- Network Policy（§24.3）----
interface NetworkPolicy {
  allowLocalhost: boolean             // 默认 false（fail-closed）
  allowPrivateNetwork: boolean        // 默认 false
  allowPublicNetwork: boolean         // 默认 true
  blockedHosts: string[]              // 支持通配 *.example.com
  allowedHosts: string[]              // 非空时白名单模式
  blockedPorts: number[]              // 默认含常见敏感端口基线（见 §8.1）
  redirectPolicy: 'follow' | 'manual-block' | 'none'   // 默认 follow 且每跳再评估
  maxResponseBytes: number            // 默认 10 MiB
  timeoutMs: number                   // 默认 30_000
  dnsRebindingProtection: boolean     // 默认 true
}

// ---- Plugin Settings（§25，profile scope）----
interface PluginSettings {
  defaultTimeoutMs: number
  followRedirects: boolean
  saveHistory: boolean
  maxResponseBytes: number
  historyRetentionDays: number
  networkPolicy: NetworkPolicy        // profile 层，可继承 shared default
  agentPermission: AgentPermissionPolicy
  secretsDisplayPolicy: 'masked'      // V0.1 仅此值；reveal 见 §8.1
  postmanCompatibility: 'strict' | 'lenient'
  activeEnvironmentId?: string        // Human UI 当前环境（client 选择状态的持久化）
}

interface AgentPermissionPolicy {
  highRiskMethodsRequireApproval: boolean      // 默认 true（POST/PUT/PATCH/DELETE）
  hostRules: { host: string; action: 'allow' | 'approval' | 'deny' }[]
}
```

### 4.2 存储布局与 scope（§19 落地，`packages/shared/src/storage-layout.ts` 定义常量）

```text
$DSH_HOME/api-client/
├── shared/
│   ├── collections.json          # Collection[]（含 folders/requests 树）
│   ├── environments.json         # Environment[]；secret 变量 currentValue 只存 SecretRef
│   ├── secrets/                  # 目录权限 0700（REVIEW 中级 #1）
│   │   └── <secretId>.json       # SecretRecord；文件权限 0600
│   └── network-policy.default.json   # shared default，profile 可继承
├── profiles/
│   ├── <profileId>/
│   │   ├── history/
│   │   │   └── history.jsonl     # ExecutionHistory 逐行 append + retention
│   │   ├── settings.json         # PluginSettings
│   │   └── audit.jsonl           # 执行审计（source identity）
│   └── unresolved/               # profile 自省失败时的隔离目录（§4.4，fail-closed 证据）
└── imports/
    └── <importId>.json           # ImportReport 持久化
```

默认 scope（§19 表，D18）：Collections / Environments / Secret references = shared；History / UI Settings = profile；Network policy = profile 可继承 shared default。

写入纪律（file-store.ts 强制）：

- 所有 JSON 写入原子化（tmp + rename）；`secrets/` 目录创建即 0700、文件写入即 0600（umask 不可依赖，显式 chmod，TC-S-06 断言）；
- `environments.json` 序列化前断言：任何 `Variable.secret === true` 的 `currentValue` 必须是 SecretRef，发现明文直接抛错拒写（TC-S-07 的正向机制）；
- LocalStorage 不作为权威状态（§19）。

### 4.3 SecretRef 解析链路（AC-32 / AC-42 的机械保证）

```text
environments.json ──Variable.currentValue = SecretRef──▶
environment-service ──▶ secret-store-service.read($ref)
   （读 shared/secrets/<id>.json，0600；仅此处接触明文）
   ──▶ ResolvedRequest（执行期内存，secretValueTraces 标记来源）
   ──▶ HTTP Executor
   ──▶ history-recorder / redaction-service：按 traces 把解析值替换为
        '<redacted>' 或 '<secret-ref:key>' 后才允许持久化/出域
```

- 重新执行请求 = Saved Request + Environment SecretRef + Executor 重新解析，**绝不从 History 恢复 secret**（AC-32，TC-C-21）；
- 删除 secret：`shared/secrets/<id>.json` 移除；悬空 SecretRef 在解析时显式报错（TC-S-09），不静默置空；
- UI/API/Agent 任何投影中 SecretRef 以 `<secret-ref:envKey>` 展示（§14.2 推荐形态），不解析。

### 4.4 profileId 自省与 fail-closed（D19 + §19.1，M0 U-6 的本设计处置）

四级优先级探测（§19.1）由 profile-service 实现，WP0 V-15 已实测各路可用性。本设计决定 fallback 形态：

- 四路均失败 → `profileId = 'unresolved'`：**profile-scoped 写入（history/settings/audit）一律 fail-closed**——返回显式错误并在 UI 提示「profile 未识别，History 已停用」；shared scope（collections/environments/secrets）不受影响；
- 严禁猜测 profile 名（D19）；
- 该处置留痕 §11 U-N1 待设计评审确认。

---

## 5. API 与工具契约清单

### 5.1 Host API 端点（逐个）

公共契约：

- **Base**：`/api-client`（注册机制依 WP0 对 U-7 的实测结论；M0 V-11 已验证 loopback + 凭证 + 拒绝匿名/跨源的最小形态）；
- **鉴权**：全部端点要求 plugin token（`Authorization: Bearer <plugin-token>` 或 WP0 实测的等价机制）；loopback-first；经 Workbench 反代时要求 trusted-proxy token（§22/§24.4）；
- **CSRF-safe mutation contract**：所有非 GET 请求必须带自定义 header `X-Dsh-Api-Client-Request: 1`（浏览器跨站表单无法伪造自定义头），缺失即 403（TC-API-10）；
- **错误格式**：`{ error: { code: string, message: string } }`，message 出场前经 redaction-service；
- **投影纪律**：任何响应中的 secret 变量/敏感头只出现 `<redacted>` / `<secret-ref:key>`。

| # | 方法/路径 | 请求 | 响应 | 说明 |
|---|---|---|---|---|
| 1 | GET `/api-client/capabilities` | — | `{ version, dshVersion, profileId, features: {...} }` | health + 能力发现（M0 ping 演进） |
| 2 | GET `/api-client/collections` | — | `Collection[]`（投影） | 列表 |
| 3 | POST `/api-client/collections` | `{ name }` | `Collection` | 新建 |
| 4 | GET `/api-client/collections/:id` | — | `Collection` | 单棵完整树 |
| 5 | PATCH `/api-client/collections/:id` | 部分字段 | `Collection` | 重命名/变量/auth |
| 6 | DELETE `/api-client/collections/:id` | — | `204` | 删除 |
| 7 | POST `/api-client/collections/:id/duplicate` | — | `Collection` | Duplicate（§6） |
| 8 | POST `/api-client/collections/:id/reorder` | `{ itemIds: string[] }` | `Collection` | 排序 |
| 9 | POST `/api-client/collections/:id/requests` | `ApiRequest`（无 id）+ `folderId?` | `ApiRequest` | 保存请求（AC-16） |
| 10 | GET `/api-client/requests/:id` | — | `ApiRequest`（投影） | |
| 11 | PATCH `/api-client/requests/:id` | 部分字段 | `ApiRequest` | |
| 12 | DELETE `/api-client/requests/:id` | — | `204` | |
| 13 | POST `/api-client/requests/:id/duplicate` | — | `ApiRequest` | |
| 14 | POST `/api-client/requests/:id/move` | `{ folderId? }` | `ApiRequest` | 跨 folder 移动 |
| 15 | GET `/api-client/environments` | — | `Environment[]`（SecretRef 投影） | |
| 16 | POST `/api-client/environments` | `{ name }` | `Environment` | |
| 17 | PATCH `/api-client/environments/:id` | 部分字段 | `Environment` | 改名/普通变量 |
| 18 | DELETE `/api-client/environments/:id` | — | `204` | |
| 19 | PUT `/api-client/environments/:id/secrets/:key` | `{ value: string }` | `{ secretRef: string }` | **write-only**；任何 GET 永不返回 value |
| 20 | DELETE `/api-client/environments/:id/secrets/:key` | — | `204` | 删 SecretRef + secret 文件 |
| 21 | POST `/api-client/execute` | `{ request?: ApiRequest, requestId?: string, environment?: string }` | `{ result: HttpExecutionResult, historyId, requestEcho: RedactedRequestSnapshot }` | Human/Agent 共用执行入口；response body 原样返回（用户声明敏感字段已脱敏） |
| 22 | GET `/api-client/history?limit&cursor` | — | `ExecutionHistory[]` | 脱敏快照 |
| 23 | GET `/api-client/history/:id` | — | `ExecutionHistory` | |
| 24 | DELETE `/api-client/history` | — | `204` | 清空（human-only，agent 无此工具） |
| 25 | POST `/api-client/import/postman` | `{ collection: unknown, name? }` | `ImportReport` | 管线 §15.3 |
| 26 | GET `/api-client/import/reports/:id` | — | `ImportReport` | |
| 27 | GET `/api-client/settings` | — | `PluginSettings` | |
| 28 | PATCH `/api-client/settings` | 部分字段 | `PluginSettings` | schema 校验 |

### 5.2 Agent 工具契约（定稿清单 6 个；**`api_client_switch_environment` 已去除**）

**D-D1（本设计决定，REVIEW 低级 #5 采纳「去掉」分支）**：不实现 `api_client_switch_environment`。理由：switch 是全局共享状态突变——agent 切换会改动 Human UI 当前环境，可能把后续 Human 请求套进错误环境的 secret，存在竞态且无可接受的锁语义；§13.1 已有 per-call `environment` 参数完整覆盖 agent 场景。环境选择只走两条路：agent 每次调用显式传 `environment`；Human UI 当前环境为 client 侧选择状态（持久化于 profile settings 的 `activeEnvironmentId`，agent 不可写）。留痕 §11 U-N3。

| 工具 | 入参 | 返回 | 风险等级 | Approval 触发条件 |
|---|---|---|---|---|
| `api_client_request` | `{ method, url, headers?, query?, body?, environment? }`（§13.1） | `{ status, statusText, headers, bodyPreview, size, durationMs, historyId }`（**脱敏投影**） | method ∈ {POST,PUT,PATCH,DELETE} = 高；其余 = 中 | 高风险 method 且 `agentPermission.highRiskMethodsRequireApproval`；或命中 hostRules=approval（§24.5） |
| `api_client_run_request` | `{ requestId }` 或 `{ collection, request }` + `{ environment? }` | 同上 | 由目标请求的 method 决定，同上 | 同上 |
| `api_client_list_collections` | — | `CollectionSummary[]` | 低（只读） | 不触发 |
| `api_client_list_requests` | `{ collectionId }` | `{ id, name, method, displayUrl }[]` | 低（只读） | 不触发 |
| `api_client_get_request` | `{ requestId }` | `ApiRequest`（auth 材料/secret 已脱敏的投影） | 低（只读） | 不触发 |
| `api_client_get_last_response` | `{ historyId? }`（缺省取最后一条） | `RedactedResponseSnapshot + RedactedRequestSnapshot` | 低 | 不触发（**永远脱敏**，见下） |

**§13.7 修订（REVIEW 低级 #6，消除「默认」明文出口）**：`api_client_get_last_response` **无条件**返回脱敏投影，工具无任何明文参数、无配置开关。唯一的明文 override 路径在 Human UI：EnvironmentView / HistoryView 中的 reveal 按钮，逐次点击、human-present、仅内存展示、不落盘、不写日志、不进入任何 Agent 可见面（§24.1「默认 UI ••••••••」的机械实现）。留痕 §11 U-N3。

共用纪律：全部工具经 `tools/register.ts` 注册/注销（卸载即时生效，AC-23）；全部走 execution-service → 同一 core executor（D10、§13.8，TC-T-01）；全部经 DSH Permission/Approval 流程（§24.5）；执行结果与错误出场前经 redaction-service；agent 执行写 history `source: 'agent'` + audit.jsonl（AC-19）。

### 5.3 「交给 Agent」出域契约（§14，WP7）

```text
点击 [交给 Agent]
  → Context Redactor(ApiDebugContext) → SafeApiDebugContext
  → ConfirmSendToAgent 弹窗（§14.4 ✓/✗ 清单，数据源 = redactionSummary）
  → 用户确认 → session-bridge：
      Create Session → Activate → Inject context
      （WP0 V-13/14 实测不可直接注入时降级 prefill composer，由用户确认发送）
```

被标记敏感的 response body 默认不注入，需用户在弹窗中主动勾选（§14.4）。

---

## 6. 测试用例 / 场景清单

分两类：**[A] 自动化**（vitest，进 `tests/`）；**[M] 手工运行时场景**（真实 DSH 0.1.2-rc.1，证据写入对应报告）。TC-M0-01…28 为 WP0 子集，保留 M0 设计原编号（定义见 M0_SPIKE_DESIGN.md §4，本文不重复展开，仅在 §7 映射中引用）。

### 6.1 Core 纯函数与执行器（WP1，`tests/core-*.spec.ts`）[A]

| TC | 类型 | 输入/操作 → 预期结果 | 映射 |
|---|---|---|---|
| TC-C-01 | 正常 | URL `{{base_url}}/users` + Environment `base_url` → 解析为环境值 | AC-14 |
| TC-C-02 | 正常 | 同名变量存在于 Local/Environment/Collection 三层 → 取值顺序 Local > Environment > Collection | AC-14 |
| TC-C-03 | 错误 | 引用未定义变量 → 显式报错（变量名列出），不静默置空 | AC-14 |
| TC-C-04 | 边界 | params：重复 key / 空值 / 特殊字符编码 / disabled 行 → 重复 key 全保留、空值保留 `k=`、正确百分号编码、disabled 不进 URL | AC-11 |
| TC-C-05 | 回归 | URL ↔ Params 双向同步纯函数互逆（编辑 URL 反映到表格、编辑表格反映到 URL） | AC-11 |
| TC-C-06 | 正常 | Bearer auth（含 SecretRef token，执行期解析）→ `Authorization: Bearer <token>`；trace 记录该值来源 | AC-15 |
| TC-C-07 | 正常 | Basic auth → `Authorization: Basic base64(user:pass)` | AC-15 |
| TC-C-08 | 正常 | API Key in header / in query 两种形态 → 落到正确位置 | AC-15 |
| TC-C-09 | 正常 | 请求 auth=inherit，folder 无 auth、collection 有 bearer → 应用 collection 的 bearer | AC-15 |
| TC-C-10 | 正常 | 六种 body 序列化：json 自动 `Content-Type: application/json`；urlencoded 正确编码；form-data 边界正确 | AC-12 |
| TC-C-11 | 正常 | 本地回显 server：GET 执行 → 200、durationMs>0、bodyKind 正确 | AC-11 |
| TC-C-12 | 正常 | POST JSON → server 收到的 body 与 Content-Type 正确 | AC-12 |
| TC-C-13 | 正常 | HEAD / OPTIONS 可配置并执行 → server 确认方法正确、HEAD 无 body 解析不挂 | AC-13 |
| TC-C-14 | 边界 | server 延迟 > timeoutMs → 超时错误，消息无明文 secret | AC-34 支撑 |
| TC-C-15 | 边界 | 响应体 > maxResponseBytes → 截断/报错并记录 size | AC-34 支撑 |
| TC-C-16 | 边界 | redirectPolicy=none 遇 302 → 不跟随；follow 时每跳重新过 network policy | AC-34 |
| TC-C-17 | 正常 | JSON/Text/HTML/XML 响应 → bodyKind 分别正确，pretty 输出合法 | AC-11 支撑（Response Viewer 数据源） |
| TC-C-18 | 正常 | Collection/Folder/Request CRUD + 重命名 + 排序 + 搜索 + Duplicate → 树结构符合 §6 层级，Duplicate 深拷贝且新 id | AC-16 |
| TC-C-19 | 正常 | Environment CRUD + 变量启停 + secret 变量绑定 SecretRef → 模型状态正确 | AC-17 |
| TC-C-20 | 正常 | ResolvedRequest（含 secret traces）+ 执行结果 → history 记录中对应位置全部脱敏 | AC-18/28 |
| TC-C-21 | 回归/安全 | 重新执行：从 Saved Request + SecretRef 重建 ResolvedRequest；断言输入不含任何 History 快照数据 | AC-32 |

### 6.2 Redaction（WP1/WP4，`tests/redaction.spec.ts`）[A]

| TC | 类型 | 输入/操作 → 预期结果 | 映射 |
|---|---|---|---|
| TC-R-01 | 正常 | §24.6 五个默认敏感头（大小写混合）→ 值全部 `<redacted>` | AC-28 |
| TC-R-02 | 正常 | auth config bearer token → 投影中只剩 `{type:'bearer'}`，token 不出现 | AC-28 |
| TC-R-03 | 正常 | basic credentials → 不落任何快照 | AC-28 |
| TC-R-04 | 正常 | apikey in query → URL 中该参数值 `<redacted>`，其余 query 保留 | AC-29 |
| TC-R-05 | 正常 | URL userinfo / path 中含 secret trace 值 → `<redacted>` | AC-29 |
| TC-R-06 | 正常 | JSON / form body 中 secret 标记变量的解析值 → `<redacted>`（嵌套 JSON 路径亦覆盖） | AC-28 |
| TC-R-07 | 正常 | response body 中用户声明敏感字段 → `<redacted>`；整体声明敏感时 bodyPreview 省略 | AC-30/31 |
| TC-R-08 | 正常 | 任意投影中的 SecretRef → 展示 `<secret-ref:envKey>`，不解析 | AC-42 |
| TC-R-09 | 错误 | executor 抛错（DNS/超时/被拒）→ error.message 经 redactor，不含 secret 值 | AC-28 |
| TC-R-10 | 安全 | 完整执行 → 落盘 history.jsonl 全文 grep 不到任何已解析 secret 值 | AC-28/29 |
| TC-R-11 | 正常 | Import Report findings 文本经 redactor | AC-26 支撑 |
| TC-R-12 | 回归 | probe-log / 调试 dump 钩子：所有出域字符串统一过 redaction-service 出口 | AC-28 |

### 6.3 Postman Import（WP6，`tests/postman-adapter.spec.ts` + `fixtures/postman/`）[A]

| TC | 类型 | 输入/操作 → 预期结果 | 映射 |
|---|---|---|---|
| TC-P-01 | 正常 | minimal v2.1 collection → 导入成功，报告 full=1 | AC-25 |
| TC-P-02 | 正常 | 三层嵌套 folder → 内部树结构一致 | AC-25 |
| TC-P-03 | 正常 | 七种方法样本 → method 全部保真 | AC-25 |
| TC-P-04 | 边界 | URL 的 raw / host+path / query / `:pathVar` 变量形态 → 正确归一化到 url+params | AC-25 |
| TC-P-05 | 边界 | 含 disabled header 的样本 → enabled=false 保留 | AC-25 |
| TC-P-06 | 正常 | raw / JSON body → body 配置正确 | AC-25 |
| TC-P-07 | 正常 | basic / bearer / apikey auth → 对应 AuthConfig | AC-25 |
| TC-P-08 | 正常 | collection variable → CollectionVariable | AC-25 |
| TC-P-09 | 安全 | 含 pre-request/tests 脚本 → ScriptConfig 保留原文 + 标准警告；**无任何执行**（无 eval/Function 调用，静态断言+运行探针） | AC-26 |
| TC-P-10 | 边界 | oauth2 / digest auth → 降级 No Auth + `auth-downgraded` finding，标记 partial | AC-26/27 |
| TC-P-11 | 边界 | `{{$guid}}` 等 dynamic variables → `dynamic-variable` finding，不预解析 | AC-26 |
| TC-P-12 | 回归 | 一个 item 无法转换 + 其余正常 → 其余照常导入，unsupported=1，**不整体失败** | AC-27 |
| TC-P-13 | 错误 | 非 v2.1 / 非法 JSON → 显式错误，零落库（collections.json 无变化） | AC-25 |
| TC-P-14 | 正常 | urlencoded / formdata body → 字段映射正确 | AC-25 |

### 6.4 Storage Scope 与 Secrets at-rest（WP4，`tests/storage-scope.spec.ts`，tmp 目录）[A]

| TC | 类型 | 输入/操作 → 预期结果 | 映射 |
|---|---|---|---|
| TC-S-01 | 正常 | 首次启动 → §4.2 目录树自动创建 | AC-18 支撑 |
| TC-S-02 | 正常 | 写 collection → 仅 `shared/collections.json` 变化 | AC-16 |
| TC-S-03 | 正常 | 写 history → 仅 `profiles/<pid>/history/history.jsonl` 变化 | AC-18 |
| TC-S-04 | 正常 | 写 settings → 仅 `profiles/<pid>/settings.json` 变化 | AC-17 支撑 |
| TC-S-05 | 错误/安全 | profile 四路探测全失败 → profile-scoped 写返回显式错误，UI 提示语存在，shared 写不受影响（fail-closed，D19） | AC-18 |
| TC-S-06 | 安全 | 写 secret → `shared/secrets/` 目录 0700、文件 0600（stat mode 断言） | AC-42 |
| TC-S-07 | 安全 | secret 变量保存 → `environments.json` 全文不含明文，只含 SecretRef；构造明文注入时序列化层抛错拒写 | AC-42 |
| TC-S-08 | 正常 | 解析链：Environment SecretRef → secret-store → 执行期内存解析值；断言解析结果不回写任何存储 | AC-32/42 |
| TC-S-09 | 错误 | 删除 secret 后再解析悬空 SecretRef → 显式错误（指明 env key），不静默置空 | AC-42 |
| TC-S-10 | 回归 | 并发/中断写入 → 原子写保证无半截 JSON（kill 模拟后文件可解析） | AC-16/18 支撑 |
| TC-S-11 | 边界 | history 超过 retentionDays → 旧条目被清理 | AC-18 支撑 |

### 6.5 Host API（WP2，`tests/host-api.spec.ts`）[A]

| TC | 类型 | 输入/操作 → 预期结果 | 映射 |
|---|---|---|---|
| TC-API-01 | 正常 | GET capabilities → 200，含 version/profileId | AC-41 支撑 |
| TC-API-02 | 正常 | collection CRUD + reorder + duplicate 全端点 → 状态与 §5.1 契约一致 | AC-16 |
| TC-API-03 | 安全 | 写 secret 后 GET environment → 响应只含 SecretRef；全端点扫描无 secret value 出口 | AC-42 |
| TC-API-04 | 正常 | POST execute（临时 GET，本地 server）→ result + historyId + requestEcho（脱敏） | AC-11/20 |
| TC-API-05 | 正常 | POST execute（requestId + per-call environment）→ 用指定环境解析执行 | AC-14/21 支撑 |
| TC-API-06 | 正常 | history list/get/clear → 全部脱敏快照；clear 后为空 | AC-18 |
| TC-API-07 | 正常 | POST import/postman → ImportReport + collectionId，collection 可读 | AC-25 |
| TC-API-08 | 安全 | 无 token 请求任意端点 → 401/403 | AC-33 |
| TC-API-09 | 安全 | 非 loopback 且无 trusted-proxy token → 拒绝；伪造 origin → 拒绝 | AC-33 |
| TC-API-10 | 安全 | mutation 缺 `X-Dsh-Api-Client-Request: 1` → 403 | AC-33 |
| TC-API-11 | 正常 | execute 带 human 标识 → history source=human；agent 通道 → source=agent，audit.jsonl 有对应记录 | AC-18/19 |
| TC-API-12 | 边界 | settings patch 非法值（负数 timeout 等）→ 400 + 校验消息 | AC-34 支撑 |

### 6.6 Agent Tools（WP5，`tests/tools.spec.ts`）[A]

| TC | 类型 | 输入/操作 → 预期结果 | 映射 |
|---|---|---|---|
| TC-T-01 | 回归 | `api_client_request` 与 Human Send 调用同一个 execution-service/core executor（模块级断言，无双套 HTTP client） | AC-20 |
| TC-T-02 | 正常 | `api_client_run_request`（requestId + per-call environment）→ 执行保存请求并返回脱敏结果 | AC-21 |
| TC-T-03 | 回归 | 注册表全部工具名匹配 `^api_client_`，且与 `dsh-http` 的 `http_request` 不冲突 | AC-22 |
| TC-T-04 | 安全 | 各工具返回体 grep 不到已解析 secret 值 | AC-28/31 |
| TC-T-05 | 安全 | `api_client_get_last_response` → 脱敏投影；工具 schema 中**不存在**任何明文开关参数 | AC-31 |
| TC-T-06 | 回归 | 注册表中**不存在** `api_client_switch_environment`（D-D1 回归锁） | AC-22 |
| TC-T-07 | 权限 | agent 调 POST/PUT/PATCH/DELETE → 触发 Approval 挂接（mock permission hook 断言被调）；GET 不触发 | AC-35 |
| TC-T-08 | 正常 | list_collections / list_requests / get_request → 投影正确且 auth 材料脱敏 | AC-22 |
| TC-T-09 | 正常 | agent 执行 → history source=agent 且与 human 同一存储体系 | AC-19 |
| TC-T-10 | 回归 | dispose 后工具注册表为空（自动化部分；运行时部分见 TC-M0-22/27） | AC-23 |

### 6.7 Security（WP8，`tests/security.spec.ts`）[A]

| TC | 类型 | 输入/操作 → 预期结果 | 映射 |
|---|---|---|---|
| TC-SEC-01 | 安全 | 默认策略下请求 `http://localhost/…` / `127.0.0.1` → 拒绝，错误消息指明 policy | AC-34 |
| TC-SEC-02 | 安全 | 默认策略下请求 10/8、172.16/12、192.168/16、169.254/16 → 拒绝；`allowPrivateNetwork=true` 后放行 | AC-34 |
| TC-SEC-03 | 正常 | blockedHosts（含 `*.example.com` 通配）→ 命中即拒；allowedHosts 非空时白名单外全拒 | AC-34 |
| TC-SEC-04 | 安全 | blockedPorts 命中（如 22/6379 基线）→ 拒绝 | AC-34 |
| TC-SEC-05 | 安全 | DNS 先解析到公网、执行期重绑定到 127.0.0.1（mock resolver）→ 被 DNS rebinding 防护拒绝 | AC-34 |
| TC-SEC-06 | 安全 | 公网 URL 302 跳转到私网地址 → 跳转目标再评估后被拒 | AC-34 |
| TC-SEC-07 | 边界 | maxResponseBytes / timeoutMs 经 settings 修改后生效 | AC-34 |
| TC-SEC-08 | 安全 | /execute 匿名/跨源/缺 CSRF header 三向拒（复跑 TC-API-08/09/10 于最终装配） | AC-33 |
| TC-SEC-09 | 权限 | hostRules 配置 host=approval → 该 host 的 GET 也需 Approval；host=deny → 全拒 | AC-35 |
| TC-SEC-10 | 安全 | 每次执行（human+agent）→ audit.jsonl 含 source identity / 时间 / 目标 host / 结论 | AC-19 |

### 6.8 架构边界（全 WP 门禁，`tests/architecture-boundary.spec.ts`）[A]

| TC | 类型 | 输入/操作 → 预期结果 | 映射 |
|---|---|---|---|
| TC-A-01 | 回归 | 静态扫描 `src/client/**`：仅 `dsh-adapter/` 与 `slots/` 允许 import DSH client 包 | AC-39 |
| TC-A-02 | 回归 | 静态扫描 `packages/core`、`packages/postman-adapter`、`packages/shared`：零 DSH import、零 React import | AC-40 |
| TC-A-03 | 回归 | 静态扫描 `src/client/views|components|hooks`：不直接 import DSH 包，只经 adapter 暴露的契约 | AC-39 |

### 6.9 手工运行时场景（WP3/WP5/WP7/WP8，真实 DSH 0.1.2-rc.1）[M]

| TC | 类型 | 输入/操作 → 预期结果 | 映射 |
|---|---|---|---|
| TC-UI-01 | 正常 | 安装完整插件 → New Session 下方入口唯一；点击 → ApiClientView（Collection Tree + Editor + Response Viewer 完整呈现） | AC-01/04 |
| TC-UI-02 | 回归 | 切换会话/折叠展开/切主题/新建会话各 3 次 → 入口自愈、唯一、无闪烁（完整 UI 下复跑） | AC-02 |
| TC-UI-03 | 回归 | `patchReload: live` 下 add/remove 完整插件 3 轮 → 全程不重启 DSH，卸载后入口/Observer/panel/工具/端点零残留；数据目录默认保留 | AC-03/43/23 |
| TC-UI-05 | 正常 | 主视图经官方 conversation replacement 呈现 ApiClientView；契约符合 WP0 冻结的 UI_ADAPTER_CONTRACT | AC-05 |
| TC-UI-06 | 正常 | 切换到 CSS takeover fallback（settings 或 feature-detect 结果）→ Conversation DOM 保持 mounted，草稿/滚动保留 | AC-06 |
| TC-UI-07 | 正常 | panel 激活中点击任一 Session → yield，官方 Conversation 恢复 | AC-07 |
| TC-UI-08 | 正常 | Settings → Plugins → API Client 配置页：§25 全配置项可读改并持久化 | AC-09 |
| TC-UI-09 | 正常 | 暗色主题 + sidebar 折叠：完整 UI 配色跟随 DSH Theme Token，折叠态入口仅图标 | AC-10 |
| TC-UI-10 | 正常 | UI 建 GET 请求，URL 用 `{{base_url}}` → Send 后 Response Viewer 显示 Status/Latency/Size/Pretty body | AC-11/14 |
| TC-UI-11 | 正常 | UI 建 POST JSON → 执行成功，Response Headers/Cookies tab 有内容 | AC-12 |
| TC-UI-12 | 正常 | Method 下拉选 HEAD / OPTIONS → 可配置可执行 | AC-13 |
| TC-UI-13 | 正常 | Save 到 Collection（含选 folder）→ 树中出现；重命名/排序/搜索/Duplicate/删除均生效且刷新后持久 | AC-16 |
| TC-UI-14 | 安全 | Environment 编辑：新建环境、加 secret 变量（UI 恒显示 `••••••••`）、顶栏切换环境 → 请求按新环境解析；reveal 按钮逐次点击才内存展示 | AC-17 |
| TC-UI-15 | 正常 | 发若干请求 → HistoryView 列表（method/displayUrl/source 徽标）；打开单条为脱敏快照；「重新执行」成功且不向 History 回读 secret | AC-18/32 |
| TC-UI-16 | 回归 | 停用插件 → 会话中 agent 调 `api_client_*` 失败/工具不可见；启用恢复 | AC-23 |
| TC-UI-17 | 安全 | 点「交给 Agent」→ 弹窗列出 ✓ 发送项/✗ secret 明文 → 确认后新 Session 创建并注入（或降级 prefill 由用户确认）；注入内容 grep 无 secret | AC-24/30 |
| TC-UI-18 | 正常 | `dsh plugin --profile workbench add link:<本仓库>` → 可安装、可打开、capability 可由安装状态推导（AC-36/37 的本仓库侧义务实证） | AC-36/37 |
| TC-UI-19 | 正常 | UI 导入 postman fixture（含脚本与不兼容 auth）→ ImportReportView 显示 §15.4 报告，导入不中断 | AC-25/26/27 |
| TC-UI-20 | 正常 | Method 语义色（GET 绿/POST 橙/PUT 蓝/PATCH 紫/DELETE 红）在树与 Tabs 中正确；暗色下对比正常 | AC-10 支撑 |

（TC-UI-04 编号保留给 WP0 探针阶段场景，正式场景自 TC-UI-01 起不重号。）

---

## 7. 验收标准（AC-01…AC-43，逐条可核验）

「WP」列为最终交付该条的工作包；「TC」列为覆盖该条的用例（WP0 的 TC-M0 作为前置验证一并列出）。

### DSH 集成

| AC | 标准 | TC 覆盖 | WP |
|---|---|---|---|
| AC-01 | 安装插件后 New Session 下方出现 API Client | TC-M0-12；TC-UI-01 | WP3 |
| AC-02 | DSH React 重渲染后入口可自愈且不重复 | TC-M0-03/04/05/13；TC-UI-02 | WP3 |
| AC-03 | 卸载插件后入口、Observer、Panel、Tool 全部移除（数据默认保留） | TC-M0-06/27；TC-UI-03 | WP8 |
| AC-04 | 点击 API Client 主区域进入 ApiClientView | TC-UI-01 | WP3 |
| AC-05 | 优先使用官方 Slot 主视图路径 | TC-M0-14；TC-UI-05 | WP3 |
| AC-06 | Slot replacement UX 不可接受时可切换 Legacy CSS takeover | TC-M0-16/17；TC-UI-06 | WP3 |
| AC-07 | 点击 Session 后恢复 DSH Conversation | TC-M0-15；TC-UI-07 | WP3 |
| AC-08 | 与其他插件 Panel 互斥，不出现双 Panel | TC-M0-18 | WP3 |
| AC-09 | Settings 插件项通过官方 Slot 接入 | TC-M0-19；TC-UI-08 | WP3 |
| AC-10 | Theme / Sidebar collapse 正常 | TC-M0-20；TC-UI-09/20 | WP3 |

### API Client

| AC | 标准 | TC 覆盖 | WP |
|---|---|---|---|
| AC-11 | GET 可正常执行 | TC-C-11；TC-API-04；TC-UI-10 | WP3 |
| AC-12 | POST JSON 可正常执行 | TC-C-10/12；TC-UI-11 | WP3 |
| AC-13 | HEAD / OPTIONS 可正常配置 | TC-C-13；TC-UI-12 | WP3 |
| AC-14 | `{{base_url}}` 正确解析（含优先级链与未定义报错） | TC-C-01/02/03；TC-API-05；TC-UI-10 | WP1 |
| AC-15 | Bearer / Basic / API Key 正确应用（含 inherit） | TC-C-06/07/08/09 | WP1 |
| AC-16 | 请求可保存到 Collection（CRUD/排序/搜索/Duplicate/持久化） | TC-C-18；TC-API-02；TC-S-02/10；TC-UI-13 | WP3 |
| AC-17 | Environment 可编辑/切换 | TC-C-19；TC-UI-14 | WP4 |
| AC-18 | Human 请求进入 profile-scoped History | TC-S-03/05/11；TC-API-06/11；TC-UI-15 | WP4 |
| AC-19 | Agent 请求进入同一审计体系且 source=agent | TC-T-09；TC-API-11；TC-SEC-10 | WP5 |

### Agent

| AC | 标准 | TC 覆盖 | WP |
|---|---|---|---|
| AC-20 | `api_client_request` 使用同一 HTTP Executor | TC-T-01；TC-API-04 | WP5 |
| AC-21 | `api_client_run_request` 可执行保存请求 | TC-T-02 | WP5 |
| AC-22 | 所有工具使用 `api_client_*` 命名空间（且无 switch_environment） | TC-T-03/06/08；TC-M0-12 | WP5 |
| AC-23 | 工具卸载时立即注销 | TC-T-10；TC-M0-22/27；TC-UI-16 | WP8 |
| AC-24 | 「交给 Agent」可创建/打开 DSH 原生 Session 或安全降级到 composer prefill | TC-M0-23/24；TC-UI-17 | WP7 |

### Postman

| AC | 标准 | TC 覆盖 | WP |
|---|---|---|---|
| AC-25 | Postman v2.1 Collection 可导入 | TC-P-01…08/13/14；TC-API-07；TC-UI-19 | WP6 |
| AC-26 | 不兼容 Script 生成 Migration Report（不执行） | TC-P-09/10/11；TC-R-11；TC-UI-19 | WP6 |
| AC-27 | 部分不兼容不阻断整体导入 | TC-P-10/12；TC-UI-19 | WP6 |

### Security

| AC | 标准 | TC 覆盖 | WP |
|---|---|---|---|
| AC-28 | History 永不持久化 Authorization/Cookie/API Key 明文 | TC-R-01/02/03/06/09/10/12；TC-C-20 | WP4 |
| AC-29 | URL/query 中 secret 同样脱敏 | TC-R-04/05/10 | WP4 |
| AC-30 | Agent Context 不含 Environment secret 明文（无条件，非「默认」） | TC-R-07；TC-UI-17 | WP7 |
| AC-31 | Agent `get_last_response` 返回 redacted projection（工具无明文出口） | TC-T-05；TC-R-07 | WP5 |
| AC-32 | 重新执行从 SecretRef/Environment 解析，不从 History 恢复 secret | TC-C-21；TC-S-08；TC-UI-15 | WP4 |
| AC-33 | Host `/execute` 不允许匿名远程调用 | TC-API-08/09/10；TC-SEC-08；TC-M0-21 | WP2 |
| AC-34 | Private network / localhost 行为受 Network Policy 控制 | TC-SEC-01…07；TC-C-14/15/16 | WP8 |
| AC-35 | 高风险 Agent mutation 可进入 Approval | TC-T-07；TC-SEC-09 | WP5 |

### Workbench（按 REVIEW_NOTES 修订理解：本仓库侧义务）

| AC | 标准 | TC 覆盖 | WP |
|---|---|---|---|
| AC-36 | 本插件作为普通第三方插件可被 registry / 本地 link 安装于 workbench profile（本仓库不做 Workbench 专用页） | TC-UI-18；TC-M0-10 | WP8 |
| AC-37 | 不以 npm 未发布为阻塞：link 安装态即可被发现、可使用 | TC-UI-18 | WP8 |
| AC-38 | V1.1 embedded surface 只有通过独立 Spike 才启用——本仓库零代码义务，文档级声明成立即通过 | 设计声明（本节 + §1.2 非目标），无可执行 TC | — |

### Compatibility

| AC | 标准 | TC 覆盖 | WP |
|---|---|---|---|
| AC-39 | DSH 内部 UI 变化只需修改 `dsh-adapter/`（+slots 薄层） | TC-A-01/03 | 全 WP 门禁 |
| AC-40 | Core / HTTP Executor / Postman Adapter 不 import DSH UI 包 | TC-A-02 | 全 WP 门禁 |
| AC-41 | 可公开的 Capability Compatibility Matrix | TC-M0-08/09/28；TC-API-01 | WP0 |

### 新增（REVIEW_NOTES 进入范围）

| AC | 标准 | TC 覆盖 | WP |
|---|---|---|---|
| **AC-42** | shared secrets at-rest 保护：`shared/secrets/` 目录 0700、文件 0600；`environments.json` 只存 SecretRef（明文注入被拒写）；SecretRef 解析链唯一出口为 secret-store-service，解析值仅执行期内存；悬空 SecretRef 显式报错 | TC-S-06/07/08/09；TC-R-08；TC-API-03 | WP4 |
| **AC-43** | 插件热插拔不重启 DSH（AC-M0-17 晋升）：`patchReload: live` 下热安装全量生效、热卸载零残留，连续 3 轮无泄漏；完整插件形态下复验 | TC-M0-27；TC-UI-03 | WP0/WP8 |

**覆盖核对**：AC-01…37、39…43 每条至少 1 个 TC；AC-38 为本仓库零代码义务的文档级 AC，已显式标注，不虚构 TC。

---

## 8. 安全设计落地清单

### 8.1 §24 各项 → 文件与机制

| §24 项 | 落地文件 | 机制 |
|---|---|---|
| 24.1 Secret 生命周期 | `shared/secret-ref.ts`；`environment-service.ts`；`secret-store-service.ts`；`variables/resolver.ts` | 三态机械分离：SecretRef（持久化）→ Resolved Secret（仅 ResolvedRequest 内存，带 traces）→ Redacted Projection（UI/History/Agent 唯一出域形态）。UI 恒 `••••••••`；reveal 仅 human-present 逐次点击、内存展示、不落盘不写日志（§5.2） |
| 24.2 全链路 Redaction | `core/security/redactor.ts` + `redaction-service.ts` | 覆盖 History / Agent Context / Logs / Import Report / Error Message / Telemetry / Debug dump 七个面（TC-R-01…12）；敏感位置：Headers / Cookies / Query / URL / Auth config / JSON·Form Body / Environment / Response 用户声明字段。所有出域字符串统一经 redaction-service 出口 |
| 24.3 SSRF / Network Policy | `core/security/network-policy.ts`（纯评估）+ `network-policy-service.ts`（加载）+ `executor/http-client.ts`（执行点） | §24.3 全配置项；默认 fail-closed（localhost/private 拒、public 放）；DNS rebinding：连接前解析一次并固定 IP、redirect 每跳重新评估；blocked ports 基线含 22/23/25/3306/5432/6379/27017；max response / timeout 强制 |
| 24.4 Host API Auth | `api/auth.ts` + `api/router.ts` | loopback-first；plugin token；trusted-proxy token（Workbench 反代场景）；mutation 强制 `X-Dsh-Api-Client-Request: 1` 自定义头（CSRF-safe）；audit source identity 提取；禁止匿名 `/execute`（AC-33） |
| 24.5 Agent Permission | `tools/register.ts` + `settings-service.ts`（AgentPermissionPolicy） | POST/PUT/PATCH/DELETE 默认高风险进 Approval（TC-T-07）；支持 host/path 级 allow/approval/deny 规则（TC-SEC-09）；Human Send 按 human permission policy 不经 agent 通道 |
| 24.6 Sensitive Headers | `core/security/sensitive-headers.ts` | Authorization / Cookie / Set-Cookie / X-API-Key / Proxy-Authorization，大小写不敏感（TC-R-01） |
| 24.7 Postman Scripts 不执行 | `postman-adapter/compat-scanner.ts` + `ScriptsPanel.tsx` | V0.1 只 parse/detect/display/warn；**代码库内禁止** `eval(` / `new Function(`（TC-P-09 静态断言 + TC-A 扫描规则）；未来 Scripts Sandbox 属 V0.3 |
| REVIEW 中级 #1 at-rest | `secret-store-service.ts` + `file-store.ts` | `shared/secrets/` 0700 / 文件 0600 显式 chmod；`environments.json` 序列化前断言 secret 变量只持 SecretRef（AC-42） |

### 8.2 高危核查点（WP8 出口逐项签字）

1. **executor 网络策略强制执行点**：permission check 与 network policy check 在发起连接**之前**完成，且 redirect 每跳重评估（TC-SEC-05/06）；
2. **redactor 覆盖所有持久化/出域路径**：history.jsonl、audit.jsonl、API 响应、工具返回、Import Report、error、log/dump 逐面 grep 验证（TC-R-10/12、TC-T-04）；
3. **`/execute` 三向拒绝**：匿名 / 非可信来源 / 缺 CSRF header（TC-SEC-08）；
4. **at-rest 权限与零明文**：`secrets/` 0700、文件 0600；`environments.json` 与 history.jsonl 全文无已写入 secret 明文（TC-S-06/07、TC-R-10）；
5. **Agent mutation Approval**：高风险方法与 hostRules 规则真实触发 DSH Approval（TC-T-07、TC-SEC-09）；
6. **Scripts 零执行**：全仓库无 `eval` / `new Function` 动态执行不可信脚本（TC-P-09）；
7. **secret-store 唯一出口**：全仓库只有 `secret-store-service.ts` 读 `shared/secrets/`（代码评审 + 静态扫描确认）。

---

## 9. 风险等级声明

**高危。** 判定依据（角色指令：涉及鉴权、密钥处理任一即高危，本条两者皆占）：

- **鉴权**：Host API 具备任意网络请求能力，需 loopback/token/CSRF/trusted-proxy 四层边界（§24.4、AC-33）；
- **密钥处理**：SecretRef 解析链、at-rest 0600/0700、全链路 Redaction（AC-28/29/42）；
- 附带：Agent 自动 mutation 需 Approval（AC-35）；SSRF 面（AC-34）。

缓解：§8.1 的机制全部有对应自动化用例；§8.2 七个高危核查点作为 WP8 出口签字项；探针阶段（WP0）不接触真实 secret、executor 探针不发网络请求。

其余风险沿用 DESIGN §32：DSH Developer Preview 契约演进（dsh-adapter 隔离 + feature-detect + fixtures 固化 + TC-A 门禁对冲）、Sidebar DOM 注入（WP0 已验证 + 自愈/去重/dispose 义务）、Conversation replacement UX（WP0 GO/NO-GO 决策 + CSS takeover fallback）、Postman Script（V0.1 不执行）。

## 10. 后端是否无改动标注

**不适用「无改动」——本仓库为全新插件，后端类代码（`src/host/` + `packages/core` 等）全部为新增**；即本设计**有后端（Host 半）开发**，实现角色不得按「后端无改动」跳过 host 侧任何 WP。同时明确：**不修改 DSH 本体、不修改 dsh-workbench 仓库、不修改任何外部服务**（D3、§3.6 zero DSH source patch；Workbench registry yaml 归 dsh-workbench 维护，U-N5）。

## 11. 未决决策列表

### 11.1 继承自 M0（U-1…U-8），全部由 WP0 实测闭环

| # | 未决点 | 状态 |
|---|---|---|
| U-1 | dist 模块格式（ESM/CJS）与 scanner 期望 | WP0 V-16 实测 → CLIENT_MANIFEST_CONTRACT |
| U-2 | client bundle 中 React / DSH client 包 external 还是内联 | WP0 V-16 实测 |
| U-3 | 深链 token 最终形态（`#api-client` hash / query / 路由段） | WP0 V-05 深链子项实测 → UI_ADAPTER_CONTRACT |
| U-4 | conversation slot 确切 key / owner props / priority 区间 | WP0 V-02 运行时目录 |
| U-5 | `patchReload: live` 确切配置名与位置 | WP0 V-17 实测 |
| U-6 | profile 不可自省时 V0.1 安全 fallback 形态 | **WP0 V-15 提供实测输入；fallback 形态已由本设计定为 fail-closed（§4.4），转入 U-N1 待评审确认** |
| U-7 | Host Remote API 注册机制与鉴权原语 | WP0 V-11 实测；§5.1 端点契约按实测结论接线 |
| U-8 | vitest 选型 | 本设计已采纳（与 M0 一致），随本设计评审一并确认 |

### 11.2 新增（本设计决定项，待设计评审确认）

| # | 决策点 | 本设计的处置 | 留痕原因 |
|---|---|---|---|
| U-N1 | profile unresolved 的 fallback 形态 | fail-closed：profile-scoped 写入显式报错并提示，shared 不受影响（§4.4） | D19 只禁止「猜测」，未指定具体形态 |
| U-N2 | secrets at-rest 是否加加密层 | V0.1 只做权限基线（0700/0600 + SecretRef 分工），加密归 V0.3 Advanced Secret Providers | REVIEW 中级 #1 字面只要求权限分工；若评审要求加密需加 WP |
| U-N3 | `api_client_switch_environment` 去除 + `get_last_response` 无明文出口 | 工具定稿 6 个；环境只走 per-call 参数；明文 override 仅 human-present reveal（§5.2） | REVIEW 低级 #5 给的是「去掉，或写明竞态语义」二选一，本设计选「去掉」；#6 选了最严解释 |
| U-N4 | Collection Export 移出 V0.1 | §1.2 非目标；`core/export/` 不创建 | REVIEW §四编辑项第 3 条为「补 AC 或移除」二选一，本设计选「移除」；若评审要求保留需补 AC 与 WP1 工作量 |
| U-N5 | Workbench registry `dsh-api-client.yaml` 归属 | 归 dsh-workbench 仓库维护；本仓库只保证可安装性（TC-UI-18） | §26.4 保留了 registry 更新思路，但 yaml 落在对侧仓库 |
| U-N6 | `conversation-actions.tsx`（header「返回 API Client」/ 输入区状态提示） | 以 WP0 运行时目录为准：对应 slot 存在才实现，不存在则整体跳过并记入 Matrix | §3.3 为「后续可」类增量能力，非 AC 强制项 |
| U-N7 | History 单条 bodyPreview 的大小上限 | 默认截断 64 KiB（超出标记 truncated），可在 settings 调整 | DESIGN 未给数值 |

---

> 本文与 M0_SPIKE_DESIGN.md 的关系：WP0 全部内容以 M0 设计原文为准（17 项验证、TC-M0-01…28、6 输出物契约），本文只做并入与衔接，未改写其任何条款。
