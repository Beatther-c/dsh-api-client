# ego-browser 真实浏览器验收方法论（DSH 插件 UI）

> 来源：2026-09-10 P0 常用交互优化浏览器验收全程实证（40+ 断言；docs/DEVLOG.md 同日条目）。每个坑都真实踩过。

## 选择器纪律

- **必须限定插件容器**：DSH 宿主自身 UI 也用标准 ARIA（宿主侧栏项目树就是 `role=treeitem` + `aria-expanded`）。全文档 `querySelectorAll('[role=treeitem]')` 会把宿主节点混进断言（本轮实测混入 5 个 expanded 节点差点误判 AC-03 失败）。一律先取 `[data-dsh-api-client="…"]` 根再下钻。
- 插件自有组件应约定 data 属性槽位（本项目：`tree-row/tree-name-slot/tree-expand-slot/...`），验收断言比 class/文本稳定。

## React 受控组件驱动

- 文本输入：原型 setter 绕 value tracker——`Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(input, v)` + `dispatchEvent(new Event('input',{bubbles:true}))`；直接赋值会被 React `updateValueIfChanged` 去重吞掉。select 用 HTMLSelectElement 原型 setter + `change`；checkbox 直接 `.click()`。
- 键盘契约：`dispatchEvent(new KeyboardEvent('keydown',{key,code,bubbles:true}))` 对 React 合成事件有效；**连续多次按键必须异步间隔**（每次之间 await ~300ms）——同步循环里 React 批处理不更新 `document.activeElement`，4 次 ArrowDown 只生效 1 次（实测假象）。
- 树行「选中态」与 DOM focus 是两回事：F2 等快捷键作用于 state 里的当前选中。测试要先建立选中（最干净：**右键目标行**——只选中、不打开、不 toggle），再派快捷键。

## 鼠标/滚动

- 真实拖动用 CDP 可信事件：`cdp('Input.dispatchMouseEvent', {type:'mousePressed'|'mouseMoved'|'mouseReleased', x, y, button:'left', buttons})`——能驱动 setPointerCapture 路径，合成 PointerEvent 不能完整替代。
- **编程式 `scrollTop=…` 会异步触发原生 scroll 事件**：先滚到底再立刻右键开菜单，菜单会被自家 scroll-close 监听在下一帧秒关（实测「菜单不出现」假象）。滚动与后续动作之间等 ≥300ms 沉降。
- 找真实滚动容器：从目标节点**自身**开始向上爬（本轮 overflow 就设在列表自己身上，从 parentElement 起爬找 miss），判据 `computedStyle.overflowY !== 'visible' && scrollHeight > clientHeight`。

## 视口/主题

- 响应式三态临界值用 `cdp('Emulation.setDeviceMetricsOverride', {width,height,deviceScaleFactor:1,mobile:false})` 精确打点（±1px 临界验证）；完事 `Emulation.clearDeviceMetricsOverride`。注意组件测的是**容器宽度**，DSH shell 会吃掉 ~56px（窗口宽 ≠ 容器宽，临界点要换算）。
- 重挂载检测：在关键节点上挂 expando（`el.__marker='X'`），状态序列跑完后断言仍在——React remount 会丢 expando，比对比 outerHTML 可靠。
- 暗色验证：DSH token 是 **body 级** `--dsw-alias-*` CSS 变量（theme.ts 注释写明）。在 `document.body.style` 覆盖变量即可模拟 shell 暗色（覆盖到 documentElement 会被 body 级同名变量遮蔽——实测无效）。断言 `getComputedStyle` 计算色翻转，portal 到 body 的菜单同样跟随。

## 剪贴板与截图

- ego-browser 后台上下文 `document.hasFocus()=false` → `navigator.clipboard.writeText/readText` 被 Chrome 安全模型拒绝（页面级 CDP 会话也没有 `Browser.grantPermissions`）。应用侧失败路径（toast+不改选择）照常验收；**内容正确性用捕获法**：页内 override `writeText` 收集实参再断言（本轮验证了复制 URL/cURL 的 redaction）。
- 截图：`await captureScreenshot('/abs/path.png')`（bridge 全局函数，签名 `(...args)`；`screenshot/takeScreenshot` 不存在）。

## 会话纪律

- 同一 task space **串行**使用：任何时刻只允许一个 ego-browser 进程（脚本轮询期间不要插自己的探测 heredoc，会控制冲突）。
- 每个 heredoc 首行必须 `useOrCreateTaskSpace(name|id)`，否则报 "Task space not selected"。
- 长任务（ChatGPT 生成类）交给 ask-chatgpt 脚本的轮询契约（exit 10 → poll），不要自己写一次性长阻塞 heredoc。
