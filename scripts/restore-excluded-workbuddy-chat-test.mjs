/**
 * WorkBuddy 登录后模型调用测试：经 gateway 发一次真实 chat 请求。
 * 前置：restore-excluded-workbuddy-login.mjs 已在 ofm-restore-e2e 完成登录。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { startStandalone } from '../packages/standalone/service.mjs'

const providerArg = process.argv[2] === "workbuddy-ai" ? "workbuddy-ai" : "workbuddy"
const dataDir = path.join(os.tmpdir(), "ofm-restore-e2e")
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

  log('[t] 启动引擎…')
  await fetch(service.url + '/api/management/engine/start', {
    method: 'POST', headers: H, body: '{}', signal: AbortSignal.timeout(120000),
  })
  await new Promise(r => setTimeout(r, 3000))

  // gateway 地址与 key
  const settings = JSON.parse(fs.readFileSync(path.join(dataDir, 'magpie/config/magpie/settings.json'), 'utf8'))
  const callerKeys = JSON.parse(fs.readFileSync(path.join(dataDir, 'magpie/config/magpie/caller-keys.json'), 'utf8'))
  const gwPort = settings.port
  const gwKey = callerKeys.find(k => k?.id === 'ofm-internal')?.secret ?? callerKeys[0]?.secret
  log('gateway:', `http://127.0.0.1:${gwPort}`, '| key id:', callerKeys.map(k => k.id).join(','))

  // ① 登录状态确认
  const st = await fetch(service.url + '/api/management/engine/ui/api/providers', { headers: H }).then(r => r.json())
  const rows = Array.isArray(st) ? st : (st?.providers ?? [])
  const wb = rows.find(x => x?.id === providerArg)
  log('\n=== ① 登录状态 ===')
  log('workbuddy signedIn:', wb?.signedIn ?? (rows.some(x => x?.id === providerArg) ? '(listed)' : 'NOT LISTED'))

  // ② gateway 模型列表
  log('\n=== ② GET /v1/models ===')
  const models = await fetch(`http://127.0.0.1:${gwPort}/v1/models`, {
    headers: { authorization: 'Bearer ' + gwKey },
  }).then(r => r.json()).catch(e => ({ error: String(e) }))
  const ids = (models?.data ?? []).map(m => m.id)
  log('模型数:', ids.length)
  const wbModels = ids.filter(id => id.startsWith(providerArg + '/'))
  log(`${providerArg} 模型:`, wbModels.join(', ') || '(无)')

  // ③ 真实推理调用（max_tokens 放宽：推理模型的 reasoning 会吃掉额度）
  const target = wbModels.find(id => /flash|auto/i.test(id)) ?? wbModels[0]
  log('\n=== ③ chat 调用 model=' + target + ' ===')
  const t0 = Date.now()
  const chat = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + gwKey },
    body: JSON.stringify({
      model: target,
      messages: [{ role: 'user', content: '只回复两个字：成功' }],
      max_tokens: 300,
    }),
    signal: AbortSignal.timeout(90000),
  })
  const ct = await chat.text()
  log('HTTP', chat.status, '| 耗时', Date.now() - t0, 'ms')
  try {
    const j = JSON.parse(ct)
    log('回复:', JSON.stringify(j.choices?.[0]?.message ?? j).slice(0, 400))
    log('usage:', JSON.stringify(j.usage ?? {}).slice(0, 200))
  } catch { log('body:', ct.slice(0, 500)) }
  process.exit(0)
}

main().catch(e => { log('[x]', e?.stack ?? String(e)); process.exit(1) })
