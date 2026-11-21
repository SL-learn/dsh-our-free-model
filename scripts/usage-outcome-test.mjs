/** 调用沉淀（noteUsageOutcome）的判定边界：中止不算失败、限流单次即标、连败与恢复。 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stubUpstream } from './lib/fake-kernel.mjs'

const upstream = await stubUpstream({ answer: async function* () { yield { type: 'text-delta', text: 'OK' }; yield { type: 'finish', reason: { kind: 'stop' } } } })
process.env.OUR_FREE_MODEL_BASE = upstream.base
const { createRuntimeStores, createModelRuntime } = await import('../src/core/runtime.js')
const { modelAvailability } = await import('../src/model-test.js')
after(() => upstream.close())

const id = 'mimo-v2.6-flash-free'
const other = 'space-bunny-free'

function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-usage-outcome-'))
  const stores = createRuntimeStores({ dataDir, logger: { warn() {} } })
  stores.settings.update({ enabled: true, exposeRegionModels: false, combos: [] })
  stores.catalogStore.update({ entries: [id, other] })
  const runtime = createModelRuntime({ ...stores, logger: { info() {}, warn() {} }, onTopology: () => {} })
  return {
    stores, runtime,
    view: () => modelAvailability(id, stores.availability.get()),
    close() { runtime.dispose(); stores.dispose(); fs.rmSync(dataDir, { recursive: true, force: true }) },
  }
}

const entry = { id, name: 'mimo' }

test('中止（用户取消/自动中止）不计连败、不改状态', () => {
  const f = fixture()
  try {
    f.runtime.noteUsageOutcome(entry, { ok: false, error: { code: 'aborted', message: 'request aborted' } })
    f.runtime.noteUsageOutcome(entry, { ok: false, error: { code: 'aborted', message: 'Request aborted by client' } })
    assert.equal(f.view().availability, 'unknown', '中止两次也不得标不可用')
    assert.equal(f.view().availabilitySource, 'probe', '没有任何测量沉淀')
  } finally { f.close() }
})

test('限流单次即标「限流中」，包括无 code 的文本归因', () => {
  const f = fixture()
  try {
    f.runtime.noteUsageOutcome(entry, { ok: false, error: { message: 'inclusionai/ling-3.2-flash:free is temporarily rate-limited. Please try again in 2m.' } })
    assert.equal(f.view().availability, 'throttled', '无 code 的 rate-limited 文案也要走暂态限流，不得计连败')
    f.runtime.noteUsageOutcome(entry, { ok: false, error: { code: 'RATE_LIMIT', message: '429' } })
    assert.equal(f.view().availability, 'throttled')
  } finally { f.close() }
})

test('硬失败连续两次标不可用；成功一次即恢复并清零', () => {
  const f = fixture()
  try {
    f.runtime.noteUsageOutcome(entry, { ok: false, error: { message: 'upstream exploded' } })
    assert.equal(f.view().availability, 'unknown', '单次硬失败不标（防误伤）')
    f.runtime.noteUsageOutcome(entry, { ok: false, error: { message: 'upstream exploded again' } })
    assert.equal(f.view().availability, 'unavailable')
    assert.equal(f.view().availabilitySource, 'usage')
    f.runtime.noteUsageOutcome(entry, { ok: true, ttftMs: 320, latencyMs: 1500 })
    assert.equal(f.view().availability, 'available')
    assert.equal(f.view().availabilitySource, 'usage')
    // 恢复后再失败一次不得直接标（连败计数已清零）。
    f.runtime.noteUsageOutcome(entry, { ok: false, error: { message: 'upstream exploded' } })
    assert.equal(f.view().availability, 'available')
  } finally { f.close() }
})

test('退役单次即终态，成功也不会被迟到的旧失败覆盖', () => {
  const f = fixture()
  try {
    f.runtime.noteUsageOutcome(entry, { ok: false, error: { message: 'The model \'x\' has reached its end of life on 2026-11-18' } })
    assert.equal(f.view().availability, 'unavailable')
    assert.equal(f.view().failureKind, 'retired')
  } finally { f.close() }
})

test('手动测试成功覆盖 usage 不可用判定（实测可用）', () => {
  const f = fixture()
  try {
    f.runtime.noteUsageOutcome(entry, { ok: false, error: { message: 'boom' } })
    f.runtime.noteUsageOutcome(entry, { ok: false, error: { message: 'boom 2' } })
    assert.equal(f.view().availability, 'unavailable')
    f.runtime.noteManualResult(id, { state: 'available', source: 'manual', at: Date.now() })
    assert.equal(f.view().availability, 'available')
    assert.equal(f.view().availabilitySource, 'manual')
  } finally { f.close() }
})
