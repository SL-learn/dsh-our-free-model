/**
 * WorkBuddy 插件 provider 登录端到端探测（方案 A 开启）。
 * 验证：noAccountDiscovery 翻转 → POST /api/plugin-signin 启动浏览器登录流程。
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
  const api = async (p, opts = {}) => {
    const res = await fetch(service.url + '/api/management' + p, { headers: H, ...opts, signal: AbortSignal.timeout(120000) })
    const t = await res.text()
    try { return { status: res.status, json: JSON.parse(t) } } catch { return { status: res.status, text: t.slice(0, 600) } }
  }

  log('[t] 启动引擎…')
  await api('/engine/start', { method: 'POST', body: '{}' })
  await new Promise(r => setTimeout(r, 3000))

  // ① settings.json 验证：noAccountDiscovery 应为 false
  const settings = JSON.parse(fs.readFileSync(path.join(dataDir, 'magpie/config/magpie/settings.json'), 'utf8'))
  log('\n=== ① settings.json ===')
  log('noAccountDiscovery:', settings.noAccountDiscovery, '(方案 A 开启时应为 false)')

  // ② 触发 WorkBuddy 浏览器登录（method 0 = browser OAuth）
  log('\n=== ② POST /api/plugin-signin provider=workbuddy method=0 ===')
  const r1 = await api('/engine/ui/api/plugin-signin', {
    method: 'POST', body: JSON.stringify({ provider: 'workbuddy', method: 0, inputs: {} }),
  })
  log('HTTP', r1.status, JSON.stringify(r1.json ?? r1.text).slice(0, 1200))
  fs.writeFileSync(path.join(dataDir, 'probe-signin-result.json'), JSON.stringify(r1, null, 2))

  // ③ 轮询登录状态（如果引擎提供了状态查询）
  log('\n=== ③ providers 状态轮询（signedIn 应变化）===')
  for (let i = 0; i < 6; i++) {
    await new Promise(r => setTimeout(r, 5000))
    const st = await api('/engine/ui/api/providers')
    const rows = Array.isArray(st.json) ? st.json : (st.json?.providers ?? [])
    const wb = rows.filter(r => r?.id === 'workbuddy')
    const signed = wb.map(r => `${r.id}: signedIn=${r.signedIn} account=${r.accountId ?? ''}`)
    log(`[poll ${i + 1}]`, signed.join(' | ') || '(workbuddy 不在列表中，共 ' + rows.length + ' 条)')
    if (signed.some(s => s.includes('signedIn=true'))) break
  }
  log('\n[t] 完成。登录 URL 见上方响应（authUrl/instructions 字段）。')
  process.exit(0)
}

main().catch(e => { log('[x]', e?.stack ?? String(e)); process.exit(1) })
