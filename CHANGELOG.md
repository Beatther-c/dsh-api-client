# Changelog

本项目所有值得记录的变化都在此文件。制度见 AGENTS.md §二「变更双记录」：用户视角一行一条（改了什么 + 可感知效果），提交后补 commit hash；技术细节详录见 docs/DEVLOG.md。

格式：按日期/里程碑分节，节内按 Added / Changed / Fixed / Removed / Docs 分类；进行中的变更先记 `## Unreleased`，合并时移入对应日期。

## Unreleased

<!-- 进行中变更记在这里 -->

## 2026-09-10

### Added

- **P0 常用交互优化**（bf5af48）：请求树稳定行 + 右键上下文菜单（新建/重命名/复制/剪切/粘贴/复制 URL/复制为 cURL/删除）+ 完整键盘契约 + 行内重命名；侧栏拖动调宽（normal/compact/hidden 三态 + overlay drawer + 宽度持久化）；Headers/Params 自动生成项分层展示（来源/状态/可停用/敏感恒遮罩）；Folder CRUD 与跨集合复制/剪切移动（Host 内存剪贴板 + 版本乐观锁 409）；删除强确认（递归统计 + dirty 计数）与 tab 生命周期一致性。AC-01～51，自动化测试 209→558 全绿，零新增运行时依赖。

### Fixed

- GPT 全量 review 回修 loop1（057cf23）：Cut 409 保留剪贴板 token、菜单粘贴改"插在该请求之后"（冻结矩阵）、Auth SecretRef 惰性解析（被用户覆盖时零解析零 trace）、Host 全部 mutation 统一 write-first 提交（写盘失败不污染权威态）、SaveRequestModal 单一状态机（stale 正确汇聚）、安全 cURL 保留 Auth 结构（值 `<redacted>`）、openRequest 防双 tab、Copy/Cut 不再假 stale、侧栏 PATCH 单写队列、pointer 事件按 pointerId 过滤；测试 558→588。
- review loop2 定向回修（d026616）：Cut 创建 409 按合同置树 stale（§3.1.1/§4.9），测试 588→589。**GPT 最终判定：可发布**（R-09 基线英文文案留 P1 治理项）。

### Changed

- 请求构建改为 canonical `buildRequestPlan`：Preview 与 Send 共享同一优先级合并算法；修复 Auth 无条件追加 Header（用户同名 Header 优先且不再出现双 Authorization）；wire Header 按大小写不敏感聚合并保留用户首拼写（bf5af48）。
- 主界面用户可见文案中文化：顶栏/空态/保存对话框/toast/删除确认等（bf5af48）。

### Docs

- 项目治理结构初始化：AGENTS.md/PROJECT.md/CHANGELOG/docs/DEVLOG/knowledge-base（40bc9ea）。
- P0 完整实施设计文档（ChatGPT 产出，七项完整性检查通过）（c58b1c3）。
- UX 设计稿（需求事实源）与真实浏览器验收证据截图入库（本批提交）。
