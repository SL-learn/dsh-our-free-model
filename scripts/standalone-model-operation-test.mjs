import assert from 'node:assert/strict'
import fs from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

// 执行组件实际的异步操作函数，模拟 Host 返回和状态更新，不复制业务逻辑。
const source = fs.readFileSync(new URL('../packages/standalone/frontend/models.tsx', import.meta.url), 'utf8')
const start = source.indexOf('  const run = async')
const end = source.indexOf('  const cancel =', start)
assert.ok(start >= 0 && end > start, '模型操作函数必须可定位')
const operationSource = stripTypeScriptTypes(source.slice(start, end))
const model = { id: 'fixture/model', name: '测试模型' }
const result = { ok: true, text: '成功回答', latencyMs: 10 }
function operation(host) {
  const state = { test: undefined, operation: undefined, error: '', message: '' }
  const pending = { current: undefined }
  const activeRef = { current: true }
  const context = {
    host, pending, activeRef, AbortController, Error,
    // 滚动锚点依赖（测试失败路径的立即刷新与视口保持）：vm 里没有 DOM，
    // scrollRef.current 恒 null 即可跳过记录；scrollAnchor 提供消费容器。
    scrollRef: { current: null },
    scrollAnchor: { current: undefined },
    setTest: value => { state.test = typeof value === 'function' ? value(state.test) : value },
    setOperation: value => { state.operation = value },
    setError: value => { state.error = value },
    setMessage: value => { state.message = value },
  }
  const run = vm.runInNewContext(operationSource + '\nrun', context)
  return { run, state, pending, activeRef }
}

export async function verifyModelOperation() {
  const refreshFailed = operation({
    testModel: async () => result,
    refresh: async () => { throw new Error('摘要暂时不可用') },
  })
  await refreshFailed.run('test', model)
  assert.equal(refreshFailed.state.test.state, 'success', '摘要刷新失败不能覆盖已成功的测试')
  assert.equal(refreshFailed.state.test.result, result, '成功回答必须保留')
  assert.match(refreshFailed.state.error, /摘要暂时不可用/, '摘要错误应单独提示')
  assert.equal(refreshFailed.state.operation, undefined)
  assert.equal(refreshFailed.pending.current, undefined)

  let refreshed = false
  const testFailed = operation({
    testModel: async () => { throw new Error('推理失败') },
    refresh: async () => { refreshed = true },
  })
  await testFailed.run('test', model)
  assert.equal(testFailed.state.test.state, 'error')
  assert.equal(testFailed.state.test.error, '推理失败')
  // 失败已在服务端沉淀（manualResults / 归因落表），前端必须立即刷新让行
  // 徽章与筛选马上跟上，不再等 15 秒轮询（2026-11-21 用户反馈）。
  assert.equal(refreshed, true)
  assert.equal(testFailed.state.operation, undefined)

  const succeeded = operation({ testModel: async () => result, refresh: async () => {} })
  await succeeded.run('test', model)
  assert.equal(succeeded.state.test.state, 'success')
  assert.equal(succeeded.state.error, '')

  const probeFailed = operation({ refreshModels: async () => { throw new Error('探测失败') } })
  await probeFailed.run('probe')
  assert.equal(probeFailed.state.error, '探测失败')
  assert.equal(probeFailed.state.test, undefined)
  assert.equal(probeFailed.state.operation, undefined)

  let rejectRefresh
  let notifyRefresh
  const refreshStarted = new Promise(resolve => { notifyRefresh = resolve })
  const cancelled = operation({
    testModel: async () => result,
    refresh: () => new Promise((_resolve, reject) => { rejectRefresh = reject; notifyRefresh() }),
  })
  const running = cancelled.run('test', model)
  await refreshStarted
  assert.equal(cancelled.state.test.state, 'success')
  cancelled.activeRef.current = false
  cancelled.pending.current.abort()
  cancelled.pending.current = undefined
  rejectRefresh(new Error('离开页面后的迟到错误'))
  await running
  assert.equal(cancelled.state.error, '', '离开页面后的错误不得更新状态')
}
