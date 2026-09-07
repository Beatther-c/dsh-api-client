/**
 * 格式探测（V01 §3.3 detect.ts）：v2.1 vs 其他版本/非法 JSON。
 * 纯判定，零副作用；parse 阶段的显式报错见 parse.ts。
 */
import { isRecord, isV21SchemaUrl } from './schema.ts'

/** 输入（已解析的 JSON 值或 JSON 字符串）是否 Postman Collection v2.1 文档。 */
export function detectPostmanV21(input: unknown): boolean {
  let value = input
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return false
    }
  }
  if (!isRecord(value)) return false
  const info = value.info
  if (!isRecord(info)) return false
  return isV21SchemaUrl(info.schema)
}
