/**
 * `{{var}}` 模板解析（§3.2 variables/parser；URL/headers/body 通用）。
 * 纯函数，零 I/O。
 */

/** 匹配 {{name}}，允许花括号内空白；不支持嵌套。 */
export const TEMPLATE_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g

/** 提取模板中的变量名（去重、保持出现顺序）。 */
export function extractVariables(template: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const match of template.matchAll(TEMPLATE_PATTERN)) {
    const name = (match[1] ?? '').trim()
    if (name !== '' && !seen.has(name)) {
      seen.add(name)
      out.push(name)
    }
  }
  return out
}

export function hasVariables(template: string): boolean {
  TEMPLATE_PATTERN.lastIndex = 0
  return TEMPLATE_PATTERN.test(template)
}

/**
 * 用 replacer 替换全部 {{var}}。replacer 返回 undefined 表示未定义——
 * 调用方决定报错策略（resolver 汇总后显式报错，TC-C-03）。
 */
export function replaceVariables(template: string, replacer: (name: string) => string | undefined): string {
  return template.replace(TEMPLATE_PATTERN, (whole, raw: string) => {
    const value = replacer(raw.trim())
    return value === undefined ? whole : value
  })
}
