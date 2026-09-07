# M0 DSH Compatibility Spike — 可执行设计

> 角色：方案设计（feature: m0-dsh-compat-spike）
> 上游契约：docs/DESIGN_V1.1.md（D1–D26 冻结）+ docs/REVIEW_NOTES_V1.1.md（二轮评审）
> 目标运行时（已实证）：DSH 0.1.2-rc.1（`~/.dsh/profiles/web/node_modules`，npm latest）
> 参考样本：`@linxin666/dsh-client-ui-task-board@0.3.16`（DOM 注入 + MutationObserver 自愈；cordis.patch.yml 样本见 REVIEW_NOTES §五）
> 官方文档：GitHub `deepseek-ai/deepseek-harness` master（docs/subsystems/slots.zh.md / web-client.zh.md）

---

## 1. 范围与非目标

### 1.1 范围

M0 是 **Compatibility Spike**（DESIGN §30、§36）：只做兼容性验证与最小探针脚手架，回答 §36 的 5 个决定工程路线的问题：

- Q1：New Session 下方 DOM 注入能否长期稳定、自愈、正确卸载；
- Q2：`conversation` replacement 能否在不损害关键 UX 的情况下承担主视图；
- Q3：若不能，CSS takeover fallback 是否稳定；
- Q4：Session creation + Safe Context injection 是否有公开、可靠的调用路径；
- Q5：profile identity 与 `dsh.client.inject` manifest 契约在目标 runtime 中如何真实表现。

具体包含：

1. 仓库脚手架从零建立（本仓库当前只有 README.md 与 docs/，无任何构建/测试配置）；
2. 一个**最小可安装探针插件**（host 半 + client 半），通过 `dsh plugin --profile web add link:<本仓库路径>` 装入本机 DSH 0.1.2-rc.1；
3. 完成 §3 的 **17 项验证清单**（DESIGN §30 十六项 + REVIEW_NOTES 中级待办 #2 补充的第 17 项「插件热插拔」）；
4. 「Open API Client」深链激活契约（REVIEW_NOTES 中级待办 #3），落在 `src/client/dsh-adapter/panel-activation.ts`，作为「程序化激活」验证的技术前置；
5. 第 5 项验证显式包含 Slot 路径 yield 机制与 replacement occupant 的 owner props / `session-maybe` scope 契约验证（REVIEW_NOTES 低级待办 #4）；
6. 使用官方排查工具 `cordis_inspect what:"client"` 与 `pnpm gen-client-catalog` 生成运行时目录（REVIEW_NOTES 低级待办 #7、DESIGN §3.5）；
7. 产出并冻结 §6 列出的 6 个输出物（DESIGN §30 与 §36 两处清单在本文合并为一处，以本文为准）。

### 1.2 非目标（逐条排除，不得扩大）

- 不实现任何正式功能：无 Collection / Environment / History / Request Editor / Response Viewer / Postman Adapter / 正式 Human UI；
- 不实现真实 HTTP Executor（V-12 的 `api_client_request` 仅为**回显桩工具**，不发出任何网络请求）；
- 不实现 secret 存储与 at-rest 保护（REVIEW_NOTES 中级待办 #1 属 M1/M3 输入，见 §10）；
- 不创建 `packages/core`、`packages/shared`、`packages/postman-adapter` 的任何实现（pnpm-workspace 仅预留 glob）；
- 不修改 DSH 源码（DESIGN §3.6：zero DSH source patch）；
- 不做 Workbench 接入（DESIGN §26 属后续阶段）；
- 不发布 npm 包。

---

## 2. 仓库脚手架与前后端文件级拆分

### 2.1 脚手架选型（本设计决定项）

| 项 | 选型 | 依据 |
|---|---|---|
| 包管理 | pnpm + workspace | DESIGN §20 仓库结构含 `pnpm-workspace.yaml`；DSH 生态官方脚本 `pnpm gen-client-catalog` 同为 pnpm |
| 语言 | TypeScript（strict） | DESIGN §21/§22 文件均为 .ts/.tsx |
| 构建 | tsup 双入口（`src/host/index.ts` → `dist/index.js`；`src/client/index.ts` → `dist/client.js`） | 匹配 §20.1 exports 契约；产物格式（ESM/CJS）为未决决策 U-1，由 V-16 实测定 |
| 测试 | vitest + jsdom | 纯函数与 DOM 注入逻辑可离线单测；运行时场景走手工验证记录（见 §4） |
| 插件包名 | 直接使用 `dsh-api-client`（真实最终名） | 避免 M1 改名导致 manifest / patch roster 二次验证 |

### 2.2 根目录新增文件（构建与测试配置 + 可安装插件 manifest）

| 文件 | 职责 |
|---|---|
| `package.json` | 双重身份：(a) workspace root（scripts：`build` / `test` / `gen:manifest-contract`）；(b) **可安装插件 manifest**，字段见 §2.6 |
| `pnpm-workspace.yaml` | 声明 `packages/*`（M0 不创建任何 package，仅为 M1 预留） |
| `tsconfig.json` | strict、ES2022、`jsx: react-jsx`、host/client 共用 |
| `tsup.config.ts` | 双入口构建；client 入口按 U-1/U-2 决策处理 external（React、DSH client 包） |
| `vitest.config.ts` | environment=jsdom，include `tests/**/*.spec.ts` |
| `cordis.patch.yml` | 见 §2.6 |
| `.gitignore` | `node_modules/`、`dist/` |

### 2.3 Host 半（`src/host/`，DESIGN §22 的 M0 探针子集）

| 文件 | 职责 | 覆盖验证项 |
|---|---|---|
| `src/host/index.ts` | Cordis 插件入口（`exports["."]`）：apply 时装配下列探针并记录生命周期（install/mount/start/stop/unmount）时间戳；dispose 时逆序清理并记录，供 V-17 热插拔核验 | V-11/12/15/16/17 |
| `src/host/probes/probe-log.ts` | 探针结果统一落盘（JSON Lines，写入 `$DSH_HOME/api-client/spike/probe-log.jsonl`），M0_SPIKE_REPORT 的证据来源 | 全部 host 侧 |
| `src/host/probes/remote-api-probe.ts` | 注册一个最小 Host Remote API endpoint（`GET /api-client/spike/ping`，loopback + 凭证校验，拒绝匿名/跨源）；dispose 时注销 | V-11 |
| `src/host/probes/tool-probe.ts` | 注册桩工具 `api_client_request`（schema 同 DESIGN §13.1，但实现仅回显入参 + `spike: true`，**不发网络请求**）；dispose 时注销并记录注销时序 | V-12/17 |
| `src/host/probes/profile-probe.ts` | 按 DESIGN §19.1 优先级探测 profile identity（runtime metadata → 插件 context/loader metadata → 环境变量 → 显式配置），输出 `{profileId, source}`；四路均失败时输出显式 `unresolved`，不猜测（D19） | V-15 |
| `src/host/probes/announcement-probe.ts` | 验证 Node 半的 system-prompt announcement 贡献位是否可用（REVIEW_NOTES §五「插件双半契约」），仅注入一行可识别标记 | V-16 辅助 |

### 2.4 Client 半（`src/client/`，DESIGN §21 的 M0 探针子集）

| 文件 | 职责 | 覆盖验证项 |
|---|---|---|
| `src/client/index.ts` | client 入口（`exports["./client"]`）：先跑 feature-detect，再按能力矩阵装配各 adapter 探针；导出统一 `dispose()` 供热卸载 | V-01/17 |
| `src/client/probe-panel.tsx` | 最小探针面板：展示 feature-detect 结果、各探针状态、当前 profile/theme 读数。它是 replacement / CSS takeover 两条路径共用的被挂载视图（M0 不做任何 API Client 功能 UI） | V-05/06/07 |
| `src/client/slots/settings-item-probe.tsx` | 通过 `settings.plugin.item`（dsh-client-ui-settings-plugins 包，REVIEW_NOTES §五已实证存在）注册一个只读探针条目 | V-09 |
| `src/client/dsh-adapter/feature-detect.ts` | 探测 `ctx.slots?.register` / `ctx.slots?.inject`、目标 slot declaration 是否存在、kind/scope、当前 occupant/priority（DESIGN §3.5）；输出结构化 `FeatureDetectResult`（纯函数，可单测） | V-01/02 |
| `src/client/dsh-adapter/slot-adapter.ts` | 官方 `conversation` replacement/shadow 探针：`ctx.slots.inject('conversation', …)` + 高 priority `register`（DESIGN §3.2 候选实现；实际 slot key/owner props/priority 以运行时目录为准，不写死）。**必须包含**：(a) yield 机制——订阅 session selection，触发注销/降优先级（REVIEW_NOTES #4，DOM 路径有 task-board capture 监听先例）；(b) replacement occupant 满足 `conversation` slot 的 owner props / `session-maybe` scope 契约并记录该契约实测形态 | V-05/06 |
| `src/client/dsh-adapter/legacy-dom-adapter.ts` | CSS takeover fallback 探针：保持 Conversation DOM mounted，`CSS hide` + panel show；恢复时反向操作（DESIGN §3.2） | V-07 |
| `src/client/dsh-adapter/sidebar-injection.ts` | New Session 下方 DOM 注入：semantic attribute 优先 + selector fallback list + MutationObserver 自愈 + 去重守卫（自愈后不得出现第二个入口）+ `dispose()` 彻底移除 DOM 与 Observer（DESIGN §3.1、§32） | V-03/04/17 |
| `src/client/dsh-adapter/panel-activation.ts` | 面板激活状态机（activate/deactivate/isActive）+ **「Open API Client」深链激活契约**（REVIEW_NOTES #3）：解析深链 token（占位形态 `#api-client`，最终形态为未决决策 U-3），冷启动与运行中两种场景均直达 panel 而非会话页；同时暴露程序化激活入口供外部（后续 Workbench）调用 | V-05（含深链子项） |
| `src/client/dsh-adapter/panel-mutual-exclusion.ts` | 与其他社区 plugin panel 的互斥：Slot 路径与 Slot 生命周期联动；DOM 路径用 DOM event / attribute 互斥（DESIGN §3.4 表） | V-08 |
| `src/client/dsh-adapter/theme-adapter.ts` | Theme token 读取（官方上下文/Token 优先，CSS 变量 fallback）+ 暗色模式 + sidebar collapse（宽态图标+文字 / 折叠 Rail 仅图标） | V-10 |
| `src/client/dsh-adapter/session-bridge.ts` | 程序化 Session creation → activate → SafeApiDebugContext（M0 用固定样例文本，不含任何 secret 逻辑）注入 / composer prefill；逐路径记录是否为公开 API 及降级点（DESIGN §14.3） | V-13/14 |

约束（DESIGN §21，AC-39/40 前置）：所有 DSH UI 内部契约只允许出现在 `dsh-adapter/` 与极薄的 slots 注册层；`probe-panel.tsx` 不得直接 import DSH client 包。

### 2.5 scripts / tests / fixtures

| 文件 | 职责 |
|---|---|
| `scripts/gen-manifest-contract.ts` | 读取本插件 package.json + V-16 实测记录，生成 `fixtures/client-manifest-contract.json` |
| `tests/feature-detect.spec.ts` | feature-detect 纯函数单测（mock ctx 有/无 slots API 两路） |
| `tests/sidebar-injection.spec.ts` | jsdom 下注入、去重、自愈回调、dispose 单测 |
| `tests/panel-activation.spec.ts` | 深链解析与激活状态机单测 |
| `tests/fixtures.spec.ts` | 两份 fixtures 的骨架 schema 校验（字段齐备性） |
| `fixtures/runtime-slot-catalog.json` | 输出物，骨架见 §6.5（由官方工具输出整理而来） |
| `fixtures/client-manifest-contract.json` | 输出物，骨架见 §6.6 |

### 2.6 最小可安装插件文件（逐文件契约）

**`package.json`（插件 manifest 部分，DESIGN §20.1；实际字段以 V-16 对 manifest scanner 实测为准）：**

```json
{
  "name": "dsh-api-client",
  "version": "0.0.1-spike.0",
  "exports": {
    ".": "./dist/index.js",
    "./client": "./dist/client.js",
    "./package.json": "./package.json"
  },
  "dsh": {
    "engines": { "dsh": ">=0.1.2-rc.1" },
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "inject": [] }
  }
}
```

- `exports["."]`：Node 半，跑在 host 进程（含 system-prompt announcement 贡献位，REVIEW_NOTES §五）；
- `exports["./client"]`：浏览器半，由 DSH 服务于 `/plugins/<id>/client.js`；缺失时 Host Client Module scanner 不识别（DESIGN §20.3，V-16 含负向验证）；
- `dsh.client.inject`：Client package dependency edge，**不是** Host Cordis service inject（DESIGN §20.2）；M0 起始为空数组，实测中若 probe-panel/slot 注册需要官方 client 包（如 React、slots 运行时）再按最小集合补充并记录进 CLIENT_MANIFEST_CONTRACT.md；
- `dsh.engines >= 0.1.2-rc.1`：依据 REVIEW_NOTES 低级待办 #8（§37 第 1–6 条已在 npm latest = 0.1.2-rc.1 安装源码中直接核验）。

**`cordis.patch.yml`（DESIGN §20.4；样本依据 REVIEW_NOTES §五 task-board 实测）：**

```yaml
- insert:
    - id: api-client
      name: 'dsh-api-client'
```

作为 `dsh.bundle.patch` 声明的 roster 插入层，叠加于 dsh-base；安装/卸载必须通过 DSH plugin lifecycle 完成（`dsh plugin --profile web add link:<路径>` / remove），不手改官方配置。

**构建产物**：`dist/index.js`、`dist/client.js`（由 tsup 生成，安装前置）。

---

## 3. 17 项验证清单

编号 V-01…V-17。V-01…V-16 与 DESIGN §30 的 16 项一一对应；V-17 为 REVIEW_NOTES 中级待办 #2 补充项。结果记录位置缩写：MATRIX = docs/DSH_COMPATIBILITY_MATRIX.md，REPORT = docs/M0_SPIKE_REPORT.md，UIC = docs/UI_ADAPTER_CONTRACT.md，CMC = docs/CLIENT_MANIFEST_CONTRACT.md，CAT = fixtures/runtime-slot-catalog.json，MAN = fixtures/client-manifest-contract.json。

| # | 验证项 | 验证操作 | 预期证据 | 结果记录位置 | §36 映射 |
|---|---|---|---|---|---|
| V-01 | `ctx.slots.register` 在目标运行时可用 | client 入口执行 feature-detect，记录 API 形态（register/inject 签名、cardinality 支持） | FeatureDetectResult 显示 register/inject 均存在且可调用 | MATRIX + REPORT | Q2 前置 |
| V-02 | runtime slot catalog 能查询目标 declaration / occupant | 运行官方工具 `cordis_inspect what:"client"`（运行时 slot 树 + occupant）与 `pnpm gen-client-catalog`（含替换风险目录）（REVIEW #7）；feature-detect 补充导出 | 得到含 `conversation`、`settings.plugin.item`、`sidebar.footer.action` 等 declaration 的目录，含 kind/scope/occupant/priority | CAT + MATRIX | Q2/Q3 前置 |
| V-03 | Sidebar New Session 下方 DOM 注入可稳定工作 | 安装插件，观察宽 Sidebar（图标+文字）与折叠 Rail（仅图标）两态 | 入口出现在 New Session 下方、唯一、可点击；截图 | REPORT + UIC（selector 契约） | Q1 |
| V-04 | MutationObserver 自愈在 React 重渲染后无明显闪烁 | 依次触发：切换会话、折叠/展开 sidebar、切换主题、新建会话 | 每次重渲染后入口 ≤1s 恢复、无重复节点、无肉眼闪烁；probe 日志记录自愈次数 | REPORT | Q1 |
| V-05 | 主视图官方 `conversation` replacement/shadow 可工作（**显式含**：yield 机制 + replacement occupant 的 owner props / `session-maybe` scope 契约（REVIEW #4）；深链/程序化激活（REVIEW #3）） | slot-adapter 以高 priority 注册 probe-panel；点击 Session 验证 yield 注销/降级；用 V-02 目录核对 occupant 契约；新窗口以深链 token 打开验证直达 panel | panel 经官方 slot 显示；yield 后官方 Conversation 恢复；契约字段记录成文；深链直达 | REPORT + UIC + MATRIX | Q2（深链子项兼 Q4 前置） |
| V-06 | replacement 后 Conversation 草稿/滚动/view 状态恢复质量 | composer 输入草稿 + 滚动到中部 → 激活 panel → 切回 Session | 逐项记录草稿/滚动位置/view tab 保留与否，给出 UX 可接受性结论（GO / NO-GO→fallback） | REPORT + MATRIX | Q2 |
| V-07 | Legacy CSS takeover fallback 可工作并保留 Conversation DOM | 强制走 legacy-dom-adapter：hide Conversation + show panel；DevTools 检查 DOM | Conversation 子树保持 mounted；切回后草稿/滚动完整保留 | REPORT + UIC | Q3 |
| V-08 | API Client Panel 与其他社区 plugin panel 的互斥机制 | 同装 `@linxin666/dsh-client-ui-task-board@0.3.16`，交替激活两个 panel | 任一时刻至多一个 panel 可见，无双 Panel、无状态残留 | REPORT + UIC（互斥协议） | Q1/Q2 支撑 |
| V-09 | `settings.plugin.item` 或目标 Settings slot 可用 | settings-item-probe 注册；打开 Settings → Plugins | 出现 API Client 探针条目 | MATRIX + REPORT | 五问外·能力矩阵补充（官方 Slot 主路径可行性） |
| V-10 | Theme token / dark mode / sidebar collapse | theme-adapter 读取 token；切暗色；折叠 sidebar | token 读数非空、入口配色跟随主题、折叠态仅图标 | MATRIX + REPORT | 五问外·能力矩阵补充 |
| V-11 | Host Remote API 注册、鉴权、注销 | remote-api-probe 注册 ping endpoint；本机带凭证访问 / 匿名访问 / 停用后访问 | 带凭证 200；匿名/跨源被拒；注销后不可达；鉴权形态记录成文 | REPORT + MATRIX | Q5 支撑（host 运行时契约） |
| V-12 | `api_client_request` Agent Tool 注册与注销 | tool-probe 注册回显桩；会话中让 agent 调用；随后停用插件再调用 | agent 可发现并成功调用（返回回显）；注销后工具不可见/调用失败；命名无冲突（`api_client_*`，D13） | REPORT + MATRIX | Q5 支撑 |
| V-13 | Programmatic Session creation | session-bridge 调用 DSH API 创建并激活 Session | 新 Session 出现且被激活；记录所用 API 是否公开、稳定 | REPORT + MATRIX | Q4 |
| V-14 | SafeApiDebugContext → Session / Composer 注入 | session-bridge 将固定样例上下文注入新 Session 或 prefill composer | 至少一条路径成立：直接注入 或 prefill+用户确认（DESIGN §14.3 降级链）；记录路径与降级点 | REPORT + MATRIX | Q4 |
| V-15 | Host 当前 profile identity 自省 | profile-probe 按 §19.1 四级优先级探测；在 web profile 下运行；另测无 metadata 场景 | 输出 `{profileId: "web", source: …}`；不可得时显式 `unresolved`（不猜测，D19） | REPORT + MATRIX | Q5 |
| V-16 | `dsh.client.inject`、`exports["./client"]`、bundle patch 的真实 manifest 契约 | 以 §2.6 manifest 安装；负向：临时去掉 `./client` export 重装观察 scanner 行为；记录 `dsh.client.inject` 实际解析方式与 `/plugins/<id>/client.js` 服务行为 | 正向识别为合法 Client Module 并服务 client.js；负向出现可识别失败；契约逐字段成文 | CMC + MAN + REPORT | Q5 |
| V-17 | 插件热插拔（`patchReload: live` 下完整热安装/热卸载，REVIEW #2） | live 模式下 `dsh plugin add link:` → 验证 client 注入半激活；`remove` → 验证 DOM+Observer 移除、panel 注销、工具注销时序、Host API 注销，全程**不重启 DSH**；重复 3 轮 | 安装后探针全量生效；卸载后零残留（DOM 查询为空、Observer disconnected、工具列表无 api_client_*、endpoint 404）；3 轮无泄漏 | REPORT + MATRIX | Q1（卸载）+ Q5（lifecycle 契约） |

五问覆盖核对：Q1 ← V-03/04/08/17；Q2 ← V-01/02/05/06/08；Q3 ← V-07；Q4 ← V-05(深链前置)/13/14；Q5 ← V-11/12/15/16/17。全部覆盖。

---

## 4. 测试用例 / 场景清单

分两类：**[A] 自动化**（vitest，不依赖真实 DSH，进 `tests/`）；**[M] 手工运行时场景**（真实 DSH 0.1.2-rc.1，操作步骤与证据写入 M0_SPIKE_REPORT.md，Review 依据报告复核）。

### 4.1 自动化用例

| TC | 类型 | 输入/操作 → 预期结果 | 映射 |
|---|---|---|---|
| TC-M0-01 | 正常 | mock ctx 含 slots.register/inject → feature-detect 返回 `slotsAvailable: true` 且含 declaration/kind/scope 字段 | AC-M0-01 |
| TC-M0-02 | 错误 | mock ctx 无 `slots` → 返回 `slotsAvailable: false`，不抛异常，降级标志置位 | AC-M0-01 |
| TC-M0-03 | 正常 | jsdom 挂载模拟 sidebar → sidebar-injection.attach → 存在带 `data-dsh-api-client` 语义属性的唯一入口节点 | AC-M0-03 |
| TC-M0-04 | 边界 | 入口节点已存在时再次 attach（模拟自愈竞态）→ 节点数仍为 1 | AC-M0-04 |
| TC-M0-05 | 正常 | 移除入口节点触发 Observer 回调 → 节点被重建 | AC-M0-04 |
| TC-M0-06 | 回归 | dispose() → 入口节点删除且 `observer.disconnect` 被调用；再触发 DOM 变更不再重建 | AC-M0-17 |
| TC-M0-07 | 正常/边界 | panel-activation 解析深链 token（占位 `#api-client`）→ 调用 activate；无 token → 不激活；未知 token → 不激活且无异常 | AC-M0-05 |
| TC-M0-08 | 正常 | fixtures/runtime-slot-catalog.json 通过骨架 schema 校验（§6.5 必填字段齐备） | AC-M0-18 |
| TC-M0-09 | 正常 | fixtures/client-manifest-contract.json 通过骨架 schema 校验（§6.6） | AC-M0-18 |

### 4.2 手工运行时场景

| TC | 类型 | 输入/操作 → 预期结果 | 映射 |
|---|---|---|---|
| TC-M0-10 | 正常 | `pnpm build` 后 `dsh plugin --profile web add link:<本仓库>` → 插件加载成功，probe-log 出现生命周期记录，`/plugins/<id>/client.js` 可访问 | AC-M0-16/20 |
| TC-M0-11 | 错误 | 临时删除 `exports["./client"]` 重装 → scanner 不识别 client module，记录具体报错/静默行为后恢复 | AC-M0-16 |
| TC-M0-12 | 正常 | 打开 DSH Web → 宽 sidebar：New Session 下方出现「图标+API Client」；折叠 Rail：仅图标 | AC-M0-03/10 |
| TC-M0-13 | 回归 | 依次执行切换会话 / 折叠展开 / 切主题 / 新建会话各 3 次 → 入口每次恢复且全程唯一、无明显闪烁 | AC-M0-04 |
| TC-M0-14 | 正常 | 点击入口 → probe-panel 经官方 conversation replacement 显示；`cordis_inspect what:"client"` 显示 occupant 已变更 | AC-M0-05 |
| TC-M0-15 | 正常 | panel 激活状态下点击任一 Session → panel yield（注销/降优先级），官方 Conversation 恢复；对照目录记录 owner props / `session-maybe` scope 契约的满足方式 | AC-M0-05 |
| TC-M0-16 | 边界 | composer 输入草稿 + 会话滚动至中部 → 激活 panel → 切回 → 逐项记录草稿/滚动/view tab 是否保留，给出 GO/NO-GO 结论 | AC-M0-06 |
| TC-M0-17 | 正常 | 强制 CSS takeover 模式重复 TC-M0-16 → Conversation DOM 保持 mounted（DevTools 证据），草稿/滚动保留 | AC-M0-07 |
| TC-M0-18 | 正常 | 同装 task-board@0.3.16，交替激活两 panel 5 次 → 任一时刻至多一个可见，无双 Panel | AC-M0-08 |
| TC-M0-19 | 正常 | Settings → Plugins → 出现 API Client 探针条目 | AC-M0-09 |
| TC-M0-20 | 正常 | 暗色主题下 theme-adapter 读数非空且入口配色跟随 DSH | AC-M0-10 |
| TC-M0-21 | 正常+错误 | ping endpoint：本机带凭证 200；匿名 curl 被拒（401/403 或等价）；跨源模拟被拒；停用插件后不可达 | AC-M0-11 |
| TC-M0-22 | 正常+错误 | 会话中要求 agent 调用 `api_client_request`（回显桩）→ 返回回显且 `spike: true`；停用插件后同一调用失败/工具不可见 | AC-M0-12 |
| TC-M0-23 | 正常 | probe-panel 触发 session-bridge → 新 Session 被创建并激活；记录 API 公开性 | AC-M0-13 |
| TC-M0-24 | 正常/降级 | 注入固定样例 SafeApiDebugContext → 直接注入成功，或降级 prefill composer 后由用户确认发送；记录实际路径 | AC-M0-14 |
| TC-M0-25 | 正常 | 新浏览器窗口打开 `<dsh-url>` + 深链 token → 直达 probe-panel 而非会话页；运行中实例内触发深链导航同样生效 | AC-M0-05 |
| TC-M0-26 | 正常+边界 | profile-probe 在 web profile 输出 `{profileId:"web", source}`；人为屏蔽 metadata 源 → 输出显式 `unresolved` 而非猜测值 | AC-M0-15 |
| TC-M0-27 | 正常+回归 | `patchReload: live` 下 add → 探针全量生效（不重启 DSH）；remove → DOM/Observer/panel/工具/endpoint 全部消失（不重启 DSH）；连续 3 轮后零残留、probe-log 无泄漏迹象 | AC-M0-17 |
| TC-M0-28 | 正常 | 执行 `cordis_inspect what:"client"` 与 `pnpm gen-client-catalog`，整理输出为 fixtures/runtime-slot-catalog.json | AC-M0-02/18 |

---

## 5. 验收标准（AC-M0-1…AC-M0-20）

AC-M0-01…17 由 §3 的 V-01…V-17 逐一派生（编号同序）；18–20 为输出物与脚手架标准。「§31 对应」指 DESIGN §31 中被本 AC 前置验证/部分覆盖的正式 AC（M0 不重复其原文）。

| AC | 标准（可逐条核验） | §31 对应 |
|---|---|---|
| AC-M0-01 | feature-detect 在真实运行时报告 `ctx.slots.register/inject` 可用，且离线单测两路（有/无）通过 | AC-05 前置 |
| AC-M0-02 | fixtures/runtime-slot-catalog.json 已由官方工具输出整理生成，含 conversation 族与 settings slot 的 declaration/kind/scope/occupant/priority | AC-41 部分 |
| AC-M0-03 | 安装后 New Session 下方出现唯一 API Client 入口（宽/折叠两态正确） | AC-01 |
| AC-M0-04 | 4 类重渲染触发各 3 次后入口均自愈、唯一、无明显闪烁 | AC-02 |
| AC-M0-05 | conversation replacement 挂载 probe-panel 成功；点击 Session 触发 yield 且官方视图恢复；owner props / `session-maybe` 契约记录成文；深链 token 冷启动/运行中均直达 panel | AC-04/05/07 前置 |
| AC-M0-06 | 草稿/滚动/view tab 恢复质量有逐项记录与明确 GO/NO-GO 结论；NO-GO 时 fallback 决策写入 REPORT | AC-06 前置 |
| AC-M0-07 | CSS takeover 下 Conversation DOM 保持 mounted 且切回后草稿/滚动保留 | AC-06 |
| AC-M0-08 | 与 task-board 交替激活无双 Panel | AC-08 |
| AC-M0-09 | Settings → Plugins 出现探针条目（官方 Slot 路径） | AC-09 |
| AC-M0-10 | Theme token 读数、暗色适配、折叠态行为全部正常 | AC-10 |
| AC-M0-11 | ping endpoint 带凭证可达、匿名/跨源被拒、注销后不可达 | AC-33 前置 |
| AC-M0-12 | `api_client_request` 桩可被 agent 发现调用，注销即时生效，命名空间无冲突 | AC-20/22/23 前置 |
| AC-M0-13 | 程序化 Session 创建+激活成立，API 公开性有明确记录 | AC-24 前置 |
| AC-M0-14 | 上下文注入或 composer prefill 至少一条路径实测成立，降级点记录成文 | AC-24 前置 |
| AC-M0-15 | profileId 在 web profile 下正确自省且来源明确；不可得时显式 unresolved | AC-18 前置（D19） |
| AC-M0-16 | manifest 正向识别 + `./client` 缺失负向行为均有记录；`dsh.client.inject` 实际语义成文 | AC-39/40 支撑（D20） |
| AC-M0-17 | live 模式 3 轮热插拔全程不重启 DSH，卸载后 DOM/Observer/Panel/Tool/API 零残留 | AC-03（含 REVIEW #2 对 AC-03 的「不重启 DSH」补强）/AC-23 |
| AC-M0-18 | §6 的 6 个输出物全部存在、非空、符合各自骨架，fixtures 通过 schema 单测 | AC-41 |
| AC-M0-19 | M0_SPIKE_REPORT.md 对 §36 五问逐一给出 GO / NO-GO / FALLBACK 结论及证据链接 | — |
| AC-M0-20 | `pnpm build` 与 `pnpm test` 全绿；`dsh plugin --profile web add link:` 安装成功 | — |

---

## 6. M0 输出物契约（6 项，合并 §30 与 §36 清单，以此为准）

### 6.1 docs/DSH_COMPATIBILITY_MATRIX.md

行按**能力**组织（不按 Slot API / DSH 版本，DESIGN §30、D26）。骨架：

```markdown
# DSH Compatibility Matrix（against 0.1.2-rc.1）
| 能力 | 官方路径 | Fallback | 实测结果 | 证据(V-xx) | 风险/备注 |
（行：sidebar 入口 / 主视图 replacement / CSS takeover / settings item /
 theme / 互斥 / host API / agent tool / session 创建 / context 注入 /
 profile 自省 / manifest / 热插拔 / 深链激活）
## 探测方法（feature-detect + runtime catalog + adapter capability matrix）
## 版本适用性声明
```

### 6.2 docs/M0_SPIKE_REPORT.md

```markdown
# M0 Spike Report
## 环境（DSH 版本 / profile / 安装方式 / 样本插件版本）
## V-01…V-17 逐项结果（操作记录、证据：截图/日志/probe-log 摘录、结论）
## §36 五问结论（Q1–Q5：GO / NO-GO / FALLBACK + 依据）
## TC-M0-10…28 执行记录
## 对 M1 的工程路线建议
```

### 6.3 docs/UI_ADAPTER_CONTRACT.md

```markdown
# UI Adapter Contract（冻结）
## FeatureDetectResult 结构
## SlotAdapter：conversation 挂载/yield/owner props 与 session-maybe scope 契约
## LegacyDomAdapter：takeover/restore 契约
## SidebarInjection：selector 优先级表 + 自愈与去重语义 + dispose 义务
## PanelActivation：深链 token 契约 + 程序化激活入口（对外，供 Workbench）
## PanelMutualExclusion 协议
## ThemeAdapter：token 来源与 fallback
## SessionBridge：创建/激活/注入/prefill 各路径公开性结论
```

### 6.4 docs/CLIENT_MANIFEST_CONTRACT.md

```markdown
# Client Manifest Contract（冻结）
## exports 契约（"." / "./client" / "./package.json"）与负向行为
## dsh.engines / dsh.bundle.patch / dsh.client.platform / dsh.client.inject 逐字段实测语义
## cordis.patch.yml roster 插入层实测格式
## 安装/卸载 lifecycle（含 patchReload: live）实测行为
## client.js 服务路径与模块格式结论（决定 U-1/U-2）
```

### 6.5 fixtures/runtime-slot-catalog.json

```json
{
  "dshVersion": "0.1.2-rc.1",
  "capturedBy": ["cordis_inspect what:\"client\"", "pnpm gen-client-catalog"],
  "capturedAt": "<ISO8601>",
  "slots": [
    {
      "key": "<declaration key>",
      "cardinality": "single|list|keyed|chain",
      "scope": "<e.g. session-maybe>",
      "ownerProps": {},
      "occupants": [{ "id": "", "priority": 0 }],
      "replacementRisk": ""
    }
  ]
}
```

### 6.6 fixtures/client-manifest-contract.json

```json
{
  "dshVersion": "0.1.2-rc.1",
  "manifest": { "exports": {}, "dsh": {} },
  "scannerBehavior": {
    "recognizedAsClientModule": true,
    "clientJsServedAt": "/plugins/<id>/client.js",
    "missingClientExportBehavior": "",
    "moduleFormat": ""
  },
  "bundlePatch": { "file": "cordis.patch.yml", "rosterEntry": {}, "patchReloadLive": "" }
}
```

---

## 7. 风险等级声明

**高危。** 判定依据（角色指令：涉及鉴权即高危）：V-11 需实现并验证 Host Remote API 的鉴权边界（loopback、凭证校验、拒绝匿名/跨源）。缓解：M0 的 endpoint 仅为无副作用 ping 探针，不暴露任何 executor 能力；不处理 secret、无支付、无数据迁移、无删除类操作（探针卸载仅清理自身注册物）。其余为 DESIGN §32 已知的兼容性风险（DSH Developer Preview 契约演进、Sidebar DOM 注入），由 dsh-adapter 隔离 + feature-detect + fixtures 固化对冲。

## 8. 后端是否无改动

**不适用「无改动」，但范围受限**：本仓库当前无任何既有业务代码；M0 新增的后端类代码仅为 `src/host/` 探针（§2.3）。**不修改 DSH 本体、不修改任何外部服务**（D3、§3.6 zero DSH source patch）。合并实现角色下，host 半与 client 半由同一实现 Agent 按本设计完成。

## 9. 未决决策列表（交由设计评审 / M0 实测解决）

| # | 未决点 | 解决途径 |
|---|---|---|
| U-1 | `dist/index.js` 与 `dist/client.js` 的模块格式（ESM/CJS）及 DSH scanner 的期望 | V-16 实测，结论写入 CMC §「模块格式」 |
| U-2 | client bundle 中 React / DSH client 运行时包是 external（经 `dsh.client.inject`）还是打包内联 | V-16 实测 `dsh.client.inject` 解析语义后定 |
| U-3 | 深链 token 的最终形态（`#api-client` hash、query 还是 DSH router 路由段） | V-05 深链子项对 DSH router 实测；契约冻结进 UIC |
| U-4 | `conversation` slot 的确切 declaration key、owner props、可用 priority 区间 | V-02 运行时目录为准（DESIGN §3.2 明令不在设计期写死） |
| U-5 | `patchReload: live` 的确切配置名与所在位置（cordis.patch.yml 字段 / DSH 配置 / CLI 参数） | V-17 实测，写入 CMC lifecycle 节 |
| U-6 | profile identity 不可自省时 V0.1 的安全 fallback 具体形态 | M0 仅记录四级探测的真实可用性（V-15），fallback 设计留给 M1 |
| U-7 | Host Remote API 的官方注册机制与鉴权原语（DSH 提供何种 server/route 注册面） | V-11 实测，写入 MATRIX + REPORT |
| U-8 | vitest 选型若与团队既有偏好冲突 | 设计评审确认；不影响 17 项验证的手工部分 |

## 10. 后续阶段输入（本设计不展开）

- **REVIEW_NOTES 中级待办 #1（shared secrets at-rest 保护）** → M1/M3 输入：secret 值单独存 `shared/secrets/`（文件 0600、目录 0700），`environments.json` 只存 SecretRef，并新增对应 AC。M0 不实现、不验证任何 secret 存储。
