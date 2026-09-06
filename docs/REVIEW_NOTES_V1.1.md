# V1.1 二轮评审待办与决策记录(2026-09-06)

来源:dsh-workbench 编排会话对《dsh-api-client 完整设计方案 V1.1》的二轮 review。
实证依据:本机 DSH 0.1.2-rc.1 安装源码(`~/.dsh/profiles/web/node_modules`)+ GitHub `deepseek-ai/deepseek-harness` master 官方文档(`docs/subsystems/slots.zh.md` / `web-client.zh.md`)+ `@linxin666/dsh-client-ui-task-board@0.3.16` 样本。

## 一、已拍板决策(用户,2026-09-06)——§26 需据此改写

- 「Workbench 批 5 缩减为 Placeholder」方案**作废**:dsh-workbench V1 保持已实现的自研 API 调试页现状验收(其 AC-21 已过 Review 第 2 轮),不改造、不受本插件阻塞。
- dsh-api-client 在与 dsh-workbench **平行的独立 Git 仓库**(本仓库)开发,**优先支持原生 DSH**。
- Workbench 后续**按普通第三方插件方式接入**:registry 新增 `dsh-api-client.yaml` + 市场安装或 `dsh plugin --profile workbench add link:<本地路径>` + capability 由安装状态推导;不做专用占位页。
- → 文档行动项:§26 全节与 AC-36/37/38 按上述改写(删「批 5 缩减 / Placeholder / V1 跳转原生」表述,保留 §26.4 registry 更新思路)。

## 二、中级待办(修完即可冻结进 M0)

1. **shared secrets 的 at-rest 保护**:§9 `Variable.currentValue` 是 secret 实体存放处,而 Environments 默认 scope=shared;§19 画了 `shared/secrets/` 但未定义它与 `environments.json` 的分工,全文无落盘权限基线。建议:secret 值单独存 `shared/secrets/`(文件 0600、目录 0700),`environments.json` 只存 SecretRef;新增对应 AC。
2. **M0 补热插拔项**:V1.0 原 10 项含「插件热安装/热卸载」,重排 16 项后丢失;11/12 项只覆盖 Host API 与 Tool 单侧注册/注销。建议补第 17 项:`patchReload: live` 下完整热插拔(client 注入半激活与清理、DOM+Observer 移除、工具注销时序、无需重启 DSH);AC-03 补「不重启 DSH」。
3. **「Open API Client」深链激活契约**:panel 激活是 client 端状态,外部(如 workbench)新窗口打开原生 DSH 需深链(如 `#api-client`)直达 panel,否则落在会话页。契约放 `panel-activation.ts`,同时作为 V1.1「程序化激活」验证的技术前置。

## 三、低级待办

4. **Slot 路径 yield 机制**:§3.1 要求「点击 Session 时 active 自动取消」,SlotAdapter 路径需写明由谁订阅 session selection 触发注销/降优先级(DOM 路径有 task-board capture 监听先例);replacement occupant 须满足 `conversation` slot 的 owner props / `session-maybe` scope 契约——M0 第 5 项显式包含。
5. **`api_client_switch_environment` 语义**:§13.1 已有 per-call `environment` 参数,switch 属全局共享状态突变(Human UI 被切换、可能套错环境 secret)——去掉,或写明竞态语义。
6. **§13.7「默认返回脱敏版本」**:「默认」暗示存在明文出口;写明 override 授权路径(Approval / human-present)或删「默认」。
7. **§3.5 点名官方排查工具**:`cordis_inspect what:"client"`(运行时 slot 树+occupant)+ `pnpm gen-client-catalog`(生成含替换风险的目录)。
8. **§37 补版本实证**:第 1–6 条已在 npm latest = 0.1.2-rc.1 安装源码中直接核验(不只 master)——这是 §20.1 engines 下限 `>=0.1.2-rc.1` 的依据。

## 四、编辑项

- §35 与 §39 内容重复(「最终产品目标」出现两次),删一。
- §30 M0 输出物(2 文档 + 2 fixtures)与 §36 冻结输出物(4 文档)不一致,合并为一处清单。
- §6 V0.1 列了 Export,但 §31 无对应 AC(补 AC 或从 V0.1 移除)。
- 交互原型现存放于 dsh-workbench 仓库 `dev-workbench-prototype/dsh-api-client_real-dsh-integration-prototype.html`,未同步 V1.1:工具名仍为 `http_request`(应 `api_client_request`)、方法下拉缺 HEAD/OPTIONS、CSS 缺 PATCH 紫、无环境编辑入口。建议迁入本仓库并同步,或注明「以 V1.1 文档为准」。

## 五、实证补充(已证实,可直接写入 §20.4)

- **cordis.patch.yml 真实样本**(task-board 自带):`- insert: [{id: ui-task-board, name: '@linxin666/dsh-client-ui-task-board'}]` —— 作为 `dsh.bundle.patch` manifest 字段声明的 roster 插入层,叠加于 dsh-base。
- **本地安装官方支持**:`dsh plugin --profile <name> add link:<本地路径>`(开发期试装与工作台「本地来源」接入都走此机制)。
- **插件双半契约**:Node 半 = `exports["."]` 跑在 host 进程(含 system-prompt announcement 贡献位);浏览器半 = `exports["./client"]`,由 DSH 服务于 `/plugins/<id>/client.js`。
- **官方 Slot 系统已在已发布的 0.1.2-rc.1 中**:`ctx.slots.register` / `ctx.slots.inject` / single·list·keyed·chain / priority 遮蔽(「将 single 和已有 occupant 的 keyed cell 视为替换点」)/ `settings.plugin.item`(dsh-client-ui-settings-plugins 包)均实测存在;sidebar 导航区(New Session 下方)无官方增量席位,sidebar 唯一插件可增量席位 = `sidebar.footer.action`(list)。
