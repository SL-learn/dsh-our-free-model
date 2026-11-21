/**
 * /providers/key 单键操作的回归测试。
 *
 * 2026-11-21 真机踩坑：key() 里 pool 过滤无条件执行，导致「改个备注就把
 * 密钥从轮换池删了」。本测试钉死：只有 remove 动池，label/toggle 不动。
 *
 * Run: node scripts/providers-key-test.mjs
 */
import assert from 'node:assert/strict'
import { createProviderManagement } from '../packages/standalone/providers.mjs'

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}

/** 内存版 stores/runtime，settings 与持久化全走同一个对象。 */
function makeManagement() {
  const settings = { aggregate: { enabled: true, providers: {} } }
  const stores = { settings: { get: () => settings } }
  const management = createProviderManagement({
    stores,
    runtime: { syncAggregateCatalog: () => {} },
    // persist 收到的是顶层 settings 键补丁（{ aggregate: {...} }），直接并入根对象。
    persist: patch => { Object.assign(settings, patch) },
  })
  return { management, settings }
}

const { management, settings } = makeManagement()
const idsOf = () => (settings.aggregate.providers.agnes.apiKeys ?? []).map(key => key.slice(-4))
const metaOf = () => settings.aggregate.providers.agnes.keyMeta ?? {}

management.save({ providerId: 'agnes', apiKeys: ['sk-account-one-1111', 'sk-account-two-2222'] })
check('初始池两把键', idsOf(), ['1111', '2222'])

// ⚠️ 回归点：label 操作不得动池。
management.key({ providerId: 'agnes', masked: 'sk-acc…1111', op: 'label', label: '主账号' })
check('label 后池仍是两把', idsOf(), ['1111', '2222'])
check('label 落到 keyMeta', metaOf()['sk-acc…1111']?.label, '主账号')

// toggle 同样不动池。
management.key({ providerId: 'agnes', masked: 'sk-acc…1111', op: 'toggle', disabled: true })
check('toggle 后池仍是两把', idsOf(), ['1111', '2222'])
check('停用态落库', metaOf()['sk-acc…1111']?.disabled, true)

// save 的 keyMeta 合并不丢已有备注。
management.save({ providerId: 'agnes', apiKeys: ['sk-account-three-3333'] })
check('合并后三把键', idsOf(), ['1111', '2222', '3333'])
check('旧备注保留', metaOf()['sk-acc…1111']?.label, '主账号')

// remove 才真正动池，apiKey 指针同步。
management.key({ providerId: 'agnes', masked: 'sk-acc…1111', op: 'remove' })
check('remove 后剩两把', idsOf(), ['2222', '3333'])
check('meta 一并清理', metaOf()['sk-acc…1111'], undefined)

// publicProviders 永不回传明文。
const view = management.list().configured.agnes
check('公开视图只含掩码', view.keys.every(row => !row.masked.includes('account')), true)
check('公开视图带停用态与备注', view.keys[0].disabled === false && typeof view.keys[0].label === 'string', true)

// 未知掩码 / 双发键报错。
assert.throws(() => management.key({ providerId: 'agnes', masked: 'sk-nope…9999', op: 'remove' }), /密钥不存在/)
console.log(failures === 0 ? '\nproviders-key-test: all checks passed' : `\nproviders-key-test: ${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
