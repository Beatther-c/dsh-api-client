/** Method 下拉（§7.1 七方法），选中项跟随 Method 语义色（§5.2）。 */
import type { ReactElement } from 'react'
import type { HttpMethod } from '@dsh-api-client/shared'
import { colors, font } from '../common/theme.ts'
import { HTTP_METHODS, methodColor } from '../common/method.ts'

export interface MethodSelectorProps {
  value: HttpMethod
  onChange: (method: HttpMethod) => void
}

export function MethodSelector(props: MethodSelectorProps): ReactElement {
  return (
    <select
      data-dsh-api-client="method-selector"
      value={props.value}
      onChange={(event) => props.onChange(event.target.value as HttpMethod)}
      style={{
        background: colors.bgLayer1,
        border: `1px solid ${colors.borderStrong}`,
        borderRadius: 4,
        color: methodColor(props.value),
        cursor: 'pointer',
        fontFamily: font.mono,
        fontSize: font.size,
        fontWeight: 700,
        padding: '5px 6px',
        outline: 'none',
      }}
    >
      {HTTP_METHODS.map((method) => (
        <option key={method} value={method} style={{ color: methodColor(method), fontWeight: 700 }}>
          {method}
        </option>
      ))}
    </select>
  )
}
