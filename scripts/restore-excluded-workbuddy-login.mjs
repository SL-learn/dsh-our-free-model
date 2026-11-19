/**
 * WorkBuddy 浏览器登录端到端：启动流程 → 打印授权 URL → 轮询至登录完成。
 * 用法：node scripts/restore-excluded-workbuddy-login.mjs [workbuddy|workbuddy-ai]
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { startStandalone } from '../packages/standalone/service.mjs'

const provider = process.argv[2] === 'workbuddy-ai' ? 'workbuddy-ai' : 'workbuddy'
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

  log(`\n=== 启动 ${provider} 浏览器登录 ===`)
  const r = await api('/engine/ui/api/plugin-signin', {
    method: 'POST', body: JSON.stringify({ provider, method: 0, inputs: {} }),
  })
  log('HTTP', r.status, JSON.stringify(r.json ?? r.text).slice(0, 900))
  if (r.status !== 200) process.exit(1)
  log('\n>>> 请在浏览器打开以下链接完成授权（流程会自动收尾）：')
  log('>>> ' + r.json.url + '\n')

  const ppFile = path.join(dataDir, 'magpie/config/magpie/plugin-providers.json')
  const deadline = Date.now() + 15 * 60 * 1000
  while (Date.now() < deadline) {
    await new Promise(rs => setTimeout(rs, 5000))
    // 只读文件与 providers 列表：重发 POST 会干扰进行中的流程
    let signedIn = '', accountId = ''
    try {
      const pp = JSON.parse(fs.readFileSync(ppFile, 'utf8'))
      const row = (Array.isArray(pp) ? pp : []).find(x => x?.id === provider)
      signedIn = String(row?.signedIn ?? '')
      accountId = row?.accountId ?? ''
    } catch {}
    const st = await api('/engine/ui/api/providers').catch(() => null)
    const rows = st && Array.isArray(st.json) ? st.json : (st?.json?.providers ?? [])
    const listed = rows.some(x => x?.id === provider)
    log(`[poll] signedIn=${signedIn} accountId=${accountId} listed=${listed}`)
    if (signedIn === 'true' || listed) {
      log('\n✅ 登录成功！signedIn=true, accountId=' + accountId)
      // 读取 providers 列表确认模型
      const st = await api('/engine/ui/api/providers')
      const rows = Array.isArray(st.json) ? st.json : (st.json?.providers ?? [])
      const wb = rows.filter(x => x?.id === provider)
      log('providers 条目:', JSON.stringify(wb[0] ?? {}).slice(0, 500))
      process.exit(0)
    }
  }
  log('\n[x] 10 分钟超时，登录未完成。')
  process.exit(1)
}

main().catch(e => { log('[x]', e?.stack ?? String(e)); process.exit(1) })
