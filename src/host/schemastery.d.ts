/**
 * Ambient shim for the runtime-only schema package.
 * `@deepseek-ai/schemastery` 是 runtime 形态依赖（root package.json
 * dependencies；host bundle 将每个 @deepseek-ai/* 说明符 external 化，运行时从
 * profile 安装解析，M0 实证裸说明符可解析）。本声明是 settings-service 的
 * Host 命名空间声明（declareNamespace）所需的最小类型面。
 */
declare module '@deepseek-ai/schemastery' {
  const z: {
    object: (shape: Record<string, unknown>) => unknown
    boolean: () => { default: (value: boolean) => unknown }
    number: () => { default: (value: number) => unknown }
    string: () => { default: (value: string) => unknown }
  }
  export default z
}
