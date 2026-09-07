/**
 * settings.plugin.item keyed 注册层 + 正式配置页（§25 全配置项）。
 *
 * 注册契约（UI_ADAPTER_CONTRACT / runtime-slot-catalog GATE）：keyed slot，
 * key = 'api-client'（与 host 半 settings 命名空间一致；host installSection
 * 已声明，卡才会被 ConfigurablePluginsTab 渲染）。经 slots.inject + slots.register
 * 组合注册，dispose 注销 inject 链（V-17 零残留语义）。
 *
 * 配置页数据走 GET/PATCH /api-client/settings（useHostApi）；secretsDisplayPolicy
 * V0.1 固定 'masked'（只读）；activeEnvironmentId 由主视图顶栏环境选择器维护，
 * 这里只读展示。
 */
import { createElement as h, useEffect, useState } from 'react'
import type { CSSProperties, ReactElement, ReactNode } from 'react'
import type { AgentPermissionPolicy, NetworkPolicy, PluginSettings } from '@dsh-api-client/shared'
import type { SlotsFace } from '../dsh-adapter/feature-detect.ts'
import { useHostApi } from '../hooks/useHostApi.ts'
import { toast } from '../components/common/Toast.tsx'
import { colors, font } from '../components/common/theme.ts'

export const SETTINGS_SLOT_KEY = 'settings.plugin.item'
export const SETTINGS_ITEM_KEY = 'api-client'

export interface SettingsItemDeps {
  slots: SlotsFace
  log?: (event: string, detail?: unknown) => void
}

/** 注册正式配置页；返回组合 disposer。注册失败只记录，绝不抛出（apply 不得炸 shell）。 */
export function attachSettingsItem(deps: SettingsItemDeps): () => void {
  const { slots } = deps
  const log = deps.log ?? (() => {})

  if (typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
    log('settings-item.unavailable', { reason: 'slots face incomplete' })
    return () => {}
  }

  try {
    const disposeInject = slots.inject(SETTINGS_SLOT_KEY, () => {
      const unregister = slots.register!(
        { name: SETTINGS_SLOT_KEY, key: SETTINGS_ITEM_KEY, registrant: 'dsh-api-client' },
        SettingsPage,
      )
      log('settings-item.register', { slot: SETTINGS_SLOT_KEY, key: SETTINGS_ITEM_KEY })
      return unregister
    })
    return () => {
      try {
        disposeInject()
      } catch (error) {
        log('settings-item.dispose-error', { message: error instanceof Error ? error.message : String(error) })
      }
      log('settings-item.dispose', { slot: SETTINGS_SLOT_KEY })
    }
  } catch (error) {
    log('settings-item.error', { message: error instanceof Error ? error.message : String(error) })
    return () => {}
  }
}

// ---- 配置页（§25）----

interface FormState {
  defaultTimeoutMs: string
  followRedirects: boolean
  saveHistory: boolean
  maxResponseBytes: string
  historyRetentionDays: string
  postmanCompatibility: 'strict' | 'lenient'
  networkPolicy: {
    allowLocalhost: boolean
    allowPrivateNetwork: boolean
    allowPublicNetwork: boolean
    blockedHosts: string
    allowedHosts: string
    blockedPorts: string
    redirectPolicy: NetworkPolicy['redirectPolicy']
    maxResponseBytes: string
    timeoutMs: string
    dnsRebindingProtection: boolean
  }
  agentPermission: {
    highRiskMethodsRequireApproval: boolean
    hostRules: Array<{ host: string; action: 'allow' | 'approval' | 'deny' }>
  }
}

function toForm(settings: PluginSettings): FormState {
  const policy = settings.networkPolicy
  return {
    defaultTimeoutMs: String(settings.defaultTimeoutMs),
    followRedirects: settings.followRedirects,
    saveHistory: settings.saveHistory,
    maxResponseBytes: String(settings.maxResponseBytes),
    historyRetentionDays: String(settings.historyRetentionDays),
    postmanCompatibility: settings.postmanCompatibility,
    networkPolicy: {
      allowLocalhost: policy.allowLocalhost,
      allowPrivateNetwork: policy.allowPrivateNetwork,
      allowPublicNetwork: policy.allowPublicNetwork,
      blockedHosts: policy.blockedHosts.join('\n'),
      allowedHosts: policy.allowedHosts.join('\n'),
      blockedPorts: policy.blockedPorts.join(', '),
      redirectPolicy: policy.redirectPolicy,
      maxResponseBytes: String(policy.maxResponseBytes),
      timeoutMs: String(policy.timeoutMs),
      dnsRebindingProtection: policy.dnsRebindingProtection,
    },
    agentPermission: {
      highRiskMethodsRequireApproval: settings.agentPermission.highRiskMethodsRequireApproval,
      hostRules: settings.agentPermission.hostRules.map((rule) => ({ ...rule })),
    },
  }
}

function parseLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

function parsePorts(text: string): number[] | undefined {
  const out: number[] = []
  for (const part of text.split(',')) {
    const trimmed = part.trim()
    if (trimmed === '') continue
    const port = Number.parseInt(trimmed, 10)
    if (!Number.isFinite(port) || port < 0 || port > 65535) return undefined
    out.push(port)
  }
  return out
}

function toPatch(form: FormState): Partial<PluginSettings> | { error: string } {
  const blockedPorts = parsePorts(form.networkPolicy.blockedPorts)
  if (blockedPorts === undefined) return { error: 'networkPolicy.blockedPorts must be comma-separated port numbers (0-65535)' }
  const numbers: Array<[string, string]> = [
    ['defaultTimeoutMs', form.defaultTimeoutMs],
    ['maxResponseBytes', form.maxResponseBytes],
    ['historyRetentionDays', form.historyRetentionDays],
    ['networkPolicy.maxResponseBytes', form.networkPolicy.maxResponseBytes],
    ['networkPolicy.timeoutMs', form.networkPolicy.timeoutMs],
  ]
  for (const [label, raw] of numbers) {
    if (!/^\d+$/.test(raw.trim())) return { error: `${label} must be a non-negative integer` }
  }
  const networkPolicy: NetworkPolicy = {
    allowLocalhost: form.networkPolicy.allowLocalhost,
    allowPrivateNetwork: form.networkPolicy.allowPrivateNetwork,
    allowPublicNetwork: form.networkPolicy.allowPublicNetwork,
    blockedHosts: parseLines(form.networkPolicy.blockedHosts),
    allowedHosts: parseLines(form.networkPolicy.allowedHosts),
    blockedPorts,
    redirectPolicy: form.networkPolicy.redirectPolicy,
    maxResponseBytes: Number.parseInt(form.networkPolicy.maxResponseBytes.trim(), 10),
    timeoutMs: Number.parseInt(form.networkPolicy.timeoutMs.trim(), 10),
    dnsRebindingProtection: form.networkPolicy.dnsRebindingProtection,
  }
  const agentPermission: AgentPermissionPolicy = {
    highRiskMethodsRequireApproval: form.agentPermission.highRiskMethodsRequireApproval,
    hostRules: form.agentPermission.hostRules.filter((rule) => rule.host.trim() !== '').map((rule) => ({ host: rule.host.trim(), action: rule.action })),
  }
  return {
    defaultTimeoutMs: Number.parseInt(form.defaultTimeoutMs.trim(), 10),
    followRedirects: form.followRedirects,
    saveHistory: form.saveHistory,
    maxResponseBytes: Number.parseInt(form.maxResponseBytes.trim(), 10),
    historyRetentionDays: Number.parseInt(form.historyRetentionDays.trim(), 10),
    postmanCompatibility: form.postmanCompatibility,
    networkPolicy,
    agentPermission,
  }
}

const inputStyle: CSSProperties = {
  background: colors.bgLayer1,
  border: `1px solid ${colors.border}`,
  borderRadius: 4,
  color: colors.text,
  font: 'inherit',
  fontSize: font.size,
  padding: '3px 8px',
  outline: 'none',
  width: 120,
}

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  marginBottom: 6,
  fontSize: font.size,
}

function Row(props: { label: string; children: ReactNode; hint?: string }): ReactElement {
  return (
    <div style={rowStyle}>
      <span style={{ flex: '0 0 240px', color: colors.textSecondary }}>{props.label}</span>
      {props.children}
      {props.hint !== undefined && <span style={{ color: colors.textSecondary, fontSize: 11 }}>{props.hint}</span>}
    </div>
  )
}

function Section(props: { title: string; children: ReactNode }): ReactElement {
  return (
    <section style={{ margin: '14px 0' }}>
      <div style={{ fontWeight: 700, marginBottom: 6, borderBottom: `1px solid ${colors.border}`, paddingBottom: 4 }}>{props.title}</div>
      {props.children}
    </section>
  )
}

function SettingsPage(): ReactElement {
  const api = useHostApi()
  const [form, setForm] = useState<FormState | undefined>()
  const [activeEnvironmentId, setActiveEnvironmentId] = useState<string | undefined>()
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api
      .get<PluginSettings>('/settings')
      .then((settings) => {
        setForm(toForm(settings))
        setActiveEnvironmentId(settings.activeEnvironmentId === '' ? undefined : settings.activeEnvironmentId)
      })
      .catch((error: unknown) => {
        toast.error(`load settings failed: ${error instanceof Error ? error.message : String(error)}`)
      })
  }, [api])

  const save = (): void => {
    if (form === undefined || saving) return
    const patch = toPatch(form)
    if ('error' in patch) {
      toast.error(patch.error)
      return
    }
    setSaving(true)
    api
      .patch<PluginSettings>('/settings', patch)
      .then(() => toast.info('Settings saved'))
      .catch((error: unknown) => {
        toast.error(`save settings failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => setSaving(false))
  }

  if (form === undefined) {
    return h('div', { style: { padding: 12, fontSize: font.size, color: colors.textSecondary } }, 'Loading settings…')
  }

  const patchForm = (partial: Partial<FormState>): void => setForm({ ...form, ...partial })
  const patchPolicy = (partial: Partial<FormState['networkPolicy']>): void => patchForm({ networkPolicy: { ...form.networkPolicy, ...partial } })
  const patchPermission = (partial: Partial<FormState['agentPermission']>): void => patchForm({ agentPermission: { ...form.agentPermission, ...partial } })

  return (
    <div data-dsh-api-client="settings-page" style={{ padding: 12, fontSize: font.size, color: colors.text, maxWidth: 720 }}>
      <Section title="General">
        <Row label="defaultTimeoutMs">
          <input style={inputStyle} value={form.defaultTimeoutMs} onChange={(e) => patchForm({ defaultTimeoutMs: e.target.value })} />
        </Row>
        <Row label="followRedirects">
          <input type="checkbox" checked={form.followRedirects} onChange={(e) => patchForm({ followRedirects: e.target.checked })} />
        </Row>
        <Row label="saveHistory">
          <input type="checkbox" checked={form.saveHistory} onChange={(e) => patchForm({ saveHistory: e.target.checked })} />
        </Row>
        <Row label="maxResponseBytes">
          <input style={inputStyle} value={form.maxResponseBytes} onChange={(e) => patchForm({ maxResponseBytes: e.target.value })} />
        </Row>
        <Row label="historyRetentionDays">
          <input style={inputStyle} value={form.historyRetentionDays} onChange={(e) => patchForm({ historyRetentionDays: e.target.value })} />
        </Row>
        <Row label="postmanCompatibility">
          <select style={inputStyle} value={form.postmanCompatibility} onChange={(e) => patchForm({ postmanCompatibility: e.target.value as 'strict' | 'lenient' })}>
            <option value="strict">strict</option>
            <option value="lenient">lenient</option>
          </select>
        </Row>
        <Row label="secretsDisplayPolicy" hint="V0.1 固定 masked；reveal 仅 Human UI human-present 路径">
          <code style={{ fontFamily: font.mono }}>masked</code>
        </Row>
        <Row label="activeEnvironmentId" hint="由主视图顶栏环境选择器维护">
          <code style={{ fontFamily: font.mono }}>{activeEnvironmentId ?? '(none)'}</code>
        </Row>
      </Section>

      <Section title="Network Policy（§24.3）">
        <Row label="allowLocalhost" hint="默认 false（fail-closed）">
          <input type="checkbox" checked={form.networkPolicy.allowLocalhost} onChange={(e) => patchPolicy({ allowLocalhost: e.target.checked })} />
        </Row>
        <Row label="allowPrivateNetwork" hint="默认 false">
          <input type="checkbox" checked={form.networkPolicy.allowPrivateNetwork} onChange={(e) => patchPolicy({ allowPrivateNetwork: e.target.checked })} />
        </Row>
        <Row label="allowPublicNetwork" hint="默认 true">
          <input type="checkbox" checked={form.networkPolicy.allowPublicNetwork} onChange={(e) => patchPolicy({ allowPublicNetwork: e.target.checked })} />
        </Row>
        <Row label="redirectPolicy">
          <select style={inputStyle} value={form.networkPolicy.redirectPolicy} onChange={(e) => patchPolicy({ redirectPolicy: e.target.value as NetworkPolicy['redirectPolicy'] })}>
            <option value="follow">follow</option>
            <option value="manual-block">manual-block</option>
            <option value="none">none</option>
          </select>
        </Row>
        <Row label="timeoutMs">
          <input style={inputStyle} value={form.networkPolicy.timeoutMs} onChange={(e) => patchPolicy({ timeoutMs: e.target.value })} />
        </Row>
        <Row label="maxResponseBytes">
          <input style={inputStyle} value={form.networkPolicy.maxResponseBytes} onChange={(e) => patchPolicy({ maxResponseBytes: e.target.value })} />
        </Row>
        <Row label="dnsRebindingProtection">
          <input type="checkbox" checked={form.networkPolicy.dnsRebindingProtection} onChange={(e) => patchPolicy({ dnsRebindingProtection: e.target.checked })} />
        </Row>
        <Row label="blockedHosts（每行一条，支持 *.example.com）">
          <textarea
            style={{ ...inputStyle, width: 320, minHeight: 56, fontFamily: font.mono }}
            value={form.networkPolicy.blockedHosts}
            onChange={(e) => patchPolicy({ blockedHosts: e.target.value })}
          />
        </Row>
        <Row label="allowedHosts（非空即白名单模式）">
          <textarea
            style={{ ...inputStyle, width: 320, minHeight: 56, fontFamily: font.mono }}
            value={form.networkPolicy.allowedHosts}
            onChange={(e) => patchPolicy({ allowedHosts: e.target.value })}
          />
        </Row>
        <Row label="blockedPorts（逗号分隔）">
          <input
            style={{ ...inputStyle, width: 320, fontFamily: font.mono }}
            value={form.networkPolicy.blockedPorts}
            onChange={(e) => patchPolicy({ blockedPorts: e.target.value })}
          />
        </Row>
      </Section>

      <Section title="Agent Permission（§24.5）">
        <Row label="highRiskMethodsRequireApproval" hint="POST/PUT/PATCH/DELETE 需人工批准">
          <input
            type="checkbox"
            checked={form.agentPermission.highRiskMethodsRequireApproval}
            onChange={(e) => patchPermission({ highRiskMethodsRequireApproval: e.target.checked })}
          />
        </Row>
        <div style={{ marginBottom: 6, color: colors.textSecondary }}>hostRules</div>
        {form.agentPermission.hostRules.map((rule, index) => (
          <div key={index} style={{ ...rowStyle, paddingLeft: 12 }}>
            <input
              style={{ ...inputStyle, width: 240, fontFamily: font.mono }}
              value={rule.host}
              placeholder="*.example.com"
              onChange={(e) => {
                const hostRules = form.agentPermission.hostRules.map((item, i) => (i === index ? { ...item, host: e.target.value } : item))
                patchPermission({ hostRules })
              }}
            />
            <select
              style={inputStyle}
              value={rule.action}
              onChange={(e) => {
                const hostRules = form.agentPermission.hostRules.map((item, i) =>
                  i === index ? { ...item, action: e.target.value as 'allow' | 'approval' | 'deny' } : item,
                )
                patchPermission({ hostRules })
              }}
            >
              <option value="allow">allow</option>
              <option value="approval">approval</option>
              <option value="deny">deny</option>
            </select>
            <button
              type="button"
              style={{ background: 'transparent', border: 'none', color: colors.danger, cursor: 'pointer' }}
              onClick={() => patchPermission({ hostRules: form.agentPermission.hostRules.filter((_, i) => i !== index) })}
            >
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          style={{ background: 'transparent', border: `1px solid ${colors.borderStrong}`, borderRadius: 4, color: colors.textSecondary, cursor: 'pointer', padding: '2px 10px' }}
          onClick={() => patchPermission({ hostRules: [...form.agentPermission.hostRules, { host: '', action: 'approval' }] })}
        >
          + Add rule
        </button>
      </Section>

      <div style={{ marginTop: 16 }}>
        <button
          type="button"
          disabled={saving}
          onClick={save}
          style={{
            background: colors.brand,
            color: colors.brandText,
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
            fontSize: font.size,
            padding: '5px 20px',
            opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? 'Saving…' : 'Save settings'}
        </button>
      </div>
    </div>
  )
}
