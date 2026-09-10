<!-- project-init template v1.2.0 — 项目层：逐项填入本项目事实，填完删除 TODO 标记；本文件优先级高于 AGENTS.md，是项目硬规范的单一事实源 -->

# PROJECT.md — dsh-api-client 项目硬规范

> 智能体开工前必读本文件（规则见 AGENTS.md §一）。带 `TODO` 的条目为未确认项，涉及时先与用户确认。

## 项目速览

Agent-native API Client for DeepSeek Harness（DSH）：Postman 级调试 UI + Agent 原生 HTTP 工具（`api_client_*`）+ Postman Collection v2.1 导入，Human 与 Agent 共用同一套 API Client Core。以 DSH 原生插件形态运行（cordis patch、热插拔），npm 已发布 `dsh-api-client@0.1.0`（MIT），GitHub 公开仓库 `Beatther-c/dsh-api-client`。

## 技术栈与架构

- pnpm monorepo；TypeScript ~5.7.2；React 18（peerDependency）；tsup 双入口构建（`dist/index.js` host + `dist/client.js` client）；Host/Core 为 Node ESM；HTTP 走 `undici`；测试 Vitest + jsdom（`tests/**/*.spec.ts`）。
- 分层与单向数据流（`hook → Host API → service/core → storage`）：
  - `packages/shared` — 共享类型与存储契约（SecretRef、storage-layout、tool-names）；
  - `packages/core` — 纯函数层（零 DSH import）：request build/body、auth apply、executor、security（SSRF 网络策略、redactor、sensitive-headers）、collection/environment/history 模型与操作、变量解析、import pipeline；
  - `packages/postman-adapter` — Postman v2.1 parse/detect/normalize/compat-scanner/migration report；
  - `src/host` — file-store 文件存储、services（collection/environment/execution/history/import/profile/settings/secret-store/redaction/audit/network-policy/tree-clipboard）、Host API router（基础 28 端点 + P0 新增 7：folders×3、tree/clipboard×4）、Agent tools；**Host 是权威数据源**，mutation 原子持久化；
  - `src/client` — dsh-adapter（feature-detect 双路径：官方 Slot 优先 + DOM fallback）、views/hooks/components/slots；DSH UI 内部契约只允许出现在 `dsh-adapter/` 与极薄 slot 注册层。

## 目录导览

- `packages/{shared,core,postman-adapter}/src` — 三个纯 TS workspace 包；
- `src/host/{api,services,tools}` — Host API 端点、服务层、Agent 工具；
- `src/client/{views,hooks,components,dsh-adapter,slots}` — 客户端 UI 与 DSH 适配层；
- `tests/` — Vitest spec（含架构边界守护 `tests/architecture-boundary.spec.ts`）；
- `docs/` — 设计/契约/验证文档（存量定稿，迁移待确认见 TODO）；`docs/design/` 定稿区；`docs/archive/` 本地过程归档（gitignored）；`docs/evidence/` 验证证据截图；
- `fixtures/` — 测试夹具；`scripts/` — 生成脚本（gen-manifest-contract）；`tools/spike` — M0 兼容性 spike；
- `cordis.patch.yml` — DSH 插件 patch manifest；`knowledge-base/` — 项目经验沉淀（随仓库提交）。

## 环境与运行

- 命令：`pnpm install` / `pnpm build`（tsup）/ `pnpm test`（vitest run）；typecheck 用 `pnpm exec tsc --noEmit`（无独立 script）；无 lint 配置。
- DSH 依赖版本锁：`@deepseek-ai/*` 全家 `0.1.2-rc.1`（精确锁定，不追 latest）；`@deepseek-ai/schemastery` 锁 `3.18.2`。
- 本地试运行：`pnpm build` 后 `dsh plugin --profile web add link:$PWD`；安装后 DSH Sidebar 出现 API Client 入口。
- npm 发布：需 Automation token（免 2FA，实证经验）；`prepublishOnly` 自动 build。**发布是外发操作，必须用户明确拍板。**
- Node 版本未在 engines/.nvmrc 锁定。<!-- TODO: 确认最低支持 Node 版本并写入 engines -->
- 网络：GitHub/npm 操作若失败，本机可用代理 `http://127.0.0.1:7890`（实证经验）。

## 硬规范与红线

1. **架构边界**：client 的 view/component/hook 禁止直接 import DSH 包；DSH 集成只经 `src/client/dsh-adapter/` 与 slot 注册层；由 `tests/architecture-boundary.spec.ts` 守护，不得削弱或删除该测试。
2. **数据权威**：UI 不得直接修改持久化数据；所有 mutation 走 `hook → Host API → service/core → storage`，Host 成功后客户端重新拉取投影；失败时 UI 保持原状，禁止不可恢复的乐观更新。
3. **秘密边界**：Authorization / Cookie / API Key / SecretRef 及 secret 环境变量解析值，不得明文出现在 DOM 文本、accessibility name、tooltip、toast、错误消息、console、日志、History、Agent context；脱敏一律走既有 redaction 出口（redaction-service / core redactor）。
4. **SSRF 网络策略**：默认 fail-closed（拒 localhost/私网）、blocked hosts/ports、redirect 逐跳重评估、DNS rebinding 防护；不得绕过或削弱。
5. **不改 DSH 上游、不 fork**；集成只经 `cordis.patch.yml` 与 adapter 层。
6. **用户可见文案使用中文**。
7. **零新增运行时依赖优先**；确需新增必须给替代方案对比，并评估对内网/离线打包部署的影响（设计文档须含依赖预算章节）。

## 质量门禁

- `pnpm test` — Vitest 全量；**基线（2026-09-10 实测）：19 spec / 209 tests 全绿**（3.0s）；交付要求 0 failed 且不低于基线覆盖。
- `pnpm exec tsc --noEmit` — **基线（2026-09-10 实测）：0 错误**。
- lint — 未配置（无 eslint/prettier/biome），暂不作为门禁。<!-- TODO: 是否引入 lint 待用户拍板 -->
- UI/布局改动必须真实浏览器实测（ego-browser 优先；遇控制冲突/连接错误已获授权回退 ZCode 自带浏览器——2026-09-07 并发争用事故教训）：断言实际渲染尺寸/位置/填充；「编译通过」「HTTP 200」「class 存在」不算证据。
- 运行时行为验证在真实 DSH 运行态做（本地 link 安装），方法参照 `docs/V01_MANUAL_VERIFICATION.md`。

## 复用与依赖策略

- UI 能力优先评估复用社区组件；客户端目前零第三方 UI 运行时依赖（React + 自绘 + DSH 主题跟随），保持该默认，自绘无需额外论证，**新增依赖才需要论证**。
- 版本锁定的 `@deepseek-ai/*` 与 schemastery 不升级 latest；升级须显式评审并同步更新 `docs/DSH_COMPATIBILITY_MATRIX.md`。

## 协作与决策机制

- 大功能开发走 **chatgpt-dev-pipeline**：ChatGPT 出设计文档并做代码 review（经 GitHub connector 拉公开仓库）、ZCode 子智能体（默认 qwen）按工作包并行实现、orchestrator 负责完整性检查/门禁/commit+push/状态记账；DESIGN_GATE 等关卡需用户拍板，用户预授权全程时原话记入 `.chatgpt-dev-pipeline/<feature>/state.json`（本地，不入库）。
- 外部咨询/评审通道：ChatGPT，经 `ask-chatgpt` skill（ego-browser 驱动，自动化脚本 `~/.zcode/skills/ask-chatgpt/scripts/ask-chatgpt`）；每功能新建专用固定会话，URL 记入状态文件。
- 验收：质量门禁全绿 + 设计文档浏览器验收清单逐条通过 + GPT review 无阻塞问题；npm 发布、插件市场上架、改写 git 历史等外发/破坏性操作必须用户单独拍板。

## 关键文档索引

- `docs/DESIGN_V1.1.md` — 完整设计方案 V1.1（技术决策 D1–D26 冻结）；
- `docs/V01_IMPLEMENTATION_DESIGN.md` — V0.1 可执行实现设计（WP0–WP8 / AC-01…43 / TC×127）；
- `docs/UI_ADAPTER_CONTRACT.md` / `docs/CLIENT_MANIFEST_CONTRACT.md` — UI 适配与 manifest 冻结契约；
- `docs/DSH_COMPATIBILITY_MATRIX.md` — DSH 能力兼容矩阵（against 0.1.2-rc.1）；
- `docs/M0_SPIKE_DESIGN.md` / `docs/M0_SPIKE_REPORT.md` — 兼容性 spike 设计与实测报告；
- `docs/V01_MANUAL_VERIFICATION.md` — V0.1 手工运行时验证记录（证据在 docs/evidence/）；
- `docs/REVIEW_NOTES_V1.1.md` — 二轮评审待办与决策记录；
- `docs/superpowers/specs/2026-09-10-api-client-everyday-ux-design.md` — 常用交互优化 UX 设计（P0/P1/P2 分期，P0 为本轮流水线范围）。
- <!-- TODO: 存量定稿文档是否迁入 docs/design/ 并补状态行（会改动 README 引用路径，待用户确认后再迁移） -->

## 决策记录

- 2026-09-10 · 「常用交互优化 P0」采用 chatgpt-dev-pipeline 执行，用户**全程预授权**：设计文档通过七项完整性检查即视为批准、门禁全绿后自动 commit+push 到 main、GPT 全量 review、卡死才停 · 理由：用户执行期间不在场，无法逐关卡确认（授权原话存于流水线状态文件 human 节）。
- 2026-09-10 · project-init 治理初始化：AGENTS.md（模板 v1.2.0 原样）/ PROJECT.md / CHANGELOG / docs/DEVLOG / knowledge-base / docs/design + docs/archive 目录 / CLAUDE.md 指针；基线实测全绿后记录 · 用户指示，双记录制度是流水线前置依赖；访谈缺省处理（可选模块 ADR/sandbox/pre-commit/CI 全部未建，待用户勾选）。
- 更早历史：V1.1 设计评审与 V0.1 实现决策见 `docs/REVIEW_NOTES_V1.1.md` 与 git log。
