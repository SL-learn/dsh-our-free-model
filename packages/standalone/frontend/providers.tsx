import { useMemo, useRef, useState, useEffect } from 'react'
import { ArrowRight, Check, CircleAlert, ExternalLink, FlaskConical, KeyRound, ListRestart, Plus, RefreshCw, Save, Search, Settings2, Trash2 } from 'lucide-react'
import { Badge, Button, Input, Switch } from './components/ui'
import { ProviderIcon } from './components/provider-icon'
import { WorkbenchDialog } from './components/workbench-dialog'
import { failureMessage, management, useManagementResource } from './management'
import { useReveal } from './motion/hooks'
import type { Host } from './types'

interface StoredKey { masked: string; label: string; disabled: boolean }
interface Provider {
  id: string; name: string; category: string; format: string; authKind: string
  baseUrl: string; modelCount: number; models?: string[]; notes: string
  website?: string; credentialUrl?: string; freeModelsHint?: string
}
interface Configuration {
  enabled: boolean; hasKey: boolean; keyCount?: number; keyHint?: string
  keys?: StoredKey[]; paidModels?: string[]; baseUrl: string; models: string[]
  discovered?: string[]
  lastTest?: { ok?: boolean; at?: number } | number
}
interface Directory { registry: Provider[]; configured: Record<string, Configuration> }
const connected = (provider: Provider, config?: Configuration) => !!config?.enabled && (config.hasKey || provider.authKind === 'none')
const modelList = (text: string) => [...new Set(text.split(/[\n,]+/).map(row => row.trim()).filter(Boolean))]
// 多把 Key 按行拆分：轮换池的展示形态与保存形态一致（每行一把，去空去重）。
const keyList = (text: string) => [...new Set(text.split(/\n+/).map(row => row.trim()).filter(Boolean))]
const endpoint = (url: string) => {
  try { const value = new URL(url); return value.host + value.pathname.replace(/\/$/, '') } catch { return url || '未设置 API 地址' }
}
const validBaseUrl = (url: string) => {
  try { const value = new URL(url.trim()); return ['http:', 'https:'].includes(value.protocol) && !value.username && !value.password } catch { return false }
}

function ProviderEditor({ provider, configuration, onClose, onSaved }: {
  provider: Provider; configuration?: Configuration; onClose(): void; onSaved(): Promise<void>
}) {
  const savedKeys = configuration?.keys ?? []
  const [baseUrl, setBaseUrl] = useState(configuration?.baseUrl || provider.baseUrl)
  const [enabled, setEnabled] = useState(configuration?.enabled ?? true)
  const [keys, setKeys] = useState<StoredKey[]>(savedKeys)
  // 添加密钥是点击按钮后的展开表单（密钥 + 备注 + 保存/取消），不是常驻
  // 文本框——常驻框既占空间，也诱导"随手一贴就入库"。
  const [addingKey, setAddingKey] = useState(false)
  const [newKeys, setNewKeys] = useState('')
  const [newLabel, setNewLabel] = useState('')
  // 备注编辑是显式动作：点备注进编辑态（该行隐藏停用/删除按钮），点「保存」
  // 才落库，点「取消」或编辑其他行即丢弃草稿——绝不因失焦/误触外部而改库。
  const [editingLabel, setEditingLabel] = useState<string | null>(null)
  const [labelDraft, setLabelDraft] = useState('')
  const [selected, setSelected] = useState<string[]>(configuration?.models ?? [])
  const [paid, setPaid] = useState<string[]>(configuration?.paidModels ?? [])
  const [discovered, setDiscovered] = useState<string[] | undefined>(configuration?.discovered)
  const [manualMode, setManualMode] = useState(false)
  const [manualText, setManualText] = useState((configuration?.models ?? []).join('\n'))
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [removing, setRemoving] = useState(false)
  const live = useRef(true)
  const lock = useRef(false)
  useEffect(() => () => { live.current = false }, [])
  const run = async (action: string, body?: Record<string, unknown>) => {
    if (lock.current) return null
    lock.current = true
    setError(''); setStatus(''); setBusy(action)
    try {
      return await management<Record<string, unknown>>(`/providers/${action}`, body ?? {})
    } catch (reason) { if (live.current) setError(failureMessage(reason)); return null }
    finally { lock.current = false; if (live.current) setBusy('') }
  }
  const runAndRefresh = async (action: string, body?: Record<string, unknown>) => {
    const result = await run(action, body)
    if (result !== null) { setStatus('已保存。'); await onSaved() }
    return result
  }

  // ── 凭据管理：添加表单展开式（密钥 + 备注 + 保存/取消），行内备注/停用/删除 ──
  const parsedNew = keyList(newKeys)
  // 与服务端 maskKey 同规则的客户端指纹（单把添加时备注直接落 keyMeta）。
  const maskOf = (key: string) => key.length <= 14 ? `…${key.slice(-4)}` : `${key.slice(0, 6)}…${key.slice(-4)}`
  const addKeys = async () => {
    if (parsedNew.length === 0 || busy !== '') return
    const meta = parsedNew.length === 1 && newLabel.trim() !== ''
      ? { [maskOf(parsedNew[0])]: { label: newLabel.trim() } } : undefined
    const result = await runAndRefresh('save', { providerId: provider.id, apiKeys: parsedNew, ...(meta ? { keyMeta: meta } : {}) })
    if (result !== null) {
      const next = (result as { configured?: Record<string, Configuration> }).configured?.[provider.id]
      if (next) setKeys(next.keys ?? [])
      setNewKeys(''); setNewLabel(''); setAddingKey(false)
    }
  }
  const cancelAdd = () => { setAddingKey(false); setNewKeys(''); setNewLabel('') }
  const keyOp = async (masked: string, op: 'remove' | 'toggle' | 'label', value?: boolean | string) => {
    if (busy !== '') return
    if (op === 'remove') {
      const entry = keys.find(row => row.masked === masked)
      if (typeof window !== 'undefined' && typeof window.confirm === 'function'
        && !window.confirm(`删除密钥 ${masked}（${entry?.label || '无备注'}）？轮换池将立即少这一把。`)) return
    }
    const result = await runAndRefresh('key', { providerId: provider.id, masked, op, ...(op === 'toggle' ? { disabled: value } : {}), ...(op === 'label' ? { label: value } : {}) })
    if (result !== null) {
      const next = (result as { configured?: Record<string, Configuration> }).configured?.[provider.id]
      if (next) setKeys(next.keys ?? [])
    }
  }
  const startLabel = (row: StoredKey) => {
    if (busy !== '') return
    setEditingLabel(row.masked); setLabelDraft(row.label)
  }
  const saveLabel = async (masked: string) => {
    const result = await runAndRefresh('key', { providerId: provider.id, masked, op: 'label', label: labelDraft })
    if (result !== null) {
      const next = (result as { configured?: Record<string, Configuration> }).configured?.[provider.id]
      if (next) setKeys(next.keys ?? [])
      setEditingLabel(null); setLabelDraft('')
    }
  }

  // ── 模型：填完 key 即可发现（未保存的 key 作为临时凭据，不落盘） ──
  const hasUsableKey = keys.some(row => !row.disabled) || parsedNew.length > 0
  const canDiscover = provider.authKind === 'none' || (hasUsableKey && validBaseUrl(baseUrl))
  const discover = async () => {
    if (!canDiscover || busy !== '') return
    const override = parsedNew.length > 0 ? { apiKeys: parsedNew } : undefined
    const result = await run('discover', { providerId: provider.id, ...(override ?? {}) })
    if (result === null) return
    const models = (result as { models?: string[] | null }).models
    if (Array.isArray(models)) {
      setDiscovered(models)
      setStatus(`发现 ${models.length} 个模型，请勾选要启用的。`)
    } else setStatus('该供应商没有公开模型列表接口，请手动填写模型 ID。')
  }
  const test = async () => {
    if (busy !== '' || !validBaseUrl(baseUrl)) return
    const override = parsedNew.length > 0 ? { apiKeys: parsedNew } : undefined
    const result = await run('test', { providerId: provider.id, ...(override ?? {}) })
    if (result === null) return
    const ok = (result as { ok?: boolean }).ok === true
    setStatus(ok ? '连接测试通过。' : '连接测试未通过，请检查 API 地址、密钥与模型。')
  }
  const modelIds = useMemo(() => [...new Set([
    ...(discovered ?? []),
    ...(provider.models ?? []),
    ...selected,
  ])], [discovered, provider.models, selected])
  const rows = modelIds
    .map(id => ({ id, name: id, paid: paid.includes(id) }))
    .filter(row => `${row.id}`.toLowerCase().includes(search.toLowerCase().trim()))
  const toggle = (id: string) => setSelected(previous => previous.includes(id) ? previous.filter(row => row !== id) : [...previous, id])
  const togglePaid = (id: string) => setPaid(previous => previous.includes(id) ? previous.filter(row => row !== id) : [...previous, id])
  const checkVisible = () => setSelected(previous => [...new Set([...previous, ...rows.map(row => row.id)])])
  const clearVisible = () => setSelected(previous => previous.filter(id => !rows.some(row => row.id === id)))
  const uncheckPaid = () => setSelected(previous => previous.filter(id => !paid.includes(id)))

  const save = async () => {
    if (busy !== '' || lock.current) return
    setError(''); setStatus(''); setBusy('save')
    try {
      const url = new URL(baseUrl.trim())
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('请输入不含用户名和密码的 HTTP(S) API 地址。')
      const models = manualMode ? modelList(manualText) : selected
      const body: Record<string, unknown> = {
        providerId: provider.id, baseUrl: url.toString(), models, paidModels: paid, enabled,
      }
      if (provider.authKind !== 'none' && keys.length === 0 && parsedNew.length === 0) throw new Error('请先添加至少一把 API Key。')
      await management('/providers/save', body)
      if (!live.current) return
      setStatus('渠道配置已保存。'); setNewKeys('')
      await onSaved()
    } catch (reason) { if (live.current) setError(failureMessage(reason)) }
    finally { if (live.current) setBusy('') }
  }
  const remove = async () => {
    if (busy !== '') return
    const result = await runAndRefresh('remove', { providerId: provider.id })
    if (result !== null) onClose()
  }
  const officialUrl = provider.website || provider.credentialUrl || ''
  const keyUrl = provider.credentialUrl || provider.website || ''
  return <WorkbenchDialog title={`${provider.name} · ${configuration ? '渠道配置' : '连接渠道'}`} onClose={onClose} busy={busy !== ''}>
    <form className="wb-form" onSubmit={event => { event.preventDefault(); void save() }}>
      <div className="wb-form-meta">
        <Badge tone="blue">{provider.format}</Badge><Badge>{provider.category}</Badge><span>{provider.authKind}</span>
        {keys.length > 0 && <span>{keys.filter(row => !row.disabled).length}/{keys.length} 把密钥参与轮换</span>}
      </div>
      {provider.notes && <p className="wb-form-notes">{provider.notes}</p>}
      {(officialUrl !== '' || keyUrl !== '') && <div className="wb-form-links">
        {keyUrl !== '' && <a href={keyUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} />申请 Key / 注册</a>}
        {officialUrl !== '' && officialUrl !== keyUrl && <a href={officialUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} />官网</a>}
      </div>}
      <label>API 地址<Input required type="url" value={baseUrl} disabled={busy !== ''} onChange={event => setBaseUrl(event.target.value)} /></label>

      <fieldset className="wb-keys">
        <legend>API Key 轮换池</legend>
        {keys.length === 0 && <p className="wb-keys-empty"><KeyRound size={15} />还没有密钥；在下方粘贴，每行一把。</p>}
        {keys.map((row, index) => {
          const editing = editingLabel === row.masked
          return <div className={`wb-keyrow ${row.disabled ? 'is-disabled' : ''}`} key={row.masked + index}>
            <code title="掩码指纹：足够辨认账号，明文不回传">{row.masked}</code>
            {editing ? <input autoFocus aria-label="编辑备注" value={labelDraft} disabled={busy !== ''}
              placeholder="备注：哪个账号"
              onChange={event => setLabelDraft(event.target.value)}
              onKeyDown={event => { if (event.key === 'Escape') { setEditingLabel(null); setLabelDraft('') } }} />
              : <button type="button" className="wb-keylabel" title="点击编辑备注" disabled={busy !== ''}
                onClick={() => startLabel(row)}>{row.label === '' ? '备注：哪个账号' : row.label}</button>}
            {editing ? <>
              <Button type="button" variant="outline" disabled={busy !== '' || labelDraft.trim() === ''} busy={busy === 'save'}
                onClick={() => { void saveLabel(row.masked) }}>保存</Button>
              <Button type="button" variant="ghost" disabled={busy !== ''} onClick={() => { setEditingLabel(null); setLabelDraft('') }}>取消</Button>
            </>
              : <>
                {row.disabled && <Badge tone="neutral">已停用</Badge>}
                <Switch checked={!row.disabled} disabled={busy !== ''} aria-label={row.disabled ? '启用这把密钥' : '停用这把密钥'}
                  onCheckedChange={value => { void keyOp(row.masked, 'toggle', !value) }} />
                <Button type="button" variant="ghost" size="icon" className="wb-danger" title="删除这把密钥" aria-label="删除这把密钥"
                  disabled={busy !== ''} onClick={() => { void keyOp(row.masked, 'remove') }}><Trash2 size={14} /></Button>
              </>}
          </div>
        })}
        {!addingKey && <Button type="button" variant="outline" disabled={busy !== ''} onClick={() => setAddingKey(true)}>
          <Plus size={14} />添加密钥</Button>}
        {addingKey && <div className="wb-keyadd">
          <textarea autoFocus rows={2} spellCheck={false} autoComplete="off" value={newKeys}
            placeholder="粘贴密钥，每行一把；保存后立即进入轮换池（自动轮换、限流自动换号）"
            disabled={busy !== ''} onChange={event => setNewKeys(event.target.value)} />
          <Input aria-label="密钥备注" placeholder={parsedNew.length === 1 ? '备注：哪个账号（可选）' : '备注仅当一次添加一把时生效'}
            value={newLabel} disabled={busy !== '' || parsedNew.length > 1}
            onChange={event => setNewLabel(event.target.value)} />
          <div className="wb-keyadd-actions">
            <Button type="button" variant="outline" disabled={parsedNew.length === 0 || keys.length + parsedNew.length > 8} busy={busy === 'save'}
              title={keys.length + parsedNew.length > 8 ? '轮换池最多 8 把' : undefined}
              onClick={() => { void addKeys() }}><Save size={14} />保存{parsedNew.length > 0 ? `（${parsedNew.length} 把）` : ''}</Button>
            <Button type="button" variant="ghost" disabled={busy !== ''} onClick={cancelAdd}>取消</Button>
          </div>
          {keys.length + parsedNew.length > 8 && <p className="wb-form-notes">轮换池最多 8 把，当前 {keys.length} 把。</p>}
        </div>}
      </fieldset>

      <fieldset className="wb-models">
        <legend>模型（勾选启用，可标记付费便于批量排除）</legend>
        <div className="wb-models-toolbar">
          <Button type="button" variant="outline" disabled={!canDiscover || busy !== ''} busy={busy === 'discover'}
            title={canDiscover ? '用当前密钥拉取模型列表' : '先填写 API Key 与地址'} onClick={() => { void discover() }}>
            <ListRestart size={15} />发现模型</Button>
          <Button type="button" variant="ghost" disabled={modelIds.length === 0 || busy !== ''} onClick={checkVisible}>全选</Button>
          <Button type="button" variant="ghost" disabled={selected.length === 0 || busy !== ''} onClick={clearVisible}>清空</Button>
          <Button type="button" variant="ghost" disabled={paid.length === 0 || busy !== ''}
            title="取消勾选所有标记为付费的模型" onClick={uncheckPaid}>取消勾选付费</Button>
          <Button type="button" variant="ghost" disabled={busy !== ''}
            onClick={() => setManualMode(value => !value)}>{manualMode ? '返回勾选' : '手动编辑'}</Button>
        </div>
        {manualMode ? <textarea rows={8} spellCheck={false} value={manualText} placeholder="每行一个模型 ID" disabled={busy !== ''}
          onChange={event => setManualText(event.target.value)} />
          : <><label className="wb-models-search"><Search size={14} /><Input aria-label="搜索模型" value={search}
            placeholder="搜索模型 ID" onChange={event => setSearch(event.target.value)} /></label>
            <div className="wb-model-list" role="group" aria-label="模型列表">
              {rows.length === 0 && <p className="wb-keys-empty">{modelIds.length === 0 ? '还没有模型：点「发现模型」拉取，或切「手动编辑」填写。' : '没有匹配的模型'}</p>}
              {rows.map(row => <label className="wb-model-row" key={row.id}>
                <input type="checkbox" checked={selected.includes(row.id)} disabled={busy !== ''} onChange={() => toggle(row.id)} />
                <span className="wb-model-id" title={row.id}>{row.id}</span>
                <button type="button" className={`wb-paid ${row.paid ? 'is-paid' : ''}`} title={row.paid ? '取消付费标记' : '标记为付费模型'}
                  disabled={busy !== ''} onClick={event => { event.preventDefault(); togglePaid(row.id) }}>{row.paid ? '付费' : '标付费'}</button>
              </label>)}
            </div></>}
        {provider.freeModelsHint !== undefined && provider.freeModelsHint !== '' && <p className="wb-form-notes">{provider.freeModelsHint}</p>}
      </fieldset>

      <div className="wb-form-switch"><span>启用渠道</span><Switch checked={enabled} disabled={busy !== ''} aria-label="启用渠道" onCheckedChange={value => setEnabled(value)} /></div>
      {error && <p className="wb-error" role="alert"><CircleAlert size={15} />{error}</p>}
      {status && <p className="wb-status" role="status"><Check size={15} />{status}</p>}
      <div className="wb-form-actions">
        <Button type="button" variant="outline" disabled={busy !== '' || !validBaseUrl(baseUrl) || (!hasUsableKey && provider.authKind !== 'none')}
          busy={busy === 'test'} title="用当前已存（或刚粘贴未保存）的密钥测试" onClick={() => { void test() }}>
          <FlaskConical size={15} />测试连接</Button>
        <Button type="submit" disabled={busy !== ''} busy={busy === 'save'}><Save size={15} />{configuration ? '保存配置' : '保存并连接'}</Button>
      </div>
      {configuration && <div className="wb-remove">
        {removing ? <><span>移除本机渠道配置？密钥池与模型选择一并删除。</span><Button variant="outline" disabled={busy !== ''} onClick={() => setRemoving(false)}>取消</Button><Button variant="outline" className="wb-danger" busy={busy === 'remove'} disabled={busy !== ''} onClick={() => void remove()}><Trash2 size={14} />确认移除</Button></>
          : <Button variant="ghost" className="wb-danger" disabled={busy !== ''} onClick={() => setRemoving(true)}><Trash2 size={14} />移除连接</Button>}
      </div>}
    </form>
  </WorkbenchDialog>
}

export function Providers({ active, host }: { active: boolean; host: Host }) {
  const { data, error, loading, reload } = useManagementResource<Directory>('/providers', active)
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('all')
  const [filter, setFilter] = useState('all')
  const [selected, setSelected] = useState<Provider>()
  const registry = data?.registry ?? []
  const configured = data?.configured ?? {}
  const categories = useMemo(() => [...new Set(registry.map(row => row.category))], [data])
  const totalConnected = registry.filter(row => connected(row, configured[row.id])).length
  const rows = registry.filter(row => {
    const isConnected = connected(row, configured[row.id])
    return `${row.name} ${row.id} ${row.baseUrl} ${row.category} ${row.format}`.toLowerCase().includes(search.toLowerCase().trim())
      && (category === 'all' || row.category === category)
      && (filter === 'all' || (filter === 'connected' ? isConnected : !isConnected))
  })
  // 列表入场：容器进视口后逐项错峰升起（只播一次）
  const reveal = useReveal<HTMLDivElement>(rows.length)
  return <div className="pd-page">
    <header className="wb-heading"><div><span className="wb-eyebrow">PROVIDERS</span><h1>聚合渠道</h1><p>第三方 API 与自有密钥</p></div>
      <Button variant="outline" title="刷新渠道目录" aria-label="刷新渠道目录" disabled={loading || !!selected} busy={loading} onClick={() => void reload()}><RefreshCw size={15} /><span>刷新</span></Button></header>
    <div className="wb-summary"><span><strong>{data ? registry.length : '—'}</strong> 全部渠道</span><span><i className="wb-dot" /><strong>{data ? totalConnected : '—'}</strong> 已连接</span><span><strong>{data ? registry.length - totalConnected : '—'}</strong> 未连接</span></div>
    <div className="wb-toolbar"><label className="wb-search"><Search size={16} /><Input aria-label="搜索聚合渠道" value={search} placeholder="搜索渠道、地址或协议" onChange={event => setSearch(event.target.value)} /></label>
      <select aria-label="渠道分类" value={category} onChange={event => setCategory(event.target.value)}><option value="all">全部分类</option>{categories.map(value => <option key={value} value={value}>{value}</option>)}</select>
      <div className="wb-segments" aria-label="连接状态">{[['all', '全部'], ['connected', '已连接'], ['pending', '未连接']].map(([id, name]) => <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)}>{name}</button>)}</div></div>
    {error && <div className="wb-feedback wb-error" role="alert"><CircleAlert size={16} /><span>{error}</span><Button variant="outline" disabled={loading} onClick={() => void reload()}>重试</Button></div>}
    <div className="wb-list-caption"><span>{rows.length} 个渠道</span><span>协议 / 模型 / 连接状态</span></div>
    <div className="pd-list m-reveal" ref={reveal} aria-busy={loading}>
      {rows.map((provider, index) => {
        const config = configured[provider.id], isConnected = connected(provider, config)
        return <div className="pd-row" key={provider.id} style={{ '--i': String(index) } as React.CSSProperties}>
          <span className={`wb-app-icon ${isConnected ? 'is-green' : ''}`}><ProviderIcon id={provider.id} name={provider.name} /></span>
          <div className="pd-name"><strong>{provider.name}</strong><small title={config?.baseUrl || provider.baseUrl}>{endpoint(config?.baseUrl || provider.baseUrl)}</small></div>
          <div className="pd-protocol"><Badge>{provider.format}</Badge><small>{provider.category}</small></div>
          <span className="pd-model-count">{config?.models?.length ?? provider.modelCount ?? '未知'} <small>模型</small></span>
          {config?.keys !== undefined && config.keys.length > 1 && <span className="pd-key-count" title="参与轮换的密钥">{config.keys.filter(row => !row.disabled).length} 把密钥</span>}
          <Badge tone={isConnected ? 'success' : 'neutral'} dot={isConnected}>{isConnected ? '已连接' : '未连接'}</Badge>
          <Button variant="outline" onClick={() => ['oauth', 'adc'].includes(provider.authKind) ? host.navigate('agents') : setSelected(provider)}>{isConnected || config ? <Settings2 size={14} /> : <ArrowRight size={14} />}{['oauth', 'adc'].includes(provider.authKind) ? '导入订阅' : isConnected || config ? '配置' : '连接'}</Button>
        </div>
      })}
      {!data && loading && <div className="wb-empty" role="status"><RefreshCw size={22} /><strong>正在读取渠道目录</strong></div>}
      {data && rows.length === 0 && <div className="wb-empty"><Search size={24} /><strong>{registry.length ? '没有匹配的渠道' : '渠道目录为空'}</strong>
        {registry.length > 0 && <Button variant="outline" onClick={() => { setSearch(''); setCategory('all'); setFilter('all') }}>清除筛选</Button>}</div>}
    </div>
    {selected && active && <ProviderEditor key={selected.id} provider={selected} configuration={configured[selected.id]} onClose={() => setSelected(undefined)} onSaved={async () => { await Promise.all([reload(), host.refresh()]) }} />}
  </div>
}
