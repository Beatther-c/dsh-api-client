/**
 * EnvironmentView（§9）：环境列表 + 变量编辑器。
 *
 * 保存映射（Host 权威，D16）：
 * - 普通变量 → PATCH /environments/:id { variables }（upsert 语义）；
 * - secret 变量（编辑态输入了新值）→ PUT /environments/:id/secrets/:key（write-only，
 *   明文只出现在这一次请求体中）；
 * - 表格中移除的已保存 secret → DELETE …/secrets/:key（级联删 secret 文件）；
 * - 保存后整体刷新投影（secret 行回到 `••••••••` 掩码态）。
 */
import { useEffect, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import type { Environment, Variable } from '@dsh-api-client/shared'
import { useEnvironments } from '../hooks/useEnvironments.ts'
import { VariableTable } from '../components/environment/VariableTable.tsx'
import type { VariableDraftRow } from '../components/environment/VariableTable.tsx'
import { toast } from '../components/common/Toast.tsx'
import { colors, font } from '../components/common/theme.ts'

export interface EnvironmentViewProps {
  onBack: () => void
}

function toDraftRows(environment: Environment): VariableDraftRow[] {
  return environment.variables.map((variable: Variable) => ({
    key: variable.key,
    // secret 变量值永不回显（投影为 <secret-ref:key> 或 {$ref}），编辑行从空开始。
    value: variable.secret ? '' : typeof variable.currentValue === 'string' ? variable.currentValue : '',
    ...(variable.initialValue !== undefined ? { initialValue: variable.initialValue } : {}),
    secret: variable.secret,
    enabled: variable.enabled,
    secretSaved: variable.secret,
    revealed: false,
    isNew: false,
  }))
}

export function EnvironmentView(props: EnvironmentViewProps): ReactElement {
  const envs = useEnvironments()
  const [selectedId, setSelectedId] = useState<string | undefined>()
  const [rows, setRows] = useState<VariableDraftRow[]>([])
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  const selected = envs.environments.find((environment) => environment.id === selectedId)

  // 选中环境变化（或刷新后）重建草稿；编辑中（dirty）不被刷新打断。
  useEffect(() => {
    if (selected === undefined) {
      setRows([])
      setDirty(false)
      return
    }
    if (!dirty) setRows(toDraftRows(selected))
  }, [selected, dirty])

  const save = async (): Promise<void> => {
    if (selected === undefined || saving) return
    setSaving(true)
    try {
      const plain = rows
        .filter((row) => !row.secret && row.key.trim() !== '')
        .map((row) => ({
          key: row.key.trim(),
          value: row.value,
          enabled: row.enabled,
          ...(row.initialValue !== undefined ? { initialValue: row.initialValue } : {}),
        }))
      if (plain.length > 0) await envs.patchVariables(selected.id, plain)
      for (const row of rows) {
        if (!row.secret || row.key.trim() === '' || row.value === '') continue
        await envs.writeSecret(selected.id, row.key.trim(), row.value)
      }
      // 表格中移除的已保存 secret → 删除 SecretRef + secret 文件。
      const remainingSecretKeys = new Set(rows.filter((row) => row.secret).map((row) => row.key))
      for (const variable of selected.variables) {
        if (variable.secret && !remainingSecretKeys.has(variable.key)) {
          await envs.deleteSecret(selected.id, variable.key)
        }
      }
      setDirty(false)
      toast.info('Environment saved')
      envs.refresh()
    } finally {
      setSaving(false)
    }
  }

  const createEnvironment = (): void => {
    const name = globalThis.prompt?.('Environment name:')
    if (name !== undefined && name !== null && name.trim() !== '') void envs.createEnvironment(name.trim())
  }

  return (
    <div data-dsh-api-client="environment-view" style={{ display: 'flex', flexDirection: 'column', height: '100%', fontSize: font.size, color: colors.text }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: `1px solid ${colors.border}` }}>
        <button type="button" onClick={props.onBack} style={navButtonStyle}>
          ← Back
        </button>
        <strong>Environments</strong>
        <span style={{ color: colors.textSecondary }}>secret 值恒掩码；reveal 仅限编辑态、仅内存</span>
      </div>
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div style={{ flex: '0 0 240px', overflow: 'auto', borderRight: `1px solid ${colors.border}`, padding: 6 }}>
          <button type="button" onClick={createEnvironment} style={{ ...navButtonStyle, width: '100%', marginBottom: 6 }}>
            + New environment
          </button>
          {envs.environments.map((environment) => (
            <div
              key={environment.id}
              onClick={() => {
                setSelectedId(environment.id)
                setDirty(false)
              }}
              style={{
                padding: '6px 8px',
                borderRadius: 4,
                cursor: 'pointer',
                background: environment.id === selectedId ? colors.fill : 'transparent',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{environment.name}</span>
              <button
                type="button"
                title="Rename"
                style={iconButtonStyle}
                onClick={(event) => {
                  event.stopPropagation()
                  const name = globalThis.prompt?.('Rename environment:', environment.name)
                  if (name !== undefined && name !== null && name.trim() !== '') void envs.renameEnvironment(environment.id, name.trim())
                }}
              >
                ✎
              </button>
              <button
                type="button"
                title="Delete（secret 文件级联删除）"
                style={{ ...iconButtonStyle, color: colors.danger }}
                onClick={(event) => {
                  event.stopPropagation()
                  if (globalThis.confirm?.(`Delete environment "${environment.name}"?`) === true) void envs.deleteEnvironment(environment.id)
                }}
              >
                🗑
              </button>
            </div>
          ))}
          {envs.environments.length === 0 && !envs.loading && (
            <div style={{ padding: 8, color: colors.textSecondary }}>No environments yet.</div>
          )}
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: 14 }}>
          {selected === undefined && <div style={{ color: colors.textSecondary }}>Select an environment to edit its variables.</div>}
          {selected !== undefined && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <strong>{selected.name}</strong>
                {dirty && <span style={{ color: colors.warning }}>● unsaved</span>}
                <button type="button" disabled={!dirty || saving} onClick={() => void save()} style={{ ...navButtonStyle, marginLeft: 'auto', opacity: dirty ? 1 : 0.5 }}>
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
              <VariableTable
                rows={rows}
                onChange={(next) => {
                  setRows(next)
                  setDirty(true)
                }}
              />
            </>
          )}
        </div>
      </div>
    </div>
  )
}

const navButtonStyle: CSSProperties = {
  background: 'transparent',
  border: `1px solid ${colors.borderStrong}`,
  borderRadius: 4,
  color: colors.text,
  cursor: 'pointer',
  fontSize: font.size,
  padding: '3px 10px',
}

const iconButtonStyle: CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: colors.textSecondary,
  cursor: 'pointer',
  fontSize: 11,
  padding: '1px 4px',
}
