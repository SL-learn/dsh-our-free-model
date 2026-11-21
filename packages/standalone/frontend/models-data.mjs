/** 筛选只影响当前视图，不改变模型开关或服务端目录。 */

/**
 * 统一的展示状态视图（2026-11-21 重构）：徽章文案、颜色、筛选共用这一份，
 * 保证「清单页看到的」和「筛选选中的」永远是同一套语义。
 *
 * 状态体系（与归因打通）；「未探测」= 无任何测量，渠道清单收录但从未测过
 * 的模型同样算未探测（与 ofm-shared-client 的语义一致）——否则渠道模型
 * 无测量时会挤进一个与「未探测」重叠的「清单已收录」态，让筛选出现空档：
 * - available   可用（探测 / 实测 / 调用成功）        绿
 * - unknown     未探测（无任何测量）                  灰
 * - unavailable 不可用（探测 / 连续调用失败）          红
 * - throttled   限流中（探测 / 手测 / 调用限流）      橙
 * - region-blocked 地区受限                           橙
 * - test-failed 实测失败·模型异常                     红（可批量隐藏）
 * - retired     已退役（上游下架）                    红（可批量隐藏）
 * - slow        响应超慢（长时间无响应）              橙（可批量隐藏）
 * - quota       额度不足（环境问题）                  蓝
 * - auth        鉴权失败（环境问题）                  蓝
 * - transport   网络异常（未定性）                    蓝
 */
export function modelStateView(model) {
  const source = model.availabilitySource
  // listing 来源没有任何真实测量：一律按「未探测」展示（渠道清单收录但从未
  // 测过的模型算未探测，与 ofm-shared-client 的语义一致）；旧摘要残留的
  // available 等也不能冒充测量成功（见 standalone-model-row-test 的防回归）。
  const state = source === 'listing' ? 'unknown' : (model.availability ?? 'unknown')
  if (source === 'manual' && state === 'unknown') {
    const kind = model.failureKind ?? 'model-error'
    if (kind === 'quota') return { state: 'quota', label: '额度不足', tone: 'blue' }
    if (kind === 'auth') return { state: 'auth', label: '鉴权失败', tone: 'blue' }
    if (kind === 'transport') return { state: 'transport', label: '网络异常', tone: 'blue' }
    if (kind === 'slow') return { state: 'slow', label: '响应超慢', tone: 'warning' }
    if (kind === 'retired') return { state: 'retired', label: '已退役', tone: 'danger' }
    return { state: 'test-failed', label: '实测失败', tone: 'danger' }
  }
  if (source === 'manual' && state === 'available') return { state: 'available', label: '实测可用', tone: 'success' }
  if (source === 'usage' && state === 'available') return { state: 'available', label: '调用可用', tone: 'success' }
  if (source === 'usage' && state === 'unavailable') {
    // 调用沉淀也能确认退役（2026-11-21 体检）：上游宣告 end-of-life 的调用
    // 失败单次即终态，展示与批量隐藏都走「已退役」，不再笼统算连续失败。
    if (model.failureKind === 'retired') return { state: 'retired', label: '已退役（调用）', tone: 'danger' }
    return { state: 'unavailable', label: '连续调用失败', tone: 'danger' }
  }
  const names = {
    available: '已探测可用', unknown: '未探测',
    unavailable: '不可用', throttled: '限流中', 'region-blocked': '地区受限',
  }
  const tones = {
    available: 'success', unknown: 'neutral',
    unavailable: 'danger', throttled: 'warning', 'region-blocked': 'warning',
  }
  return { state, label: names[state] ?? '未知状态', tone: tones[state] ?? 'neutral' }
}

/** 「可用状态」下拉的选项（全部状态 + 归因并入后的各态）。 */
export const stateOptions = [
  ['available', '可用（探测 / 实测 / 调用）'],
  ['unknown', '未探测'],
  ['unavailable', '不可用'],
  ['throttled', '限流中'],
  ['region-blocked', '地区受限'],
  ['test-failed', '实测失败（模型异常）'],
  ['retired', '已退役（上游下架）'],
  ['slow', '响应超慢（长时间无响应）'],
  ['quota', '额度不足'],
  ['auth', '鉴权失败'],
  ['transport', '网络异常'],
]

// ── 来源类别（2026-11-21 用户要求"自己的 Key/账号与公共池在清单里能分清"）──
// 四类：我的 Key（聚合渠道/扩展，用户自有 API Key）、我的账号（EAC router
// 浏览器登录渠道）、组合（本地合成，路由到其他行）、公共池（免登录共享凭据）。
// 映射是**显示层事实**，只认渠道 id；未知渠道一律归公共池并记一次警告——
// 宁可少标，不可把公共池误标成"我的"。
/** @type {Record<string, string>} 渠道来源类别 → 显示名 */
export const SOURCE_CLASS_NAMES = {
  'own-key': '我的 Key', 'own-account': '我的账号', combo: '组合', shared: '公共池',
}
/** @type {Record<string, string>} 渠道 id → 来源类别 */
const SOURCE_CHANNEL_MAP = {
  aggregate: 'own-key', extension: 'own-key',
  codearts: 'own-account', trae: 'own-account', raccoon: 'own-account', loomy: 'own-account',
  minimax: 'own-account', cline: 'own-account', qoder: 'own-account', qodercn: 'own-account',
  opencode: 'own-account', zcode: 'own-account', lobsterai: 'own-account', buddy: 'own-account',
  gemini: 'own-account',
  anonymous: 'shared', kilo: 'shared', eac: 'shared', magpie: 'shared',
  combo: 'combo',
}
const warnedChannels = new Set()
/** @param {string|undefined} channel @returns {string} 来源类别 id */
export function sourceClassOf(channel) {
  const mapped = SOURCE_CHANNEL_MAP[channel]
  if (mapped !== undefined) return mapped
  if (typeof channel === 'string' && channel !== '' && !warnedChannels.has(channel)) {
    warnedChannels.add(channel)
    try { console.warn(`[models] 未知渠道 "${channel}" 按公共池展示；若是新登录渠道请更新 SOURCE_CHANNEL_MAP`) } catch { /* 非浏览器环境跳过 */ }
  }
  return 'shared'
}

/** 渠道下拉的分组顺序与标题（按来源类别）。 */
export const SOURCE_GROUP_ORDER = [
  ['own-key', '我的 Key（聚合渠道）'],
  ['own-account', '我的账号（EAC router）'],
  ['combo', '组合'],
  ['shared', '公共池（免登录共享）'],
]

// ── 引擎车道（magpie）按 lane 拆分（2026-11-21 用户找不到 AMD 入口）──
// magpie 引擎的车道模型（amd/…、z-ai/…）在目录里统一挂 channel:'magpie'，
// 清单页只会显示一整块「magpie」。模型的 id 前缀就是 lane，据此拆开显示。
export const AGGREGATE_CHANNEL_PREFIX = 'aggregate:'
export const MAGPIE_CHANNEL_PREFIX = 'magpie:'

/** @type {Record<string, string>} lane 前缀 → 显示名；未收录的 lane 用「引擎车道 <前缀>」兜底。 */
export const ENGINE_LANE_NAMES = {
  amd: 'AMD Radeon',
  'z-ai': '智谱 Z.ai',
}

/** 该模型的引擎 lane 前缀（非 magpie 渠道返回 null）。 */
export function engineLaneOf(model) {
  if (model.channel !== 'magpie') return null
  const prefix = String(model.id ?? '').split('/')[0] ?? ''
  return prefix !== '' && prefix !== 'magpie' ? prefix : null
}

export function engineLaneName(prefix) {
  return ENGINE_LANE_NAMES[prefix] ?? `引擎车道 ${prefix}`
}

/** 渠道筛选匹配（支持两种复合值：aggregate:<providerId>、magpie:<lane>）。 */
export function matchesChannel(model, channel) {
  if (channel === 'all') return true
  if (channel.startsWith(AGGREGATE_CHANNEL_PREFIX)) {
    return model.channel === 'aggregate' && model.providerId === channel.slice(AGGREGATE_CHANNEL_PREFIX.length)
  }
  if (channel.startsWith(MAGPIE_CHANNEL_PREFIX)) {
    const lane = channel.slice(MAGPIE_CHANNEL_PREFIX.length)
    return model.channel === 'magpie' && String(model.id ?? '').startsWith(`${lane}/`)
  }
  return model.channel === channel
}

export function filterModels(catalog, { search = '', channel = 'all', capability = 'all', availability = 'all', access = 'all', source = 'all' }) {
  const query = search.trim().toLocaleLowerCase()
  const matchesSource = model => {
    if (source === 'all') return true
    const cls = sourceClassOf(model.channel)
    return source === 'own' ? cls === 'own-key' || cls === 'own-account' : cls === source
  }
  return catalog.filter(model =>
    matchesChannel(model, channel)
    && matchesSource(model)
    && (capability === 'all' || (capability === 'vision' ? model.vision : capability === 'reasoning' ? model.reasoning : !model.vision))
    && (availability === 'all' || modelStateView(model).state === availability)
    && (access === 'all' || (access === 'routable' ? model.routable : !model.routable))
    && `${model.name} ${model.id}`.toLocaleLowerCase().includes(query))
}
