# DEVLOG — 开发日志

倒序追加（新条目在最上）。制度见 AGENTS.md §二「变更双记录」：收口时一次性补记；bug 修复必须写根因；功能改造必须写前后差异与动机；调研须附证据来源。

<!--
每条格式：

## YYYY-MM-DD · 标题

- **背景**：为什么做
- **变更**：文件级要点（多批次改动合并一条时，批次列全）
- **决策与理由**：
- **踩坑与修复**：（bug 写根因，不止症状与修法）
- **验证**：测试数 / 实测证据
- **关联**：commit hash、设计文档、CHANGELOG 条目
-->

## 2026-09-10 · project-init 治理结构初始化

- **背景**：用户决定用 chatgpt-dev-pipeline 执行「API Client 常用交互优化 P0」（UX 设计稿 docs/superpowers/specs/2026-09-10-api-client-everyday-ux-design.md）；流水线要求双记录（CHANGELOG + DEVLOG）与仓库规范文件（AGENTS.md / PROJECT.md），仓库此前没有该治理结构，用户指示用 project-init skill 初始化。
- **变更**：新增 AGENTS.md（模板 v1.2.0 原样复制）、PROJECT.md（探测事实 + 基线实测填充）、CHANGELOG.md、docs/DEVLOG.md、knowledge-base/README.md、docs/design/.gitkeep、docs/archive/（本地）、CLAUDE.md（一行指针）；.gitignore 追加 `docs/archive/`、`.chatgpt-dev-pipeline/`、`.env`、`.env.*`；README.md 追加「开发规范」小节。
- **决策与理由**：用户不在场，Step 2 访谈按缺省处理——可选模块（ADR 目录/sandbox 原型区/pre-commit hook/CI）全部未建，待用户回来勾选；指针层只建 CLAUDE.md（ZCode/Codex 原生读 AGENTS.md）；存量 docs/ 定稿文档不迁移 docs/design/（会改 README 引用路径），留 TODO 待确认。
- **踩坑与修复**：无（纯文档与目录初始化）。
- **验证**：基线实测 `pnpm test` 19 spec / 209 tests 全绿（3.0s）、`pnpm exec tsc --noEmit` 0 错误；敏感项扫描：git 跟踪文件无秘密文件（仅 secret-ref.ts / secret-store-service.ts 等代码文件名含 secret），仓库无 .env 用法（秘密走 DSH shared/secrets/ 0600 权限，不入库）。
- **关联**：CHANGELOG Unreleased · Docs；本轮流水线状态 `.chatgpt-dev-pipeline/api-client-everyday-ux-p0/state.json`（本地不入库）。
