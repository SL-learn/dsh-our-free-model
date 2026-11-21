import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual'
import { Boxes, Check, CircleAlert, CircleCheck, Copy, Eye, EyeOff, LoaderCircle, Play, RefreshCw, Search, SlidersHorizontal, Square, X } from 'lucide-react'
import { providers } from 'ofm-provider-list'
import { Badge, Button, Input } from './components/ui'
import { filterModels, modelStateView, stateOptions } from './models-data.mjs'
import { visibilityCopy } from './visibility-data.mjs'
import type { Host, Model, ModelTestResult, ServiceSettings, Summary } from './types'
import './models.css'

// 手动测试失败的归因展示名（与服务端 classifyModelFailure 的取值对齐；
// 放前端本地是因为 src/model-test.js 依赖 node 侧模块，不能进浏览器包）。
const failureKindNames: Record<string, string> = {
  'model-error': '模型异常', quota: '额度不足', 'rate-limit': '限流中',
  region: '地区受限', auth: '鉴权失败', transport: '网络异常',
}
const sourceNames: Record<string, string> = { anonymous: '匿名模型', kilo: 'Kilo 免费池', eac: 'EAC 协付' }
const channelName = (id: string) => sourceNames[id]
  ?? providers.find(provider => provider.id === id)?.name ?? id
const number = (value: number) => new Intl.NumberFormat('zh-CN').format(value)
const capacity = (value?: number) => value && Number.isFinite(value) && value > 0
  ? value >= 1000 ? `${Number((value / 1000).toFixed(1))}K` : number(value) : '未知'
const initialFilters = { search: '', channel: 'all', capability: 'all', availability: 'all', access: 'all' }
type Operation = 'refresh' | 'probe' | 'test'
type TestState = { model: Model; state: 'pending' | 'success' | 'error' | 'cancelled'; result?: ModelTestResult; error?: string; kind?: string }

export function Models({ summary, host, active }: { summary: Summary; host: Host; active: boolean }) {
  const visibility = visibilityCopy(document.documentElement.lang)
  const [filters, setFilters] = useState(initialFilters)
  const [operation, setOperation] = useState<Operation>()
  const [test, setTest] = useState<TestState>()
  // 测试等待秒表（2026-11-21「卡死」反馈）：每秒跳动的数字证明页面活着——
  // 数字在走、图标静止才是动画问题；数字也卡死则是渲染进程被挂起。
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (operation !== 'test') { setElapsed(0); return undefined }
    const started = Date.now()
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [operation])
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState<string>()
  const [focusedId, setFocusedId] = useState<string>()
  const [visibilitySaving, setVisibilitySaving] = useState(false)
  const visibilityPending = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pending = useRef<AbortController | undefined>(undefined)
  const activeRef = useRef(active)
  activeRef.current = active
  const models = useMemo<Model[]>(() => filterModels(summary.catalog, filters), [summary.catalog, filters])
  const channels = useMemo(() => [...new Set(['anonymous', 'kilo', 'eac', ...summary.catalog.map(model => model.channel), filters.channel])]
    .filter(id => id !== 'all'), [summary.catalog, filters.channel])
  const focusedIndex = focusedId ? models.findIndex(model => model.id === focusedId) : -1
  const rangeExtractor = useCallback((range: Range) => {
    const visible = defaultRangeExtractor(range)
    return focusedIndex >= 0 ? [...new Set([...visible, focusedIndex])].sort((a, b) => a - b) : visible
  }, [focusedIndex])
  const virtual = useVirtualizer({
    count: models.length, getScrollElement: () => scrollRef.current,
    estimateSize: () => 112, overscan: 5, enabled: active,
    getItemKey: index => models[index].id, rangeExtractor,
  })
  const changeFilters = (patch: Partial<typeof initialFilters>) => {
    // 使用原生滚动归零，避免动态测量时平滑滚动的目标高度变化。
    if (scrollRef.current) scrollRef.current.scrollTop = 0
    setFilters(previous => ({ ...previous, ...patch }))
    setFocusedId(undefined)
  }
  useEffect(() => {
    if (!active) {
      pending.current?.abort()
      pending.current = undefined
      setOperation(undefined)
      setTest(previous => previous?.state === 'pending' ? { ...previous, state: 'cancelled' } : previous)
    }
    return () => { pending.current?.abort(); pending.current = undefined }
  }, [active])
  useEffect(() => {
    if (active && scrollRef.current) {
      const max = Math.max(0, virtual.getTotalSize() - scrollRef.current.clientHeight)
      if (scrollRef.current.scrollTop > max) scrollRef.current.scrollTop = max
    }
  }, [models.length, active, virtual])

  const run = async (kind: Operation, model?: Model) => {
    if (pending.current || !activeRef.current) return
    const controller = new AbortController()
    pending.current = controller
    setOperation(kind); setError(''); setMessage('')
    if (model) setTest({ model, state: 'pending' })
    const isCurrent = () => pending.current === controller && !controller.signal.aborted && activeRef.current
    try {
      if (kind === 'test' && model) {
        const result = await host.testModel(model.id, controller.signal)
        if (!isCurrent()) return
        setTest({ model, state: 'success', result })
        try {
          await host.refresh()
        } catch (reason) {
          if (!isCurrent()) return
          const detail = reason instanceof Error ? reason.name === 'TimeoutError' ? '请求超时，请重试。' : reason.message : '请求失败，请重试。'
          setError(`模型测试已成功，但刷新摘要失败：${detail}`)
        }
      } else {
        await host.refreshModels(kind === 'probe', controller.signal)
        if (!isCurrent()) return
        setMessage(kind === 'probe' ? '可用性探测已完成' : '模型清单已更新')
      }
    } catch (reason) {
      if (!isCurrent()) return
      const detail = reason instanceof Error ? reason.name === 'TimeoutError' ? '请求超时，请重试。' : reason.message : '操作失败，请重试。'
      if (kind === 'test' && model) setTest({ model, state: 'error', error: detail, kind: (reason as { failureKind?: string })?.failureKind })
      else setError(detail)
    } finally {
      if (isCurrent()) { pending.current = undefined; setOperation(undefined) }
    }
  }

  const cancel = () => {
    pending.current?.abort()
    pending.current = undefined
    setOperation(undefined)
    setTest(previous => previous ? { ...previous, state: 'cancelled' } : previous)
  }

  const copyModelId = (model: Model) => {
    void host.copy(model.id).then(() => {
      if (activeRef.current) {
        setCopied(model.id)
        setTimeout(() => { if (activeRef.current) setCopied(undefined) }, 1800)
      }
    }).catch(host.error)
  }

  // 一键隐藏实测/调用不可用的模型（写入 hiddenModelIds，可随时在列表里恢复）。
  // 范围收紧（2026-11-21 用户要求「避免误管」）：只有「探测不可用 / 地区受限 /
  // 实测确认模型异常」才进批量隐藏；额度不足、限流、鉴权、网络异常都是环境
  // 问题——模型本体可能完好，混进来就是误杀。它们的归因存在 failureKind。
  const probeBroken = summary.catalog.filter(model =>
    (model.availability === 'unavailable' || model.availability === 'region-blocked') && model.hiddenByUser !== true)
  const testBroken = summary.catalog.filter(model =>
    model.availabilitySource === 'manual' && model.failureKind === 'model-error' && model.hiddenByUser !== true)
  const envLimited = summary.catalog.filter(model =>
    model.availabilitySource === 'manual' && model.failureKind !== undefined && model.failureKind !== 'model-error'
    && model.availability !== 'throttled' && model.hiddenByUser !== true)
  const unusable = [...probeBroken, ...testBroken]
  const hideUnusable = () => {
    if (unusable.length === 0) return
    const scope = unusable.length === 1 ? unusable[0].name : `${unusable.length} 个模型`
    const breakdown = [
      probeBroken.length > 0 && `探测不可用 ${probeBroken.length} 个`,
      testBroken.length > 0 && `实测确认模型异常 ${testBroken.length} 个`,
    ].filter(Boolean).join('、')
    const suffix = envLimited.length > 0
      ? `\n\n另有 ${envLimited.length} 个模型属额度不足/鉴权/网络异常等环境问题，不会包含——它们不代表模型损坏。`
      : '\n\n额度不足、限流、网络异常等环境问题不会包含——它们不代表模型损坏。'
    if (typeof window !== 'undefined' && !window.confirm(
      `隐藏 ${scope}？${breakdown ? `（${breakdown}）` : ''}\n它们将被排除出推理路由（清单里仍可见，随时可单独恢复）。${suffix}`)) return
    void saveVisibility({ hiddenModelIds: [...new Set([...(summary.settings.hiddenModelIds ?? []), ...unusable.map(model => model.id)])] })
  }

  const saveVisibility = async (patch: Partial<ServiceSettings>) => {
    if (visibilityPending.current || !activeRef.current) return
    visibilityPending.current = true
    setVisibilitySaving(true); setError(''); setMessage('')
    try {
      await host.saveSettings(patch)
      if (activeRef.current) setMessage(visibility.saved)
      try { await host.refresh() } catch (reason) { if (activeRef.current) host.error(reason as Error) }
    } catch (reason) {
      if (activeRef.current) setError(reason instanceof Error ? reason.message : '保存失败，请重试。')
    } finally {
      visibilityPending.current = false
      setVisibilitySaving(false)
    }
  }

  if (!active) return null
  const filtered = Object.entries(filters).some(([key, value]) => value !== initialFilters[key as keyof typeof initialFilters])
  const routable = summary.catalog.filter(model => model.routable).length
  return <div className="model-browser" data-testid="models-ready">
    <header className="dashboard-heading">
      <div><div className="heading-eyebrow">WORKSPACE / MODELS</div><h1>模型清单</h1>
        <p>{number(summary.catalog.length)} 个模型 · {number(routable)} 个可接入</p></div>
      <div className="actions">
        <Button variant="outline" disabled={!!operation} onClick={() => { void run('refresh') }}>
          <RefreshCw size={15} className={operation === 'refresh' ? 'spinning' : ''} />{operation === 'refresh' ? '正在刷新' : '刷新清单'}
        </Button>
        <Button disabled={!!operation || !summary.settings.enabled} title="会向上游发送少量推理请求"
          onClick={() => { void run('probe') }}>
          {operation === 'probe' ? <LoaderCircle size={15} className="spinning" /> : <CircleCheck size={15} />}
          {operation === 'probe' ? '正在探测' : '探测可用性'}
        </Button>
        <Button variant="outline" disabled={visibilitySaving || unusable.length === 0}
          title="把探测不可用与实测确认异常的模型排除出推理路由；额度不足、限流、网络异常等环境问题不计入，可随时单独恢复"
          onClick={hideUnusable}>
          {visibilitySaving ? <LoaderCircle size={15} className="spinning" /> : <EyeOff size={15} />}
          隐藏不可用{unusable.length > 0 && `（${number(unusable.length)}）`}
        </Button>
      </div>
    </header>
    <div className="model-summary">
      <span><span className={`status-dot ${summary.settings.enabled ? '' : 'paused'}`} />{summary.settings.enabled ? '推理已启用' : '推理已暂停'}</span>
      <span>清单更新：{summary.catalogSyncedAt ? new Date(summary.catalogSyncedAt).toLocaleString('zh-CN', { hour12: false }) : '尚未刷新'}</span>
      <span>主动探测和测试会产生推理请求</span>
    </div>
    {error && <div className="channel-error" role="alert"><CircleAlert size={16} /><span>{error}</span>
      <Button variant="ghost" aria-label="关闭错误提示" title="关闭错误提示" onClick={() => setError('')}><X size={15} /></Button></div>}
    {message && <p className="model-feedback" role="status"><Check size={15} />{message}</p>}
    <div className="model-filters">
      <div className="model-search"><Search size={16} /><Input type="search" aria-label="搜索模型" placeholder="搜索模型名称或 ID…"
        value={filters.search} onChange={event => changeFilters({ search: event.target.value })} /></div>
      <select aria-label="筛选渠道" value={filters.channel} onChange={event => changeFilters({ channel: event.target.value })}>
        <option value="all">全部渠道</option>{channels.map(id => <option value={id} key={id}>{channelName(id)}</option>)}
      </select>
      <select aria-label="筛选模型能力" value={filters.capability} onChange={event => changeFilters({ capability: event.target.value })}>
        <option value="all">全部能力</option><option value="text">纯文本</option><option value="vision">支持视觉</option><option value="reasoning">支持思考</option>
      </select>
      <select aria-label="筛选可用状态" value={filters.availability} onChange={event => changeFilters({ availability: event.target.value })}>
        <option value="all">全部状态</option>{stateOptions.map(([id, name]) => <option value={id} key={id}>{name}</option>)}
      </select>
    </div>
    <div className="model-list-toolbar">
      <div className="channel-filters" role="group" aria-label="筛选公开范围">
        {([['all', '全部模型'], ['routable', '可接入'], ['hidden', '未公开']] as const).map(([id, name]) =>
          <button key={id} aria-pressed={filters.access === id} onClick={() => changeFilters({ access: id })}>{name}</button>)}
      </div>
      <span role="status" data-testid="model-result-count">{number(models.length)} / {number(summary.catalog.length)} 个模型</span>
      {filtered && <Button variant="ghost" onClick={() => changeFilters(initialFilters)}><X size={14} />清空筛选</Button>}
    </div>
    <div className="model-list-toolbar">
      <label><input type="checkbox" role="switch" checked={summary.settings.hideFreeModels === true}
        disabled={visibilitySaving} onChange={event => { void saveVisibility({ hideFreeModels: event.target.checked }) }} /> {visibility.hideFree}</label>
      <label><input type="checkbox" role="switch" checked={summary.settings.hideEacModels === true}
        disabled={visibilitySaving} onChange={event => { void saveVisibility({ hideEacModels: event.target.checked }) }} /> {visibility.hideEac}</label>
    </div>
    {test && <section className={`model-test-result model-test-${test.state}`} aria-label="模型测试结果" aria-live="polite">
      <div className="model-test-heading"><div><strong>
        {test.state === 'pending' ? '正在测试' : test.state === 'success' ? '测试完成' : test.state === 'cancelled' ? '测试已取消' : '测试失败'}
      </strong><span>{test.model.name}{test.result && ` · ${number(test.result.latencyMs)} ms`}{test.state === 'pending' && elapsed > 0 && ` · 已等待 ${elapsed} 秒`}</span></div>
        {test.state === 'pending' ? <Button variant="outline" onClick={cancel}><Square size={14} />取消测试</Button>
          : <Button variant="ghost" aria-label="关闭测试结果" title="关闭测试结果" onClick={() => setTest(undefined)}><X size={15} /></Button>}
      </div>
      {test.state === 'pending' && elapsed >= 30 && <p className="model-test-hint" role="status">测试是 16 token 的最小请求，通常几十秒内返回；长时间无响应多半是上游挂起，可取消后重试（服务端会在 120–150 秒自动中止）。</p>}
      {test.state === 'success' && <><pre>{test.result?.text}</pre>{test.result?.persisted === false && <p role="status">测试已成功，但结果未能保存；请检查数据目录权限或重新测试。</p>}</>}
      {test.state === 'error' && <p>{test.error}
        {test.kind && test.kind !== 'model-error' && <span className="model-test-hint">
          （归因：{failureKindNames[test.kind] ?? test.kind}）这是环境/账号问题，不代表模型损坏；不会计入「隐藏不可用」。</span>}
        {test.kind === 'model-error' && <span className="model-test-hint">（归因：模型异常）模型疑似真断，可计入「隐藏不可用」。</span>}
      </p>}
    </section>}
    {models.length ? <div className="model-table" role="table" aria-label="模型清单" aria-rowcount={models.length + 1} aria-colcount={5}>
      <div className="model-table-header" role="row"><span role="columnheader">模型 / ID</span><span role="columnheader">渠道与能力</span>
        <span role="columnheader">上下文 / 输出</span><span role="columnheader">可用状态</span><span role="columnheader">操作</span></div>
      <div className="model-table-body">
      <div ref={scrollRef} className="model-scroll" role="rowgroup" tabIndex={0} aria-label="滚动模型列表" onKeyDown={event => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault()
          virtual.scrollToIndex(event.key === 'Home' ? 0 : models.length - 1, { align: event.key === 'Home' ? 'start' : 'end' })
        }
      }}>
        <div className="model-virtual-content" style={{ height: virtual.getTotalSize() }}>
          {virtual.getVirtualItems().map(item => {
            const model = models[item.index]
            // 徽章文案/颜色/筛选三处共用 models-data.mjs 的 modelStateView（2026-11-21 重构）。
            const view = modelStateView(model)
            const state = view.state
            const envFailure = ['quota', 'auth', 'transport'].includes(state)
            const disabledReason = !summary.settings.enabled ? '推理服务已暂停' : !model.routable && !model.hiddenByUser ? '模型尚未公开，请检查渠道账号或模型设置' : operation ? '请等待当前操作完成' : ''
            return <div role="row" aria-rowindex={item.index + 2} key={item.key} data-index={item.index} data-model-id={model.id}
              data-hidden={model.hiddenByUser === true || undefined}
              className="model-table-row" ref={virtual.measureElement} style={{ transform: `translateY(${item.start}px)` }}
              onFocusCapture={() => setFocusedId(model.id)} onBlurCapture={event => {
                if (!event.currentTarget.contains(event.relatedTarget)) setFocusedId(undefined)
              }}>
              <div role="cell" className="model-identity"><strong>{model.name}</strong><code>{model.id}</code></div>
              <div role="cell" className="model-source"><span>{channelName(model.channel)}</span><div className="model-capabilities">
                <Badge>{model.vision ? '视觉' : '纯文本'}</Badge>{model.reasoning && <Badge tone="blue">思考</Badge>}</div></div>
              <div role="cell" className="model-limits"><span title={model.contextWindow ? `${model.contextWindow} Token` : undefined}>{capacity(model.contextWindow)} <small>上下文</small></span>
                <span title={model.maxOutput ? `${model.maxOutput} Token` : undefined}>{capacity(model.maxOutput)} <small>输出</small></span></div>
              <div role="cell" className="model-state"><Badge tone={view.tone}>
                {view.label}</Badge>
                {(model.availabilitySource === 'manual' || model.availabilitySource === 'usage') && state !== 'available' && model.detail && <small title={model.detail}
                  style={{ maxWidth: '100%', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{model.detail}</small>}
                {envFailure && <small>环境问题，不代表模型损坏</small>}
                {!model.routable && <small>{model.hiddenByUser ? visibility.hidden : '未公开'}</small>}
                {model.ttftMs != null && <small>首响应 {number(model.ttftMs)} ms</small>}</div>
              <div role="cell" className="model-row-actions">
                {/* 隐藏/复制收进同一个带边框的迷你分段组：与「测试」按钮一致的
                    视觉层级（2026-11-21 用户反馈裸图标样式不合理）。隐藏开关只对
                    公开车道模型有意义（hiddenModelIds 不作用于渠道模型），复制恒可用。 */}
                <div className="model-row-mini">
                  {['anonymous', 'kilo', 'eac', 'aggregate', 'combo'].includes(model.channel) && <Button variant="ghost"
                    disabled={visibilitySaving || model.hiddenByGroup === true}
                    title={model.hiddenByGroup ? visibility.groupHidden : model.hiddenByUser ? visibility.show : visibility.hide}
                    aria-label={`${model.hiddenByUser ? visibility.show : visibility.hide}：${model.id}`}
                    onClick={() => { const ids = summary.settings.hiddenModelIds ?? []; void saveVisibility({
                      hiddenModelIds: ids.includes(model.id) ? ids.filter(id => id !== model.id) : [...ids, model.id],
                    }) }}>
                    {/* 图标表达**当前状态**而非动作（2026-11-21 用户反馈分不清）：
                        已隐藏 = 琥珀色斜眼 + 整行压暗；可见 = 睁眼。 */}
                    {model.hiddenByUser ? <EyeOff size={15} className="md-eye-off-hidden" /> : <Eye size={15} className="md-eye-on-visible" />}
                  </Button>}
                  <Button variant="ghost" title={`复制 ${model.id}`} aria-label={`复制模型 ID：${model.id}`} onClick={() => copyModelId(model)}
                    className={copied === model.id ? 'md-copy-done' : ''}>
                    {copied === model.id ? <Check size={15} /> : <Copy size={15} />}
                  </Button>
                </div>
                <Button variant="outline" disabled={!!disabledReason} title={disabledReason || `测试 ${model.name}，会产生推理请求`}
                  aria-label={`测试模型：${model.id}`} onClick={() => { void run('test', model) }}
                  className={operation === 'test' && test?.model.id === model.id ? 'md-testing' : ''}>
                  {operation === 'test' && test?.model.id === model.id ? <LoaderCircle size={14} className="spinning" /> : <Play size={14} />}测试
                </Button>
              </div>
            </div>
          })}
        </div>
      </div>
      </div>
    </div> : <div className="model-empty"><Boxes size={28} /><h2>{summary.catalog.length ? '没有匹配的模型' : '模型清单为空'}</h2>
      <p>{summary.catalog.length ? '调整搜索条件或清空筛选。' : '刷新清单后重试，或检查渠道连接。'}</p>
      {filtered && <Button variant="outline" onClick={() => changeFilters(initialFilters)}><SlidersHorizontal size={15} />清空筛选</Button>}
    </div>}
    <p className="footnote">清单收录不代表实时可用。Kilo 免费池可能记录提示词，请勿发送敏感内容。</p>
  </div>
}
