/**
 * 平台真实调用体检（2026-11-21 起为永久维护脚本）。
 *
 *   node scripts/platform-audit.mjs [--port 18900] [--out docs/platform-audit-<date>.json]
 *
 * 对每个渠道平台挑 1 个代表模型做两次最小真实调用（走 /v1 API，非测试按钮）：
 *   1. user role 基线调用（max_tokens 4，"hi"）
 *   2. developer role 兼容调用（OpenAI 新式 system）
 * 触发 429 / 频繁调用立即停止该平台本轮剩余调用。结果按平台分组输出 JSON，
 * 由 docs/platform-audit.md 汇总记录（永久数据，随 git 维护）。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const args = process.argv.slice(2)
const argOf = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const PORT = argOf('--port') ?? '18900'
const BASE = `http://127.0.0.1:${PORT}`
const settingsPath = process.env.OFM_AUDIT_SETTINGS
  ?? path.join(os.homedir(), 'AppData', 'Local', 'Our Free Model', 'data', 'settings.json')
const key = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).forwardKey
const outArg = argOf('--out') ?? 'C:/Users/SL/AppData/Local/Temp/ofm-audit.json'

const TIMEOUT_MS = 60_000
const call = async (model, messages) => {
  const started = Date.now()
  try {
    const response = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages, max_tokens: 4, stream: false }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const text = await response.text()
    let payload
    try { payload = JSON.parse(text) } catch { payload = { raw: text.slice(0, 200) } }
    const message = payload?.choices?.[0]?.message
    const usage = payload?.usage ?? {}
    // 思考模型在小 max_tokens 下会把预算全部消耗在 reasoning 上（content=null、
    // finish_reason=length）——这算「可用（思考截断）」，不算故障。
    const reasoningTruncated = response.ok && message?.content == null
      && (usage.completion_tokens_details?.reasoning_tokens ?? 0) > 0
    return {
      status: response.status,
      ms: Date.now() - started,
      ok: response.ok && (typeof message?.content === 'string' || reasoningTruncated),
      note: reasoningTruncated ? 'reasoning-truncated' : undefined,
      error: response.ok ? undefined : String(payload?.error?.message ?? payload?.message ?? text.slice(0, 180)),
      content: response.ok ? String(message?.content ?? '').slice(0, 40) : undefined,
    }
  } catch (error) {
    return { status: 0, ms: Date.now() - started, ok: false, error: `${error.name}: ${error.message.slice(0, 160)}` }
  }
}

const main = async () => {
  const modelsResponse = await fetch(`${BASE}/v1/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) })
  const { data } = await modelsResponse.json()
  // 分组：渠道 id = '/' 前缀；无前缀或 anonymous 前缀 = 核心聚合车道。
  const groups = new Map()
  for (const entry of data) {
    const first = entry.id.split('/')[0]
    const channel = !entry.id.includes('/') || first === 'anonymous' ? 'core' : first
    if (!groups.has(channel)) groups.set(channel, entry.id)
  }
  const results = []
  for (const [channel, model] of groups) {
    const record = { channel, model, baseline: undefined, developer: undefined, stopped: false }
    process.stdout.write(`[${channel}] ${model} ... `)
    record.baseline = await call(model, [{ role: 'user', content: 'hi' }])
    process.stdout.write(`user=${record.baseline.ok ? 'ok' : record.baseline.status} `)
    // 限流/频繁调用：停止该平台，不做 developer 调用。
    const throttled = record.baseline.status === 429
      || /rate|throttl|频繁|too many|overloaded/i.test(record.baseline.error ?? '')
    if (throttled) {
      record.stopped = true
      record.developer = { skipped: 'rate-limited on baseline call' }
      console.log('STOPPED (rate limit)')
      results.push(record)
      continue
    }
    record.developer = await call(model, [{ role: 'developer', content: 'hi' }])
    process.stdout.write(`developer=${record.developer.ok ? 'ok' : record.developer.status}\n`)
    results.push(record)
  }
  fs.writeFileSync(outArg, JSON.stringify({ auditedAt: new Date().toISOString(), port: PORT, results }, null, 2))
  console.log(`\nwritten: ${outArg} (${results.length} platforms)`)
}

await main()
