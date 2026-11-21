/**
 * OpenCode 出口池（2026-11-21）。
 *
 * 背景：OpenCode 免费额度按**出口 IP** 计量。单一出口被 429 后，整个车道
 * 都不可用。channel-pack 的 opencode adapter 已内置「遇限流自动换下一个槽」
 * 的轮换（opencode-adapter.ts stream()），且每个槽可绑**独立代理**
 * （opencode.setProxy → 独立 dispatcher）。因此「多代理自动轮换」不需要改
 * 任何引擎：把 N 个代理地址编成 N 个匿名槽，各绑一个代理，轮换时自然换 IP。
 *
 * 本面板做三件事：
 *   1. 列出已有 opencode 槽 + 每槽代理绑定（opencode.listSlots，掩码）；
 *   2. 批量应用：把用户填的每个代理地址建一个匿名槽并绑定（幂等：已有同
 *      代理的槽不重复建）；
 *   3. 每个地址可先「测出口 IP」（opencode.testProxy）确认可用再应用。
 *
 * 明文代理地址只在这一步从输入框 POST 到后端；后端只回掩码 label，永不回明文。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { CircleAlert, FlaskConical, Globe2, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { Button, Input } from './components/ui'
import { failureMessage } from './management'

type Rpc = (method: string, payload?: object) => Promise<any>
interface Slot {
  id: string
  nickname: string
  enabled: boolean
  anonymous: boolean
  proxyLabel: string
  hasProxy: boolean
}

// 多行输入按行拆分（与 providers.tsx 的 keyList 同口径）。
const addressList = (text: string) => [...new Set(text.split(/[\n,]+/).map(row => row.trim()).filter(Boolean))]

export function OpencodeExitPool({ rpc, onChanged }: { rpc: Rpc; onChanged?: () => void }) {
  const [slots, setSlots] = useState<Slot[]>()
  const [input, setInput] = useState('')
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [tested, setTested] = useState<Record<string, string>>({})
  const mounted = useRef(false)

  const reload = useCallback(async () => {
    try {
      const value = await rpc('opencode.listSlots')
      if (!mounted.current) return
      setSlots(value.slots ?? [])
      setError('')
    } catch (failure) {
      if (mounted.current) setError(failureMessage(failure as Error))
    }
  }, [rpc])
  useEffect(() => {
    mounted.current = true
    void reload()
    return () => { mounted.current = false }
  }, [reload])

  const apply = async () => {
    const addresses = addressList(input)
    if (addresses.length === 0) { setError('请先填入至少一个代理地址（每行一个）。'); return }
    if (typeof window !== 'undefined' && !window.confirm(
      `按 ${addresses.length} 个代理地址建立/绑定 OpenCode 出口槽？\n`
      + '每个地址会对应一个匿名通道，遇到限流时自动切换到下一个出口。\n'
      + '已有的同代理槽会被复用，不会重复创建。')) return
    setBusy(true); setError(''); setStatus('')
    try {
      let created = 0, reused = 0, bound = 0
      // 先取一遍现有槽，尽量复用「已绑同代理」的槽。
      let current: Slot[] = (await rpc('opencode.listSlots')).slots ?? []
      for (const address of addresses) {
        // 已有同代理槽（掩码一致）→ 复用；否则新建一个匿名槽。
        let slot = current.find(row => row.hasProxy && row.proxyLabel !== '' && addressIncludes(row.proxyLabel, address))
        if (!slot) {
          const result = await rpc('opencode.addAnonymous', { nickname: `出口 ${shortOf(address)}` })
          slot = { id: result.accountId, nickname: `出口 ${shortOf(address)}`, enabled: true, anonymous: true, proxyLabel: '', hasProxy: false }
          current = [...current, slot]
          created += 1
        } else reused += 1
        // 绑定代理（setProxy 会做形状校验，失败即抛）。
        await rpc('opencode.setProxy', { accountId: slot.id, proxy: address })
        bound += 1
      }
      if (mounted.current) setStatus(`完成：新建 ${created} 个、复用 ${reused} 个，绑定 ${bound} 个代理。`)
      setInput('')
      await reload()
      onChanged?.()
    } catch (failure) {
      if (mounted.current) setError(failureMessage(failure as Error))
    } finally { if (mounted.current) setBusy(false) }
  }

  const testOne = async (address: string) => {
    setBusy(true); setError('')
    try {
      const value = await rpc('opencode.testProxy', { proxy: address })
      if (mounted.current) setTested(previous => ({ ...previous, [address]: `${value.exitIp}（${value.country || '未知地区'}，${value.latencyMs}ms）` }))
    } catch (failure) {
      if (mounted.current) setTested(previous => ({ ...previous, [address]: `失败：${failureMessage(failure as Error)}` }))
    } finally { if (mounted.current) setBusy(false) }
  }

  const removeSlot = async (slot: Slot) => {
    if (typeof window !== 'undefined' && !window.confirm(`删除出口槽「${slot.nickname}」？该槽的代理绑定也会一起移除。`)) return
    setBusy(true); setError('')
    try {
      await rpc('account.delete', { accountId: slot.id })
      await reload()
      onChanged?.()
    } catch (failure) {
      if (mounted.current) setError(failureMessage(failure as Error))
    } finally { if (mounted.current) setBusy(false) }
  }

  const addresses = addressList(input)
  const proxied = slots?.filter(slot => slot.hasProxy).length ?? 0
  return <div className="ofm_hero exit-pool" aria-label="OpenCode 出口池">
    <h3>OpenCode 出口池（多代理自动轮换）</h3>
    <p className="ofm_note">
      OpenCode 免费额度按出口 IP 计量，单一出口被限流后整条车道不可用。
      在这里填入多个代理地址（每行一个），每个地址会对应一个独立匿名通道；
      请求遇到限流时会自动切换到下一个出口，无需手动干预。
      没有代理地址时本页无需操作，车道走本机直连。
    </p>
    <label className="exit-pool-input-label" htmlFor="exit-pool-input">代理地址（http / https / socks5，每行一个）</label>
    <textarea id="exit-pool-input" className="exit-pool-input" rows={4} spellCheck={false}
      placeholder={'http://user:pass@host:port\nsocks5://host:1080'}
      value={input} onChange={event => setInput(event.target.value)} disabled={busy} />
    <div className="ofm_row ofm_acts">
      <Button variant="outline" disabled={busy || addresses.length === 0} onClick={() => { for (const address of addresses) void testOne(address) }}>
        <FlaskConical size={15} />测试所选地址出口 IP
      </Button>
      <Button disabled={busy || addresses.length === 0} onClick={() => { void apply() }}>
        <Plus size={15} />应用为出口槽（{addresses.length}）
      </Button>
      <Button variant="ghost" disabled={busy} onClick={() => { void reload() }}><RefreshCw size={15} />刷新</Button>
    </div>
    {Object.entries(tested).length > 0 && <div className="exit-pool-tested">
      {Object.entries(tested).map(([address, result]) => <p key={address}><code>{shortOf(address)}</code> → {result}</p>)}
    </div>}
    {error && <div className="channel-error" role="alert"><CircleAlert size={16} /><span>{error}</span></div>}
    {status && <p className="ofm_note" role="status">{status}</p>}
    <div className="exit-pool-list">
      <h4>当前出口槽（{proxied} 个已绑代理 / {slots?.length ?? 0} 个槽）</h4>
      {slots === undefined ? <p className="ofm_note">正在读取…</p>
        : slots.length === 0 ? <p className="ofm_note">暂无 OpenCode 槽。填入代理地址后点「应用」即可创建。</p>
          : slots.map(slot => <div className="exit-pool-row" key={slot.id}>
            <Globe2 size={15} />
            <div className="exit-pool-info"><strong>{slot.nickname}</strong>
              <code>{slot.id}</code>
              <small>{slot.hasProxy ? `代理：${slot.proxyLabel}` : '直连（本机出口）'}{slot.anonymous ? ' · 匿名通道' : ' · API key 账号'}{!slot.enabled ? ' · 已停用' : ''}</small></div>
            {slot.hasProxy && <Button variant="ghost" aria-label={`删除 ${slot.nickname}`} title="删除该出口槽" disabled={busy} onClick={() => { void removeSlot(slot) }}><Trash2 size={14} /></Button>}
          </div>)}
    </div>
    <p className="ofm_note">轮换由 OpenCode 适配器自动完成：某出口返回限流/额度耗尽时标记该槽并换下一个，已交付内容的流不会重放。代理地址以掩码显示，明文只保存在本机。</p>
  </div>
}

function shortOf(address: string) {
  try {
    const url = new URL(address)
    return `${url.protocol}//${url.host}`
  } catch { return address.slice(0, 24) }
}

// 复用判据：掩码 label 与地址 host:port 命中的同一个出口算已绑定（避免重复建槽）。
// label 只含 host/port（密码打码），用 host+port 做保守匹配；匹配失败就新建（幂等仍由 setProxy 覆盖保证）。
function addressIncludes(label: string, address: string) {
  try {
    const a = new URL(address)
    const hostPort = a.host
    return label.includes(hostPort)
  } catch { return false }
}
