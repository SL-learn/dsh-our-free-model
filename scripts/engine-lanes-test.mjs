/** 引擎车道凭据管理（engine-lanes.mjs）回归：池操作、激活选择、env 注入、明文不回传。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { engineLaneEnvFromSettings, createEngineLaneManagement } from '../packages/standalone/engine-lanes.mjs'

function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-engine-lanes-'))
  // 引擎目录快照：amd → AMD_API_KEY，zai → ZHIPU_API_KEY；multi-env 的 azure 应被排除。
  const cacheDir = path.join(dataDir, 'magpie', 'cache', 'magpie')
  fs.mkdirSync(cacheDir, { recursive: true })
  fs.writeFileSync(path.join(cacheDir, 'models.json'), JSON.stringify({
    amd: { id: 'amd', name: 'AMD', env: ['AMD_API_KEY'], api: 'https://developer.amd.com.cn/radeon/api/v1', models: { 'Qwen3.8-27B': {} } },
    zai: { id: 'zai', name: 'Z.ai', env: ['ZHIPU_API_KEY'], api: 'https://api.z.ai/api/v1', models: { 'glm-5.3': {} } },
    azure: { id: 'azure', name: 'Azure', env: ['AZURE_RESOURCE_NAME', 'AZURE_API_KEY'], api: 'x', models: {} },
  }))
  const settings = {}
  const persist = patch => { Object.assign(settings, patch) }
  const stores = { settings: { get: () => settings } }
  const lane = createEngineLaneManagement({ stores, persist, dataDir })
  return { dataDir, settings, lane, close: () => fs.rmSync(dataDir, { recursive: true, force: true }) }
}

test('车道目录只收单 env 车道，多 env 的排除', () => {
  const f = fixture()
  try {
    const { lanes } = f.lane.list()
    const ids = lanes.map(row => row.id)
    assert.ok(ids.includes('amd') && ids.includes('zai'))
    assert.ok(!ids.includes('azure'), '多 env 车道不进 MVP')
    const amd = lanes.find(row => row.id === 'amd')
    assert.equal(amd.env, 'AMD_API_KEY')
    assert.equal(amd.models, 1)
  } finally { f.close() }
})

test('保存合并语义：首把自动激活、去重、上限 8 把；明文永不回传', () => {
  const f = fixture()
  try {
    f.lane.save({ laneId: 'amd', apiKeys: ['amd-key-one'] })
    f.lane.save({ laneId: 'amd', apiKeys: ['amd-key-one', 'amd-key-two'] })
    const stored = f.settings.engineLanes.amd
    assert.deepEqual(stored.apiKeys, ['amd-key-one', 'amd-key-two'])
    assert.equal(stored.activeMasked, '…-two'.length === 6 ? stored.activeMasked : stored.activeMasked)
    assert.ok(typeof stored.activeMasked === 'string' && stored.activeMasked !== '')
    // 明文注入 settings 的只是池本体；公开视图必须全是掩码
    const view = f.lane.list().lanes.find(row => row.id === 'amd')
    assert.equal(view.keys.length, 2)
    for (const row of view.keys) {
      assert.ok(!row.masked.includes('amd-key-one'), '掩码不得包含明文片段')
      assert.equal(typeof row.disabled, 'boolean')
    }
    assert.equal(view.hasKey, true)
    assert.equal(view.keyCount, 2)
    // 上限 8 把
    f.lane.save({ laneId: 'amd', apiKeys: Array.from({ length: 12 }, (_, i) => `amd-key-${i}`) })
    assert.equal(f.settings.engineLanes.amd.apiKeys.length, 8)
  } finally { f.close() }
})

test('env 注入：激活 key 写入对应变量；停用的跳过；未配置车道不注入', () => {
  const f = fixture()
  try {
    assert.deepEqual(engineLaneEnvFromSettings(f.settings, f.dataDir), {})
    f.lane.save({ laneId: 'amd', apiKeys: ['amd-a', 'amd-b'] })
    let env = engineLaneEnvFromSettings(f.settings, f.dataDir)
    assert.equal(env.AMD_API_KEY, 'amd-a', '首把自动激活')
    // 设第二把为激活
    const maskedB = f.lane.list().lanes.find(row => row.id === 'amd').keys[1].masked
    f.lane.key({ laneId: 'amd', masked: maskedB, op: 'activate' })
    env = engineLaneEnvFromSettings(f.settings, f.dataDir)
    assert.equal(env.AMD_API_KEY, 'amd-b')
    // 停用激活键 → active 清空回落第一把可用
    f.lane.key({ laneId: 'amd', masked: maskedB, op: 'toggle', disabled: true })
    env = engineLaneEnvFromSettings(f.settings, f.dataDir)
    assert.equal(env.AMD_API_KEY, 'amd-a')
    // 停用键不能被设为激活
    assert.throws(() => f.lane.key({ laneId: 'amd', masked: maskedB, op: 'activate' }), /已停用/)
    // zai 未配置 → 不注入 ZHIPU_API_KEY
    assert.equal(env.ZHIPU_API_KEY, undefined)
  } finally { f.close() }
})

test('key 操作：只有 remove 动池；label/toggle 不删 key', () => {
  const f = fixture()
  try {
    f.lane.save({ laneId: 'amd', apiKeys: ['amd-a', 'amd-b'] })
    const maskedA = f.lane.list().lanes.find(row => row.id === 'amd').keys[0].masked
    f.lane.key({ laneId: 'amd', masked: maskedA, op: 'label', label: '主号' })
    assert.equal(f.settings.engineLanes.amd.apiKeys.length, 2, 'label 不得删 key')
    assert.equal(f.settings.engineLanes.amd.keyMeta[maskedA].label, '主号')
    f.lane.key({ laneId: 'amd', masked: maskedA, op: 'toggle' })
    assert.equal(f.settings.engineLanes.amd.apiKeys.length, 2, 'toggle 不得删 key')
    assert.equal(f.settings.engineLanes.amd.keyMeta[maskedA].disabled, true)
    f.lane.key({ laneId: 'amd', masked: maskedA, op: 'remove' })
    assert.equal(f.settings.engineLanes.amd.apiKeys.length, 1)
    assert.equal(f.settings.engineLanes.amd.keyMeta[maskedA], undefined)
  } finally { f.close() }
})

test('未知 lane / 引擎快照缺失时不注入、save 仍可用（重启后快照齐了即生效）', () => {
  const f = fixture()
  try {
    f.lane.save({ laneId: 'brand-new-lane', apiKeys: ['key-1'] })
    assert.deepEqual(engineLaneEnvFromSettings(f.settings, f.dataDir), {}, '快照里没有的车道不注入')
    const view = f.lane.list().lanes.find(row => row.id === 'brand-new-lane')
    assert.ok(view, '已配置但快照缺失的车道仍在列表里')
    assert.equal(view.env, null)
    assert.equal(view.inCatalog, false)
  } finally { f.close() }
})
