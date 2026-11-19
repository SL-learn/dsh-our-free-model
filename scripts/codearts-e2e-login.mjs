/**
 * CodeArts 真实端到端验证（自带登录流程，只读验证）。
 *
 * 流程：
 *   1. 启动一个隔离 dataDir 的 standalone 服务；
 *   2. 通过 channel-pack RPC 触发 CodeArts 登录，拿到官方 loginUrl；
 *   3. 在浏览器完成华为云授权（本机回调，脚本持续运行等待）；
 *   4. 落库后只做查询类验证：account.list / credits.balances / model.list；
 *   5. 不调用 credits.claimAll 等任何写操作。
 *
 * 用法：
 *   node scripts/codearts-e2e-login.mjs [--wait-ms 300000] [--keep]
 *
 *   --wait-ms   等待浏览器授权的最长毫秒数（默认 300000，即 5 分钟；
 *               OAuth 回调服务端超时 180s，实际超过 3 分钟基本已失败）。
 *   --keep      结束后保留 dataDir（默认成功也保留，便于复用登录态；
 *               仅在显式 --reset 时清空）。
 *   --reset     开始前清空 dataDir（会丢弃已有登录态）。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { startStandalone } from '../packages/standalone/service.mjs'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const waitMs = Number(arg('--wait-ms', '300000'))
const reset = args.includes('--reset')

const dataDir = path.join(os.tmpdir(), 'ofm-codearts-e2e')
if (reset && fs.existsSync(dataDir)) fs.rmSync(dataDir, { recursive: true, force: true })
fs.mkdirSync(dataDir, { recursive: true })
// 只读约定：--no-refresh 不会关闭每日自动签到（README 有说明），必须在启动前
// 显式禁用，否则登录成功后内置调度器会自动尝试签到（写操作）。
fs.mkdirSync(path.join(dataDir, 'channel-pack'), { recursive: true })
fs.writeFileSync(path.join(dataDir, 'channel-pack/auto-checkin.json'), JSON.stringify({ enabled: false }))

const log = (...a) => process.stdout.write(a.join(' ') + '\n')
let service

async function main() {
  service = await startStandalone({ dataDir, port: 0, refresh: false })
  log('[e2e] 独立端已启动:', service.url)
  log('[e2e] dataDir:', dataDir)

  const key = JSON.parse(fs.readFileSync(service.keyFile, 'utf8')).forwardKey
  const rpc = async (method, payload = {}, timeoutMs = 180000) => {
    const res = await fetch(service.url + '/api/management/channels/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify({ method, payload }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    let result
    try { result = JSON.parse(text) } catch { throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`) }
    if (!res.ok || !result.ok) {
      throw new Error((result.error?.code || 'HTTP' + res.status) + ': ' + (result.error?.message || ''))
    }
    return result.value
  }

  // 已有登录态则直接复用
  let accounts = (await rpc('account.list', { provider: 'codearts' })).accounts ?? []
  let target = accounts.find(a => a.refreshable) ?? accounts[0]
  if (target) log('[e2e] 复用已有 CodeArts 账号:', target.id, target.nickname ?? '')
  else {
    log('[e2e] 未发现已有账号，触发官方登录…')
    const started = await rpc('account.create', { provider: 'codearts' }, 120000)
    target = { id: started.accountId }
    log('')
    log('==================== 请在浏览器完成授权 ====================')
    log(started.loginUrl)
    log('============================================================')
    log('[e2e] 账号占位:', target.id, '| 等待回调落库（最长', Math.round(waitMs / 1000), '秒）…')

    const deadline = Date.now() + waitMs
    let done = false
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 3000))
      let poll
      try { poll = await rpc('login.poll', { accountId: target.id, provider: 'codearts' }, 30000) }
      catch (e) { log('[e2e] poll 暂不可用:', e.message); continue }
      if (poll?.done) {
        if (!poll.success) throw new Error('登录失败: ' + (poll.error ?? '未知原因'))
        done = true
        log('[e2e] 登录成功，凭据已落库。')
        break
      }
    }
    if (!done) throw new Error('等待浏览器授权超时')
  }

  // ---------- 只读验证 ----------
  log('\n[e2e] ===== 只读验证开始（不触发签到/领取）=====')
  accounts = (await rpc('account.list', { provider: 'codearts' })).accounts ?? []
  log('[verify] account.list:')
  for (const a of accounts) {
    log('  -', a.id, '| nickname=', a.nickname, '| enabled=', a.enabled, '| refreshable=', a.refreshable, '| expiresAt=', a.expiresAt)
  }

  let balanceOk = 0, balanceFail = 0
  const balances = await rpc('credits.balances', { provider: 'codearts' })
  log('[verify] credits.balances:')
  for (const row of balances.accounts ?? []) {
    if (row.balance && typeof row.balance.total === 'number') {
      balanceOk++
      log('  -', row.nickname, '| 积分余额 total =', row.balance.total)
    } else {
      balanceFail++
      log('  -', row.nickname, '| error =', row.error ?? '(无)')
    }
  }

  const models = await rpc('model.list', { provider: 'codearts' })
  log('[verify] model.list: 模型数 =', (models.models ?? []).length)
  for (const m of (models.models ?? []).slice(0, 12)) {
    log('  -', m.id, '|', m.name ?? '', '| free=', m.isFree, '| disabled=', m.disabled)
  }

  log('\n[e2e] ===== 验证汇总 =====')
  log('  账号数:', accounts.length, '| 余额查询成功:', balanceOk, '| 失败:', balanceFail, '| 模型数:', (models.models ?? []).length)
  log('[e2e] 完成。dataDir 保留在:', dataDir)
}

main().catch(e => {
  log('[e2e] 错误:', e.stack || e.message)
  process.exitCode = 1
}).finally(async () => {
  if (service) { try { await service.close() } catch {} }
})
