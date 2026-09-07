# Client Manifest Contract（冻结）

> 冻结基线：DSH 0.1.2-rc.1 web profile。机器可读版本：`fixtures/client-manifest-contract.json`（由 `pnpm gen:manifest-contract` 从本仓库 package.json 生成）。证据编号 V-xx / TC-M0-xx 见 `docs/M0_SPIKE_REPORT.md`。

## exports 契约（"." / "./client" / "./package.json"）与负向行为

```json
"exports": {
  ".": "./dist/index.js",
  "./client": "./dist/client.js",
  "./package.json": "./package.json"
}
```

- `"."`：host 半入口（cordis 插件，`apply(ctx)` + 可选 `dispose()`），由 Loader 以 Node ESM 导入。
- `"./client"`：client 半入口。client-modules 的 `resolveMeta` 仅在 `dsh.client.platform === "web"` 时读取此键（接受字符串或 `{ "default": "…" }` 一层条件形式；其他形式抛 `must be a string or an object with a string default`）。
- `"./package.json"`：tooling 约定。
- **负向行为（TC-M0-11，boot-fatal）**：声明了 `dsh.client` 但缺 `exports["./client"]` → 进程启动时整个 plugin tree 加载失败，DSH web 不可服务。错误原文：

  ```
  Error: dsh: plugin tree failed to load: failed to apply loader entry modules (@deepseek-ai/dsh-client-modules): client-modules: 1 client package failed to compose:
      - client-modules: dsh-api-client declares dsh.client but exports no "./client" bundle
  ```

- **缓存契约（重要）**：`resolveMeta` 把包元数据按 sourceKey 做了进程级 memoize（client/modules/src/index.ts）。**live 重组不会重读 package.json**——manifest 改动（含 exports、dsh.*）必须进程重启才生效（U-5 同源结论）。

## dsh.engines / dsh.bundle.patch / dsh.client.platform / dsh.client.inject 逐字段实测语义

| 字段 | 本仓库值 | 实测语义 |
|---|---|---|
| `dsh.engines.dsh` | `>=0.1.2-rc.1` | 声明性约束；安装/扫描未见强制阻断（未做负向降级实测） |
| `dsh.bundle.patch` | `./cordis.patch.yml` | 该文件作为 bundle 层 patch 参与组合（profile bundles 含本包时） |
| `dsh.client.platform` | `web` | resolveMeta 的门：`!== 'web'` 时该包不成为 client 行 |
| `dsh.client.inject` | `[]` | client 半的包依赖边（cordis inject 语义）：声明后 client apply 时由模块表保证先行物化。本探针刻意为空——所有 client 服务经 `ctx.inject([...])` 可选等待（修 #1/#5 的竞态教训） |
| `dsh.client.external` | （未用） | 精确的非 baseline 模块请求（recon：task-board lib/client.js） |

## cordis.patch.yml roster 插入层实测格式

本仓库 `cordis.patch.yml`（bundle 层）：

```yaml
- insert:
    - id: api-client
      name: dsh-api-client
```

- profile `package.json` 的 `dsh.profile.bundles` 含 `dsh-api-client` 时，该 insert 在 bundle 层生效，host 半以 id `api-client` 挂载（probe-log `lifecycle install {"name":"api-client","inject":["webServer","tools","systemPrompt"]}`）。
- **冲突**：用户层（profile cordis.patch.yml）再 insert 同 id 行 → 进程启动时 duplicate id 致命（实测）。免重启临时挂载可在用户层加 insert 行（live 重读生效），但**重启前必须删除**。
- 用户层 id 定向覆盖（`- id: api-client\n  disabled: true`）是热插拔的正确姿势（V-17：~8s 内 stop/unmount 全序列 + endpoint 404；删除即回挂）。注意 0.1.2-rc.1 上观察到一次回弹异象（覆盖仍在却 unmount→remount，见 REPORT V-17），重组幂等性不宜过度依赖。

## 安装/卸载 lifecycle（含 patchReload: live）实测行为

- 安装：`dsh plugin --profile web add link:<repo>` → 转发 pnpm（profile dir 下 `link:` 依赖 + bundles 调和）→ **需一次进程重启**完成标准挂载（bundle insert 在 boot 时生效）。
- `patchReload: "live"`：patch 文件变更触发**配置/生命周期级**重组（免进程重启的热插拔可用，V-17）；但 **Node ESM 模块缓存与 client-modules pkgMeta 缓存都不破**（U-5）——host 代码变更、package.json 变更必须进程重启。仅注释变化的 patch 编辑不触发重组（YAML 解析后配置相同即短路）；改真实配置值才触发。
- 卸载：`dsh plugin --profile web remove dsh-api-client` → 依赖与 bundles 调和移除 → 重启后零残留（M0 收尾路径）。
- 热卸载零残留标准（V-17 实测）：probe-log 无新事件、ping endpoint 404、页面无入口 DOM、combo 不再含本包 segment、工具列表无 api_client_*。

## client.js 服务路径与模块格式结论（决定 U-1/U-2）

- 服务路径（TC-M0-10）：`/plugins/??<pkg>/client.js[,<更多 segment 逗号连接>]&rev=<hash>` combo 形态；本包 segment 为 `dsh-api-client/client.js`，随 application 批次 combo 服务 200。**无 rev 的裸 segment 404；过期 rev 404**；`dist/client.js` 每次变更经 client-hmr（chokidar）换 rev，浏览器刷新生效（client 半热载）。
- 模块格式（U-1）：host 半 `dist/index.js` = **ESM**（Loader `import()`）；client 半 `dist/client.js` = **lazy-CJS**——`window.__ModuleLoader__.load({id, factory})`，`factory(require)` 物化 exports。本仓库 tsup 双格式产出与此一致。
- external 决策（U-2）：baseline 模块（react、react/jsx-runtime、react-dom、react-dom/client、@deepseek-ai/cordis、@deepseek-ai/dsh-client-store、@deepseek-ai/dsh-client-ui-slots、@deepseek-ai/dsh-client-ui-primitives）由 shell 冻结模块表提供，**必须 external 不得内联**；其余依赖走 `dsh.client.inject`（包依赖边）或 `dsh.client.external`（精确非 baseline 请求）。
- host 半的运行时包解析：host 进程内裸说明符（如 `@deepseek-ai/schemastery`）从**插件自身目录链**解析（实证可用，经 devDependency 声明）；进程级 package.json 缓存会记忆 miss——首次解析失败后新增的包在同进程内仍不可解析（修 #9b 的 file-URL 直导 profile 副本为兜底）。
