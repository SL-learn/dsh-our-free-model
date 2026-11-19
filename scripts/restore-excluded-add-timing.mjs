/** add 安装计时诊断：确认 502 是否为代理 30s 超时。 */
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
  const mgmt = async (p, opts = {}, timeoutMs = 600000) => {
    const res = await fetch(service.url + '/api/management' + p, { headers: H, ...opts, signal: AbortSignal.timeout(timeoutMs) })
    const t = await res.text()
    try { return { status: res.status, json: JSON.parse(t), text: t } } catch { return { status: res.status, text: t.slice(0, 300) } }
  }

  await mgmt('/engine/start', { method: 'POST', body: '{}' })
  log('[t] 引擎已启动，发起 add（计时）…')
  const t0 = Date.now()
  const addRes = await mgmt('/engine/ui/api/plugins/add', {
    method: 'POST', body: JSON.stringify({ spec: '@magpie-community/opencode-workbuddy-auth' }),
  })
  log('[t] add HTTP', addRes.status, '| 耗时', ((Date.now() - t0) / 1000).toFixed(1) + 's')
  log('[t] body:', (addRes.text ?? JSON.stringify(addRes.json)).slice(0, 300))
  // 502 后延迟查状态：引擎侧可能仍在装
  for (let i = 1; i <= 4; i++) {
    await new Promise(r => setTimeout(r, 15000))
    const plugins = await mgmt('/engine/ui/api/plugins', {}, 30000)
    const text = JSON.stringify(plugins.json ?? plugins.text)
    log(`[t] +${i * 15}s /api/plugins 含 workbuddy-auth:`, text.includes('opencode-workbuddy-auth'))
  }
}

main().catch(e => { log('[t] ERROR:', e.stack || e.message); process.exitCode = 1 })
  .finally(async () => { if (service) { try { await service.close() } catch {} } })
