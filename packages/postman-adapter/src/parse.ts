/**
 * Parse + Schema Validation（V01 §3.3 parse.ts）。
 * 失败显式抛错（ImportAdapter.parse 契约）——管线据此保证零部分落库（TC-P-13）。
 * 校验范围：v2.1 身份（info.schema URL）+ 结构骨架（item 树形态）。
 * 单项内容问题（未知 method、不可转 auth 等）不在此失败，留给 normalize 逐项标记。
 */
import type { PostmanCollectionDoc, PostmanItem } from './schema.ts'
import { isPostmanSchemaUrl, isRecord, isV21SchemaUrl } from './schema.ts'

export class PostmanParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PostmanParseError'
  }
}

function validateItem(value: unknown, path: string): asserts value is PostmanItem {
  if (!isRecord(value)) {
    throw new PostmanParseError(`item at "${path}" is not an object`)
  }
  if (value.item !== undefined && !Array.isArray(value.item)) {
    throw new PostmanParseError(`folder at "${path}" has a non-array "item" field`)
  }
  if (value.item === undefined && value.request === undefined) {
    throw new PostmanParseError(`item at "${path}" has neither "item" (folder) nor "request"`)
  }
  if (value.request !== undefined && typeof value.request !== 'string' && !isRecord(value.request)) {
    throw new PostmanParseError(`request at "${path}" is neither a URL string nor an object`)
  }
  const name = typeof value.name === 'string' ? value.name : '(unnamed)'
  for (const [index, child] of ((value.item as unknown[] | undefined) ?? []).entries()) {
    validateItem(child, `${path}/${name}[${index}]`)
  }
}

/**
 * 解析并校验输入。接受已解析 JSON 值或 JSON 字符串。
 * @throws PostmanParseError 非 v2.1 / 非法 JSON / 结构骨架破损。
 */
export function parsePostmanCollection(input: unknown): PostmanCollectionDoc {
  let value = input
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch (error) {
      throw new PostmanParseError(
        `input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  if (!isRecord(value) || !isRecord(value.info)) {
    throw new PostmanParseError('input is not a Postman collection (missing "info" object)')
  }
  const schema = value.info.schema
  if (!isV21SchemaUrl(schema)) {
    throw new PostmanParseError(
      isPostmanSchemaUrl(schema)
        ? `unsupported Postman schema version: ${schema} (only v2.1 is supported in V0.1)`
        : 'input is not a Postman Collection v2.1 document (info.schema mismatch)',
    )
  }
  if (!Array.isArray(value.item)) {
    throw new PostmanParseError('postman collection has no "item" array')
  }
  for (const [index, item] of (value.item as unknown[]).entries()) {
    validateItem(item, `(root)[${index}]`)
  }
  return value as unknown as PostmanCollectionDoc
}
