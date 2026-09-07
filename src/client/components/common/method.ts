/**
 * Method 语义色（§5.2）：GET 绿 / POST 橙 / PUT 蓝 / PATCH 紫 / DELETE 红；
 * HEAD/OPTIONS 走中性色。树、Tabs、MethodSelector、History 共用同一张表。
 */
import type { HttpMethod } from '@dsh-api-client/shared'

export const HTTP_METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']

export const METHOD_COLORS: Record<HttpMethod, string> = {
  GET: '#1a7f37',
  POST: '#c26a00',
  PUT: '#0969da',
  PATCH: '#8250df',
  DELETE: '#cf222e',
  HEAD: '#6e7781',
  OPTIONS: '#6e7781',
}

export function methodColor(method: HttpMethod): string {
  return METHOD_COLORS[method] ?? '#6e7781'
}
