# 平台真实调用体检（platform audit）

> **永久维护数据**：每轮体检结果按日期追加在本文件，随 git 保存。后续体检在
> 相同结构上更新，用于跟踪各渠道平台的真实可用性、测试准确性问题与修复效果。

## 方法

- 脚本：`node scripts/platform-audit.mjs --port <管理端口> --out <json 路径>`
- 每个渠道平台挑 1 个代表模型，**走 /v1 API 真实调用**（非测试按钮）：
  1. user role 基线调用（`max_tokens: 4`，`"hi"`，最小化 token 消耗）
  2. developer role 兼容调用（OpenAI 新式 system，验证入站/上游兼容）
- 触发 429 / 频繁调用立即停止该平台本轮剩余调用
- 思考模型在极小 max_tokens 下 content 为空但 reasoning_tokens > 0 记为
  `reasoning-truncated`（可用），不算故障
- 原始 JSON 数据随文档同目录存档：`platform-audit-<日期>.json`

---

## 2026-11-21 第一轮（服务 2.8.6，24 平台 / 575 模型）

### 结果总表

| 平台 | 代表模型 | user 基线 | developer 兼容 | 结论 |
|---|---|---|---|---|
| core（聚合车道） | big-pickle | 429 限流 | 跳过 | 限流暂停（正常波动） |
| amd | amd/Qwen3.8-27B | 502 Invalid bearer token | 同 | ⚠️ **凭据失效** |
| minimaxai | minimaxai/minimax-m3.1-flash | ok | ok | ✅ |
| moonshotai | moonshotai/kimi-k3.1-pro | ok（22s） | 60s 超时 | ⚠️ 上游慢/抖动 |
| z-ai | z-ai/glm-5.3-flash | 60s 超时 | 60s 超时 | ❌ **挂起**（响应超慢类） |
| stepfun-ai | stepfun-ai/step-5-preview | 60s 超时 | ok（21s） | ⚠️ 排队抖动 |
| deepseek-ai | deepseek-ai/deepseek-v4.1-flash | 502 end-of-life | 同 | ⚠️ **已退役，清单未清** |
| opencode | opencode/glm-5.3-flash-free | 404 模型不存在或已停用 | 同 | ⚠️ **清单与渠道不同步** |
| openai | openai/gpt-oss-20b | 502 end-of-life | 同 | ⚠️ **已退役，清单未清** |
| kilo-auto | kilo-auto/free | ok | ok | ✅ |
| baidu | baidu/ernie-5.5-flash-preview:free | ok | ok | ✅ |
| particle-ai | particle-ai/particle-1:free | 429 限流 | 跳过 | 限流暂停（正常波动） |
| recursive | recursive/flint-v1.0:free | ok | ok | ✅ |
| nvidia | nvidia/nemotron-3.5-super-vl:free | ok | ok | ✅ |
| openrouter | openrouter/free | ok | ok | ✅ |
| reflection | reflection/beam-free | ok | ok | ✅ |
| stealth | stealth/glyph-cluster | ok | ok | ✅ |
| codearts | codearts/GLM-5.2 | ok（9.6s） | 502（仅 system 无 user，上游拒绝） | ✅（见边界注记） |
| qoder | qoder/auto | 502 model_error + pricingUrl | 同 | ⚠️ **付费墙/订阅失效** |
| qodercn | qodercn/auto | ok | ok | ✅ |
| cline | cline/cline-free/nemotron-3.5-super-vl | ok（思考截断） | ok | ✅ 思考模型 |
| loomy | loomy/spark-x2.6 | ok（思考截断） | ok | ✅ 思考模型 |
| raccoon | raccoon/sn-sensenova-6-8-flash | ok（思考截断） | ok | ✅ 思考模型 |
| minimax | minimax/MiniMax-M3.1-Flash | ok | 502（仅 system 无 user，上游拒绝） | ✅（见边界注记） |

**汇总**：✅ 可用 13 / ⚠️ 异常 7 / 限流暂停 2 / 思考模型可用 3（判定修正后）。

### 发现的问题（按影响排序）

1. **amd 渠道凭据失效**（502 Invalid bearer token）：9 个模型全部不可用，
   清单仍完整展示——需要更新渠道凭据。
2. **z-ai 渠道挂起**：两次调用均 60 秒无响应。用户真实调用会卡死到超时，
   命中「响应超慢」场景；调用沉淀连败后会标 unavailable。
3. **退役模型仍在清单**（deepseek-ai、openai 前缀各 1 个）：真实调用返回
   502 end-of-life。手动测试已能归因「已退役」，但**调用沉淀**（usage）尚未
   做退役判定——连败只标 unavailable；清单展示与真实可用性不同步。
4. **opencode 渠道清单不同步**：`opencode/glm-5.3-flash-free` 清单收录但
   渠道返回 404「模型不存在或已停用」。
5. **qoder 渠道付费墙**：502 model_error + pricingUrl（订阅失效），17 个
   模型全部无效仍在清单。
6. **限流波动**：core / particle-ai 触发 429（按约定跳过），正常波动。
7. **思考模型小 max_tokens 截断**：cline / loomy / raccoon 在 max_tokens ≤ 8
   时 content 为 null（reasoning_tokens 吃满预算）——审计判定已修正为
   `reasoning-truncated`（可用）；真实使用给足 max_tokens 即可。
8. **developer 单条消息边界**：codearts / minimax 上游拒绝「只有 system 没
   有 user」的对话（本审计 developer 调用只发一条消息所致）。真实场景
   developer 总是伴随 user 消息，不受影响；记录备查。

### 本轮已修复（此前轮次）

- developer role 入站解析（渠道网关按 system 接收）——本轮 13 个平台
  developer 兼容全部通过
- 「已退役」独立归因与筛选（manual 测试路径）；调用沉淀退役判定为后续项
- 孤儿锁自动回收（本轮启动时验证：残留 pid 8880 锁被自动清理）

### 2026-11-21 体检后修复（同日第二批）

- **调用沉淀退役判定**（问题 3）：`noteUsageOutcome`（core/runtime.js）对
  错误文本做退役归因（classifyModelFailure），命中即**单次**标 unavailable +
  `failureKind:'retired'`（不走连败计数——终态等第二次没有意义）；清单页
  usage 行显示「已退役（调用）」并纳入「已退役」筛选与批量隐藏。
- **聚合渠道多凭据 + 自动轮换**（凭据 UI）：「聚合渠道」页（用户自有 API
  Key 的 76 家 provider）每渠道支持保存 **多把 Key**（最多 8 把，每行一把），
  请求级 round-robin 轮换分摊配额；被上游拒绝的键（429 限流 / 401 鉴权）
  进入冷却（Retry-After 优先，默认 60s、上限 10min），冷却期内不再选中；
  一轮流放中被拒且**尚未出帧**时，同 body 自动换下一把键重试（已出帧不重试，
  避免输出重复）。存储形态 `apiKeys: string[]`（旧 `apiKey` 单键继续兼容）。
  测试：scripts/aggregate-test.mjs 轮换 5 组（顺序轮换 / 429 换键重试 /
  401 换键重试 / 冷却过期回归 / 目录准入）。
- **amd 渠道定位澄清**（问题 1）：amd 车道来自 magpie 引擎
  （`magpie/cache/magpie/models.json` 的 amd provider，`AMD_API_KEY` 环境变量，
  AMD Radeon Cloud tokenfactory），key 管理在引擎侧，OFM 的聚合渠道多键轮换
  不覆盖该车道；凭据仍需用户在引擎侧更新。

### 后续行动候选

- [ ] amd（magpie 车道）凭据更新（用户操作，引擎侧）
- [x] 调用沉淀（noteUsageOutcome）增加退役判定 → 标「已退役」（2026-11-21）
- [ ] 清单与渠道实际可用性同步（404/下架模型自动隐藏或标注）
- [ ] z-ai 渠道挂起问题定位（上游 or 本地适配器）
