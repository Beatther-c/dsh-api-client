/**
 * 顶栏环境切换（§9 + §5.2 D-D1）：
 * - 选择状态持久化到 profile settings 的 activeEnvironmentId（PATCH /settings）；
 * - 该状态是 Human UI 的 client 侧选择，agent 工具不可写（无 switch 工具）；
 * - 执行时逐次显式传 environment id。
 */
import type { ReactElement } from 'react'
import type { Environment } from '@dsh-api-client/shared'
import { useHostApi } from '../../hooks/useHostApi.ts'
import { toast } from '../common/Toast.tsx'
import { colors, font } from '../common/theme.ts'

export interface EnvironmentSelectorProps {
  environments: Environment[]
  activeEnvironmentId: string | undefined
  onSelected: (id: string | undefined) => void
}

export function EnvironmentSelector(props: EnvironmentSelectorProps): ReactElement {
  const api = useHostApi()
  const select = (id: string | undefined): void => {
    props.onSelected(id)
    // 持久化失败不阻断本地选择（host 为权威，下次加载以其为准）。
    api.patch('/settings', id === undefined ? { activeEnvironmentId: '' } : { activeEnvironmentId: id }).catch((error: unknown) => {
      toast.error(`persist activeEnvironmentId failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  return (
    <select
      data-dsh-api-client="environment-selector"
      aria-label="active environment"
      value={props.activeEnvironmentId ?? ''}
      onChange={(event) => select(event.target.value === '' ? undefined : event.target.value)}
      style={{
        background: colors.bgLayer1,
        border: `1px solid ${colors.borderStrong}`,
        borderRadius: 4,
        color: colors.text,
        cursor: 'pointer',
        fontSize: font.size,
        padding: '4px 8px',
        outline: 'none',
        maxWidth: 200,
      }}
    >
      <option value="">No Environment</option>
      {props.environments.map((environment) => (
        <option key={environment.id} value={environment.id}>
          {environment.name}
        </option>
      ))}
    </select>
  )
}
