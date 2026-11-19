/**
 * MOD verification: the OFM_RESTORE_EXCLUDED switch.
 *
 * With the switch off (default) the four excluded channels are denied exactly
 * as upstream shipped. With it on, every denial decision — ids, presets,
 * packages, prose, mutations and catalog models — is lifted, so CodeArts,
 * WorkBuddy China/international (CodeBuddy) and Huawei Cloud MaaS can be
 * installed, signed in to and served again.
 *
 * This is a pure-function test: no engine binary, no network, no temp dirs.
 * Run: node scripts/mod-restore-policy-test.mjs
 */
import assert from 'node:assert/strict'
import {
  RESTORE_ENV_VAR, restoreExcludedEnabled, isDeniedChannel, deniedModel,
  filterEngineJSON, assertEngineMutation, deniedLookup, policyMutation,
} from '../src/magpie-policy.js'

let checks = 0
const check = (name, run) => { run(); checks++; console.log(`ok ${checks} - ${name}`) }

const FOUR = [
  'workbuddy', 'workbuddy-ai', 'codebuddy', 'codebuddy-cn',
  'codearts', 'huaweicloud', 'Huawei Cloud MaaS', 'ModelArts', '华为云', '码道',
]
const env = value => value === undefined ? {} : { [RESTORE_ENV_VAR]: value }

// --- switch parsing -------------------------------------------------------
check('switch is off by default and for other values', () => {
  assert.equal(restoreExcludedEnabled({}), false)
  assert.equal(restoreExcludedEnabled(env('0')), false)
  assert.equal(restoreExcludedEnabled(env('false')), false)
  assert.equal(restoreExcludedEnabled(env('yes-please')), false)
})
check('switch accepts 1 / true / yes (case of value kept literal)', () => {
  assert.equal(restoreExcludedEnabled(env('1')), true)
  assert.equal(restoreExcludedEnabled(env('true')), true)
  assert.equal(restoreExcludedEnabled(env('yes')), true)
})

// --- off: upstream behaviour unchanged ------------------------------------
const originalEnv = globalThis.process?.env
const setEnv = value => {
  if (!globalThis.process) return
  if (value === undefined) delete globalThis.process.env[RESTORE_ENV_VAR]
  else globalThis.process.env[RESTORE_ENV_VAR] = value
}

setEnv(undefined)
check('OFF: all four channels denied by id and by text', () => {
  for (const name of FOUR) assert.equal(isDeniedChannel(name), true, `expected denied: ${name}`)
})
check('OFF: a model owned by an excluded channel is dropped', () => {
  assert.equal(deniedModel({ id: 'm1', owned_by: 'codearts' }), true)
  assert.equal(deniedModel({ id: 'workbuddy/x', owned_by: 'x' }), true)
})
check('OFF: mutation to install/sign in is refused with 403', () => {
  assert.throws(() => assertEngineMutation('POST', '/api/plugins/add', { spec: 'codearts-auth' }),
    error => error.statusCode === 403)
  assert.throws(() => assertEngineMutation('POST', '/api/signin', { agent: 'codearts' }),
    error => error.statusCode === 403)
})
check('OFF: plugin name still redacted in third-party prose', () => {
  const out = filterEngineJSON('/api/plugins/listings', { listings: [{ package: 'uses codearts and workbuddy' }] })
  assert.doesNotMatch(JSON.stringify(out), /codearts|workbuddy/i)
})
check('OFF: a plugin detail lookup is refused', () => {
  assert.equal(deniedLookup('/api/plugins/page', new URLSearchParams({ name: 'codearts-auth' })), true)
})

// --- on: every decision lifted -------------------------------------------
setEnv('1')
check('ON: all four channels allowed by id and by text', () => {
  for (const name of FOUR) assert.equal(isDeniedChannel(name), false, `expected allowed: ${name}`)
})
check('ON: a model owned by a former excluded channel is kept', () => {
  assert.equal(deniedModel({ id: 'm1', owned_by: 'codearts' }), false)
  assert.equal(deniedModel({ id: 'workbuddy/x', owned_by: 'x' }), false)
})
check('ON: market / provider / usage answers pass through untouched', () => {
  const market = { listings: [{ package: '@magpie-community/opencode-codearts-auth', providers: ['codearts'] }], state: { plugins: [{ spec: 'workbuddy' }] } }
  assert.deepEqual(filterEngineJSON('/api/plugins/market', market), market)
  const providers = { presets: [{ id: 'huaweicloud' }], providers: [{ pid: 'codearts', move: { package: 'codearts-auth' } }] }
  assert.deepEqual(filterEngineJSON('/api/providers', providers), providers)
  const upstream = { providers: { codearts: { ok: true }, codex: { ok: true } } }
  assert.deepEqual(filterEngineJSON('/api/upstream', upstream), upstream)
})
check('ON: mutations that install / enable / sign in are no longer refused', () => {
  const cases = [
    ['/api/plugins/add', { spec: 'codearts-auth' }],
    ['/api/plugins/off', { spec: 'workbuddy', off: false }],
    ['/api/plugin-signin', { provider: 'codearts' }],
    ['/api/signin', { agent: 'codearts' }],
    ['/api/login/oauth', { agent: 'workbuddy' }],
    ['/api/provider/move', { id: 'huaweicloud' }],
    ['/api/provider/save', { preset: 'huaweicloud', id: 'codearts', name: '华为云' }],
  ]
  for (const [route, body] of cases) {
    assert.doesNotThrow(() => assertEngineMutation('POST', route, body), `route ${route}`)
  }
})
check('ON: third-party prose is no longer redacted', () => {
  const out = filterEngineJSON('/api/plugins/listings', { listings: [{ package: 'uses codearts and workbuddy' }] })
  assert.match(JSON.stringify(out), /codearts/i)
  assert.match(JSON.stringify(out), /workbuddy/i)
})
check('ON: plugin detail lookup is no longer refused', () => {
  assert.equal(deniedLookup('/api/plugins/page', new URLSearchParams({ name: 'codearts-auth' })), false)
})
check('policyMutation routing is unchanged by the switch', () => {
  assert.equal(policyMutation('POST', '/api/plugins/add'), true)
  assert.equal(policyMutation('GET', '/api/plugins/add'), false)
})

// restore env
if (globalThis.process) {
  if (originalEnv === undefined || originalEnv === null) delete globalThis.process.env[RESTORE_ENV_VAR]
  else if (Object.hasOwn(originalEnv, RESTORE_ENV_VAR)) globalThis.process.env[RESTORE_ENV_VAR] = originalEnv[RESTORE_ENV_VAR]
  else delete globalThis.process.env[RESTORE_ENV_VAR]
}

console.log(`\nmod-restore-policy: ${checks} checks passed`)
