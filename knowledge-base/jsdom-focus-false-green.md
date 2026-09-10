# jsdom 焦点假绿：focus() 可见性语义与 act() 时序反转

> 来源：2026-09-10 P0 常用交互优化真实浏览器验收（docs/DEVLOG.md 同日条目；缺陷 R1/R2，回修后复验通过）。

## 结论

**所有以「焦点落位」为验收点的 UI（菜单、对话框、drawer、focus trap），jsdom 测试全绿不构成通过证据，必须真实浏览器复验。** 本项目两个 P0 缺陷在 558 个 jsdom 测试全绿的情况下于真实浏览器 100% 复现。

## 两个独立机制

### 1. jsdom 的 focus() 无可见性语义

真实浏览器**静默拒绝**把焦点投给 `visibility: hidden`（及 `display:none`）元素——`el.focus()` 不报错、`document.activeElement` 不变。jsdom 无布局/可见性引擎，对任何带 `tabIndex` 的元素 `focus()` 都成功。

触发形态（本项目 TreeContextMenu）：portal 菜单采用「首帧隐形渲染测量 → setPlacement → 可见」两阶段定位，挂载 effect 里 `setPlacement` 后**同步**调 `focus()`——此刻重渲染尚未发生，菜单仍 hidden，真实浏览器拒绝聚焦，且后续可见化不会补投焦点。

修法：焦点投放拆到「落位可见后」的第二个 effect（deps 含 placement），配 one-shot ref 防重投；全禁用时落 `tabIndex={-1}` 的菜单容器兜底。

### 2. act() 推迟 passive effect 冲刷，反转组件间焦点交接顺序

真实浏览器（React 18）：离散事件内 setState 同步 commit → 下一个 setState 处理前**同步冲刷**已挂起的 passive effects。于是「菜单动作打开对话框」的真实顺序是：对话框挂载 → (菜单 close 的 setMenu 触发冲刷) Modal initialFocus 执行 → closeMenu 的同步 focusRow **最后抢回焦点**。

jsdom + act()：passive effect 冲刷被推迟到 act 作用域末尾——顺序反转为 focusRow 在前、Modal focus 在后，终态恰好正确，测试假绿。

修法（焦点交接通用模式）：关闭侧的焦点归还改为**微任务 + 条件接管**——`Promise.resolve().then(() => { 仅当 activeElement 为 null/body/脱离节点(isConnected===false)/仍在正关闭的菜单内时才 focusRow })`；焦点已被对话框等有意义目标承接时不抢。微任务在 paint 前执行，无可见闪烁。

## 判别口诀

- 测试绿 + 真实浏览器焦点终态错 → 先查「元素当时可见吗」，再查「谁最后动了焦点」（在候选抢夺点打 `document.activeElement` 日志）。
- 写焦点断言用例时自问：这个断言在 act 反转时序后还成立吗？若成立是侥幸，标注「真实浏览器验收项」并给 jsdom 可判定的机制锚用例（如「焦点已被外部承接时不抢回」）。
