/** 筛选只影响当前视图，不改变模型开关或服务端目录。 */
export function filterModels(catalog, { search = '', channel = 'all', capability = 'all', availability = 'all', access = 'all', failure = 'all' }) {
  const query = search.trim().toLocaleLowerCase()
  // 失败归因筛选（2026-11-21）：模型异常/额度不足/鉴权/网络按 failureKind 精确匹配；
  // 限流/地区还要兼容探测车道沉淀的同义状态（throttled / region-blocked 无 failureKind）。
  const failureMatches = (model, failure) => {
    if (failure === 'rate-limit') return model.failureKind === 'rate-limit' || model.availability === 'throttled'
    if (failure === 'region') return model.failureKind === 'region' || model.availability === 'region-blocked'
    return model.failureKind === failure
  }
  return catalog.filter(model =>
    (channel === 'all' || model.channel === channel)
    && (capability === 'all' || (capability === 'vision' ? model.vision : capability === 'reasoning' ? model.reasoning : !model.vision))
    && (availability === 'all' || (model.availability ?? 'unknown') === availability)
    && (failure === 'all' || failureMatches(model, failure))
    && (access === 'all' || (access === 'routable' ? model.routable : !model.routable))
    && `${model.name} ${model.id}`.toLocaleLowerCase().includes(query))
}
