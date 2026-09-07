/**
 * DSH Theme Token 投影（§5.3 / UI_ADAPTER_CONTRACT ThemeAdapter）：
 * 可用 token 是 design-platform.css 投影到 body 的 `--dsw-alias-*` CSS 变量
 * （暗色覆盖由 shell 负责，CSS 变量自动跟随，无需 JS 订阅）。
 * 每个引用都带静态 fallback，脱离 DSH shell 时（Storybook/测试）也可渲染。
 */
export const colors = {
  bg: 'var(--dsw-alias-bg-base, #ffffff)',
  bgLayer1: 'var(--dsw-alias-bg-layer-1, #f6f7f9)',
  bgLayer2: 'var(--dsw-alias-bg-layer-2, #eceef1)',
  text: 'var(--dsw-alias-label-primary, #0f1115)',
  textSecondary: 'var(--dsw-alias-label-secondary, #5c6370)',
  border: 'var(--dsw-alias-border-l1, rgba(0,0,0,0.06))',
  borderStrong: 'var(--dsw-alias-border-l2, rgba(0,0,0,0.12))',
  // DSH 实测温补：--dsw-alias-brand-text 在官方亮色主题同为 #0f1115（与
  // brand-primary 相同，作按钮文字会隐形）；DSH 原生主按钮文字色用
  // --dsw-alias-label-primary-inverted（亮主题 #fff / 暗主题随反转）。
  brand: 'var(--dsw-alias-brand-primary, #2f6fed)',
  brandText: 'var(--dsw-alias-label-primary-inverted, #ffffff)',
  fill: 'var(--dsw-alias-fill-primary, rgba(0,0,0,0.04))',
  danger: '#c9372c',
  warning: '#b8860b',
  success: '#1a7f37',
} as const

export const font = {
  size: '12px',
  family: 'inherit',
  mono: 'ui-monospace, SFMono-Regular, Menlo, monospace',
} as const
