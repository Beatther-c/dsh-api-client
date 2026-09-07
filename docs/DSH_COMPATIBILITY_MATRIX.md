# DSH Compatibility Matrix（against 0.1.2-rc.1）

> 行按**能力**组织（M0 §6.1、DESIGN §30、D26）。实测环境：macOS，DSH web profile（HTTP 127.0.0.1:3080），官方 shell（ui-sidebar，codex-ui 禁用），样本插件 `dsh-api-client@0.0.1-spike.0` 经 `dsh plugin --profile web add link:` 安装。
> 「实测结果」列只写已实证的事实；每项的证据见 `docs/M0_SPIKE_REPORT.md` 对应 V-xx 条目与 `docs/evidence/m0/`。

| 能力 | 官方路径 | Fallback | 实测结果 | 证据(V-xx) | 风险/备注 |
|---|---|---|---|---|---|
| sidebar 入口 | 无 New Session 下方官方席位；唯一官方加法是 `sidebar.footer.action`（list/root，现占 cordis-panel） | DOM 注入（MutationObserver 自愈） | DOM 注入稳定：入口唯一、在 New Session 之后；摘除后 50ms 内同帧重插；折叠/展开两态跟随 | V-03/04/12/13 | selector 锚定官方 shell DOM（logoRow/New Session button）；codex-ui 接管 shell 时锚点失效（shell 依赖，已实测） |
| 主视图 replacement | `conversation` slot（single/session-maybe）注册替代 occupant | — | 可替代：激活后 occupants=[dsh-api-client]，官方 composer 隐藏；owner props 收到 sessionId | V-01/02/05 | 同优先级时挂载顺序决定胜负（H5 同为 p0），不要依赖优先级 |
| replacement 下的状态保留 | DSH store 层 | — | 草稿文本与滚动位置在 replacement 期间存活在 store 层，yield 后完整恢复 | V-06 | 官方 React 树确实被卸载；保留的是 store 状态不是 DOM |
| yield（让位） | 订阅 `sessions.list.getSnapshot().current` 变化 → deactivate | — | 三条 yield 路全通：Close 按钮 / 会话行点击 / 持久化选择恢复（pending→ready 边沿） | V-05/06 | 武装点必须是首个 `phase:'ready'` 快照，否则冷启动误 yield（修 #4/4b） |
| CSS takeover fallback | — | 会话列 `visibility:hidden` + 绝对定位 overlay（子树保持挂载） | 稳定：takeover/restore 精确还原 inline style；可重复激活 | V-07/17 | 两个已修缺陷：激活早于会话列挂载会永久放弃（修 #10 重试）；overlay 继承 `visibility:hidden` 导致面板不可见（修 #10 显式复位） |
| settings 插件卡片 | `settings.plugin.item`（keyed/root，key=命名空间） | — | 可用但**双重门控**：client keyed 注册 + Host describe 镜必须声明同名命名空间，缺一不渲染 | V-09/19 | Host 侧 `settings.installSection(ownerCtx, ns, schema, entry, {setSource, onChange})`；schema 用 @deepseek-ai/schemastery（3.18.2 无 `.optional()`，字段默认可选，`.default()` 可用） |
| theme | client ctx `theme` 服务（preference/snapshot/media/overrides） | body 上的 `--dsw-alias-*` CSS 变量 | context 读数随切换更新（dark/light source:context）；内建主题 `active.tokens` 为空冻结对象，真实 token 在 `--dsw-alias-*` | V-10/20 | theme 服务与 plugin apply 竞态：`ctx.get('theme')` 首次为 undefined，需 `ctx.inject(['theme'])` 重读（修 #5） |
| 互斥（panel 排他） | **无总线**；task-board 用硬编码对等名协议 | 镜像协议：`dsh-panel-activate` 事件 + `data-dsh-<name>-active` html 属性 | **单向**实证：我激活→task-board 隐藏；task-board 激活→我让位；再点我→task-board 不让位（双 panel 共存） | V-08/18 | task-board 只认 `event.detail === siblingPanelName`（硬编码 'ssh'）；其 panelName='taskboard'。契约缺口：pairwise 硬编码，新 panel 需逐一对齐 |
| host Remote API | `webServer` 服务注册路由 | — | 注册/注销随生命周期；匿名与跨源 403、同源/带 Origin 200；拒绝事件可观测 | V-11/21 | 鉴权边界实证符合预期（loopback+凭证） |
| agent tool | `tools.register(defineTool(...))` + `systemPrompt` announcement | — | agent 在会话中成功调用 `api_client_request` 并拿到 echo 桩返回（"1 次工具调用"） | V-12/22 | announcement（order 900）注入系统提示生效；工具发现→调用→回显全链路通 |
| session 创建 | `sessions.create({workspaceId})` + `sessions.open(id)`（client 公开 API） | — | 公开可用：创建并激活新会话实证 | V-13/23 | **裸 `create()` 得到无工作区会话，composer 禁用**（contenteditable=false 占位）；必须绑定 workspaceId（修 #12b，ui-workspace navigation 同款用法） |
| context 注入 / composer prefill | 无 composer service（ctx.get('composer') 为 undefined） | DOM prefill | 官方路径**不存在**；DOM 路径可行但必须是富编辑器感知写入 | V-14/24 | composer 是 Lexical 编辑器：裸 textContent 写入被 reconciliation 清除（实测）；`execCommand('insertText')` 可存活（修 #12c）；只预填不发送（§14.3 用户确认） |
| profile 自省 | loader-metadata / DSH_PROFILE | — | `{profileId:"web", source:"loader-metadata"}`（DSH_PROFILE 未设，profiles/web/package.json 命中） | V-15/26 | 四级探测前两级实测；runtime-metadata 未命中 |
| manifest 契约 | `exports["./client"]` + `dsh.client.platform="web"` | — | 正向：combo 服务 200、client 启动；负向：缺 `./client` → **整树 boot 失败** | V-16/10/11 | 错误原文见 CLIENT_MANIFEST_CONTRACT.md；manifest 改动不被 live 重组重读（pkgMeta 按 sourceKey 进程级缓存），需进程重启 |
| 热插拔 | `patchReload: live` 重组 | 进程重启 | 配置/生命周期热重组可用（disabled override 卸载全序列 ~8s、ping 404、零残留；删 override 回挂）；**host 代码与 manifest 缓存不破** | V-17/27 | 4 轮实测 + 1 次回弹异象（见 REPORT）；U-5 结论：代码级变更必须重启进程 |
| 深链激活 | DSH router 不吃 hash；自有 token `#api-client` | — | 冷启动 + hashchange 均直达 panel | V-05 | token 为 M0 占位形式（U-3），M1 定正式形式 |

## 探测方法（feature-detect + runtime catalog + adapter capability matrix）

1. **feature-detect**：client apply 时对 `ctx.slots` 门面做形状探测（register/inject/entries/entriesOfSlot/snapshot/spec/subscribe/getVersion/renderSlot），并对三个目标 slot 做 `spec()` 声明探测；结果进 `data.features` 与 probe panel。
2. **runtime catalog**：`window.__DSH_API_CLIENT_PROBE__.snapshot()` 抓取活树全量 slot 快照（归档 `docs/evidence/m0/slot-snapshot-official-shell.json`），整理进 `fixtures/runtime-slot-catalog.json`；cordis_inspect 交叉核验（TC-M0-28，list/self 可用，query 带参有桥接 bug）。
3. **adapter capability matrix**：每条能力在 dsh-adapter 内有独立探针模块（sidebar-injection / slot-adapter / legacy-dom-adapter / theme-adapter / panel-mutual-exclusion / session-bridge / settings-item-probe），各自记录能力判定与降级点到 probe panel 与 console。

## 版本适用性声明

本矩阵全部结论仅对 **DSH 0.1.2-rc.1（web profile，官方 shell）** 负责。DSH 处于 Developer Preview，slot 表、settings 门控、互斥协议、client-modules 扫描语义均为演进中契约；codex-ui 等 takeover shell 会改变 sidebar 相关行的前提。升级 DSH 后应按 `docs/M0_SPIKE_DESIGN.md` §3 重跑 17 项验证再引用本矩阵。

---

## 补记（V0.1 实施期，WP8 归档）

- **U-N6（conversation header/input 增量 slot → conversation-actions.tsx 整体跳过）**：冻结的运行时目录（`fixtures/runtime-slot-catalog.json`，WP0 V-02）中，可独立注册的顶层席位仅 root / conversation / settings.plugin.item / sidebar / sidebar.footer.action / shell.overlay 六个；`session.header`、`input.*`、`composer.bar` 等只作为官方 ConversationRoot occupant 声明的**子席位**出现在 `conversation` 行的 replacementRisk 注记中——它们随 occupant 整体挂载/卸载，不是插件可独立占位的增量挂点。据此按 V01 §11.2 U-N6 处置：`src/client/slots/conversation-actions.tsx`（conversation header「返回 API Client」+ 输入区 API Context 状态提示）**整体跳过**，V0.1 不实现、不注册；「返回会话」路径由矩阵「yield（让位）」行的既有机制承担（面板 Close 按钮 / 会话行点击 / 持久化选择恢复）。若后续 DSH 版本把上述子席位开放为独立可注册 slot，按 WP0 目录复核结论重估本项。
