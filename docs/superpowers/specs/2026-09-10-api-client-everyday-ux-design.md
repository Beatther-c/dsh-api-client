# DSH API Client 常用交互优化设计

- 日期：2026-09-10
- 状态：待用户评审
- 范围：左侧请求树、可调侧栏、Headers/Body 自动项，以及轻量 API Client 的常用能力补齐
- 非范围：本文件不进入实现，不承诺完整复刻 Postman 平台

## 1. 目标

本轮优化首先解决高频操作中的摩擦，而不是追赶 Postman 的全部平台能力：

1. 左侧集合树在悬停时不再因行尾按钮出现而挤压名称、产生视觉跳动。
2. Collection、Folder、Request 使用符合桌面应用习惯的右键上下文菜单完成新建、复制、粘贴、删除和重命名。
3. 点击 Collection 或 Folder 的整行即可展开或收缩；首次进入默认全部收缩，并提供全部展开/全部收缩入口。
4. 左侧栏可拖动调宽，且不会导致编辑器重挂载或丢失未保存内容。
5. Headers 页明确展示 Body、Auth 和运行时将自动产生的 Header，避免“界面里没写、实际却发出”的不透明行为。
6. 盘点当前能力与 Postman 常用能力的差距，只纳入日常调试高频项。

成功标准是：用户可以稳定、连续地整理请求树，发送前可以理解最终请求的来源与覆盖关系，并能完成常见 HTTP API 调试，不需要学习复杂自动化平台能力。

## 2. 当前项目基线

项目是 pnpm monorepo：React 18 + TypeScript 5.7 客户端，Node ESM Host/Core，`undici` 负责 HTTP，Vitest + jsdom 负责测试。分层如下：

- `packages/shared`：共享类型和存储契约；
- `packages/core`：请求构建、Auth、执行、安全、Collection 纯函数；
- `packages/postman-adapter`：Postman v2.1 导入、规范化和迁移报告；
- `src/host`：文件存储、服务、Host API、Agent tools；
- `src/client`：DSH 适配层、React views/hooks/components。

架构门禁要求客户端 view/component/hook 不直接依赖 DSH 包，UI 数据操作继续走 `hook → Host API → service/core → storage`，不能在组件里直接修改持久化数据。

### 2.1 已确认的问题

| 问题 | 当前原因 | 影响 |
|---|---|---|
| 树节点行宽跳动 | `TreeItem` 在 hover 时动态挂载多个行尾按钮 | 名称反复缩短，点击目标移动 |
| 默认全部展开 | `collapsed` 初始值为空集合 | Collection 多时首屏过长 |
| 只能点小箭头折叠 | Folder/Collection 整行没有 toggle 行为 | 点击命中区太小 |
| 侧栏固定宽度 | 主视图写死 `260px` | 长名称看不全，主区也无法按任务调配空间 |
| Folder 操作缺失 | Core 已有部分 Folder 纯函数，但 service/API/UI 未接入 | 右键菜单不能只靠前端完成 |
| Headers 自动项不透明 | 发送时补 `Content-Type`、`Accept`，Auth 也会注入 Header/Query，但界面只有一句提示 | 保存内容与实际发送内容难核对 |
| 搜索状态与折叠状态混杂 | 搜索时强制展示祖先，但 toggle 仍修改普通折叠集合 | 用户操作没有即时视觉反馈 |
| 删除状态不一致 | Request 删除未等待成功便关闭 tab；Collection 删除不清理其打开 tabs | API 失败或删除父节点后 UI 与 Host 不一致 |
| 脏 tab 可直接关闭 | 关闭时没有确认 | 容易丢失未保存修改 |

现有请求编辑能力包括 Params/URL 双向同步、Headers 键值表、Basic/Bearer/API Key/继承认证、none/raw/JSON/form-data/urlencoded Body、响应查看、环境变量、历史、Postman v2.1 导入和 Agent bridge。当前 Body 尚无 binary、form-data 文件字段和 raw 子类型选择；Headers/Params 尚无 Bulk Edit、多行粘贴解析、自动补全和 Preset。

## 3. 已选设计方向

用户已在可视化评审中选择：

- 左侧栏采用 A「桌面原生型」：稳定行 + 右键菜单 + 整行折叠 + 可调宽分隔条 + 键盘快捷键。
- Headers 采用 A「用户项与自动项分层」：自动项单独分组、标明来源、运行时计算且不污染保存数据。

说明：Postman 当前官方文档主要描述集合树的悬停更多菜单、快捷键和拖拽；本项目的右键菜单是依据用户偏好采用的桌面交互，并非声称逐像素复制 Postman 左树。

## 4. 左侧请求树设计

### 4.1 稳定行结构

每一行固定包含：展开箭头或占位、类型/HTTP Method、名称、必要状态。移除所有 hover 时动态出现的操作按钮。名称区域始终使用同一宽度，超出时省略号截断，悬停通过 tooltip 显示完整名称。

空 Collection/Folder 不显示伪展开箭头。深层嵌套使用有限视觉缩进，达到最大缩进后不继续压缩名称区，但逻辑层级不受限。

### 4.2 左键行为

- Collection/Folder：单击整行先把该行设为当前选择，再切换展开或收缩；箭头与整行行为一致。
- Request：单击打开或激活对应请求 tab。
- 双击 Request：不额外触发重命名，避免与快速打开冲突；重命名统一用右键菜单或 `F2`。
- 左键空白区域：清除树选择并关闭上下文菜单。

### 4.3 默认状态、全部展开和搜索

- 首次进入 API Client 时，所有 Collection/Folder 默认收缩。
- 工具区提供一个双态按钮：当前全部展开时显示“全部收缩”，其余状态显示“全部展开”。按钮使用图标并带中文 tooltip，避免挤占搜索框。
- 普通折叠状态只保存在当前 UI 会话中；P0 不把节点展开状态写入持久化设置，以避免删除、复制、导入后产生过期 ID。页面重载后重新回到全部收缩。
- 搜索值先 trim，再按 Unicode 小写进行不区分大小写的原始子串匹配；不做 URL decode。空查询等同未搜索。搜索匹配 Request 名称、原始 URL、Collection 名称和 Folder 名称。
- 搜索态只临时展开匹配项的祖先路径，不覆盖用户的普通折叠状态。
- Request 命中时只显示该 Request 与祖先；Collection/Folder 自身命中时显示它的完整后代。数据刷新、重命名、新增或删除后立即按当前查询重新计算结果。
- 搜索态有独立的 `searchCollapsed`：命中路径初始展开，用户单击 Collection/Folder 只修改临时搜索折叠状态；清除搜索后丢弃它并恢复普通折叠状态。
- 搜索态禁用“全部展开/全部收缩”，并以 tooltip 说明“清除搜索后恢复原折叠状态”。

### 4.4 右键菜单

右键首先只选中目标，再打开菜单；不得打开 Request，也不得切换 Folder 展开状态。菜单通过 portal/fixed 层渲染，不能被树区域的 `overflow: auto` 裁切，并在靠近窗口边缘时自动翻转。

| 目标 | 菜单项 |
|---|---|
| 树空白区 | 新建 Collection、粘贴、全部展开/全部收缩 |
| Collection | 新建 Request、新建 Folder、重命名、复制、粘贴、删除 |
| Folder | 新建 Request、新建子 Folder、重命名、复制、粘贴、删除 |
| Request | 打开、重命名、复制、剪切、粘贴到所属容器之后、复制 URL、复制为 cURL、删除 |

菜单分组顺序固定为：创建 → 编辑 → 复制/粘贴 → 导出文本 → 危险操作。无可粘贴内容、Cut 来源已删除/过期或目标非法时，“粘贴”禁用并显示原因；Copy 使用快照，不因来源删除而失效。

菜单关闭条件：点击空白、按 `Esc`、滚动树、窗口 resize、切换 pane、执行动作成功或失败。`Shift+F10` 或键盘菜单键可在当前选择处打开菜单；菜单使用 `role=menu/menuitem`。菜单打开时焦点进入第一个可用项，上下方向键移动，Home/End 跳到首尾，`Enter` 执行，`Esc` 关闭并把 DOM focus 返回原树行。执行 mutation 时仅当前菜单和目标行进入 pending，树的其他只读导航仍可用；同一节点的重复 mutation 被禁用。

树行全部可聚焦，并采用以下键盘契约：

| 按键 | 行为 |
|---|---|
| 上/下 | 移动到上一个/下一个当前可见节点 |
| 左 | 展开节点则收缩；已收缩则移动到父节点 |
| 右 | 收缩节点则展开；已展开则移动到第一个子节点 |
| Home/End | 移动到第一个/最后一个可见节点 |
| Enter/Space | Collection/Folder toggle；Request 打开或激活 |
| F2 | 重命名当前节点 |
| Shift+F10/菜单键 | 打开右键菜单 |
| Cmd/Ctrl+C | Copy 当前节点 |
| Cmd/Ctrl+X | 仅 Request 可 Cut；其他节点无动作并提示原因 |
| Cmd/Ctrl+V | 按当前选择作为目标执行 Paste；无选择时等同根区域 |
| Delete/Backspace | 打开删除确认，不直接删除 |
| Esc | 取消重命名或关闭菜单，保留当前行焦点 |

### 4.5 重命名

重命名使用行内输入框，不再使用浏览器 `prompt`。入口为右键菜单或 `F2`，`Enter` 在普通树行上不进入重命名：

- `Enter` 提交，`Esc` 取消；
- 失焦默认提交，空字符串或只有空格时不提交并恢复原名；
- 同一时间只允许一个节点进入编辑态；
- 提交中显示轻量忙碌状态；失败则保持编辑态并展示错误，不丢失输入；
- 名称冲突允许存在，但不允许空名称。

### 4.6 复制、剪切和粘贴语义

树节点复制采用 Host 内存中的结构化剪贴板，不依赖操作系统剪贴板中的私有 JSON；“复制 URL”和“复制为 cURL”才写入系统剪贴板。Client 只持有不透明 clipboard token 和不含业务内容的节点类型/动作描述，权威快照保留在当前 profile 的 Host 内存中，避免脱敏 API 投影把 Auth 材料复制成 `<redacted>`，也避免把可能敏感的 Body/Auth 快照留在浏览器内存或持久化存储。

Host 内部剪贴板结构包含：随机 token、profileId、操作类型 `copy|cut`、节点类型、源节点 ID、源 Collection ID、创建时间，以及 Copy 的权威节点快照或 Cut Request 的 `request.updatedAt + sourceCollection.updatedAt` 前置版本。token 30 分钟未使用即失效，不写磁盘。Copy 永远使用复制时快照，即使源随后被重命名、移动、修改或删除仍可粘贴；Cut 不保存可独立落库的快照，粘贴前必须验证 Request 和源 Collection 版本未变化，否则报冲突并保留剪贴板。

P0 保持当前数据模型的“两组兄弟顺序”：同一容器内 Folder 和 Request 分别排序，渲染时 Folder 在前、Request 在后，不引入 Folder/Request 混合顺序字段。合法目标和插入位置如下：

| 来源 | 根空白区 | Collection | Folder | Request |
|---|---|---|---|---|
| Copy Collection | 允许，追加根末尾 | 允许，作为根级 Collection 插在目标后 | 禁止 | 禁止 |
| Copy Folder | 禁止 | 允许，追加到其 Folder 列表末尾 | 允许，追加为子 Folder | 禁止 |
| Copy Request | 禁止 | 允许，追加到顶层 Request 末尾 | 允许，追加到其 Request 末尾 | 允许，插在目标 Request 后 |
| Cut Request | 禁止 | 允许，移动到顶层 Request 末尾 | 允许，移动到其 Request 末尾 | 允许，移动到目标 Request 后 |

根空白区“粘贴”因此只接受 Collection。Collection 和 Folder P0 只有 Copy、没有 Cut；Folder move、循环移动校验和完整层级拖拽统一属于 P1。

其他粘贴规则：

- Copy：深拷贝完整子树，Collection/Folder/Request 均生成新 ID；所有 Request 的 `collectionId/folderId` 按新目标重写。
- Cut：Host 成功完成一次原子 move 后清空剪贴板；失败时源节点和剪贴板保持不变。
- Copy 的名称冲突采用“名称 副本”“名称 副本 2”的稳定规则；Cut/move 保留原名，目标允许同名。
- “完整快照”复制当前持久化节点的全部字段、嵌套顺序、Body/Auth 配置和 SecretRef；不复制 History、实际响应、打开 tab、环境当前值或运行时派生 Header。所有结构 ID 重建，外部 `{{variable}}` 引用文本保持原样。

上述能力需要补 Folder CRUD/duplicate/copy、Collection copy，以及跨 Collection Request move/copy 的 Host API，不能只改 React 组件。持久化更新必须保持 Host-authoritative：成功后重新拉取树投影；mutation 成功但重新拉取失败时，显示“数据已保存，列表刷新失败”，把树标记为 stale、禁用后续 mutation 并提供重试刷新；不得谎称已回滚。Copy-Paste 携带目标 Collection `updatedAt`；Cut-Paste 还携带源 Request/Collection 版本。并发变化返回 409，不覆盖新状态。

### 4.7 删除与恢复

- 删除 Request：确认框显示名称；Host 成功后才关闭对应 tab。
- 删除 Folder：确认框显示递归统计的子 Folder 数和 Request 数。
- 删除 Collection：确认框显示递归总 Request 数；成功后关闭其全部已打开 tabs。
- 若 Folder/Collection 下存在 dirty tabs，确认框额外显示“将放弃 N 个未保存修改”，确定按钮文案为“删除并放弃修改”；否则为“删除”。取消按钮默认获得焦点，`Esc` 和关闭按钮都等同取消。
- 成功删除一个或多个 tabs 后，优先激活被删区域左侧最近的存活 tab；左侧没有时选择右侧第一个；均无则回到空状态。
- P0 采用强确认且失败不改变 UI，不提供 Undo。可恢复删除需要新的存储契约，明确放入 P1；在该契约完成前不得显示“撤销”入口。

## 5. 可调侧栏设计

在树和主编辑区之间加入 6px 可命中的分隔条。`viewportWidth` 明确定义为 API Client 主布局容器经 `ResizeObserver` 得到的内容宽度，内部维护用户偏好宽度 `preferredWidth` 与当前渲染宽度 `renderedWidth`：

- 容器宽度不小于 706px 时：默认/偏好宽度 `260px`，正常最小 `220px`，最大 `min(520px, viewportWidth - 480px - 6px)`，为主区和分隔条分别保留 480px 与 6px；
- 容器宽度为 526–705px 时进入 compact：`renderedWidth = clamp(preferredWidth, 160px, viewportWidth - 360px - 6px)`，为主区和分隔条分别保留 360px 与 6px；
- 容器宽度小于 526px 时自动隐藏 docked 树和分隔条，并显示“展开请求树”按钮；隐藏不改写 `preferredWidth`；
- 极窄状态点击按钮后，树以 API Client 容器内左侧 overlay drawer 打开，宽度为 `min(320px, viewportWidth - 32px)`，覆盖主区而不挤压或重挂载编辑器；带半透明 backdrop；
- drawer 打开后焦点进入搜索框并限制在 drawer 内。`Esc`、点击 backdrop、再次点击关闭按钮或打开 Request 后关闭 drawer，焦点返回“展开请求树”按钮；Collection/Folder toggle 不关闭；
- drawer 打开期间 resize 到 526px 及以上时无动画切换为 docked 树并保留当前树行/搜索焦点：526–705px 使用 compact，706px 及以上使用正常状态；从 docked 状态缩到 525px 以下时默认关闭 drawer，只显示展开按钮；overlay 状态不持久化；
- pointer down 后使用 pointer capture，拖动期间只更新宽度，不重挂载树或编辑器；
- 双击分隔条恢复 `260px`；
- 键盘聚焦分隔条后，左右方向键每次调整 10px，按住 Shift 时每次 40px；
- 使用 `role=separator`、`aria-orientation=vertical` 和当前值/最小值/最大值；
- pointermove 只更新 `renderedWidth`；pointerup 或 lostpointercapture 时把最终正常宽度写入 `preferredWidth` 并持久化。pointercancel 恢复拖动起点且不持久化；
- 双击和键盘调整后立即更新内存，键盘连续操作以 300ms debounce 持久化；保存失败显示非阻断 toast，当前会话继续使用内存宽度；
- `preferredWidth` 写入 profile 级 UI 设置 `collectionSidebarWidth`，加载时钳制到 220–520px；compact/隐藏只改变 `renderedWidth`，容器恢复后回到偏好宽度。

不使用原生 CSS `resize`，因为它难以统一命中区、键盘可访问性、范围约束和持久化行为。

## 6. Headers / Body 自动项设计

### 6.1 Postman 对照结论

Postman 会依据 Body、Authorization、Cookie 和请求设置生成 Header；Headers 页可以查看隐藏的自动项、了解来源并覆盖或停用。Body 选择会影响 `Content-Type`，发送时还会计算 `Content-Length`。这项能力有用，因为它让“编辑器配置”与“最终上网请求”之间的转换可解释。

本项目不复制 `Postman-Token`，也不冒充 Postman Runtime。只展示本客户端真实会产生的值。

### 6.2 两层展示

Headers 页分成：

1. **用户 Header**：现有可编辑表格，支持启停、重复项告警、敏感值遮罩。
2. **自动生成 Header**：默认收缩，标题显示“自动生成 N 项”；展开后显示名称、预览值、来源和状态，不写回 `ApiRequest.headers`。

来源标签包括：`来自 Body`、`来自 Auth`、`来自 Cookie Jar`、`来自客户端默认值`、`来自运行时`。点击 Body/Auth/Cookie 来源可切换到对应编辑区域；客户端默认值显示停用说明，运行时项只显示说明，不伪装成可编辑链接。

自动项分两类：

- 发送前可确定的 Header：`Content-Type`、`Accept`、Bearer/Basic `Authorization` 和 Header API Key。Query API Key 不计入 Header 数量，而是在 Params 页的“Auth 自动参数”分组中单独显示。
- 由底层请求编码或网络栈确定：`Content-Length`、`Host`、`Accept-Encoding` 等。发送前显示“发送时计算”，发送后应在实际请求快照/Console 中展示最终值；若底层无法可靠回传，则不能伪造数值。

P0 的停用规则是确定的：

- Body 和客户端默认值生成的行可在自动项分组中取消勾选，按 `{ name: lowercaseHeaderName, source: 'body' | 'client-default' }` 持久化到请求级 `suppressedGeneratedHeaders`；同名不同来源互不误伤；
- Auth 生成行不能在 Headers 页直接停用，必须跳转到 Auth 页改为 `none` 或修改认证配置；
- 网络运行时行只读，不能在预览中停用；若底层允许用户显式覆盖，则通过用户 Header 覆盖；
- 新增同名用户 Header 不会删除 suppression 记录，但用户 Header 仍按最高优先级发送；以后移除用户 Header 时，原 suppression 状态继续生效。

当前首批展示：

| 来源 | 自动项 | 当前实现 | 本轮处理 |
|---|---|---|---|
| Body | `Content-Type` | 已自动补 | 改为可见、有来源、可覆盖 |
| 默认请求 | `Accept: */*` | 已自动补 | 改为可见、有来源、可覆盖 |
| Auth | `Authorization` 或 API Key | 已注入 | 在 Header/Params 中显示安全预览和来源 |
| 运行时 | `Content-Length` 等 | `undici` 处理 | 只读说明；实际值仅在可观测时展示 |
| Cookie Jar | `Cookie` | 未实现 | 放入 P1，不在本轮假展示 |

### 6.3 覆盖优先级

统一优先级：

`启用的用户 Header > 未被 suppression 的 Auth/Body 生成值 > 未被 suppression 的客户端默认值 > 网络运行时最终值`

- 用户添加同名 Header 时，自动行显示“被用户值覆盖”。
- 禁用的用户 Header 不参与覆盖，也不阻止同名自动项生成。
- `Content-Type` 的手动值优先于 Body 推导值。
- Auth 生成项应回到 Auth 页编辑或停用，避免在 Headers 页编辑敏感材料后与 Auth 状态分叉。
- 当前 `applyAuth` 会无条件追加认证 Header；实现时必须改为大小写不敏感的合并规则，确保用户显式 Header 确实优先且不会产生两个 `Authorization`。
- Header 名称比较大小写不敏感；若有两个启用的同名用户 Header，则抑制同名自动项并按用户顺序交给 transport。Core 的 wire 转换必须按小写名称聚合而保留首个用户拼写，并用集成测试记录 `undici` 对可重复/不可重复 Header 的最终行为；不能承诺底层协议不允许的重复语义。
- `Host`、`Content-Length`、`Accept-Encoding` 分别标注“运行时最终决定”；只有经真实 `undici` 验证可覆盖的项才允许显示“用户值覆盖”，否则用户同名值在发送前报清晰错误或被标为无效，不能用统一优先级作虚假承诺。
- 自动项只是一份发送计划投影；保存请求时仅保存用户 Header、原有 Body/Auth 配置和 `suppressedGeneratedHeaders`，不保存 `GeneratedHeaderPreview`、环境解析值、Basic/Bearer/API Key 派生值或运行时最终值。

Query API Key 的冲突规则独立于 Header：启用的用户 URL/Params 同名项优先；若已存在一个或多个启用同名项，Auth 自动参数不追加并显示“被用户参数覆盖”；只有禁用同名项时仍会生成 Auth 参数。生成值在 Params 页恒以 `••••••••` 展示。

### 6.4 权威构建与安全预览

预览和真实 Send 不允许各自实现一套合并算法。Core 新增 canonical `buildRequestPlan`，统一计算 URL/Params、用户 Header、suppression、Body/Auth/default contributions 和 Body；Headers/Params 预览调用同一 primitive 的安全投影模式，Host Send 调用其解析模式。两种模式共享合并/优先级逻辑，仅变量与 SecretRef 的值解析不同。

安全投影规则：

- Authorization、Cookie、API Key、SecretRef 和由 secret 环境变量解析出的值统一显示 `••••••••`；未解析的普通变量保留 `{{name}}`；
- 已识别的敏感值不得出现在 DOM 文本、accessibility name、tooltip、toast、错误消息、console、History 或 Agent context；
- “复制 URL/安全 cURL”保留未解析普通变量；SecretRef、Auth 派生值、secret 环境变量，以及敏感 Header 名下的字面量都使用 `<redacted>`。普通用户 Body/Headers 按其编辑器字面量复制，因为这是用户主动触发的本机剪贴板动作；P0 不提供复制已解析 secret 的 cURL；
- 复制为 cURL 使用 POSIX 单引号转义，包含 method、URL、启用的用户 Header、Body 以及安全自动项；剪贴板写入失败时 toast 提示且不改变选择；
- wire 一致性测试必须把 preview plan 与注入 transport 实际收到的 resolved request 逐项比对，并用真实本地 echo 服务验证 suppression、覆盖、重复 Header 和 Query API Key 冲突。

运行时项计入标题的总数，但标题同时拆分为“发送前 N 项 · 运行时 M 项”；发送完成后，只有 transport 实际回传的项才从“发送时计算”更新为最终值，敏感项仍保持遮罩。

### 6.5 Body 常用补齐（P1）

优先补齐 Postman 日常 HTTP 调试中高频且当前缺失的能力：

- raw 类型增加 `Text / JSON / JavaScript / HTML / XML` 子类型，联动正确 `Content-Type` 与语法高亮；
- `form-data` 每行支持 Text/File，两者共享启停和描述；文件仅保存受控的本机引用，不把文件内容写入 Collection JSON；
- 增加 binary Body，支持选择本地文件，并清楚提示不会自动推断 `Content-Type`；
- JSON 保留格式化、压缩和校验；
- Params、Headers、urlencoded、form-data 增加 Bulk Edit 与多行粘贴解析。

暂不在本轮加入 GraphQL 专用编辑器。

## 7. 常用能力差距与分期

### P0：本轮核心

- 请求树稳定行、右键菜单、整行展开/收缩、默认收缩、全部展开/收缩；
- 可调宽侧栏及宽度持久化；
- Collection/Folder/Request 的重命名、复制、粘贴、删除闭环；
- Request 的剪切与跨 Collection/Folder 移动；Collection/Folder P0 不支持剪切；
- Request 的复制 URL 与复制为 cURL；
- 自动 Header 分层展示与来源/覆盖关系；
- 删除成功后再更新 tabs，关闭脏 tab 前确认；
- 相关键盘和可访问性行为；
- 为上述 UI 与 Host mutation 补自动化测试。

### P1：紧随其后的常用增强

- Params/Headers Bulk Edit、多行粘贴、常见 Header 自动补全与 Header Preset；
- raw 子类型、form-data 文件、binary Body；
- 导入 cURL、导入 OpenAPI、导出 Collection；
- 可恢复删除与 10 秒 Undo；
- Cookie Jar；
- 树节点拖拽移动与完整层级排序；
- 响应区搜索、复制、下载，发送中取消与更清晰的 TLS/网络错误分类；
- Collection/Folder 级 Auth 和 Variables 的可视化编辑。

### P2：用户明确需要后再做

- Pre-request / Post-response 脚本执行与断言；
- Collection Runner 和数据驱动批量运行；
- 完整 OAuth 2.0 授权流程、客户端证书和高级代理；
- 保存 Response 为 Example、历史响应对比；
- GraphQL、WebSocket、gRPC。

### 近期不做

- 云同步、团队协作、评论和权限体系；
- Mock Server、Monitor、定时任务；
- AI 自动生成测试、API 文档发布和 Git 治理；
- 性能压测。

这些是 Postman 平台能力，不是本地优先轻量 HTTP 客户端的核心缺口。

## 8. 组件与契约调整

### 8.1 Client

- `CollectionTree`：负责树投影、搜索态、普通展开态、全局展开动作和当前选择。
- `TreeItem`：稳定行、整行点击、行内重命名和键盘入口；不再持有操作按钮组。
- 新增 `TreeContextMenu`：菜单定位、焦点管理、节点动作矩阵。
- 新增 `ResizableCollectionPane`：分隔条、宽度钳制、键盘调整和设置持久化。
- `HeadersEditor`：将用户 Header 与 `GeneratedHeaderPreview[]` 分层渲染。
- `ApiClientView`：统一协调 tab 生命周期，所有 destructive mutation 等待 Host 成功后再更新 UI。

### 8.2 Shared/Core

- 增加树节点描述、结构化 clipboard snapshot、`suppressedGeneratedHeaders: Array<{name, source}>` 和 Folder/跨 Collection mutation 的输入/输出类型；旧请求缺省为空数组。
- Core 提供纯函数：Folder add/rename/delete/duplicate/copy、Collection copy、Request 跨容器 copy/move、名称副本生成和版本前置校验。Folder move、Folder/Request 混排和完整层级 reorder 不进入 P0。
- 增加 canonical `buildRequestPlan` 及其安全投影，综合用户项、suppression 和各生成来源；Preview 与 Send 必须共用它，敏感值仍遵守现有遮罩和 redaction 规则。

### 8.3 Host/API

- Collection/Folder/Request mutation 继续由 Host 作为权威状态源并原子持久化。
- 为 Folder CRUD/duplicate/copy、Collection copy、Request 跨 Collection copy/move 增加明确端点；一次用户动作只对应一次原子写入。
- 设置接口增加 `collectionSidebarWidth`，保持向后兼容默认值。
- 若提供实际发送 Header 快照，必须先经过现有 redaction 出口，Authorization、Cookie、API Key 不得进入日志、History 或 Agent context 明文。

P0 新增或扩展的端点契约如下；路径是设计合同，实施计划不得再另造第二套通用 mutation API：

| 方法与路径 | 用途 | 关键输入 |
|---|---|---|
| `POST /collections/:id/folders` | 新建顶层或子 Folder | `name, parentFolderId?, expectedCollectionUpdatedAt` |
| `PATCH /collections/:id/folders/:folderId` | 重命名 Folder | `name, expectedCollectionUpdatedAt` |
| `DELETE /collections/:id/folders/:folderId` | 递归删除 Folder | `expectedCollectionUpdatedAt` |
| `POST /tree/clipboard/copy` | Host 捕获 Collection/Folder/Request 权威快照 | `kind, collectionId, nodeId?` |
| `POST /tree/clipboard/cut` | 创建 Request Cut 引用 | `requestId, requestUpdatedAt, sourceCollectionUpdatedAt` |
| `POST /tree/clipboard/:token/paste` | 按 §4.6 矩阵原子 copy/move | `targetKind, targetId?, targetCollectionId?, expectedTargetCollectionUpdatedAt` |
| `DELETE /tree/clipboard/:token` | 主动清空剪贴板 | 无 |

所有 clipboard token 必须绑定 profileId、随机不可猜、只存内存并设 30 分钟 TTL；API 响应只返回安全描述，不回传权威快照。Cut-Paste 成功即消费 token；Copy token 可重复粘贴直到清空、过期或 Host 重启。

不改变 DSH adapter 边界；新 UI 组件放在 `src/client/components/common` 或 `collection` 下。

## 9. 错误与一致性

- 所有菜单 mutation 都有 pending 状态，重复触发被抑制。
- Host 失败时树和 tabs 保持原状态，toast 给出可操作错误；不得先做不可恢复的乐观删除。
- Client 只保存 clipboard token；Copy-Paste 由 Host 内存快照执行并校验目标版本，Cut-Paste 由 Host 同时校验源 Request、源 Collection 和目标 Collection 版本。
- 页面 reload 后 Client 丢弃 token；Host 中的孤立 token 由 TTL 清理。任何节点快照都不得写入浏览器持久化存储或 Host 磁盘。
- 自动 Header 预览失败不阻断编辑；该区域显示失败原因，但实际 Send 仍走 Host 的权威构建链。
- multipart boundary 必须由真实编码器生成，UI 不写死或提前伪造。
- 删除当前打开节点后，active tab 使用 §4.7 的“左侧最近、否则右侧第一个”规则。

## 10. 测试与验收

### 10.1 自动化测试

至少覆盖：

1. hover 前后节点名称区 `getBoundingClientRect().width` 差值不超过 0.5 CSS px，操作按钮不再挂载。
2. Collection/Folder 整行点击 toggle；Request 行点击只打开请求。
3. 初始全部收缩；全部展开/收缩；空节点无箭头。
4. 搜索临时展开祖先，清除搜索后恢复原状态。
5. 右键菜单按节点类型显示正确动作；右键不触发打开/toggle。
6. 菜单 Esc、outside click、scroll、resize 关闭；菜单 bounding rect 始终位于 API Client 可视容器内并保留至少 4px 边距，所有菜单项可滚动或翻转到达。
7. 行内重命名的 Enter/Esc/失焦/空值/失败路径。
8. Copy/Paste 深拷贝新 ID并正确重写 `collectionId/folderId`；Copy 来源删除后仍可粘贴；Cut Request 的源版本过期时返回 409 且不移动。
9. Folder/Collection 删除统计和确认；Host 失败时 tab/tree 不变化。
10. 删除成功后关闭相关 tabs；关闭 dirty tab 必须确认。
11. resize 的 min/max、双击复位、键盘调整、持久化和窄窗口钳制。
12. 自动 Header 的来源、覆盖、大小写不敏感、敏感值遮罩和不落库。
13. 只针对当前已存在的 JSON/raw/Text-only form-data/urlencoded Body 回归：类型切换正确重算 `Content-Type`，multipart boundary 与真实 body 一致；不验收 P1 的 raw 子类型、文件字段或 binary。
14. 架构边界测试继续通过，client 不绕过 Host API。

### 10.2 浏览器验收

使用内置浏览器在真实 DSH 运行态验证：

- 在长 Collection 名称和深层 Folder 下反复悬停，名称和主区无跳动；
- 左键整行折叠，右键只开菜单；
- 连续完成 Request 与 Folder 的复制、粘贴、重命名、删除；刷新后数据正确；
- 把侧栏拖到最小、最大和中间宽度，刷新后恢复；编辑器草稿和响应不丢失；
- 切换当前已有的 JSON/raw/Text-only form-data Body，自动 Header 项和来源即时更新；P1 的文件字段、binary 和 raw 子类型不在本轮验收；
- 手动设置同名 `Content-Type` 后，界面明确显示自动值被覆盖，实际请求只发送用户值；
- Auth 自动项恒脱敏，History/日志/Agent context 不出现秘密明文；
- 浅色/深色、窄窗口、菜单靠四个边缘均可用。

## 11. 实施拆分建议

为降低一次性变更风险，建议按以下顺序实施，但仍作为同一设计范围验收：

1. 树稳定行、展开状态、全局展开和 resize；
2. Context menu、行内重命名、键盘行为；
3. Folder/跨容器 Host mutation 与复制粘贴；
4. 删除/tab 一致性与 dirty tab 确认；
5. Generated Header plan 与分层 UI；
6. P1 中 Body/Bulk Edit 等常用增强另开实现计划，不与 P0 混在一个大提交。

## 12. 官方对照来源

- [Postman：配置 Headers、Header Preset 与自动生成 Header](https://learning.postman.com/docs/use/send-requests/create-requests/headers/)
- [Postman：Params 与 Body 类型、Content-Type 联动和 Bulk Edit](https://learning.postman.com/docs/use/send-requests/create-requests/parameters)
- [Postman：管理 Collection、Folder、拖拽、多选与恢复](https://learning.postman.com/latest-v-12/docs/use/use-collections/manage-collections)
- [Postman：创建和保存 Request](https://learning.postman.com/docs/use/send-requests/create-requests/request-basics)
- [Postman：Authorization 生成项与继承](https://learning.postman.com/latest-v-12/docs/use/send-requests/authorization/specifying-authorization-details)
