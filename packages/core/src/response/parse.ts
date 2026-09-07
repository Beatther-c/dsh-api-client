/**
 * Response 解析（§8，§3.2 response/parse）：body 类型检测、size 计算、pretty 化。
 * 纯函数，零 I/O。
 */
import type { HttpExecutionResult } from '@dsh-api-client/shared'

export type BodyKind = HttpExecutionResult['bodyKind']

const TEXT_ENCODER = new TextEncoder()

/** size 按字节计（UTF-8）。 */
export function computeSize(bodyText: string): number {
  return TEXT_ENCODER.encode(bodyText).length
}

function sniffTextKind(bodyText: string): BodyKind {
  const head = bodyText.trimStart().slice(0, 256).toLowerCase()
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) return 'html'
  if (head.startsWith('<?xml')) return 'xml'
  if (head.startsWith('{') || head.startsWith('[')) {
    try {
      JSON.parse(bodyText)
      return 'json'
    } catch {
      return 'text'
    }
  }
  return 'text'
}

/**
 * body 类型检测（TC-C-17）：优先 Content-Type；缺省时按内容嗅探。
 * 明确的二进制 content-type → 'binary'。
 */
export function detectBodyKind(contentType: string | undefined, bodyText: string): BodyKind {
  const ct = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  if (ct !== '') {
    if (ct === 'application/json' || ct.endsWith('+json')) return 'json'
    if (ct === 'text/html' || ct === 'application/xhtml+xml') return 'html'
    if (ct === 'application/xml' || ct === 'text/xml' || ct.endsWith('+xml')) return 'xml'
    if (ct.startsWith('text/')) return 'text'
    if (ct === 'application/octet-stream' || ct.startsWith('image/') || ct.startsWith('audio/') || ct.startsWith('video/')) {
      return 'binary'
    }
    return sniffTextKind(bodyText)
  }
  return sniffTextKind(bodyText)
}

/** Pretty 化（Response Viewer Pretty 模式数据源）：JSON 合法时缩进重排，其余原样。 */
export function prettyBody(kind: BodyKind, bodyText: string, indent = 2): string {
  if (kind !== 'json') return bodyText
  try {
    return JSON.stringify(JSON.parse(bodyText), null, indent)
  } catch {
    return bodyText
  }
}
