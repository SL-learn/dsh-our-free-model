/**
 * 方案 A 第二阶段：安装 WorkBuddy 社区插件 + 对照华为云 MaaS preset。
 * 需在第一阶段（restore-excluded-market-probe）验证放行后运行。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { startStandalone } from '../packages/standalone/service.mjs'

const dataDir = path.join(os.tmpdir(), 'ofm-restore-e2e')
fs.mkdirSync(path.join(dataDir, 'channel-pack'), { recursive: true })
fs.writeFileSync(path.join(dataDir, 'channel-pack/auto-checkin.json'), JSON.stringify({ enabled: false }))
process.env.OFM_RESTORE_EXCLUDED = '1'

const log = (...a) => process.stdout.write(a.join(' ') + '\n')
let service

async function main() {
  service = await startStandalone({ dataDir, port: 0, refresh: false })
  const key = JSON.parse(fs.readFileSync(service.keyFile, 'utf8')).forwardKey
  const frag = /[#&]login=([A-Za-z0-9_-]+)/.exec(service.managementUrl)?.[1]
  const sessionRes = await fetch(service.url + '/api/management/session', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bootstrapToken: frag }),
  })
  const setCookie = sessionRes.headers.get('set-cookie') ?? ''
  const cookie = /([A-Za-z0-9_-]+=[A-Za-z0-9_-]+)/.exec(setCookie)?.[1] ?? ''
  const H = { 'content-type': 'application/json', authorization: 'Bearer ' + key, cookie }
  const mgmt = async (p, opts = {}) => {
    const res = await fetch(service.url + '/api/management' + p, { headers: H, ...opts, signal: AbortSignal.timeout(300000) })
    const t = await res.text()
    try { return { status: res.status, json: JSON.parse(t) } } catch { return { status: res.status, text: t.slice(0, 400) } }
  }

  log('[t] 启动引擎…')
  await mgmt('/engine/start', { method: 'POST', body: '{}' })

  // ① 华为云 MaaS preset 对照（providers 列表）
  log('\n=== ① /api/providers 对照（华为云 MaaS preset）===')
  const provOn = await mgmt('/engine/ui/api/providers')
  const provList = JSON.stringify(provOn.json ?? provOn.text)
  log('HTTP', provOn.status, '| 含 huaweicloud:', provList.includes('huaweicloud'), '| body 大小:', provList.length)
  if (provList.includes('huaweicloud')) {
    try {
      const arr = provOn.json
      const rows = Array.isArray(arr) ? arr : (arr.providers ?? [])
      const hc = rows.filter(r => JSON.stringify(r).includes('huaweicloud') || String(r?.id ?? '').includes('huaweicloud'))
      for (const r of hc.slice(0, 3)) log('  huaweicloud 条目:', JSON.stringify(r).slice(0, 220))
    } catch {}
  }
  // 关闭开关对照（同进程动态切）
  delete process.env.OFM_RESTORE_EXCLUDED
  const provOff = await mgmt('/engine/ui/api/providers')
  log('关闭开关后 | 含 huaweicloud:', JSON.stringify(provOff.json ?? provOff.text).includes('huaweicloud'))
  process.env.OFM_RESTORE_EXCLUDED = '1'

  // ② 安装 WorkBuddy 社区插件
  log('\n=== ② 安装 @magpie-community/opencode-workbuddy-auth ===')
  const addRes = await mgmt('/engine/ui/api/plugins/add', {
    method: 'POST', body: JSON.stringify({ spec: '@magpie-community/opencode-workbuddy-auth' }),
  })
  log('add HTTP', addRes.status, JSON.stringify(addRes.json ?? addRes.text).slice(0, 600))

  // ③ 安装后插件状态与 provider
  log('\n=== ③ 安装后状态 ===')
  const plugins = await mgmt('/engine/ui/api/plugins')
  const text = JSON.stringify(plugins.json ?? plugins.text)
  log('HTTP', plugins.status, '| /api/plugins 含 workbuddy:', text.includes('workbuddy'))
  try {
    const arr = plugins.json
    const rows = Array.isArray(arr) ? arr : (arr.plugins ?? [])
    for (const r of rows.filter(r => JSON.stringify(r).toLowerCase().includes('workbuddy')).slice(0, 4)) {
      log('  插件:', JSON.stringify(r).slice(0, 400))
    }
  } catch {}
  const provAfter = await mgmt('/engine/ui/api/providers')
  const afterText = JSON.stringify(provAfter.json ?? provAfter.text)
  log('providers 含 workbuddy:', afterText.includes('workbuddy'), '| 含 workbuddy-ai:', afterText.includes('workbuddy-ai'))
  try {
    const arr = provAfter.json
    const rows = Array.isArray(arr) ? arr : (provAfter.json.providers ?? [])
    for (const r of rows.filter(r => String(r?.id ?? '').startsWith('workbuddy')).slice(0, 4)) {
      log('  provider:', JSON.stringify(r).slice(0, 300))
    }
  } catch {}
}

main().catch(e => { log('[t] ERROR:', e.stack || e.message); process.exitCode = 1 })
  .finally(async () => { if (service) { try { await service.close() } catch {} } })
