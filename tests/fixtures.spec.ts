/**
 * TC-M0-08/09: the two fixtures' skeleton schema validation (M0 §6.5/§6.6
 * required-field completeness, AC-M0-18).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, name), 'utf8'))
}

const CARDINALITIES = ['single', 'list', 'keyed', 'chain']

describe('fixtures skeleton schema (TC-M0-08/09)', () => {
  it('TC-M0-08: runtime-slot-catalog.json has every §6.5 required field', () => {
    const catalog = readFixture('runtime-slot-catalog.json') as Record<string, unknown>
    expect(typeof catalog.dshVersion).toBe('string')
    expect(Array.isArray(catalog.capturedBy)).toBe(true)
    expect((catalog.capturedBy as unknown[]).length).toBeGreaterThan(0)
    expect(typeof catalog.capturedAt).toBe('string')
    expect(Array.isArray(catalog.slots)).toBe(true)
    expect((catalog.slots as unknown[]).length).toBeGreaterThan(0)

    for (const slot of catalog.slots as Array<Record<string, unknown>>) {
      expect(typeof slot.key).toBe('string')
      expect(CARDINALITIES).toContain(slot.cardinality)
      expect(typeof slot.scope).toBe('string')
      expect(typeof slot.ownerProps).toBe('object')
      expect(slot.ownerProps).not.toBeNull()
      expect(Array.isArray(slot.occupants)).toBe(true)
      for (const occupant of slot.occupants as Array<Record<string, unknown>>) {
        expect(typeof occupant.id).toBe('string')
        expect(typeof occupant.priority).toBe('number')
      }
      expect(typeof slot.replacementRisk).toBe('string')
    }

    // The M0 target slots are present in the catalog seed.
    const keys = (catalog.slots as Array<{ key: string }>).map((slot) => slot.key)
    expect(keys).toContain('conversation')
    expect(keys).toContain('settings.plugin.item')
    expect(keys).toContain('sidebar.footer.action')
  })

  it('TC-M0-09: client-manifest-contract.json has every §6.6 required field', () => {
    const contract = readFixture('client-manifest-contract.json') as Record<string, unknown>
    expect(typeof contract.dshVersion).toBe('string')

    const manifest = contract.manifest as Record<string, unknown>
    expect(typeof manifest).toBe('object')
    expect(typeof manifest.exports).toBe('object')
    expect(typeof manifest.dsh).toBe('object')
    const exportsMap = manifest.exports as Record<string, unknown>
    expect(exportsMap['.']).toBe('./dist/index.js')
    expect(exportsMap['./client']).toBe('./dist/client.js')
    expect(exportsMap['./package.json']).toBe('./package.json')

    const scanner = contract.scannerBehavior as Record<string, unknown>
    for (const field of ['recognizedAsClientModule', 'clientJsServedAt', 'missingClientExportBehavior', 'moduleFormat']) {
      expect(scanner[field] === undefined, `scannerBehavior.${field} missing`).toBe(false)
    }

    const bundlePatch = contract.bundlePatch as Record<string, unknown>
    expect(bundlePatch.file).toBe('cordis.patch.yml')
    expect(typeof bundlePatch.rosterEntry).toBe('object')
    expect(bundlePatch.rosterEntry).not.toBeNull()
    expect(bundlePatch.patchReloadLive === undefined).toBe(false)
  })
})
