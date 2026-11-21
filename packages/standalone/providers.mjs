import { listProviders, getProvider } from '../../src/providers/index.js'
import { fetchProviderModels, testProvider } from '../../src/aggregate.js'
import { isDeniedChannel } from '../../src/magpie-policy.js'

const fail = message => Object.assign(new Error(message), { statusCode: 400 })
const modelsOf = value => {
  if (!Array.isArray(value) || value.length > 300 || value.some(id => typeof id !== 'string' || !id.trim() || id.length > 300 || /[\0\r\n]/.test(id))) {
    throw fail('模型清单必须为不超过 300 项的模型名称数组')
  }
  return [...new Set(value.map(id => id.trim()))]
}

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

export function publicProviders(section) {
  return Object.fromEntries(Object.entries(section?.providers ?? {}).map(([id, value]) => {
    const keys = storedKeys(value)
    return [id, {
      enabled: value.enabled !== false,
      hasKey: keys.length > 0,
      keyCount: keys.length,
      keyHint: keys.length > 0 ? `…${keys[0].slice(-4)}` : '',
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
  function write(id, value) {
    const section = stores.settings.get().aggregate ?? {}
    const providers = { ...section.providers }
    if (value === null) delete providers[id]
    else providers[id] = value
    persist({ aggregate: { ...section, providers } })
    runtime.syncAggregateCatalog()
    return { configured: publicProviders(stores.settings.get().aggregate) }
  }
  return {
    list() {
      return {
        registry: listProviders().map(provider => ({
          id: provider.id, name: provider.name, category: provider.category, format: provider.format,
          authKind: provider.auth.kind, baseUrl: provider.baseUrl ?? '', modelCount: provider.models.length,
          models: provider.models.map(model => model.id), website: provider.website ?? '',
          notes: provider.notes ?? '', credentialUrl: provider.auth.url ?? '', local: provider.local === true,
        })),
        configured: publicProviders(stores.settings.get().aggregate),
      }
    },
    save(patch) {
      const provider = get(patch.providerId)
      if (!['apiKey', 'none'].includes(provider.auth.kind)) throw fail('此渠道请使用订阅账号导入')
      for (const name of Object.keys(patch)) if (!['providerId', 'enabled', 'apiKey', 'apiKeys', 'baseUrl', 'models'].includes(name)) throw fail('不支持的供应商设置字段')
      const previous = stores.settings.get().aggregate?.providers?.[provider.id] ?? {}
      const next = { enabled: true, ...previous, addedAt: previous.addedAt ?? Date.now() }
      if (patch.enabled !== undefined) {
        if (typeof patch.enabled !== 'boolean') throw fail('enabled 必须为布尔值')
        next.enabled = patch.enabled
      }
      if (patch.apiKeys !== undefined) {
        // Multi-key save: the rotation pool. Order matters only as a display
        // hint; the request path round-robins and cooldowns decide the rest.
        if (!Array.isArray(patch.apiKeys)) throw fail('API Key 清单必须为数组')
        if (patch.apiKeys.length > 8) throw fail('每个渠道最多保存 8 把 API Key')
        const seen = new Set()
        const keys = []
        for (const value of patch.apiKeys) {
          if (typeof value !== 'string' || value.length > 8192 || /[\0\r\n]/.test(value)) throw fail('API Key 格式无效')
          const key = value.trim()
          if (key === '' || seen.has(key)) continue
          seen.add(key)
          keys.push(key)
        }
        if (keys.length === 0) throw fail('请至少输入一把有效的 API Key')
        next.apiKeys = keys
        // Single-key readers (desktop builds, backups) keep working off `apiKey`.
        next.apiKey = keys[0]
      } else if (patch.apiKey !== undefined) {
        if (typeof patch.apiKey !== 'string' || patch.apiKey.length > 8192 || /[\0\r\n]/.test(patch.apiKey)) throw fail('API Key 格式无效')
        next.apiKey = patch.apiKey.trim()
        // A legacy single-key save rewrites the pool to one entry — the old
        // editor can only manage one key, so keeping stale extras behind an
        // invisible pool would surprise whoever next opens the new editor.
        next.apiKeys = [next.apiKey]
      }
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
    remove({ providerId }) { get(providerId); return write(providerId, null) },
    async test({ providerId }, signal) {
      get(providerId)
      const started = stores.settings.get().aggregate?.providers?.[providerId]
      const result = await testProvider(stores.settings.get().aggregate, providerId, { signal })
      const current = stores.settings.get().aggregate?.providers?.[providerId]
      if (current && current === started && !signal?.aborted) write(providerId, { ...current, lastTest: { ...result, at: Date.now() } })
      return result
    },
    async discover({ providerId }, signal) {
      get(providerId)
      const started = stores.settings.get().aggregate?.providers?.[providerId]
      const ids = await fetchProviderModels(stores.settings.get().aggregate, providerId, { signal })
      if (ids === null) return { models: null, note: '供应商没有可用的模型列表接口' }
      const current = stores.settings.get().aggregate?.providers?.[providerId]
      if (current && current === started && !signal?.aborted) write(providerId, { ...current, discovered: ids.slice(0, 300) })
      return { models: ids }
    },
  }
}
