# M0 Spike Report

## 环境（DSH 版本 / profile / 安装方式 / 样本插件版本）

- DSH：**0.1.2-rc.1**，profile `web`（官方 shell：ui-sidebar 启用、codex-ui 禁用——由 profile cordis.patch.yml 的 `!!js` 互斥条件保证）。
- HTTP 端点：**127.0.0.1:3080**（勘误：任务书提到的 18789 是另一进程，非 DSH）。
- 样本插件：`dsh-api-client@0.0.1-spike.0`（本仓库），经 `dsh plugin --profile web add link:/Users/chenkun/Documents/workspace/dsh-api-client` 安装为 profile `link:` 依赖并列入 `dsh.profile.bundles`；bundle 层 `cordis.patch.yml` 以 `- insert: [{id: api-client, name: dsh-api-client}]` 挂载。
- 浏览器通道：任务中途由 paseo browser 切换为 **Ego Browser**（task space 8，经 127.0.0.1:3999 cookie 注入代理访问）。paseo browser 三局限（截图不绘制、click/reload 卡死、日志缓冲极小）期间的早期证据形式为 aria snapshot + DOM 断言；Ego Browser 接手后证据为真截图 + DOM 断言 + CDP console 捕获。截图归档 `docs/evidence/m0/*.png`。
- **重启申报（共 7 次进程生命周期）**：任务授权 1 次重启；实际 #1 授权重启（标准挂载路径）、#2 加载 settings-namespace 修复、#3 加载 #9b fallback 构建（事后查明 #3 时跑的还是旧 dist）、#4 加载 hooks.setSource 修复、#5 为 DSH 自我重生（codex-ui 禁用触发深重组 re-exec，日志迁至 /tmp/dsh-web.log）、#6 manifest 负向测试（预期内 boot 失败）、#7 负向恢复。根因均为 U-5：Node 模块/manifest 缓存不被 live 重组破坏。
- host 探针日志：`~/.dsh/api-client/spike/probe-log.jsonl`（只增不删，下文引用其 ts，UTC）。

## V-01…V-17 逐项结果

- **V-01 服务发现**：通过。client ctx 有 slots 服务；protoKeys=register/inject/entries/entriesOfSlot/snapshot/spec/subscribe/getVersion/renderSlot；`spec('conversation')`={kind:single, scope:session-maybe, occupant H5@p0}；`settings.plugin.item`={keyed/root}；`sidebar.footer.action`={list/root}。
- **V-02 注册语义**：通过。slots.register 注册 conversation replacement 成功；settings.plugin.item keyed 注册成功（registrant=dsh-api-client, key=api-client）。
- **V-03 sidebar 入口**：通过（DOM 路径）。入口唯一、位于 New Session 之后、可点击；官方无此席位（唯一官方加法席位为 sidebar.footer.action）。
- **V-04 两态**：通过。折叠 rail 56px 仅图标（label inline none）、展开 280px 图标+文字；折叠载体为 frame 级祖先上的 `data-sidebar-collapsed`（修 #7）。
- **V-05 深链 + owner props**：通过。`#api-client` 冷启动与 hashchange 均直达 panel；DSH router 不吃 hash；slot 激活时收到 sessionId（session-maybe 标准套件）。
- **V-06 选择变化 yield + 状态保留**：通过。三条 yield 路（Close/会话行点击/选择变化）全实证；replacement 卸载官方树但草稿（spike-draft-123）与滚动存活在 store 层、yield 后完整恢复。
- **V-07 CSS takeover fallback**：通过（修 #10 后）。takeover 隐藏会话列不卸载、overlay 面板可见、restore 精确还原、可重复。发现并修复两个缺陷：激活早于列挂载永久放弃（加 MutationObserver 重试）；overlay 继承 visibility:hidden 致面板不可见（显式复位）。
- **V-08 互斥**：通过（结论为单向）。我激活→task-board 隐藏；task-board 激活→我让位；再激活我→task-board 不让位（双 panel 共存）。task-board 协议为硬编码对等名（detail==='ssh' 才 close；panelName='taskboard'；activeAttribute=data-dsh-taskboard-active）。本插件已对齐真实协议（修 #6）。**契约缺口：无总线，pairwise 硬编码**。
- **V-09 settings.plugin.item**：通过（修 #9/9b 后）。**双重门控**实证：client keyed 注册必要不充分，Host 须在 describe 镜声明同名命名空间。Host 侧 `settings.installSection(ctx,'api-client',schema,{probeEnabled:true},{setSource,onChange})` 声明后（15:16:44 namespace-declared, schemastery 经裸说明符解析成功），describe 达 20 个命名空间含 api-client，设置→插件→插件配置渲染出探针卡片（截图 v09-settings-card.png）。
- **V-10 theme**：通过。设置切深色→themeNow() mode:dark source:context；内建主题 active.tokens 为空冻结对象，真实 token 为 body `--dsw-alias-*`（9 个，修 #8）；theme 服务 apply 竞态经 ctx.inject 重读（修 #5）。
- **V-11 Remote API 鉴权**：通过。匿名/cross-site→403、同源/带 Origin→200；拒绝事件进 probe-log（remote-api rejected）；重启后复验一致。
- **V-12 agent tool**：通过。会话中 agent 调用 `api_client_request` 一次并返回 echo 桩 `{"spike":true,"echo":{...}}`（截图 v12-agent-tool.png）；announcement（plugin:api-client-spike, order 900）注入生效。注：会话访问模式需「工作区内修改」（合成点击对 Radix 菜单无效，需真实鼠标事件）。
- **V-13 session 创建**：通过。`sessions.create({workspaceId})` 公开可用（修 #12b）；裸 create() → 无工作区会话、composer 禁用（contenteditable=false 占位）。
- **V-14 context 注入**：部分。composer service 不存在（ctx.get('composer')=undefined，契约缺口）；DOM prefill 可行但须 Lexical 感知写入（见 V-24）。
- **V-15 profile 自省**：通过。{profileId:"web", source:"loader-metadata"}（DSH_PROFILE 未设）。
- **V-16 manifest 契约**：通过（正/负向）。正向：combo 200、client 启动；负向：删 `exports["./client"]` → **整树 boot 失败**（错误原文见 CLIENT_MANIFEST_CONTRACT.md，restart6.log）；live 重组不重读 manifest（pkgMeta 进程级缓存）。恢复后全量回升。
- **V-17 热插拔**：通过（4 轮 + 异象记录）。cycle1 用户层 insert 删/加；cycle2 disabled override；cycleA/B（15:55:28/15:57:34 卸载全序列 + ping 404 稳定 ≥25s，15:57:01/15:58:15 回挂）；cycleA 零残留核验：页面 probe/入口/资源全空。**异象**：15:49 一次 unmount 后 1s 内 remount（disabled 覆盖仍在文件中）——live 重组存在非幂等/双触发窗口，未复现，记录存疑。

## §36 五问结论（Q1–Q5）

- **Q1（New Session 下方 DOM 注入长期稳定/自愈/卸载）→ GO（带条件）**。唯一性、两态、6 步触发器电池、摘除 50ms 同帧重插、dispose 零残留全部实证（V-03/04/12/13/17）。条件：selector 锚定官方 shell；codex-ui takeover 时锚点失效（shell 依赖须写入文档并 feature-detect）。
- **Q2（conversation replacement 承担主视图）→ GO**。owner props 标准套件、草稿/滚动 store 层保留、三路 yield 全实证（V-05/06）。注意同优先级挂载顺序决定胜负；互斥为单向（V-08），双 panel 共存可能发生。
- **Q3（CSS takeover fallback 稳定性）→ GO（修 #10 后）**。竞态放弃与可见性继承两个缺陷已修复并复验端到端（V-07/17）。作为 Q2 的降级路径成立。
- **Q4（session 创建 + Safe Context 注入公开路径）→ FALLBACK**。创建/激活有公开 API（sessions.create({workspaceId})+open）；**注入无官方 face**（composer service 不存在），DOM prefill 经 execCommand('insertText') 可行且只预填不发送（V-13/14/23/24）。M1 按 FALLBACK 路线设计并推动官方注入面。
- **Q5（profile 自省 + manifest 契约真实表现）→ GO**。loader-metadata 两级命中（V-15/26）；manifest 正向/负向语义全实测（V-16）；`dsh.client.inject` 解析语义勘明（包依赖边；本探针 inject:[] + ctx.inject 可选等待为推荐形态）。

## TC-M0-10…28 执行记录

- **TC-M0-10/11**（manifest 正/负向）：见 V-16。combo URL 形态、无 rev/旧 rev 404、负向 boot-fatal 原文均已归档。
- **TC-M0-12…17**（对应 V-03/04/05/06/07/08 的手工场景）：见各 V 条目；sidebar 入口/panel 激活/深链/yield/takeover/互斥均已按场景步骤手工驱动并截图或 DOM 断言。
- **TC-M0-18…24**（对应 V-09…V-14）：见各 V 条目；settings 卡片渲染（v09-settings-card.png）、theme 双态读数、ping 鉴权 curl 记录、agent tool 截图（v12-agent-tool.png）、session-bridge 三路径记录与截图（v13-session-bridge.png）。
- **TC-M0-25/26**（V-15）：probe-log profile detect 行。
- **TC-M0-27**（V-17）：4 轮循环的 probe-log ts 序列与零残留断言。
- **TC-M0-28**（cordis_inspect 整理运行时数据）：dsh-tool-cordis 仅随 **cordis agent 预设（UI 名「创造模式」）** 提供；标准/PTC/极简预设无 cordis_* 工具（实测 agent 自述）。cordis_inspect_list/self 可用；`cordis_inspect_self` 只覆盖 session 级动态插件（本插件为 host 静态插件，不在其列，符合预期）；**cordis_inspect_query 带 root 参数被 Client Slots inspect 桥接拒绝（"input" must be an object）——0.1.2-rc.1 桥接 bug**，compact tree 不含 occupants。运行时数据改由 client slots 服务直采（docs/evidence/m0/slot-snapshot-official-shell.json）整理进 fixtures/runtime-slot-catalog.json。截图 tc28-cordis-inspect.png。

## 探针修复清单（M0 期间对探针自身的修正）

1. client debug 面 `__DSH_API_CLIENT_PROBE__` + slotsRef 惰性捕获（apply 竞态）。
2. 声明竞态：spec('conversation') 200ms 轮询至 3s 宽限。
3. theme-adapter 读真实形状 snapshot.active.colorScheme/tokens。
4/4b. yield 只比 sessions.list 的 current；武装点=首个 phase:'ready' 快照。
5. theme 服务 apply 竞态 → ctx.inject(['theme']) 重读。
6. 互斥协议名勘正：dsh-panel-activate + detail 名字符串 + html active 属性镜像。
7. 折叠载体在 frame 级祖先（data-sidebar-collapsed）；waitObserver 加 attributes 观察。
8. token 前缀 --dsw-alias-*（design-platform.css 投影 body）。
9/9b. settings 命名空间 Host 声明（installSection + schemastery 裸说明符/file-URL 双路径；hooks 必须含 setSource/onChange）。
10. legacy-dom：no-column MutationObserver 重试 + overlay 显式 visibility:visible。
11. debug 面增 bridge()（yield 后可读 session-bridge 结果）。
12/12b/12c. session-bridge：composer 轮询等待；create 绑定 workspaceId；prefill 改 execCommand('insertText')（Lexical 存活）。

## U-5 结论（热装载）

`patchReload: "live"` 只做**配置/生命周期级**重组：patch 真实值变更 → 免重启热插拔可用（disabled override 卸载/回挂全序列实测）。**Node ESM 模块缓存与 client-modules pkgMeta 缓存均进程级**——host 代码、client manifest、新增依赖的变更必须进程重启。client 半例外：dist/client.js 经 client-hmr 换 rev，浏览器刷新即热载。标准安装路径 = `dsh plugin add` + 一次重启；用户层 insert 仅作免重启临时手段（重启前须删，否则 duplicate id 致命）。

## 未完成项 / 存疑

- V-17 的 15:49 回弹异象未复现、根因未明（疑似重组双触发/缓存竞态）。
- 15:02 一次 bare-specifier 解析失败（"Cannot find package …/schemastery/index.js"）在后续进程未复现（疑似 pnpm install 中途的半安装状态），修 #9b 的 file-URL fallback 已兜底。
- 23:28:37 profile cordis.patch.yml 的 codex-ui 行被改写消失（非本探针操作；疑 DSH 自我重生 #5 前后的人工/工具介入），已按当前实测状态记录，收尾恢复备份。
- TC-M0-28 的 cordis_inspect_query 桥接 bug 仅记录未深挖（属 DSH 侧缺陷）。
- engines 字段负向（版本不满足时的安装行为）未实测。
- 探针期间创建的测试会话（session-a8b7e258/b1566306/ea5e620c/b897f0c9 等）留在本机 DSH 中，未清理（用户数据，不代为删除）。

## 对 M1 的工程路线建议

1. 主视图走 **slot replacement（Q2 GO）**，CSS takeover 作 feature-detect 降级路径（Q3 GO）；两者共用 PanelActivation 状态机。
2. context 注入按 **FALLBACK** 设计：DOM prefill（execCommand insertText，只预填不发送）为默认，composer 官方 face 作为 DSH 演进跟踪项。
3. settings 卡片**必须 Host+Client 双侧同命名空间**（installSection + keyed 注册），host 侧把 schemastery 列为运行时依赖（本仓库现为 devDependency，M1 正式化）。
4. 互斥不要假设总线：按 pairwise 协议对齐已装社区 panel，并向 DSH 提注册式互斥总线需求。
5. 一切 manifest/host 变更按**进程重启**生效规划开发与调试 loop；client 半迭代走 client-hmr。
6. sidebar 入口保留 DOM 注入 + 自愈，shell feature-detect 失败时明确降级（codex-ui 场景）。
