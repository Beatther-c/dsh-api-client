/**
 * Body 序列化（§7.6 V0.1 六种）+ JSON Editor 纯函数（validate / format / compact）。
 * 纯函数，零 I/O。
 */
import type { BodyConfig, KeyValue } from '@dsh-api-client/shared'

export interface SerializedBody {
  data?: string | Uint8Array
  /** 该 body 形态隐含的 Content-Type（request/build 在用户未显式设置时自动补上）。 */
  contentType?: string
}

function enabledFields(fields: KeyValue[]): KeyValue[] {
  return fields.filter((f) => f.enabled)
}

/** multipart/form-data boundary：随机且不回读输入，避免与内容碰撞的可预测格式。 */
export function generateBoundary(): string {
  return `----dsh-api-client-${crypto.randomUUID().replaceAll('-', '')}`
}

/**
 * P0 §5.7：form-data 的 boundary 预览占位符——preview 不生成假的随机最终值
 * 供用户误认为实际 wire 值（UX §9：multipart boundary 必须由真实编码器生成，
 * UI 不写死或提前伪造）。
 */
export const MULTIPART_BOUNDARY_PLACEHOLDER = '<发送时生成>'

/** multipart Content-Type 模板：preview 占位与 Send 实际 boundary 共用的单一出口，防止映射漂移。 */
export function multipartContentType(boundary: string): string {
  return `multipart/form-data; boundary=${boundary}`
}

/**
 * Body 形态 → Generated Content-Type（P0 §5.7 冻结映射，canonical plan 的 Body
 * contribution 单一事实源）：none 无贡献；raw→text/plain；json→application/json；
 * urlencoded→application/x-www-form-urlencoded；form-data→带占位 boundary 的
 * multipart（真实 boundary 发送时由 serializeBody 同一次编码生成并同时写入
 * body 与 Content-Type，§5.7）。
 */
export function bodyContentType(body: BodyConfig): string | undefined {
  switch (body.type) {
    case 'none':
      return undefined
    case 'raw':
      return 'text/plain'
    case 'json':
      return 'application/json'
    case 'urlencoded':
      return 'application/x-www-form-urlencoded'
    case 'form-data':
      return multipartContentType(MULTIPART_BOUNDARY_PLACEHOLDER)
  }
}

function serializeFormData(fields: KeyValue[], boundary: string): string {
  const parts = enabledFields(fields).map(
    (f) => `--${boundary}\r\nContent-Disposition: form-data; name="${f.key.replaceAll('"', '\\"')}"\r\n\r\n${f.value}\r\n`,
  )
  return `${parts.join('')}--${boundary}--\r\n`
}

function serializeUrlencoded(fields: KeyValue[]): string {
  return enabledFields(fields)
    .map((f) => `${encodeURIComponent(f.key)}=${encodeURIComponent(f.value)}`)
    .join('&')
}

export interface SerializeBodyOptions {
  /** 测试可注入固定 boundary 以获得确定性输出。 */
  boundary?: string
}

/**
 * 序列化 BodyConfig（TC-C-10）：
 * - json → Content-Type: application/json（原文发送，不做重排）；
 * - urlencoded → application/x-www-form-urlencoded，正确百分号编码；
 * - form-data → multipart/form-data; boundary=…，part 边界正确；
 * - raw（Text）→ text/plain；none → 无 body。
 */
export function serializeBody(body: BodyConfig, options?: SerializeBodyOptions): SerializedBody {
  switch (body.type) {
    case 'none':
      return {}
    case 'raw':
      return { data: body.raw, contentType: bodyContentType(body) }
    case 'json':
      return { data: body.json, contentType: bodyContentType(body) }
    case 'urlencoded':
      return {
        data: serializeUrlencoded(body.fields),
        contentType: bodyContentType(body),
      }
    case 'form-data': {
      // P0 §5.7：Send 时同一次编码生成 boundary，并同时写入 body 与 Content-Type
      //（真实 echo 测试 tests/p0-undici-wire.spec.ts 断言二者一致）。
      const boundary = options?.boundary ?? generateBoundary()
      return {
        data: serializeFormData(body.fields, boundary),
        contentType: multipartContentType(boundary),
      }
    }
  }
}

// ---- JSON Editor 纯函数（format / validate / compact；syntax highlight 与 error line 属 UI 层）----

export interface JsonValidationOk {
  ok: true
}

export interface JsonValidationError {
  ok: false
  message: string
  /** 由引擎报错位置换算的 1-based 行号（可得时）。 */
  line?: number
  column?: number
}

export type JsonValidation = JsonValidationOk | JsonValidationError

function positionToLineColumn(text: string, position: number): { line: number; column: number } {
  let line = 1
  let lastBreak = -1
  for (let i = 0; i < position && i < text.length; i++) {
    if (text[i] === '\n') {
      line += 1
      lastBreak = i
    }
  }
  return { line, column: position - lastBreak }
}

/** V8 JSON.parse 报错中的 "at position N" → 行列。 */
function locateParseError(text: string, message: string): { line?: number; column?: number } {
  const match = /position (\d+)/.exec(message)
  if (!match) return {}
  const position = Number.parseInt(match[1] ?? '', 10)
  if (!Number.isFinite(position)) return {}
  return positionToLineColumn(text, position)
}

export function jsonValidate(text: string): JsonValidation {
  try {
    JSON.parse(text)
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, message, ...locateParseError(text, message) }
  }
}

export function jsonFormat(text: string, indent = 2): string {
  return JSON.stringify(JSON.parse(text), null, indent)
}

export function jsonCompact(text: string): string {
  return JSON.stringify(JSON.parse(text))
}
