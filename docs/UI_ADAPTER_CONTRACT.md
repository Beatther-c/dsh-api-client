# UI Adapter Contract（冻结）

> 冻结基线：DSH 0.1.2-rc.1 web profile（官方 shell）。本契约由 M0 探针实证固化（证据编号 V-xx 见 `docs/M0_SPIKE_REPORT.md`）。adapter 实现位于 `src/client/dsh-adapter/`。

## FeatureDetectResult 结构

`detectFeatures({ slots })` 产出（`src/client/dsh-adapter/feature-detect.ts`）：

```ts
interface FeatureDetectResult {
  slotsAvailable: boolean      // ctx.slots 存在
  registerAvailable: boolean   // slots.register 为函数
  injectAvailable: boolean     // slots.inject 为函数
  degraded: boolean            // 任一关键能力缺失 → DOM fallback
  slots: Array<{               // 目标 slot 逐项声明探测
    key: 'conversation' | 'settings.plugin.item' | 'sidebar.footer.action'
    declared: boolean
    occupants: Array<{ registrant: string; key?: string; id?: string; priority: number; active: boolean }>
    kind?: 'single' | 'list' | 'keyed' | 'chain'
    scope?: string               // 'root' | 'session' | 'session-maybe'
    declaredBy?: string
  }>
  notes: string[]              // 竞态/异常记录（含 ctx.inject 失败）
}
```

实测门面（0.1.2-rc.1）：slots 服务 protoKeys = `register / inject / entries / entriesOfSlot / snapshot / spec / subscribe / getVersion / renderSlot`。竞态契约：**slots 服务到达 ≠ 声明安装完成**（ui-layout 在 frame 挂载时才声明 `conversation`），声明探测须在宽限期内轮询（SLOTS_GRACE_MS=3000，修 #2）；`ctx.get('slots'/'theme')` 在 apply 时可能为 undefined，经 `ctx.inject([...])` 重读（修 #1/#5）。

## SlotAdapter：conversation 挂载/yield/owner props 与 session-maybe scope 契约

- 挂载：`slots.register({ name: 'conversation', children, store, inject })`（AGENTS 规则：唯一 API 是 register；注册他包 slot 用 `slots.inject(name, cb)`）。激活时以 priority 0 替换官方 occupant（H5@p0）；**同优先级由挂载顺序决定胜负，不得依赖**。
- owner props（session-maybe 标准套件，ui-session AGENTS）：`sessionId: string | undefined` + `useSession` + `useProjection`；root scope 席位给 `useSessions`。实测激活时收到 `sessionId: "session-02b380e4-…"`（V-05）。
- 状态保留：replacement 卸载官方 React 树，但**草稿与滚动位置存活在 DSH store 层**，yield 后完整恢复（V-06）。
- yield 契约（修 #4/4b）：只订阅 `sessions.list.getSnapshot().current`（不是 list 全快照）；武装点 = 首个 `phase:'ready' ` 快照（冷启动持久化选择恢复发生在 pending→ready 边沿，不是用户手势）。三条已实证 yield 路：panel Close / 会话行点击 / 选择变化。
- dispose 义务：deactivate 时注销 register 返回值、恢复官方 occupant（实测 yield 后 H5 恢复）。

## LegacyDomAdapter：takeover/restore 契约

- takeover：会话列（`findConversationColumn` selector 表首个命中者）`visibility:hidden`（**不卸载子树**），列内追加 overlay 容器（`data-dsh-api-client-panel`），`position:absolute;inset:0;z-index:10`。
- **overlay 必须显式 `visibility:visible`**（容器在隐藏列内，visibility 继承，修 #10）。
- **激活可早于会话列挂载**（冷启动深链）：未命中时武装 MutationObserver 重试，不得永久放弃（修 #10）；restore/dispose 时解除武装。
- restore：React root unmount、容器移除、列的 `visibility/position` 写回 takeover 前捕获的 inline 原值（V-07 实证零残留）。
- 重复激活/关闭可循环（V-07 实证）。

## SidebarInjection：selector 优先级表 + 自愈与去重语义 + dispose 义务

- 锚点（官方 shell，按优先级）：`SIDEBAR_COLUMN_SELECTOR` 列 → logoRow（`[class*="logoRow"]`）的父行 → New Session 按钮（logoRow 内嵌套 button，否则 root 首个直接 BUTTON）→ 入口行插入 New Session 行之后。
- 幂等键：入口 `button[data-dsh-api-client=""][data-dsh-plugin][data-dsh-part="sidebar-entry"]`；放置前 `querySelector(ROW_SELECTOR)` 查重（去重语义）。
- 自愈：root 级 MutationObserver 发现入口被 React 重渲染摘除时**同帧（microtask，先于 paint）重插**；body 级 waitObserver 观察 sidebar 面板重挂载与 **frame 级祖先上的 `data-sidebar-collapsed`**（折叠载体不在 sidebar 列上，修 #7）。实测摘除后 50ms 内同节点重插（V-12）；6 步触发器电池后入口恒唯一（V-13）。
- 两态：展开 280px（图标+文字）/ 折叠 rail 56px（仅图标，label inline `none`），跟随 `data-sidebar-collapsed`（V-04）。
- dispose 义务：断开两个 observer、移除入口节点、注销 active 订阅与 click 监听（V-17 零残留实证）。
- shell 依赖：锚点对应官方 ui-sidebar DOM；codex-ui takeover shell 下锚点失效（实测，属已知边界）。

## PanelActivation：深链 token 契约 + 程序化激活入口（对外，供 Workbench）

- token：`#api-client`（M0 占位，U-3；M1 定正式形式）。解析是全函数：空/缺失 → 'none'；精确 token（大小写不敏感、trim）→ 'activate'；其余 → 'unknown'（绝不抛异常、绝不误激活）。DSH router 不消费 hash（实测），hash 归插件自用。
- 冷启动读 `location.hash` + `hashchange` 监听均直达（V-05）。
- 程序化入口：`activate(source?)` / `deactivate(source?)` / `toggle(source?)` 幂等；`isActive()` / `lastSource()` / `subscribe(listener)`。Workbench 等外部调用方走 `activate()`。

## PanelMutualExclusion 协议

- 现状（0.1.2-rc.1）：**无总线**，pairwise 硬编码。task-board 协议：监听 `dsh-panel-activate` DOM 事件，仅当 `event.detail === options.siblingPanelName`（其配置硬编码 'ssh'）时 close；激活时镜像 `data-dsh-taskboard-active` 到 `<html>`；其 panelName='taskboard'。
- 本插件对齐形式（修 #6）：激活时派发 `dsh-panel-activate`（detail='api-client' 名字符串）并镜像 `data-dsh-apiclient-active`；收到 detail 为他名的同事件时让位。
- 实测**单向互斥**（V-08/18）：我激活 → task-board 隐藏；task-board 激活 → 我让位；我再激活 → task-board 不让位（双 panel 共存）。M1 如需全互斥，须推动 DSH 提供注册式总线或逐一对齐每个社区 panel 的硬编码名。

## ThemeAdapter：token 来源与 fallback

- 主路径：client ctx `theme` 服务（ownKeys: preference/fontSize/snapshot/media/overrides）；`snapshot.active.colorScheme` 为明暗实测来源（修 #3）；切换后 context 读数更新（dark: source:context，V-10/20）。
- token 真相：内建主题 `active.tokens` 是**空冻结对象**；可用 token 是 design-platform.css 投影到 body 的 `--dsw-alias-*` CSS 变量（实测 9 个：bg-base #fff、label-primary #0f1115、border-l1 #0000000a 等，修 #8）。
- fallback：context 不可读时读 DOM 变量 + 观察 dark class/媒体查询；`ctx.inject(['theme'])` 解决 apply 竞态（修 #5）。

## SessionBridge：创建/激活/注入/prefill 各路径公开性结论

| 路径 | 公开性 | 实测结论 |
|---|---|---|
| `sessions.create({workspaceId})` + `sessions.open(id)` | **公开 API** | 端到端通（V-13/23）。裸 `create()` → 无工作区会话、composer 禁用；workspaceId 来自 `workspaces.list.getSnapshot().items`（ui-workspace navigation 同款，修 #12b） |
| composer service prefill | **不存在** | `ctx.get('composer')` 为 undefined（V-14/24）——契约缺口，M1 需 DOM 路径或推动官方 face |
| DOM composer prefill | 启发式 | composer 是 Lexical：裸 textContent+input 事件被 reconciliation 清除（实测）；`execCommand('insertText')` 写入可存活（修 #12c）；新会话 composer 异步挂载，需 ≤2.5s 轮询等待（修 #12）；**只预填不发送**（DESIGN §14.3 用户确认） |
