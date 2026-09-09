# dsh-api-client

**API Client for DeepSeek Harness**

Postman-like API testing UI
\+ Agent-native HTTP tools
\+ Postman Collection import

Human UI 与 Agent Tools 共用同一套 API Client Core 的 DSH 原生插件。

## 特性

- **Postman 级调试体验**：Collection / Folder / Request 三级树、Request Tabs、7 种 HTTP 方法、Params/Headers/Auth/Body 编辑器、JSON Editor、Response Viewer（Pretty/Raw/Preview）
- **Agent 原生工具**：`api_client_request` / `api_client_run_request` / `api_client_list_collections` / `api_client_list_requests` / `api_client_get_request` / `api_client_get_last_response`——Agent 与 Human 共用同一 HTTP Executor 与审计体系，高风险方法自动进入 Approval
- **Postman Collection v2.1 导入**：兼容性扫描 + Migration Report，脚本只警告不执行，部分不兼容不阻断导入
- **Environment 与密钥安全**：`shared/secrets/`（0700/0600）+ SecretRef 引用分工，History 与 Agent Context 全链路脱敏，History 永不持久化密钥明文
- **SSRF 网络策略**：默认 fail-closed（拒 localhost/私网）、blocked hosts/ports、redirect 逐跳重评估、DNS rebinding 防护
- **DSH 原生集成**：官方 Slot 优先 + DOM fallback 双路径 UI 适配（feature-detect，不按版本嗅探）、Settings 配置页、主题跟随、热插拔无需重启

## 安装

需要 DeepSeek Harness `>=0.1.2-rc.1`。

```bash
# 从 npm 安装（发布后）
dsh plugin --profile web add dsh-api-client

# 本地源码安装（开发/试用）
git clone https://github.com/Beatther-c/dsh-api-client.git
cd dsh-api-client && pnpm install && pnpm build
dsh plugin --profile web add link:$PWD
```

安装后 DSH Sidebar「New Session」下方出现 **API Client** 入口。

## 使用

- **Human**：点击 Sidebar 入口进入主视图——新建/导入 Collection，编辑请求，Send，查看 Response 与 History；Environment 管理变量与 secret（UI 恒脱敏显示）；Settings → Plugins → API Client 调整超时/网络策略/权限
- **Agent**：在 DSH 会话中直接让 Agent 调用 `api_client_*` 工具，或在 API Client 中点击「交给 Agent」把脱敏后的调试上下文送入新会话

## 文档

| 文件 | 内容 |
|---|---|
| [docs/DESIGN_V1.1.md](docs/DESIGN_V1.1.md) | 完整设计方案 V1.1（技术决策 D1–D26 冻结） |
| [docs/V01_IMPLEMENTATION_DESIGN.md](docs/V01_IMPLEMENTATION_DESIGN.md) | V0.1 可执行实现设计（WP0–WP8 / AC-01…43 / TC×127） |
| [docs/M0_SPIKE_DESIGN.md](docs/M0_SPIKE_DESIGN.md) + [docs/M0_SPIKE_REPORT.md](docs/M0_SPIKE_REPORT.md) | DSH 兼容性验证设计与实测报告（17 项） |
| [docs/DSH_COMPATIBILITY_MATRIX.md](docs/DSH_COMPATIBILITY_MATRIX.md) | DSH 能力兼容矩阵（against 0.1.2-rc.1） |
| [docs/UI_ADAPTER_CONTRACT.md](docs/UI_ADAPTER_CONTRACT.md) / [docs/CLIENT_MANIFEST_CONTRACT.md](docs/CLIENT_MANIFEST_CONTRACT.md) | UI 适配与插件 manifest 冻结契约 |
| [docs/V01_MANUAL_VERIFICATION.md](docs/V01_MANUAL_VERIFICATION.md) | V0.1 手工运行时验证记录（含证据截图） |
| [docs/REVIEW_NOTES_V1.1.md](docs/REVIEW_NOTES_V1.1.md) | 二轮评审待办与决策记录 |

## 开发

```bash
pnpm install
pnpm build    # tsup 双入口：dist/index.js(host) + dist/client.js(client)
pnpm test     # vitest：19 spec / 209 tests
```

架构：`packages/core|shared|postman-adapter`（纯 TS，零 DSH import）+ `src/host`（Host API 28 端点 + 服务 + Agent 工具）+ `src/client`（dsh-adapter 双路径 + 视图/组件）。所有 DSH UI 内部契约只允许出现在 `dsh-adapter/` 与极薄 slot 注册层。

### 开发规范

智能体工作规范见 [AGENTS.md](AGENTS.md)；项目硬规范（红线/门禁/环境/决策）见 [PROJECT.md](PROJECT.md)；变更记录见 [CHANGELOG.md](CHANGELOG.md) 与 [docs/DEVLOG.md](docs/DEVLOG.md)；经验沉淀见 [knowledge-base/](knowledge-base/README.md)。

## Roadmap

- **V0.1**（当前）：完整 API Client + Agent 工具 + Postman 导入 + 安全体系 + 兼容矩阵
- **V0.2**：OpenAPI / curl / HAR 导入、Collection Runner、Workbench Embedded Surface Spike
- **V0.3**：OAuth2、Scripts Sandbox、Tests、Advanced Secret Providers
- **V1.0**：GraphQL / WebSocket / gRPC / Mock、插件市场稳定发布、多 profile 兼容

## License

[MIT](LICENSE)
