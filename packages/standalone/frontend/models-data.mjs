/** 筛选只影响当前视图，不改变模型开关或服务端目录。 */

/**
 * 统一的展示状态视图（2026-11-21 重构）：徽章文案、颜色、筛选共用这一份，
 * 保证「清单页看到的」和「筛选选中的」永远是同一套语义。
 *
 * 状态体系（与归因打通）：
 * - available   可用（探测 / 实测 / 调用成功）        绿
 * - listed      清单已收录                            灰
 * - unknown     未探测（无任何测量）                  灰
 * - unavailable 不可用（探测 / 连续调用失败）          红
 * - throttled   限流中（探测 / 手测 / 调用限流）      橙
 * - region-blocked 地区受限                           橙
 * - test-failed 实测失败·模型异常                     红（可批量隐藏）
 * - quota       额度不足（环境问题）                  蓝
 * - auth        鉴权失败（环境问题）                  蓝
 * - transport   网络异常（未定性）                    蓝
 */
export function modelStateView(model) {
  const state = model.availabilitySource === 'listing' ? 'listed' : model.availability ?? 'unknown'
  const source = model.availabilitySource
  if (source === 'manual' && state === 'unknown') {
    const kind = model.failureKind ?? 'model-error'
    if (kind === 'quota') return { state: 'quota', label: '额度不足', tone: 'blue' }
    if (kind === 'auth') return { state: 'auth', label: '鉴权失败', tone: 'blue' }
    if (kind === 'transport') return { state: 'transport', label: '网络异常', tone: 'blue' }
    return { state: 'test-failed', label: '实测失败', tone: 'danger' }
  }
  if (source === 'manual' && state === 'available') return { state: 'available', label: '实测可用', tone: 'success' }
  if (source === 'usage' && state === 'available') return { state: 'available', label: '调用可用', tone: 'success' }
  if (source === 'usage' && state === 'unavailable') return { state: 'unavailable', label: '连续调用失败', tone: 'danger' }
  const names = {
    available: '已探测可用', listed: '清单已收录', unknown: '未探测',
    unavailable: '不可用', throttled: '限流中', 'region-blocked': '地区受限',
  }
  const tones = {
    available: 'success', listed: 'neutral', unknown: 'neutral',
    unavailable: 'danger', throttled: 'warning', 'region-blocked': 'warning',
  }
  return { state, label: names[state] ?? '未知状态', tone: tones[state] ?? 'neutral' }
}

/** 「可用状态」下拉的选项（全部状态 + 归因并入后的各态）。 */
export const stateOptions = [
  ['available', '可用（探测 / 实测 / 调用）'],
  ['listed', '清单已收录'],
  ['unknown', '未探测'],
  ['unavailable', '不可用'],
  ['throttled', '限流中'],
  ['region-blocked', '地区受限'],
  ['test-failed', '实测失败（模型异常）'],
  ['quota', '额度不足'],
  ['auth', '鉴权失败'],
  ['transport', '网络异常'],
]

export function filterModels(catalog, { search = '', channel = 'all', capability = 'all', availability = 'all', access = 'all' }) {
  const query = search.trim().toLocaleLowerCase()
  return catalog.filter(model =>
    (channel === 'all' || model.channel === channel)
    && (capability === 'all' || (capability === 'vision' ? model.vision : capability === 'reasoning' ? model.reasoning : !model.vision))
    && (availability === 'all' || modelStateView(model).state === availability)
    && (access === 'all' || (access === 'routable' ? model.routable : !model.routable))
    && `${model.name} ${model.id}`.toLocaleLowerCase().includes(query))
}
