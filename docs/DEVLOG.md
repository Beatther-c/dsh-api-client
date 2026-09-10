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

## 2026-09-10 · P0 常用交互优化（chatgpt-dev-pipeline 全程）

- **背景**：用户以《DSH API Client 常用交互优化设计》（docs/superpowers/specs/2026-09-10-api-client-everyday-ux-design.md，Stage 0 产物：树 hover 跳动/默认全展开/无右键菜单/侧栏固定 260px/自动 Header 不透明等 9 项已确认问题 + P0/P1/P2 分期）为需求源，指定走 chatgpt-dev-pipeline：ChatGPT 出实施设计并做代码 review，qwen 子智能体按工作包并行实现，orchestrator 负责门禁/提交/记账。用户**全程预授权**（设计过七项检查即视为批准、门禁全绿自动 commit+push main、卡死才停），原话存 `.chatgpt-dev-pipeline/api-client-everyday-ux-p0/state.json`（本地）。
- **变更**（48 文件 +15650/-815，bf5af48；按工作包）：
  - WP0 shared：SuppressedGeneratedHeader/GeneratedHeaderPreview/GeneratedQueryPreview/RequestPlanPreview/TreeClipboardDescriptor/TreePasteResult 类型 + ApiRequest.suppressedGeneratedHeaders? + PluginSettings.collectionSidebarWidth（settings-service 特批两行：默认 260 + 220-520 校验）；
  - WP1 core/collection/ops：10 个新纯函数（快照深拷贝×3/nextCopyName「名称 副本」/insertRequestAt/moveRequestAcrossCollections/统计×2/版本谓词×2）；
  - WP2 core canonical plan：request/plan.ts（~640 行 buildRequestPlan 双模式 + mergeContributions 九步唯一优先级算法 + suppression 规范化 + buildCopyUrl/buildCurlCommand/posixShellQuote）、build/body/resolver/apply/executor/http-client 改造为 wrapper 或消费方、wire lowercase 聚合；runtime catalog 经 undici@8.10.2 真实集成测试固化（收录 Host/Content-Length，**排除 Accept-Encoding——实测 undici 默认不发**）；
  - WP3 host：tree-clipboard-service（uuid token/profileId/30min TTL/纯内存）、api/folders×3 + api/tree-clipboard×4 端点、collection-service 单调 nextTimestamp + commitCollections 单次写盘 + Folder CRUD、requests.ts suppression 校验；
  - WP4 client 侧栏：ResizableCollectionPane（三态公式/drawer 焦点 trap/children 恒同节点）+ useCollectionSidebarWidth（300ms debounce/失败非阻断）；
  - WP5 client 树：CollectionTree/TreeItem 重写（稳定槽位/双折叠模型/键盘全契约）、TreeContextMenu（portal+两阶段定位）、tree-projection、useTreeClipboard（AC-13 四字段）、useCollections stale/§4.9 流程、useHostApi delete(path,body?)；
  - WP6 通用：tab-lifecycle 纯函数（左邻规则）、TreeDeleteConfirmDialog/DirtyTabCloseDialog、Modal initialFocus/ariaLabel 兼容增强；
  - WP7 generated UI：useRequestPlanPreview（竞态双守卫）、GeneratedItemsSection（Headers/Query 两组）、HeadersEditor/ParamsEditor 分层改造；
  - WP8 汇聚：ApiClientView 全量接线（pane/删除流 §7.3 顺序/Headers 新 props/stale 门禁/文案中文化）；
  - 回修 R1/R2/R3：菜单→对话框焦点交接微任务化+条件接管（CollectionTree）、菜单焦点落位后投放（TreeContextMenu 两 effect 拆分 + menuNonce）、删除/统计/重命名同步 key∨requestId 双匹配（ApiClientView）。
- **决策与理由**：
  - GPT 设计 §0 六项澄清均采纳（clipboard 端点合同恢复与 UX 原文核对一致；compact 160-219 渲染域持久化钳 220；Cut 源外部删除由 Host 404/409 裁决不新增 status 端点）；
  - orchestrator 裁定：WP0 特批 settings-service 两行（否则 Record<keyof PluginSettings> 立即编译破）后顺序移交 WP4；WP3/WP5/WP7 依赖满足即派发不等 wave 整批；Save 不加版本锁（冻结合同未要求，stale 门禁兜底）；基线英文文案（UrlBar Send/Save、ResponseViewer 空态）不在 P0 扩面（AC-47 口径=新增文案），记 P1 候选；
  - 各包披露待 GPT review：cutSourceRef 瞬态引用（AC-13 字面张力）、「粘贴到所属容器之后」=容器末尾追加解释、cURL 排除 Auth 派生条目 vs Query 保留 <redacted> 的不对称、Query 名大小写敏感按 RFC 3986、plan 深路径 import（包索引连带 undici 污染浏览器 bundle）。
- **踩坑与修复**：
  - **46KB 任务书单次 CDP Input.insertText 超时** → ask-chatgpt kernel 加分块插入（≤3000 字符/块 + 代理对不拆 + 长度校验），脚本与 provider 配方双修；
  - **ChatGPT 页面"卡死"假象**：首次生成 35min+ 零可见输出（gen=true len=0）实为 canvas 长文生成中；用户手动重试反而产生第二条空消息——kernel 提取逻辑"取最后一条"抓到空消息 → 定向提取"最后一条**非空**"救回 46796 字符全文；kernel 新增卡死看门狗（10min 签名零变化自动点重试一次，再 10min 报 STUCK）；
  - **jsdom 双重假绿（本轮最重要教训，已蒸馏 KB）**：①真实浏览器拒绝 focus() 到 visibility:hidden 元素（菜单两阶段定位首帧），jsdom 无可见性语义 focus 恒成功；②act() 推迟 passive effect 冲刷，把「Modal initialFocus → closeMenu focusRow 抢回」的真实浏览器顺序反转成恰好正确——R1/R2 测试全绿但真实浏览器必现；
  - **draft-key tab 身份分裂**：保存后 tab.key 仍 draft-N，按 request id 匹配 key 的删除流漏关（幽灵 tab）→ 汇聚层 key∨requestId 双匹配 + 3 回归用例含变异校验；
  - 验收方法坑：DSH 宿主侧栏自身用 role=treeitem（选择器必须限定插件容器）；编程式 scrollTop 异步触发原生 scroll 事件（先滚后右键的菜单被自家 scroll-close 秒关）；连续按键同步派发被 React 批处理吞掉（需异步间隔）；ego-browser 后台上下文 document 未聚焦 → navigator.clipboard 写入被 Chrome 拒（应用失败路径正确，内容验证用 writeText 捕获法）。
- **验证**：
  - 自动化：tsc 0 错误；vitest **30 spec / 558 tests 全绿**（基线 209 + 新增 349）；tsup 双入口 build 成功（client 310.11KB，grep undici=0）；architecture-boundary 全绿；
  - 真实浏览器（DSH 0.1.2-rc.1 web profile + ego-browser，证据 docs/evidence/p0/×4）：40+ 断言通过——hover 宽度差 0px、容器 706/705/526/525 临界 ±1px、拖动/双击/键盘精确调整+持久化 240→220→260+reload 恢复、全状态序列编辑器零重挂载、跨集合复制「副本」/剪切原子移动/Host 快照保留真实 Auth 材料、重命名树+tab+Host 三向同步、自动项计数随 Body 即时联动、suppression Save→reload→仍停用、用户 Content-Type 覆盖后 **wire 仅单条 text/css**、suppressed Accept **wire 零发送**、Query API Key 覆盖 wire 仅用户值、两个测试 token 全 DOM 扫描 0 命中、History 脱敏、host 日志零泄漏、暗色跟随（body 级 var 覆盖全组件+portal 菜单翻转）、删除级联空态回归；R1/R2/R3 回修后全部场景复验通过；
  - 环境还原：测试集合全部清理（9 集合基线）、侧栏复位 260、echo server 41234 保留运行。
- **关联**：设计 docs/design/api-client-everyday-ux-p0-implementation-design.md（c58b1c3）；需求源 docs/superpowers/specs/2026-09-10-api-client-everyday-ux-design.md；治理初始化 40bc9ea；功能 bf5af48；KB：jsdom-focus-false-green、ego-browser-acceptance-methodology；GPT review 结论待 Stage 5 补记。

## 2026-09-10 · project-init 治理结构初始化

- **背景**：用户决定用 chatgpt-dev-pipeline 执行「API Client 常用交互优化 P0」（UX 设计稿 docs/superpowers/specs/2026-09-10-api-client-everyday-ux-design.md）；流水线要求双记录（CHANGELOG + DEVLOG）与仓库规范文件（AGENTS.md / PROJECT.md），仓库此前没有该治理结构，用户指示用 project-init skill 初始化。
- **变更**：新增 AGENTS.md（模板 v1.2.0 原样复制）、PROJECT.md（探测事实 + 基线实测填充）、CHANGELOG.md、docs/DEVLOG.md、knowledge-base/README.md、docs/design/.gitkeep、docs/archive/（本地）、CLAUDE.md（一行指针）；.gitignore 追加 `docs/archive/`、`.chatgpt-dev-pipeline/`、`.env`、`.env.*`；README.md 追加「开发规范」小节。
- **决策与理由**：用户不在场，Step 2 访谈按缺省处理——可选模块（ADR 目录/sandbox 原型区/pre-commit hook/CI）全部未建，待用户回来勾选；指针层只建 CLAUDE.md（ZCode/Codex 原生读 AGENTS.md）；存量 docs/ 定稿文档不迁移 docs/design/（会改 README 引用路径），留 TODO 待确认。
- **踩坑与修复**：无（纯文档与目录初始化）。
- **验证**：基线实测 `pnpm test` 19 spec / 209 tests 全绿（3.0s）、`pnpm exec tsc --noEmit` 0 错误；敏感项扫描：git 跟踪文件无秘密文件（仅 secret-ref.ts / secret-store-service.ts 等代码文件名含 secret），仓库无 .env 用法（秘密走 DSH shared/secrets/ 0600 权限，不入库）。
- **关联**：CHANGELOG Unreleased · Docs；本轮流水线状态 `.chatgpt-dev-pipeline/api-client-everyday-ux-p0/state.json`（本地不入库）。
