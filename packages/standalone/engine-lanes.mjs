/** 引擎车道（magpie）凭据管理。
 *
 * 2026-11-21 用户要求「设计一个 UI 入口设置引擎车道 key，而不是必须内置
 * 环境变量」。引擎（Go 二进制）只在 spawn 时读一次环境变量（models.json 的
 * `env` 字段声明每个车道需要哪个变量，如 amd → AMD_API_KEY），运行中改 env
 * 无效——所以多 key 池在 OFM 侧管理，激活 key 由 OFM 在 spawn 前注入，
 * 换 key 通过「重启引擎」生效（management 的 /engine-lanes/restart）。
 *
 * 与聚合渠道（providers.mjs）同构的安全约定：明文密钥永不回传前端，公开
 * 视图只含掩码 + 备注 + 停用标记。
 */
import fs from 'node:fs'
import path from 'node:path'
import { maskKey } from '../../src/aggregate.js'

/** 引擎自己的目录快照（缓存）：laneId → { name, env, api, models }。 */
function laneCatalog(dataDir) {
  const file = path.join(dataDir, 'magpie', 'cache', 'magpie', 'models.json')
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const lanes = new Map()
    for (const row of Object.values(raw ?? {})) {
      if (!row || typeof row !== 'object' || !Array.isArray(row.env) || row.env.length !== 1) continue
      if (typeof row.id !== 'string' || row.id === '') continue
      lanes.set(row.id, {
        id: row.id, name: typeof row.name === 'string' ? row.name : row.id,
        env: row.env[0], api: typeof row.api === 'string' ? row.api : '',
        models: row.models && typeof row.models === 'object' ? Object.keys(row.models).length : 0,
      })
    }
    return lanes
  } catch {
    // 引擎没跑过（无快照）或快照损坏：车道目录为空，只回已配置的车道。
    return new Map()
  }
}

/** 池内的激活 key：优先用户点选的激活项（且未停用），否则第一把可用 key。 */
function pickActiveKey(pool) {
  const raw = Array.isArray(pool?.apiKeys) ? pool.apiKeys : []
  const meta = pool?.keyMeta && typeof pool.keyMeta === 'object' ? pool.keyMeta : {}
  const usable = []
  for (const key of raw) {
    if (typeof key !== 'string' || key === '' || key.length > 8192) continue
    const entry = meta[maskKey(key)]
    if (entry && entry.disabled === true) continue
    usable.push(key)
  }
  if (usable.length === 0) return null
  const active = pool.activeMasked
  if (typeof active === 'string' && active !== '') {
    const hit = usable.find(key => maskKey(key) === active)
    if (hit) return hit
  }
  return usable[0]
}

/** spawn 前注入的 env：{ ENV_NAME: key }。lane→env 名来自引擎目录快照。 */
export function engineLaneEnvFromSettings(settings, dataDir) {
  const pools = settings?.engineLanes
  if (!pools || typeof pools !== 'object') return {}
  const catalog = laneCatalog(dataDir)
  const env = {}
  for (const [laneId, pool] of Object.entries(pools)) {
    const lane = catalog.get(laneId)
    if (!lane) continue
    const key = pickActiveKey(pool)
    if (key) env[lane.env] = key
  }
  return env
}

export function createEngineLaneManagement({ stores, persist, dataDir, magpieEngine, magpieModels, onEngineStarted, servedLanes } = {}) {
  if (!stores || typeof persist !== 'function') throw new TypeError('engine-lanes: stores 与 persist 必须提供')

  const poolsOf = () => {
    const value = stores.settings.get().engineLanes
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  }
  const writePool = (laneId, patch) => {
    const pools = { ...poolsOf() }
    const previous = pools[laneId] && typeof pools[laneId] === 'object' ? pools[laneId] : {}
    pools[laneId] = { ...previous, ...patch }
    persist({ engineLanes: pools })
    return pools[laneId]
  }

  /** 公开视图：车道目录（引擎快照里单 env 的车道）∪ 已配置的车道；明文不回传。
   *  served = 引擎正在实际服务的车道（从引擎实时清单反推），清单页/配置过密钥
   *  的车道在 UI 里成行，其余 300+ 车道走搜索选择器，不整列平铺。 */
  function list() {
    const catalog = laneCatalog(dataDir)
    const pools = poolsOf()
    let served = null
    try {
      const value = typeof servedLanes === 'function' ? servedLanes() : null
      if (value instanceof Set) served = value
    } catch { /* 引擎未启动时无实时清单 */ }
    const ids = [...new Set([...catalog.keys(), ...Object.keys(pools)])]
    const lanes = ids.map(id => {
      const lane = catalog.get(id)
      const pool = pools[id] && typeof pools[id] === 'object' ? pools[id] : {}
      const raw = Array.isArray(pool.apiKeys) ? pool.apiKeys : []
      const meta = pool.keyMeta && typeof pool.keyMeta === 'object' ? pool.keyMeta : {}
      const seen = new Set()
      const keys = []
      for (const key of raw) {
        if (typeof key !== 'string' || key === '' || key.length > 8192 || seen.has(key)) continue
        seen.add(key)
        const entry = meta[maskKey(key)]
        keys.push({ masked: maskKey(key), label: entry?.label ?? '', disabled: entry?.disabled === true })
      }
      const activeKey = pickActiveKey(pool)
      return {
        id, name: lane?.name ?? id, env: lane?.env ?? null, api: lane?.api ?? '',
        models: lane?.models ?? 0, inCatalog: catalog.has(id), served: served?.has(id) === true,
        hasKey: keys.length > 0, keyCount: keys.length,
        active: activeKey ? maskKey(activeKey) : null,
        keys,
      }
    })
    // 在用的车道排最前，其余按名称。
    lanes.sort((a, b) => (Number(b.served) - Number(a.served))
      || (Number(b.hasKey) - Number(a.hasKey))
      || a.name.localeCompare(b.name, 'zh-Hans-CN'))
    return { lanes }
  }

  /** 保存（合并语义，与聚合渠道一致）：新 key 并入池，可带 keyMeta。 */
  function save({ laneId, apiKeys, keyMeta } = {}) {
    if (typeof laneId !== 'string' || laneId === '' || laneId.length > 64) throw new Error('laneId 无效')
    const pool = { ...poolsOf()[laneId] }
    if (pool.apiKeys === undefined) pool.apiKeys = []
    if (Array.isArray(apiKeys)) {
      const merged = [...(Array.isArray(pool.apiKeys) ? pool.apiKeys : [])]
      for (const key of apiKeys) {
        if (typeof key !== 'string') continue
        const clean = key.trim()
        if (clean === '' || clean.length > 8192 || merged.includes(clean)) continue
        merged.push(clean)
      }
      // 池上限与聚合渠道一致：8 把。
      pool.apiKeys = merged.slice(-8)
      // 首把 key 自动成为激活项。
      if (pool.activeMasked === undefined && pool.apiKeys.length > 0) {
        pool.activeMasked = maskKey(pool.apiKeys[0])
      }
    }
    if (keyMeta && typeof keyMeta === 'object' && !Array.isArray(keyMeta)) {
      pool.keyMeta = { ...(pool.keyMeta && typeof pool.keyMeta === 'object' ? pool.keyMeta : {}), ...keyMeta }
    }
    writePool(laneId, pool)
    return list()
  }

  /** 单 key 操作：remove（移出池）/ toggle（停用）/ label（备注）/ activate（设为激活）。 */
  function key({ laneId, masked, op, label, disabled, activate } = {}) {
    if (typeof laneId !== 'string' || laneId === '' || typeof masked !== 'string' || masked === '') {
      throw new Error('laneId 与 masked 必须提供')
    }
    const pools = { ...poolsOf() }
    const pool = { ...(pools[laneId] && typeof pools[laneId] === 'object' ? pools[laneId] : {}) }
    const keys = Array.isArray(pool.apiKeys) ? [...pool.apiKeys] : []
    const meta = { ...(pool.keyMeta && typeof pool.keyMeta === 'object' ? pool.keyMeta : {}) }
    const target = keys.find(key => maskKey(key) === masked)
    if (target === undefined) throw new Error('未找到该掩码对应的密钥')
    // ⚠️ 只有 remove 动池；label/toggle/activate 只改元数据（聚合渠道踩过的坑）。
    if (op === 'remove') {
      pool.apiKeys = keys.filter(key => key !== target)
      if (pool.activeMasked === masked) pool.activeMasked = null
      delete meta[masked]
    } else if (op === 'toggle') {
      meta[masked] = { ...meta[masked], disabled: disabled === undefined ? !(meta[masked]?.disabled === true) : disabled === true }
      if (meta[masked].disabled === true && pool.activeMasked === masked) pool.activeMasked = null
    } else if (op === 'label') {
      meta[masked] = { ...meta[masked], label: String(label ?? '').slice(0, 60) }
    } else if (op === 'activate') {
      if (meta[masked]?.disabled === true) throw new Error('已停用的密钥不能设为激活')
      pool.activeMasked = masked
    } else throw new Error(`未知的密钥操作：${op}`)
    pool.keyMeta = meta
    writePool(laneId, pool)
    return list()
  }

  /** 换 key 生效 = 重启引擎（引擎只在 spawn 时读 env）；重启后刷新清单。 */
  async function restart() {
    if (!magpieEngine) throw new Error('模型工作台不可用')
    await magpieEngine.stop()
    const status = await magpieEngine.start()
    await magpieModels?.refresh().catch(() => {})
    onEngineStarted?.()
    return status
  }

  return { list, save, key, restart }
}
