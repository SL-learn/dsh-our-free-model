/**
 * 方案 A 其余三平台（WorkBuddy 国内/国际版、华为云 MaaS）插件市场对照测试。
 *
 * 同一进程内动态切换 OFM_RESTORE_EXCLUDED（magpie-policy 按函数读 env，
 * 无需重启），启动 magpie 引擎后对照插件市场/订阅 provider 列表：
 *   - 开关关：四平台相关条目应被过滤（原 16 项 magpie-policy 语义）
 *   - 开关开：条目应放行出现
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { startStandalone } from '../packages/standalone/service.mjs'

const dataDir = path.join(os.tmpdir(), 'ofm-restore-e2e')
fs.mkdirSync(path.join(dataDir, 'channel-pack'), { recursive: true })
fs.writeFileSync(path.join(dataDir, 'channel-pack/auto-checkin.json'), JSON.stringify({ enabled: false }))

const log = (...a) => process.stdout.write(a.join(' ') + '\n')
let service

const KEYWORDS = ['workbuddy', 'codebuddy', 'huaweicloud', 'huawei', 'codearts', 'maas', '码道', '华为']

function scan(obj, depth = 0, out = [], trail = '') {
  if (depth > 6 || obj === null || obj === undefined) return out
  if (Array.isArray(obj)) { obj.forEach((v, i) => scan(v, depth + 1, out, `${trail}[${i}]`)); return out }
  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      const keyHit = KEYWORDS.some(w => String(k).toLowerCase().includes(w))
      if (keyHit) out.push({ trail: `${trail}.${k}`, kind: 'key', preview: JSON.stringify(v).slice(0, 160) })
      scan(v, depth + 1, out, `${trail}.${k}`)
    }
    return out
  }
  const s = String(obj)
  if (KEYWORDS.some(w => s.toLowerCase().includes(w))) out.push({ trail, kind: 'value', preview: s.slice(0, 160) })
  return out
}

async function main() {
  service = await startStandalone({ dataDir, port: 0, refresh: false })
  const key = JSON.parse(fs.readFileSync(service.keyFile, 'utf8')).forwardKey
  // engine/* 是特权管理路由：Bearer forwardKey 不够，需 bootstrap 会话 cookie。
  // bootstrap token 在 service.managementUrl 的 #login= 片段里（10 分钟有效）。
  const frag = /[#&]login=([A-Za-z0-9_-]+)/.exec(service.managementUrl)?.[1]
  if (!frag) throw new Error('managementUrl 中未找到 bootstrap token: ' + service.managementUrl)
  const sessionRes = await fetch(service.url + '/api/management/session', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bootstrapToken: frag }),
  })
  if (sessionRes.status !== 200) throw new Error('建立管理会话失败 HTTP ' + sessionRes.status + ': ' + await sessionRes.text())
  const setCookie = sessionRes.headers.get('set-cookie') ?? ''
  const cookie = /([A-Za-z0-9_-]+=[A-Za-z0-9_-]+)/.exec(setCookie)?.[1] ?? ''
  log('[t] 管理会话已建立 (cookie', cookie.slice(0, 12) + '...)')
  const H = { 'content-type': 'application/json', authorization: 'Bearer ' + key, cookie }
  const mgmt = async (p, opts = {}) => {
    const res = await fetch(service.url + '/api/management' + p, { headers: H, ...opts, signal: AbortSignal.timeout(120000) })
    const t = await res.text()
    try { return { status: res.status, json: JSON.parse(t) } } catch { return { status: res.status, text: t.slice(0, 200) } }
  }

  log('[t] 独立端:', service.url)
  log('[t] 启动 magpie 引擎…')
  const st = await mgmt('/engine/status')
  log('[t] engine/status:', JSON.stringify(st.json ?? st).slice(0, 200))
  const startRes = await mgmt('/engine/start', { method: 'POST', body: '{}' })
  log('[t] engine/start:', startRes.status, JSON.stringify(startRes.json ?? startRes).slice(0, 300))
  if (startRes.status !== 200) { log('[t] 引擎启动失败，终止'); return }

  // ① 开关关：市场列表
  const mkts = async () => {
    const r = await mgmt('/engine/ui/api/plugins/market')
    return r
  }
  const off = await mkts()
  log('\n=== 阶段① OFM_RESTORE_EXCLUDED 未设（默认过滤）===')
  log('HTTP', off.status, '| body 大小:', JSON.stringify(off.json ?? off.text).length)
  const offHits = scan(off.json ?? off.text)
  log('四平台关键词命中:', offHits.length)
  for (const h of offHits.slice(0, 10)) log('  -', h.trail, '=', h.preview.slice(0, 100))

  // ② 开关开：同一进程内动态切换
  process.env.OFM_RESTORE_EXCLUDED = '1'
  log('\n=== 阶段② OFM_RESTORE_EXCLUDED=1（放行）===')
  const on = await mkts()
  log('HTTP', on.status, '| body 大小:', JSON.stringify(on.json ?? on.text).length)
  const onHits = scan(on.json ?? on.text)
  log('四平台关键词命中:', onHits.length)
  for (const h of onHits.slice(0, 20)) log('  -', h.trail, '=', h.preview.slice(0, 120))

  // ③ 差异汇总
  log('\n=== 差异 ===')
  log('关:', offHits.length, '处命中 | 开:', onHits.length, '处命中 | 新增:', onHits.length - offHits.length)
  if (onHits.length > offHits.length) {
    log('放行后新出现的条目（对照）:')
    const offSet = new Set(offHits.map(h => h.trail + '|' + h.preview))
    for (const h of onHits) if (!offSet.has(h.trail + '|' + h.preview)) log('  +', h.trail, '=', h.preview.slice(0, 120))
  }
  // 保存完整响应供后续安装测试
  fs.writeFileSync(path.join(os.tmpdir(), 'ofm-restore-market-on.json'), JSON.stringify(on.json ?? on.text))
  fs.writeFileSync(path.join(os.tmpdir(), 'ofm-restore-market-off.json'), JSON.stringify(off.json ?? off.text))
}

main().catch(e => { log('[t] ERROR:', e.stack || e.message); process.exitCode = 1 })
  .finally(async () => { if (service) { try { await service.close() } catch {} } })
