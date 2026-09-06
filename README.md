# dsh-api-client

Agent-native API Client for DeepSeek Harness.

Postman-like API testing UI + Agent-native HTTP tools + Postman Collection import —— Human UI 与 Agent Tools 共用同一套 API Client Core 的 DSH 原生插件。

## 状态

- 设计方案:V1.1 修订版([docs/DESIGN_V1.1.md](docs/DESIGN_V1.1.md)),技术决策 D1–D26 已冻结
- 二轮评审待办:[docs/REVIEW_NOTES_V1.1.md](docs/REVIEW_NOTES_V1.1.md)
- 开发阶段:**M0 Compatibility Spike 未开始**(16+1 项清单见方案 §30/§36)

## 定位

- **优先支持原生 DeepSeek Harness**(DSH Web GUI):官方 Slot 路径优先(`ctx.slots.register`);Sidebar 导航区入口无官方席位,采用 DOM 注入 fallback —— 双路径 `dsh-ui-adapter`,按能力 feature-detect,不按版本号嗅探。
- dsh-workbench 等发行版**按普通第三方社区插件接入**(registry / 市场安装 / `dsh plugin --profile <name> add link:<path>` 本地来源),插件不为任何工作台做私有实现。
- 不依赖 `dsh-http`;Agent 工具统一 `api_client_*` 命名空间;History 与 Agent Context 全链路脱敏。

## 文档

| 文件 | 内容 |
|---|---|
| [docs/DESIGN_V1.1.md](docs/DESIGN_V1.1.md) | 完整设计方案(V1.1 正式修订版) |
| [docs/REVIEW_NOTES_V1.1.md](docs/REVIEW_NOTES_V1.1.md) | 二轮评审待办、最终决策记录与实证补充 |

## License

待定(MIT 或 Apache-2.0,M8 开源发布前确定)。
