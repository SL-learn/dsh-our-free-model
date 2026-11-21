import { listProviders, getProvider } from '../../src/providers/index.js'
import { fetchProviderModels, maskKey, testProvider } from '../../src/aggregate.js'
import { isDeniedChannel } from '../../src/magpie-policy.js'

const fail = message => Object.assign(new Error(message), { statusCode: 400 })
const modelsOf = value => {
  if (!Array.isArray(value) || value.length > 300 || value.some(id => typeof id !== 'string' || !id.trim() || id.length > 300 || /[\0\r\n]/.test(id))) {
    throw fail('模型清单必须为不超过 300 项的模型名称数组')
  }
  return [...new Set(value.map(id => id.trim()))]
}

const KEY_PATTERN = /[\0\r\n]/

/** A provider's stored keys: the `apiKeys` list where valid, else the legacy single `apiKey`. */
const storedKeys = value => {
  const raw = Array.isArray(value?.apiKeys) ? value.apiKeys : [value?.apiKey]
  const seen = new Set()
  const keys = []
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const key = entry.trim()
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    keys.push(key)
    if (keys.length >= 8) break
  }
  return keys
}

/** Per-key user metadata (备注 / 停用)，keyed by the key's client-visible mask. */
const storedKeyMeta = value => {
  const meta = value?.keyMeta
  return meta !== null && typeof meta === 'object' && !Array.isArray(meta) ? meta : {}
}

/** 客户端可见的键视图：掩码指纹 + 备注 + 停用态，从不回传完整凭据。 */
const publicKeys = value => storedKeys(value).map(key => {
  const masked = maskKey(key)
  const entry = storedKeyMeta(value)[masked]
  return {
    masked,
    label: typeof entry?.label === 'string' ? entry.label : '',
    disabled: entry?.disabled === true,
  }
})

export function publicProviders(section) {
  return Object.fromEntries(Object.entries(section?.providers ?? {}).map(([id, value]) => {
    const keys = storedKeys(value)
    const paid = Array.isArray(value.paidModels) ? value.paidModels : []
    return [id, {
      enabled: value.enabled !== false,
      hasKey: keys.length > 0,
      keyCount: keys.length,
      keyHint: keys.length > 0 ? `…${keys[0].slice(-4)}` : '',
      keys: publicKeys(value),
      paidModels: paid,
      baseUrl: value.baseUrl ?? '',
      models: value.models ?? [], discovered: value.discovered ?? [],
      lastTest: value.lastTest
        ? { ...value.lastTest, message: keys.reduce((text, key) => String(text).replaceAll(key, '[redacted]'), String(value.lastTest.message ?? '')) }
        : undefined,
    }]
  }))
}

export function createProviderManagement({ stores, runtime, persist }) {
  const get = id => {
    if (typeof id !== 'string') throw fail('请选择供应商')
    // A channel this build does not offer is unknown here, exactly as it is
    // absent from the directory above.
    if (isDeniedChannel(id)) throw fail('此渠道不在本应用的提供范围内')
    const provider = getProvider(id)
    if (!provider) throw fail('未知供应商')
    return provider
  }
  const settingOf = providerId => stores.settings.get().aggregate?.providers?.[providerId] ?? {}
  function write(id, value) {
    const section = stores.settings.get().aggregate ?? {}
    const providers = { ...section.providers }
    if (value === null) delete providers[id]
    else providers[id] = value
    persist({ aggregate: { ...section, providers } })
    runtime.syncAggregateCatalog()
    return { configured: publicProviders(stores.settings.get().aggregate) }
  }
  /** 校验一把待入库的 key（字符串、长度、无控制字符），返回 trim 后的值。 */
  const validKey = value => {
    if (typeof value !== 'string' || value.length > 8192 || KEY_PATTERN.test(value)) throw fail('API Key 格式无效')
    const key = value.trim()
    if (key === '') throw fail('API Key 不能为空')
    return key
  }
  /** 校验并归一 keyMeta：掩码键 → { label?, disabled? }，白名单字段。 */
  const keyMetaOf = value => {
    if (value === undefined) return undefined
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw fail('keyMeta 格式无效')
    const meta = {}
    for (const [masked, entry] of Object.entries(value)) {
      if (typeof masked !== 'string' || masked.length > 64 || /[\0\r\n]/.test(masked)) throw fail('keyMeta 掩码无效')
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw fail('keyMeta 条目无效')
      const next = {}
      if (entry.label !== undefined) {
        if (typeof entry.label !== 'string' || entry.label.length > 120) throw fail('key 备注过长')
        next.label = entry.label.trim()
      }
      if (entry.disabled !== undefined) {
        if (typeof entry.disabled !== 'boolean') throw fail('keyMeta.disabled 必须为布尔值')
        next.disabled = entry.disabled
      }
      meta[masked] = next
    }
    return meta
  }
  return {
    list() {
      return {
        registry: listProviders().map(provider => ({
          id: provider.id, name: provider.name, category: provider.category, format: provider.format,
          authKind: provider.auth.kind, baseUrl: provider.baseUrl ?? '', modelCount: provider.models.length,
          models: provider.models.map(model => model.id), website: provider.website ?? '',
          notes: provider.notes ?? '', credentialUrl: provider.auth.url ?? '', local: provider.local === true,
          freeModelsHint: typeof provider.freeModelsHint === 'string' ? provider.freeModelsHint : '',
        })),
        configured: publicProviders(stores.settings.get().aggregate),
      }
    },
    save(patch) {
      const provider = get(patch.providerId)
      if (!['apiKey', 'none'].includes(provider.auth.kind)) throw fail('此渠道请使用订阅账号导入')
      for (const name of Object.keys(patch)) if (!['providerId', 'enabled', 'apiKey', 'apiKeys', 'keyMeta', 'baseUrl', 'models', 'paidModels'].includes(name)) throw fail('不支持的供应商设置字段')
      const previous = settingOf(provider.id)
      const next = { enabled: true, ...previous, addedAt: previous.addedAt ?? Date.now() }
      if (patch.enabled !== undefined) {
        if (typeof patch.enabled !== 'boolean') throw fail('enabled 必须为布尔值')
        next.enabled = patch.enabled
      }
      if (patch.apiKeys !== undefined) {
        // Multi-key save **merges**: the editor keeps existing keys and adds
        // newly pasted ones; single-key removal happens in the `key` op. 旧
        // `apiKey` 单键形态继续兼容（视为整池重写）。
        if (!Array.isArray(patch.apiKeys)) throw fail('API Key 清单必须为数组')
        const incoming = patch.apiKeys.map(validKey)
        const existing = storedKeys(previous)
        const legacyOnly = !Array.isArray(previous.apiKeys) && typeof previous.apiKey === 'string' && previous.apiKey !== ''
        const pool = legacyOnly ? [] : existing.slice()
        for (const key of incoming) if (!pool.includes(key)) pool.push(key)
        if (pool.length > 8) throw fail('每个渠道最多保存 8 把 API Key')
        if (pool.length === 0) throw fail('请至少输入一把有效的 API Key')
        next.apiKeys = pool
        // Single-key readers (desktop builds, backups) keep working off `apiKey`.
        next.apiKey = pool[0]
        next.keyMeta = { ...storedKeyMeta(previous), ...keyMetaOf(patch.keyMeta) }
      } else if (patch.apiKey !== undefined) {
        if (typeof patch.apiKey !== 'string' || patch.apiKey.length > 8192 || KEY_PATTERN.test(patch.apiKey)) throw fail('API Key 格式无效')
        next.apiKey = patch.apiKey.trim()
        // A legacy single-key save rewrites the pool to one entry — the old
        // editor can only manage one key, so keeping stale extras behind an
        // invisible pool would surprise whoever next opens the new editor.
        next.apiKeys = [next.apiKey]
        next.keyMeta = storedKeyMeta(previous)
      } else {
        next.keyMeta = { ...storedKeyMeta(previous), ...keyMetaOf(patch.keyMeta) }
      }
      if (patch.paidModels !== undefined) next.paidModels = modelsOf(patch.paidModels)
      if (patch.baseUrl !== undefined) {
        if (typeof patch.baseUrl !== 'string' || patch.baseUrl.length > 2048) throw fail('API 地址无效')
        const raw = patch.baseUrl.trim()
        if (raw) {
          let parsed
          try { parsed = new URL(raw) } catch { throw fail('请输入有效的 HTTP 或 HTTPS 地址') }
          if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash || parsed.search) throw fail('API 地址不能包含凭据、查询参数或片段')
        }
        next.baseUrl = raw.replace(/\/+$/, '')
      }
      if (patch.models !== undefined) next.models = modelsOf(patch.models)
      // A changed endpoint or credential invalidates the old connectivity verdict.
      const keysChanged = JSON.stringify(next.apiKeys ?? []) !== JSON.stringify(previous.apiKeys ?? [])
      if (next.baseUrl !== previous.baseUrl || next.apiKey !== previous.apiKey || keysChanged) delete next.lastTest
      return write(provider.id, next)
    },
    /** 单把 key 的账号管理操作：删除 / 停用·启用 / 备注。按掩码定位。 */
    key({ providerId, masked, op, label, disabled }) {
      const provider = get(providerId)
      if (!['apiKey', 'none'].includes(provider.auth.kind)) throw fail('此渠道不使用 API Key')
      if (typeof masked !== 'string' || masked === '') throw fail('请选择要操作的密钥')
      const current = settingOf(provider.id)
      const keys = storedKeys(current)
      const matches = keys.filter(key => maskKey(key) === masked)
      if (matches.length === 0) throw fail('密钥不存在或已被移除')
      if (matches.length > 1) throw fail('多把密钥的指纹相同，请删除后重新按顺序添加')
      const target = matches[0]
      const meta = { ...storedKeyMeta(current) }
      const pool = keys.filter(key => key !== target)
      if (op === 'remove') {
        delete meta[maskKey(target)]
      } else if (op === 'toggle') {
        if (typeof disabled !== 'boolean') throw fail('disabled 必须为布尔值')
        meta[maskKey(target)] = { ...meta[maskKey(target)], disabled }
      } else if (op === 'label') {
        if (typeof label !== 'string' || label.length > 120) throw fail('备注过长')
        meta[maskKey(target)] = { ...meta[maskKey(target)], label: label.trim() }
      } else throw fail('不支持的密钥操作')
      const next = { ...current, apiKeys: pool, apiKey: pool[0] ?? '', keyMeta: meta }
      if (next.apiKey !== current.apiKey) delete next.lastTest
      return write(provider.id, next)
    },
    remove({ providerId }) { get(providerId); return write(providerId, null) },
    async test({ providerId, apiKeys }, signal) {
      get(providerId)
      const override = apiKeys !== undefined ? { apiKeys: apiKeys.map(validKey), apiKey: undefined } : undefined
      const started = settingOf(providerId)
      const result = await testProvider(stores.settings.get().aggregate, providerId, { signal, override })
      const current = settingOf(providerId)
      if (current && current === started && !signal?.aborted && override === undefined) write(providerId, { ...current, lastTest: { ...result, at: Date.now() } })
      return result
    },
    async discover({ providerId, apiKeys }, signal) {
      get(providerId)
      // 未保存的 key 也能发现模型：编辑器把刚粘贴的键作为 override 传入，
      // 不落盘（保存仍是显式动作）。优先用新键，没有则用已存池。
      const override = apiKeys !== undefined ? { apiKeys: apiKeys.map(validKey), apiKey: undefined } : undefined
      const ids = await fetchProviderModels(stores.settings.get().aggregate, providerId, { signal, override })
      if (ids === null) return { models: null, note: '供应商没有可用的模型列表接口' }
      if (override === undefined) {
        const current = settingOf(providerId)
        write(providerId, { ...current, discovered: ids.slice(0, 300) })
      }
      return { models: ids }
    },
  }
}
