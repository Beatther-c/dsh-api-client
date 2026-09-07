import { defineConfig } from 'tsup'

/**
 * Dual-entry build (M0 §2.1):
 * - `src/host/index.ts` → `dist/index.js` (ESM; the Cordis loader imports the
 *   package root as an ESM module — runtime fact: task-board's host half is
 *   `"type": "module"` ESM with named `apply`/`inject` exports).
 * - `src/client/index.ts` → `dist/client.js` (lazy-CJS bundle). Runtime fact
 *   (dsh-client-modules): the browser registers plugin bundles through the
 *   `window.__ModuleLoader__.load({id, factory})` facade; the factory receives
 *   a synchronous `require` bound to the shell's frozen module table
 *   (react, react/jsx-runtime, react-dom, react-dom/client, @deepseek-ai/cordis,
 *   @deepseek-ai/dsh-client-store, @deepseek-ai/dsh-client-ui-slots,
 *   @deepseek-ai/dsh-client-ui-primitives). Every one of those stays external;
 *   nothing else may be requested (M0 `dsh.client.inject: []`).
 *
 * U-1/U-2 disposition (WP0 recon): host = ESM, client = lazy-CJS wrapper;
 * React and DSH client packages are external, resolved by the runtime module
 * table, never inlined.
 */

const CLIENT_BANNER = `window.__ModuleLoader__.load({
	id: "dsh-api-client",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;`

const CLIENT_FOOTER = `		return module.exports;
	}
});`

export default defineConfig([
  {
    entry: { index: 'src/host/index.ts' },
    outDir: 'dist',
    format: ['esm'],
    platform: 'node',
    target: 'node18',
    clean: true,
    sourcemap: true,
    dts: false,
    // The host process resolves @deepseek-ai/* from the profile installation;
    // probe code only needs their types at build time (imports are type-only).
    // undici stays external too: it is CJS and bundling it into the ESM host
    // entry produces a dynamic-require shim that crashes on Node builtins
    // ("Dynamic require of \"assert\" is not supported") under the Cordis
    // loader. It is declared as a root dependency so Node resolves it from
    // the package's own node_modules at runtime.
    external: [/^@deepseek-ai\//, 'undici'],
  },
  {
    entry: { client: 'src/client/index.ts' },
    outDir: 'dist',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2022',
    clean: false,
    sourcemap: false,
    dts: false,
    // The exports map spells ./dist/client.js; the file is served to the
    // browser as a classic script (never loaded by Node), so the .js
    // extension is safe despite "type": "module".
    // (JSX comes from tsconfig's `jsx: react-jsx`; the client sources call
    // createElement directly, so no JSX runtime import is emitted anyway.)
    outExtension: () => ({ js: '.js' }),
    external: [
      'react',
      'react/jsx-runtime',
      'react-dom',
      'react-dom/client',
      /^@deepseek-ai\//,
    ],
    banner: { js: CLIENT_BANNER },
    footer: { js: CLIENT_FOOTER },
  },
])
