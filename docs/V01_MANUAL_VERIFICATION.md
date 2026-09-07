# V0.1 手工运行时验证报告（TC-UI sweep）

> 验证对象：完整插件形态（WP0–WP7 交付后）。方法：真实 DSH 0.1.2-rc.1 + Ego Browser 手工场景驱动，逐条记录操作、证据（截图 / DOM 断言 / 落盘数据）、结论。
> 不在本 sweep：TC-UI-03（热插拔回归）、TC-UI-18（workbench 安装）——属 WP8。

## 环境

- DSH：**0.1.2-rc.1**，profile `web`（官方 shell），HTTP `127.0.0.1:3080`。
- 插件安装方式：`pnpm build` → `dsh plugin --profile web add link:/Users/chenkun/Documents/workspace/dsh-api-client`。
- **重启申报**：任务授权 1 次重启。实际进程生命周期 2 次：
  - #1 授权重启：SIGTERM PID 33209 → `nohup dsh web --no-open > /tmp/dsh-web.log 2>&1 &`（PID 54499）→ **boot 失败**（缺陷 F-01）。
  - #2 修复 F-01 后重启（PID 58239）→ 健康（根路径 401 为 DSH 正常鉴权行为）。全部 TC 在同一进程内完成；后续 client 半修复（F-02/03/04）经 client-hmr 换 rev + 页面刷新生效，未再重启。
- 浏览器通道：**Ego Browser** task space 12（`dsh-api-client v01 manual verification`），真截图 + DOM 断言。全程未动用 paseo browser 回退（任务书第 2 条授权的回退通道，未触发）。
- 目标 API：自起 node 回显 server `http://127.0.0.1:41234`（GET/POST JSON/HEAD/OPTIONS/Set-Cookie，脚本 `/tmp/echo-server.mjs`）；插件 Settings 中 `networkPolicy.allowLocalhost` 已打开（默认 fail-closed 拒 localhost，特性非缺陷）。
- 样本插件 `dsh-client-ui-task-board@0.3.16` 已装（互斥观察对象；单向互斥为契约已知现状，本 sweep 未单独复测）。
- Host API 鉴权抽查（负向）：匿名 / 仅同源 Origin 请求 `GET /api-client/collections` → 401 `missing-token`（fail-closed，符合 §24.4）。
- 模型：会话 agent 为 Qwen3.8 Max（TC-UI-16/17 实际调用人）。

## 发现的缺陷与修复清单

### F-01 host bundle 打包 undici 导致 boot 崩溃（已修复，host 半，需重启生效）

- **现象**：安装完整插件后 DSH boot 失败：`failed to import loader entry api-client (dsh-api-client): Dynamic require of "assert" is not supported`（`/tmp/dsh-web.log`）。undici（CJS）被 tsup 打包进 ESM host 入口，`__require` shim 在纯 ESM 下无法加载 Node 内建模块。
- **修复（最小改动）**：`tsup.config.ts` host 构建 `external` 增加 `'undici'`（附注释固化原因）；root `package.json` `dependencies` 增加 `"undici": "^8.10.2"`（Node 运行时从包自身 node_modules 解析）。dist/index.js 1.22MB → 152KB；180/180 tests 绿；重启后插件正常加载。
- **启示**：WP0 探针期 host 无 undici 依赖，未暴露此打包陷阱。

### F-02 Save 到 Collection 后树不即时刷新（已修复，client 半，hmr 生效）

- **现象**：保存请求成功落盘（`~/.dsh/api-client/shared/collections.json` 有据），但树中不出现，需整页刷新。
- **根因**：`ApiClientView.tsx` `SaveRequestModal onSaved` 只更新 tab 状态，未调 `collections.refresh()`。
- **修复**：onSaved 中补 `collections.refresh()`（一行 + 注释）。复验：保存 "Save Refresh Check" 与 folder 内保存 "Folder Child Req" 均即时上树。

### F-03 编辑器 Send 恒走 draft 投影，History 无 requestId → 「重新执行」恒静默空转（已修复，client 半）

- **现象**：已保存请求从树打开后 Send，history 条目 `requestId` 缺失（落盘 JSONL 实证）；HistoryView 的「重新执行」走 requestId + SecretRef 链（§10/AC-32），`entry.requestId === undefined` 时直接 return，按钮可点但无任何反馈。
- **修复**：`ApiClientView.tsx send()`——干净已保存 tab（`requestId` 存在且非 dirty/authDirty）改走 `{ requestId }` 执行；脏草稿保持 draft 投影语义。复验：修复后 history 条目携带 requestId，「重新执行」toast `Re-executed: 200` 并追加第 9 条 history。
- **遗留 UX 注记**：无 requestId 的条目（未保存草稿的执行记录）「重新执行」按钮仍静默空转，建议后续版本禁用并提示（本 sweep 不改）。

### F-04 Send 按钮文字与底色同色（已修复，client 半）

- **现象**：亮色主题 Send 按钮文字不可见（`color` 与 `background` 同为 rgb(15,17,21) 计算值实证）。
- **根因**：`theme.ts` `brandText` 取 `--dsw-alias-brand-text`，而该 token 在 DSH 官方亮色主题实测为 `#0f1115`（与 `--dsw-alias-brand-primary` 相同）；DSH 原生主按钮文字色实为 `--dsw-alias-label-primary-inverted`。
- **修复**：`brandText` 改取 `--dsw-alias-label-primary-inverted`（附实测注释）。复验：亮色 rgb(255,255,255) on rgb(15,17,21)，暗色 rgb(53,54,56) on rgb(249,250,251)，双主题可读（截图 tc20-send-button-*-fixed.png）。

## TC-UI 逐条记录

### TC-UI-01 安装后入口唯一 + 点击呈现 ApiClientView —— PASS

- DOM 断言：`button[data-dsh-api-client][data-dsh-part="sidebar-entry"]` 计数 = **1**；位于「新建会话」按钮之后（`compareDocumentPosition` FOLLOWING）。点击后 probe `active=true, lastSource="sidebar-entry"`。
- 截图：`tc01-sidebar-entry.png`、`tc01-apiclient-view.png`（顶栏 No Environment/History/Import/Environment/交给 Agent/✕，左树空态 + 搜索 + +，中央编辑/响应区空态）。
- 结论：**PASS**（AC-01/04）。

### TC-UI-02 入口自愈回归（切换会话/折叠展开/切主题/新建会话 ×3）—— PASS

- 3 轮 × 6 动作，每个动作后**同帧**（同一 tick）与**沉降后**（800ms）双采样入口计数：**18/18 检查点恒为 1**（无重复、无丢失）。终态截图 `tc02-after-battery.png`。
- 观测方式与局限：「无闪烁」以 React 重渲染后入口数恒 1（同帧+沉降双采样，覆盖摘除-重插的微任务窗口）为据；未逐帧录屏，亚帧级视觉抖动不在观测范围。
- 结论：**PASS**（AC-02）。

### TC-UI-05 主视图经官方 conversation replacement 呈现 —— PASS

- probe：`mode()="slot"`、`features.degraded=false`、conversation slot `declared=true, kind="single", scope="session-maybe"`、occupant H5@p0、`notes=[]`——与冻结契约（UI_ADAPTER_CONTRACT §SlotAdapter）occupant/priority/scope 语义一致。
- 结论：**PASS**（AC-05）。

### TC-UI-06 CSS takeover fallback —— 受限（不可从 UI 触发，设计如此）

- 事实：挂载路径在 client boot 时由 feature-detect **commit-once** 决定（`src/client/index.ts:126-146`），**无运行时开关**；debug 面 `__DSH_API_CLIENT_PROBE__` 仅暴露 `features/mode/active/lastSource`，无强制降级入口。
- 处置：不为此新增调试开关（超最小修复原则）。takeover/restore 契约（Conversation DOM 不卸载、草稿/滚动保留、零残留）维持 WP0 探针级实证（M0_SPIKE_REPORT V-07）。本 sweep 记录 `mode()="slot"`、`degraded=false` 佐证当前走官方路径。
- 结论：**受限**——完整插件形态无法从 UI 强制切换；契约语义以 WP0 实证为准。

### TC-UI-07 panel 激活中点击 Session → yield —— PASS

- panel 激活态点击会话树「你好打招呼」→ `active=false, lastSource="session-selection-dom"`，官方 Conversation（对话/轨迹 tab）恢复。截图 `tc07-yield-conversation.png`。
- 结论：**PASS**（AC-07）。

### TC-UI-08 Settings → Plugins → API Client 配置页 —— PASS

- 设置 → 插件 → 插件配置 → API Client 段（schemastery 表单）全配置项渲染（dialog innerText 归档）：General（defaultTimeoutMs/followRedirects/saveHistory/maxResponseBytes/historyRetentionDays/postmanCompatibility/secretsDisplayPolicy=masked 固定/activeEnvironmentId 只读）、Network Policy §24.3（allowLocalhost/allowPrivateNetwork/allowPublicNetwork/redirectPolicy/timeoutMs/maxResponseBytes/dnsRebindingProtection/blockedHosts/allowedHosts/blockedPorts）、Agent Permission §24.5（highRiskMethodsRequireApproval/hostRules）——覆盖 §25 清单。
- 改 `defaultTimeoutMs`→45000、`allowLocalhost`→true → Save → **整页刷新后保持**（截图 `tc08-persisted-after-reload.png`、`tc08-allowLocalhost-true.png`）；落盘 `~/.dsh/api-client/profiles/web/settings.json` 复核一致。
- 操作注记：首轮按控件索引点击误改 allowPrivateNetwork（表单控件无稳定 aria 标签，改按 label 文本定位后正确）——执行误差非缺陷，allowLocalhost=false 时 localhost 请求被拒符合 fail-closed 设计。
- 结论：**PASS**（AC-09）。

### TC-UI-09 暗色主题 + sidebar 折叠 —— PASS

- 暗色：`--dsw-alias-bg-base #151517` / `label-primary #f9fafb` / `border-l1 #ffffff0f`（契约 §ThemeAdapter token 源），ApiClientView 暗色渲染正常（`tc09-dark-panel.png`）。
- 折叠态：入口宽 36px、label `display:none`（仅图标）、位于 `data-sidebar-collapsed="true"` 的 frame 级祖先内（契约修 #7 载体）。截图 `tc09-dark-collapsed.png`。
- 结论：**PASS**（AC-10）。

### TC-UI-10 GET + {{base_url}} → Response Viewer 完整 —— PASS

- Echo Env（含 `base_url=http://127.0.0.1:41234`）顶栏激活；GET `{{base_url}}/echo?x=1` → **200 OK · 13.06ms · 166 B**；Pretty body 显示 echo JSON（`"method":"GET"`、host=127.0.0.1:41234）——`{{base_url}}` 按环境解析实证（同证 TC-UI-14 的「请求按新环境解析」）。Body/Headers(9)/Cookies(1)/Tests tab 齐备，Pretty/Raw/Preview 切换在。截图 `tc10-get-response.png`。
- 观察（非失败）：URL query 与 Params 行双向同步致 `x=1` 出现两次（`?x=1&x=1`，echo server 如实回显）——§7.3 同步语义的直接后果，记录供后续 UX 评估。
- 结论：**PASS**（AC-11/14）。

### TC-UI-11 POST JSON → Headers/Cookies tab 有内容 —— PASS

- Body 选 JSON 输 `{"hello":"v01","n":42}` → **200 OK**；echo 回显 method=POST 与 body 原文。
- Headers tab 9 条全量（含 `set-cookie: session=echo123; Path=/; HttpOnly`）；Cookies tab 解析出 `session: echo123`。截图 `tc11-post-json-response.png`、`tc11-response-headers.png`、`tc11-response-cookies.png`。
- 结论：**PASS**（AC-12）。

### TC-UI-12 HEAD / OPTIONS 可配置可执行 —— PASS

- Method 下拉含全部 7 方法（GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS）；HEAD → **200**（无 body），OPTIONS → **204**。截图 `tc12-head-response.png`、`tc12-options-response.png`。
- 结论：**PASS**（AC-13）。

### TC-UI-13 Save 到 Collection + CRUD/排序/搜索/持久化 —— PASS（2 子项受限）

- Save（含 folder 选择）：Save 弹窗提供 Collection 下拉 + Folder 下拉（nested-folders 导入集合展示 `level-one` / `level-one/level-two` / `level-one/level-two/level-three` 层级选项）；存入 level-two 后树即时出现（F-02 修复后）。截图 `tc13-save-dialog-folder.png`、`tc13-saved-into-folder.png`。
- 重命名（prompt 改名 Echo POST JSON）/ Duplicate（"Echo POST JSON (copy)"）/ 排序（Move up 后顺序翻转）/ 搜索（"copy" 仅命中副本行）/ 删除（confirm 后移除）全部生效；**整页刷新后持久**（`tc13-persisted-after-reload.png`，落盘 collections.json 复核）。
- **受限子项（已知设计缺口，非实现缺陷）**：folder CRUD（Host API 无 folder 端点，folder 仅随导入产生）；普通环境变量删除（Host API 无删除端点，UI 明示「只能禁用」）。
- 结论：**PASS**（受限项如实记录）。

### TC-UI-14 Environment 编辑 + secret 纪律 —— PASS

- 新建环境（prompt "Echo Env"）；变量表加 `base_url`（普通）与 `api_token`（secret）→ Save 后落盘持久（`shared/environments.json` + `shared/secrets/*.json`）。
- **掩码**：保存后 secret 行恒 `••••••••`，页面任何处无 `s3cr3t-v01-token(-v2)` 明文（innerText 断言）；secret 值不回传（编辑态该行仅余「重新输入」入口）。
- **reveal**：「重新输入」→ 输新值（password 型）→ 👁 点击后 input 变 text 型内存展示 → 🙈 复原；逐次点击语义符合（`tc14-reveal-in-memory.png`）。
- **切换**：顶栏 combobox No Environment → Echo Env（`tc14-env-switched.png`），`{{base_url}}` 请求按新环境解析（TC-UI-10 实证）；刷新后环境/集合/secret 均在。
- 结论：**PASS**（AC-17）。

### TC-UI-15 History 列表/脱敏快照/重新执行 —— PASS（经 F-03 修复）

- 列表：时间 + method（语义色徽标）+ displayUrl + source 徽标（Human/agent）；标题行明示 "redacted snapshots only"（`tc15-history-list.png`）。
- 单条脱敏快照：request 头 `X-Token: <redacted>`、response 头 `set-cookie: <redacted>`、**bodyPreview 内 echo 回的 `x-token` 同被 `<redacted>`**；落盘 history.jsonl 全文无 secret 明文（截图 `tc15-history-detail-redacted.png` + JSONL 复核）。
- 重新执行：已保存请求执行（requestId 链）→ History 选中 → 重新执行 → toast `Re-executed: 200`，追加新条目（source=human、requestId 一致），不经 History 回读 secret（`tc15-history-reexecute.png`）。
- 结论：**PASS**（AC-18/32）。

### TC-UI-16 agent 工具 + 停用/恢复 —— PASS

- 安装态：DSH 会话（Qwen3.8 Max）调 `api_client_list_collections`（返回 7 collections）与 `api_client_request`（GET http://127.0.0.1:41234/agent-echo → 200）均成功；history 落盘 `source: "agent"`（`tc16-agent-running.png`）。
- 停用：profile `cordis.patch.yml` 追加 `- id: api-client / disabled: true`（**免重启 live 重组**）→ Host API `/api-client/collections` 404、sidebar 入口 0、probe 消失；同会话再调 → agent 原样回报 `Error: unknown tool "api_client_list_collections"`（`tc16-disabled-tool-call.png`）。
- 恢复：还原 patch → 免重启回挂 → 入口/probe/Host API 恢复；agent 再调成功列出 7 collections（`tc16-restored-tool-call.png`）。
- 结论：**PASS**（AC-23）。

### TC-UI-17 交给 Agent —— PASS

- 对带 secret 头（`X-Token: {{api_token}}`）且已执行的请求点「交给 Agent」→ 出域确认弹窗 ✓/✗ 清单（✓ Request/Response metadata、✓ Environment 仅名称、✓ Execution metadata；✗ Response body 默认不发送、**✗ Secret 明文无条件不发送**、✗ Auth 材料/环境变量值）（`tc17-agent-confirm-dialog.png`）。
- 确认 → 新 Session 创建并 prefill（composer 内容实证：`X-Token: <redacted>`、`set-cookie: <redacted>`、response body 未包含、环境仅名称）；**只预填不发送**（截图 `tc17-session-prefilled.png` 显示内容停留在 composer 待用户确认）。
- prefill 全文 grep 无 `s3cr3t`（DOM 断言）。
- 结论：**PASS**（AC-24/30）。

### TC-UI-19 Postman import —— PASS

- `fixtures/postman/scripts.json` → 报告：requests 1 / partial 1，2 条 script not executed 警告（prerequest + test 脚本保留不执行）。
- `fixtures/postman/oauth2.json` → 报告：requests 2 / partial 2，oauth2 与 digest auth 降级 No Auth 警告。
- `fixtures/postman/nested-folders.json` → 报告：requests 3 / folders 3 / full 3，"No findings"。
- 报告形态符合 §15.4（计数 + 兼容分级 + 逐项清单），三次导入均不中断、树即时出现新集合（截图 `tc19-import-scripts-report.png`、`tc19-import-oauth2-report.png`、`tc19-import-nested-report.png`、`tc19-nested-tree.png`）。
- 结论：**PASS**（AC-25/26/27）。

### TC-UI-20 Method 语义色 —— PASS

- 计算值断言（树徽标 + Tab 内 MethodSelector，浅/暗双主题一致）：GET `rgb(26,127,55)`=#1a7f37 绿、POST `rgb(194,106,0)`=#c26a00 橙、PUT `rgb(9,105,218)`=#0969da 蓝、PATCH `rgb(130,80,223)`=#8250df 紫、DELETE `rgb(207,34,46)`=#cf222e 红；HEAD/OPTIONS 中性灰（源码同表 §5.2）。
- 暗色对比截图 `tc20-method-colors-dark.png`（树 + Tab 徽标在 #151517 底上可读）；另发现并修复 Send 按钮对比度缺陷（F-04）。
- 结论：**PASS**（AC-10 支撑）。

## 中断与操作注记

- sweep 期间用户多次手动接管 Ego task space（ownership 在 agent / agentDelegatedToUser 间切换），浏览器驱动在接管窗口暂停、恢复后续跑；接管窗口内未产生任何断言证据。用户在接管期自行创建了集合 "1"/"ytrrty" 并导入了 IPAM_OpenAPI_Admin 集合——这些数据保留未清理，其中 IPAM 集合的 5 方法请求行被本 sweep 用作 TC-UI-20 树内徽标证据。
- 插件创建/重命名/删除走原生 `prompt()`/`confirm()`（`ApiClientView.tsx` treeHandlers），会阻塞 renderer 使后续 CDP evaluate 超时；本 sweep 以页面级 `window.prompt/confirm` stub（仅测试窗口、刷新即还原）驱动，相应断言均以 stub 捕获的 `__lastPrompt` 消息原文 + 树/落盘结果佐证，未伪造原生对话框截图。
- 「无闪烁」「对比正常」等视觉判定的观测方式与局限已随各 TC 条目注明（DOM 双采样 / 计算值断言 / 截图人工复核）。

## 遗留问题

1. **TC-UI-06 受限**：CSS takeover 路径在完整插件形态无运行时触发入口（commit-once 设计）；如需在 V0.2 复验，建议加 debug 强制开关或接受 WP0 探针证据。
2. **F-03 遗留 UX**：无 requestId 的 history 条目「重新执行」按钮静默空转，建议禁用并提示原因。
3. **URL/Params 双向同步重复参数**：URL 含 query 且 Params 行同步时生成重复参数（`?x=1&x=1`）——同步语义副作用，供 UX 评估。
4. **互斥单向**（契约已知）：未在本 sweep 复测 task-board 互斥，维持契约文档结论。
5. 用户接管期创建的测试集合（"1"/"ytrrty"/IPAM 导入）与本 sweep 创建的集合/环境/history 均保留在本机 DSH（用户数据，不代为删除）。
6. TC-UI-16 停用/恢复采用 disabled override（免重启）；`dsh plugin remove` 全量卸载回归属 TC-UI-03（WP8）。

## 收尾状态

- 插件保持**安装态**（`dsh plugin --profile web list` 可见 `dsh-api-client@link:`），DSH 进程健康（401 正常鉴权）。
- profile `cordis.patch.yml` 已还原（TC-UI-16 临时 disabled 行移除，备份 `/tmp/cordis.patch.yml.bak`）。
- 回显 server 已停；Ego task space 12 已关闭。
- 证据截图：`docs/evidence/v01/*.png`（64 张，含探索过程图）。

---

# WP8 终态回归（TC-UI-03 / TC-UI-18 / 探针退役后冒烟）

> 背景：WP8a 代码变更（探针退役 probe-log→tools/spike、host 日志改 console 面、session-bridge 探针面移除、/execute 响应新增 responseEcho、3 处小修）后，209 tests 绿。host 半变更经一次授权重启生效。

## 环境（WP8b）

- DSH：**0.1.2-rc.1**，profile `web`，HTTP `127.0.0.1:3080`；workbench 回归用第二实例 profile `workbench` @ `127.0.0.1:3081`（已停）。
- **重启申报（WP8b 授权 1 次，实际 1 次）**：SIGTERM 旧进程（父 58239 + 子 58241；首次只杀父进程致 EADDRINUSE，补杀子进程后重启成功——操作教训：dsh web 为父子双进程）→ 新进程 PID 22551/22553，401 健康。
- 构建：`pnpm build`（dist 151.81KB）+ `pnpm vitest run` **209/209 绿**。
- 浏览器：Ego Browser task space 16；回显 server 127.0.0.1:41234（同前脚本）。

## 探针退役后冒烟 —— PASS

- 页面加载无崩溃；debug 面 `__DSH_API_CLIENT_PROBE__.mode()` 可读（`"slot"`）；sidebar 入口唯一（DOM 计数=1）。截图 `wp8-smoke-boot.png`。
- panel 打开正常；UI 新建 tab 发 GET `http://127.0.0.1:41234/wp8-ui-smoke` → **200**（allowLocalhost 设置随数据目录保留，无需重开）。截图 `wp8-smoke-ui-get.png`。
- `/execute` 响应含 **responseEcho**：页面内用 `window.__DSH_API_CLIENT_BOOTSTRAP__` token + `X-Dsh-Api-Client-Request: 1`（CSRF 头，缺它 403——鉴权契约顺带复验）直调，`200`，响应键 = `result / historyId / requestEcho / responseEcho`；responseEcho 内 `set-cookie: <redacted>`（脱敏随路）。
- 结论：退役后插件端到端存活，**PASS**。

## TC-UI-03 热插拔 3 轮（patchReload: live，全程未重启 DSH）—— PASS

机制：profile `~/.dsh/profiles/web/cordis.patch.yml` 追加/移除 `- id: api-client / disabled: true`（M0 U-5 实证路径；操作前备份 `/tmp/cordis.patch.yml.wp8bak`）。DSH PID 22551 全程同一进程。

每轮验证项：① sidebar 入口 DOM 为空 ② 无自愈重建（触发 React 重渲染后入口仍为 0，Observer 随 client 卸载）③ panel/probe 消失 ④ agent 工具不可用（会话中调用报 `unknown tool "api_client_list_collections"`，Qwen3.8 Max 原样回报）⑤ `/api-client/capabilities` 404（**空 body、无 content-type**，非 SPA fallback HTML）。回挂后验证：入口=1、probe mode="slot"、capabilities 401（路由在）、新会话工具调用成功。

| 轮 | 卸载（①②③④⑤） | 回挂恢复 | 证据 |
|---|---|---|---|
| R1 | 全过（reload 后 entry=0/probe 无/panelDom=0；unknown tool；404 空 body） | entry=1/probe=slot/capabilities 401；**新会话**工具调用成功（"7 个 collection"） | `tc03-r1-unloaded.png` / `tc03-r1-unknown-tool.png` / `tc03-r1-restored-newsession.png` |
| R2 | 全过（重渲染后入口仍 0，无自愈；unknown tool；404） | 同左（新会话调用成功） | `tc03-r2-unloaded.png` / `tc03-r2-restored.png` |
| R3 | 全过 | 同左；终态 patch 文件无 api-client 行、数据目录保留（7 collections / 13 history entries） | `tc03-r3-unloaded.png` / `tc03-r3-restored.png` |

观测注记（如实记录，不判 FAIL）：

1. **live 页面惰性**：热卸载后**已打开页面**内的 client 模块继续存活（入口/面板仍在但 Host API 已死）；刷新后零残留。这是 DSH 平台语义（live 重组只覆盖 host 生命周期，client 半经 rev/刷新更替），与 M0 U-5 一致，非插件缺陷。①②③的零残留断言均以刷新后页面为准。
2. **旧会话工具列表缓存**：R1 回挂后，卸载期间用过的旧会话仍报 unknown tool（host 日志确认 tools 已重新 register：install→mount→tools register→start 完整序列 ×3）；**新会话即正常**。判定为 DSH 会话级工具清单快照行为，非插件缺陷（R2/R3 均直接用新会话验证恢复）。
3. **watcher 灵敏度**：R2 回挂时 `cp` 还原 patch 文件未触发热重组（404 持续 ~19s），追加一行注释后即时触发——live 重组文件监听对整文件替换不敏感，与 M0 记录的「非幂等/双触发窗口」同类平台 quirks，操作层绕过。

结论：3 轮热插拔全项通过、第三轮后零残留、数据目录默认保留——**PASS**（AC-03/43/23）。

## TC-UI-18 workbench 安装 —— PASS

- `dsh plugin --profile workbench add link:/Users/chenkun/Documents/workspace/dsh-api-client` → 安装成功。证据：`~/.dsh/profiles/workbench/package.json` dependencies 出现 `dsh-api-client: link:…`；`dsh.profile.bundles` 列表含 `dsh-api-client`（连同 dsh-http/dsh-sql/dsh-ssh 等）。
- 能力由安装状态推导（本仓库侧义务核验）：`dist/index.js` + `dist/client.js` 存在；package.json `exports` 三键（`.` / `./client` / `./package.json`）；`dsh.engines.dsh = ">=0.1.2-rc.1"` 满足（当前 0.1.2-rc.1）；`dsh.client.platform = "web"`、`inject: []`。
- **可加载打开实证**：`dsh --profile workbench --no-open --port 3081` 起第二实例（web profile 实例不停，无端口冲突）→ boot 日志含 api-client settings namespace 声明 → Ego 打开 3081：sidebar 入口在、`probe.mode()="slot"`、点击后 ApiClientView 完整呈现（共享数据目录下同一批 7 collections 可见）。截图 `tc18-workbench-panel.png`。
- 还原：`dsh plugin --profile workbench remove dsh-api-client` → dependencies 与 bundles 均不含 api-client（脚本核验 clean）；workbench 实例已停。
- 证据边界：workbench profile 实为 web-app 基座（bundles 含 `@deepseek-ai/dsh-web-app`），故「打开」验证在与 web 相同的 shell 语义下进行；registry yaml 归 dsh-workbench 仓库维护（U-N5），不在本仓库义务内。
- 结论：**PASS**（AC-36/37）。

## WP8b 修复清单

无新增修复。WP8a 变更一次性通过回归。WP8a-C2/C3 两处小修的运行时侧证（3080 web profile 实证）：无 requestId 的 history 条目「重新执行」按钮 `disabled=true` + tooltip「此条目未关联已保存请求，无法经 SecretRef 链重放」（截图 `wp8-c2-rerun-disabled.png`）；URL 输入 `…/dup-check?x=1` 经 Params 同步后无重复参数（`duplicated: false`，WP8a 前为 `?x=1&x=1`）。

## WP8b 遗留

1. 旧会话工具列表在插件回挂后不刷新（平台行为，建议向 DSH 反馈会话级工具清单失效策略）。
2. live 重组 watcher 对整文件替换不灵敏（平台 quirks，操作层以追加写入触发）。
3. `dsh web` 为父子双进程，SIGTERM 需覆盖子进程，否则 EADDRINUSE（操作教训，已记录于重启申报）。

## WP8b 收尾状态

- web profile：插件保持**安装态**（`dsh-api-client@link:`），DSH PID 22551 健康（401）；profile `cordis.patch.yml` 无 api-client 残留行。
- workbench profile：插件已 remove、实例已停（父子双进程 48577/48579 均已 SIGTERM，3081 端口已释放），还原完成。
- 回显 server 已停；Ego task space 16 已关闭。
- 新增证据截图：`docs/evidence/v01/wp8-*.png`、`tc03-*.png`、`tc18-*.png`。
