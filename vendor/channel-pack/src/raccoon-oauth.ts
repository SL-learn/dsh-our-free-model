/**
 * Raccoon Work 登录与续期的纯 API 层。
 *
 * ## 两条登录路径
 *
 * 1. **微信扫码**（首选）：`qrcode_code` 由**服务端 IAM 域下发**
 *    （`POST /api/iam/v1/auth/mp/qrcode`），轮询也走 IAM 域
 *    （`POST /api/iam/v1/auth/mp/qrcode/login`）。⚠️ 旧实现的「本地自造 code +
 *    web/auth 域 `login_with_qrcode_code` 轮询」**已失效**：该接口对任意 code
 *    都返回 pending、永不 success（实测 2026-10-29）——这正是
 *    「扫码后无法登录」的根源。 IAM 域签名是 `qrcode_code`，与客户端的
 *    `office-raccoon://auth/callback` 自定义协议链路无关，宿主侧 Node 进程
 *    可以直接轮询拿 token。
 * 2. **短信验证码**（次选）：手机号需 AES-128-CFB 加密，且 `send_sms` 要求
 *    先过阿里云滑块拿到 `captcha_param`。
 *
 * ## 为什么不用官方桌面端的授权码链路
 *
 * `desktopLogin.js` 走「网页授权 → `office-raccoon://auth/callback?code=` →
 * `POST /login_with_authorization_code`」。回调地址在网页里是**写死的**，
 * 改不成 localhost，插件收不到回调。故该链路只保留 `exchangeRaccoonAuthorizationCode`
 * 供将来（如支持自定义协议的环境）复用。
 *
 * ## 本模块是纯 API 层
 *
 * 不含本地 HTTP 服务器（那是 `raccoon-login-page.ts` 的职责），
 * 也不做凭据持久化（那是 `raccoon-auth.ts` 的职责）。全部函数可离线单测。
 */

import { appendRaccoonDebugLog, scrubBody } from './raccoon-debug-log.js'
import { randomBytes } from 'node:crypto'
import {
  RACCOON_IAM_PREFIX,
  RACCOON_QR_STATUS,
  RACCOON_REQUEST_TIMEOUT_MS,
  decodeJwtExpMs,
  encryptRaccoonPhone,
  raccoonHeaders,
  type RaccoonCredential,
} from './raccoon.js'
import { type RaccoonProduct } from './raccoon-product.js'

/** 扫码轮询的状态值（expired：二维码过期，需重新申请）。 */
export type RaccoonQrStatus = 'pending' | 'logging' | 'canceled' | 'expired' | 'success'

/** 服务端下发的扫码会话（IAM 域，见 spec 实测记录 2026-10-29）。 */
export interface RaccoonQrSession {
  /** 服务端下发的 qrcode_code（**不再本地自造**——本地自造 code 轮询旧域永远 pending）。 */
  code: string
  /** 扫码页路径（以 / 开头，如 /login/mp）。 */
  scanPath: string
  /** 二维码有效期（毫秒；响应缺失时按 spec 兜底 5 分钟）。 */
  expiresMs: number
}

/** 一次扫码轮询的结果。 */
export interface RaccoonQrPollResult {
  status: RaccoonQrStatus
  /** 仅 `success` 时存在。 */
  accessToken?: string
  /** 仅 `success` 时存在。 */
  refreshToken?: string
  /** 仅 `success` 时存在（毫秒时间戳字符串）。 */
  expiresAt?: string
  /** 仅 `logging` 时存在（二维码有效期）。 */
  expiredAt?: string
}

/** 业务响应信封（失败可能带 HTTP 400/401，也可能 HTTP 200 + 非 0 code）。 */
interface RaccoonEnvelope {
  /** web 域是数字（0=成功）；IAM 域是**字符串 "OK"**（实测 2026-11-19）。 */
  code: number | string
  message: string
  details: string
  data: Record<string, unknown> | undefined
}

/** 解析业务信封。`code === 0` 为成功；IAM 域的字符串 "OK" 归一为 0。 */
function parseEnvelope(payload: unknown, status: number): RaccoonEnvelope {
  const record = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {}
  // ⚠️ IAM 域成功码是字符串 "OK"（实测 /api/iam/v1/auth/mp/qrcode 响应），
  //   归一为 0 让 `code === 0` 的判断对两个域都成立；其他字符串（错误码）
  //   保留原值 —— `!== 0` 判定为失败，不会被误当成功。
  const code = typeof record.code === 'number' ? record.code
    : record.code === 'OK' ? 0
    : typeof record.code === 'string' && record.code.length > 0 ? record.code
    : (status >= 400 ? status : 0)
  const message = typeof record.message === 'string' ? record.message : ''
  const details = typeof record.details === 'string' ? record.details : ''
  const data = typeof record.data === 'object' && record.data !== null && !Array.isArray(record.data)
    ? record.data as Record<string, unknown>
    : undefined
  return { code, message, details, data }
}

/** 把信封里的错误拼成一条可读信息（服务端文案优先）。 */
function envelopeError(envelope: RaccoonEnvelope, fallback: string): Error {
  const parts = [envelope.message, envelope.details].filter((s) => s.length > 0)
  const text = parts.length > 0 ? parts.join(': ') : fallback
  return new Error(`raccoon: ${text}`)
}

/** 发一次 JSON 请求并解析信封。 */
async function postJson(
  url: string,
  body: Record<string, unknown>,
  fetcher: typeof fetch,
  headers: Record<string, string> = {},
): Promise<{ envelope: RaccoonEnvelope; status: number }> {
  let response: Response
  try {
    response = await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(RACCOON_REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    // 落盘：网络层异常（超时/DNS/连接拒绝）原先全部不可见
    appendRaccoonDebugLog({ event: 'http-error', url, error: String(error) })
    throw new Error(
      `raccoon: 请求失败：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    appendRaccoonDebugLog({ event: 'http-non-json', url, httpStatus: response.status })
    throw new Error(`raccoon: 响应不是 JSON（HTTP ${response.status}）`)
  }
  // 落盘：每次原始响应（脱敏截断）——诊断「扫码确认瞬间服务端到底回了什么」的关键现场
  appendRaccoonDebugLog({
    event: 'http',
    url,
    httpStatus: response.status,
    body: scrubBody(JSON.stringify(parsed)),
  })
  return { envelope: parseEnvelope(parsed, response.status), status: response.status }
}

/**
 * 生成一个扫码用的 `qrcode_code`（32 位小写 hex = 16 字节随机）。
 *
 * ⚠️ **仅作渲染占位/测试兜底**：主流程的 code 由服务端下发
 * （`requestRaccoonQrSession`），本地自造 code 轮询旧 web/auth 域永远 pending。
 * 依据客户端：`CryptoJS.lib.WordArray.random(16)`（渲染层模块 68284 的 `yl()`）。
 */
export function generateQrCode(): string {
  return randomBytes(16).toString('hex')
}

/**
 * 向 IAM 域申请扫码会话（服务端下发 code）。
 *
 * ⚠️ **扫码登录必须走 IAM 域**（实测 2026-10-29，见 spec.md）：
 * `POST /api/iam/v1/auth/mp/qrcode` → `{code:0, data:{qrcode_code, scan_path, expires_in}}`。
 * 旧的 web/auth 域 `login_with_qrcode_code` 对任意随机 code 都返回 pending、
 * 永不 success——这正是「扫码后无法登录」的根源。
 */
export async function requestRaccoonQrSession(
  product: RaccoonProduct,
  fetcher: typeof fetch = fetch,
): Promise<RaccoonQrSession> {
  const { envelope, status } = await postJson(
    `${product.apiBase}${RACCOON_IAM_PREFIX}/auth/mp/qrcode`,
    {},
    fetcher,
  )
  if (envelope.code !== 0 || envelope.data === undefined) {
    throw envelopeError(envelope, `申请扫码二维码失败（HTTP ${status}）`)
  }
  const code = typeof envelope.data.qrcode_code === 'string' ? envelope.data.qrcode_code : ''
  const scanPath = typeof envelope.data.scan_path === 'string' ? envelope.data.scan_path : ''
  if (code.length === 0 || !scanPath.startsWith('/')) {
    throw new Error('raccoon: 扫码二维码响应不合法（qrcode_code / scan_path 缺失）')
  }
  const expiresIn = typeof envelope.data.expires_in === 'number' && envelope.data.expires_in > 0
    ? envelope.data.expires_in * 1000
    : 5 * 60 * 1000
  return { code, scanPath, expiresMs: expiresIn }
}

/**
 * 构造二维码承载的微信登录页 URL。
 *
 * ⚠️ 编码的是**扫描 URL**（不是 code 本身），且 `scan_path` 必须用
 * **服务端下发的值**（`requestRaccoonQrSession` 返回的 `scanPath`）——
 * 上游可以改扫码页路径，写死 `/login/mp` 会让扫码后的授权对不上 code。
 * 依据 spec 实测：
 * `` `${base}${scan_path}?code=${code}&appname=商汤小浣熊官网&source=platform` ``。
 * 浏览器里 GET 该 URL 会 404 是正常的——它只对微信客户端有意义。
 */
export function buildQrImageUrl(product: RaccoonProduct, code: string, scanPath = '/login/mp'): string {
  const params = new URLSearchParams({
    code,
    appname: '商汤小浣熊官网',
    source: 'platform',
  })
  return `${product.apiBase}${scanPath}?${params.toString()}`
}

/**
 * 轮询一次扫码登录状态（IAM 域）。
 *
 * ⚠️ **必须轮询 IAM 域** `POST /api/iam/v1/auth/mp/qrcode/login`
 * （body `{qrcode_code}`，code 来自服务端下发）；旧 web/auth 域
 * `login_with_qrcode_code` 对任意 code 永远 pending（实测 2026-10-29）。
 *
 * ⚠️ **任何异常都降级为 `pending`**（网络抖动、响应畸形、限流、未知状态）：
 * 轮询是 2 秒一次的循环，偶发失败不应中断流程。**业务失败（code 非 0）
 * 绝不能归为「码失效」** —— IAM 域的 success 是**一次性消费**：用户确认后，
 * 堆积的并发轮询会拿到「二维码已被使用」的业务错误（实测 2026-11-19），
 * 若据此换码，会把刚确认成功的登录毁掉。真正的失效由
 * `data.status === 'expired' / 'canceled'` 显式表达。
 */
export async function pollRaccoonQrLogin(
  product: RaccoonProduct,
  code: string,
  fetcher: typeof fetch = fetch,
): Promise<RaccoonQrPollResult> {
  let envelope: RaccoonEnvelope
  try {
    const result = await postJson(
      `${product.apiBase}${RACCOON_IAM_PREFIX}/auth/mp/qrcode/login`,
      { qrcode_code: code },
      fetcher,
    )
    envelope = result.envelope
  } catch (error) {
    appendRaccoonDebugLog({ event: 'poll-network-suppressed', error: String(error) })
    return { status: 'pending' }
  }
  if (envelope.code !== 0 || envelope.data === undefined) {
    // 落盘：被吞掉的业务失败原文（「已被使用」/「请求已结束」等都藏在这里，
    // 是诊断一次性消费竞态的核心证据）
    appendRaccoonDebugLog({
      event: 'poll-biz-failure-suppressed',
      code: envelope.code,
      message: envelope.message,
      details: envelope.details,
    })
    return { status: 'pending' }
  }

  const raw = envelope.data.status
  const status = typeof raw === 'string' ? raw : ''
  const expiredAt = typeof envelope.data.expired_at === 'string' ? envelope.data.expired_at : undefined

  if (status === RACCOON_QR_STATUS.canceled) return { status: 'canceled' }
  if (status === RACCOON_QR_STATUS.expired) return { status: 'expired' }
  if (status === RACCOON_QR_STATUS.logging) {
    return { status: 'logging', ...expiredAt !== undefined ? { expiredAt } : {} }
  }
  if (status === RACCOON_QR_STATUS.success) {
    const accessToken = typeof envelope.data.access_token === 'string' ? envelope.data.access_token : ''
    const refreshToken = typeof envelope.data.refresh_token === 'string' ? envelope.data.refresh_token : ''
    // ⚠️ 缺 token 的 success 视为未完成：否则会产出空凭据并让流程卡死
    if (accessToken.length === 0) {
      // 落盘：success 却缺 token——服务端行为与本地假设不符的现场（code 已被消费！）
      appendRaccoonDebugLog({
        event: 'poll-success-missing-token',
        dataKeys: Object.keys(envelope.data).sort().join(','),
      })
      return { status: 'pending' }
    }
    const expMs = decodeJwtExpMs(accessToken)
    return {
      status: 'success',
      accessToken,
      refreshToken,
      ...expMs !== undefined ? { expiresAt: String(expMs) } : {},
    }
  }
  return { status: 'pending' }
}

/**
 * 下发短信验证码。
 *
 * ⚠️ 手机号必须 AES-128-CFB 加密（否则 `100003 params_encryted_error`）。
 * ⚠️ `captcha_param` 是阿里云滑块验证码的产物，**必需**（否则
 * `100006 captcha_verify_error`）。
 */
export async function sendRaccoonSmsCode(
  product: RaccoonProduct,
  phone: string,
  captchaParam: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const { envelope } = await postJson(
    `${product.apiBase}${product.authApiPrefix}/send_sms`,
    {
      captcha_param: captchaParam,
      nation_code: '86',
      phone: encryptRaccoonPhone(phone),
    },
    fetcher,
  )
  if (envelope.code !== 0) {
    if (envelope.code === 100006) {
      throw new Error('raccoon: 图形验证码校验失败，请重新完成滑块验证')
    }
    throw envelopeError(envelope, '下发短信验证码失败')
  }
}

/**
 * 用短信验证码登录。
 *
 * @returns 完整凭据（`expires_at` 由 JWT 的 exp 推算）。
 * @throws 验证码错误/过期、手机号非法、网络失败。
 */
export async function loginRaccoonWithSmsCode(
  product: RaccoonProduct,
  phone: string,
  smsCode: string,
  fetcher: typeof fetch = fetch,
): Promise<RaccoonCredential> {
  const { envelope } = await postJson(
    `${product.apiBase}${product.authApiPrefix}/login_with_sms`,
    {
      nation_code: '86',
      phone: encryptRaccoonPhone(phone),
      sms_code: smsCode,
    },
    fetcher,
  )
  if (envelope.code !== 0) throw envelopeError(envelope, '短信登录失败')
  return credentialFromEnvelope(envelope)
}

/** 从成功信封里取出凭据；缺 `access_token` 时抛错（不产出半截凭据）。 */
function credentialFromEnvelope(envelope: RaccoonEnvelope): RaccoonCredential {
  const data = envelope.data ?? {}
  const accessToken = typeof data.access_token === 'string' ? data.access_token : ''
  const refreshToken = typeof data.refresh_token === 'string' ? data.refresh_token : ''
  if (accessToken.length === 0) {
    throw new Error('raccoon: 登录响应缺少 access_token')
  }
  const expMs = decodeJwtExpMs(accessToken)
  const officeIdentity = typeof data.office_identity === 'string' ? data.office_identity : ''
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    ...expMs !== undefined ? { expires_at: String(expMs) } : {},
    ...officeIdentity.length > 0 ? { office_identity: officeIdentity } : {},
  }
}

/**
 * 用授权码换取凭据（官方桌面端链路）。
 *
 * 本插件**当前不走这条路**（收不到自定义协议回调），保留它是为了让
 * 「官方链路」有可单测的落点，并在将来支持自定义协议时可直接复用。
 */
export async function exchangeRaccoonAuthorizationCode(
  product: RaccoonProduct,
  authorizationCode: string,
  fetcher: typeof fetch = fetch,
): Promise<RaccoonCredential> {
  const { envelope } = await postJson(
    `${product.apiBase}${product.authApiPrefix}/login_with_authorization_code`,
    { authorization_code: authorizationCode },
    fetcher,
  )
  if (envelope.code !== 0) {
    // 官方约定：200035 = 授权码不存在/过期/已消费
    if (envelope.code === 200035) {
      throw new Error('raccoon: 授权码已失效，请重新发起登录')
    }
    throw envelopeError(envelope, '授权码登录失败')
  }
  return credentialFromEnvelope(envelope)
}

/**
 * 用 refresh_token 换新凭据。
 *
 * ⚠️ 服务端可能**只返回新的 access_token**（不带新 refresh_token），
 * 此时必须**保留旧值** —— 否则续期一次就把账号变成不可续期。
 * ⚠️ 服务端不返回的附加字段（昵称、身份、设备号）也要保留。
 * ⚠️ 401 表示 refresh_token 已失效，**抛「请重新登录」且不重试**。
 */
export async function refreshRaccoonCredential(
  product: RaccoonProduct,
  credential: RaccoonCredential,
  fetcher: typeof fetch = fetch,
): Promise<RaccoonCredential> {
  const { envelope, status } = await postJson(
    `${product.apiBase}${product.authApiPrefix}/refresh`,
    { refresh_token: credential.refresh_token },
    fetcher,
  )
  if (status === 401 || envelope.code === 200003) {
    throw new Error('raccoon: 登录态已过期，请重新登录')
  }
  if (envelope.code !== 0) throw envelopeError(envelope, '续期失败')

  const data = envelope.data ?? {}
  const accessToken = typeof data.access_token === 'string' ? data.access_token : ''
  if (accessToken.length === 0) {
    throw new Error('raccoon: 续期响应缺少 access_token')
  }
  const nextRefresh = typeof data.refresh_token === 'string' && data.refresh_token.length > 0
    ? data.refresh_token
    : credential.refresh_token
  const expMs = decodeJwtExpMs(accessToken)
  return {
    ...credential,
    access_token: accessToken,
    refresh_token: nextRefresh,
    ...expMs !== undefined ? { expires_at: String(expMs) } : {},
  }
}

/**
 * 拉取用户信息（展示用）。
 *
 * ⚠️ 失败时返回**空对象**而不是抛错：用户信息只用于昵称展示，
 * 不该因为它失败而让整个登录流程失败（登录已经成功了）。
 *
 * ⚠️ `nickname` 取的是远端的 `name`，而**它是服务端自动生成的默认名**
 *（实测 `RaccoonAva`），微信扫码不回传微信昵称 —— 故多账号消歧要靠 `phone`。
 */
export async function fetchRaccoonUserInfo(
  product: RaccoonProduct,
  credential: RaccoonCredential,
  fetcher: typeof fetch = fetch,
): Promise<{ userId?: string; nickname?: string; officeIdentity?: string; phone?: string }> {
  try {
    const response = await fetcher(`${product.apiBase}${product.authApiPrefix}/user_info`, {
      method: 'GET',
      headers: raccoonHeaders(credential),
      signal: AbortSignal.timeout(RACCOON_REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) return {}
    const envelope = parseEnvelope(await response.json(), response.status)
    if (envelope.code !== 0 || envelope.data === undefined) return {}
    const userId = typeof envelope.data.id === 'string' ? envelope.data.id : ''
    const nickname = typeof envelope.data.name === 'string' ? envelope.data.name : ''
    const officeIdentity = typeof envelope.data.office_identity === 'string'
      ? envelope.data.office_identity
      : ''
    const phone = typeof envelope.data.phone === 'string' ? envelope.data.phone : ''
    return {
      ...userId.length > 0 ? { userId } : {},
      ...nickname.length > 0 ? { nickname } : {},
      ...officeIdentity.length > 0 ? { officeIdentity } : {},
      ...phone.length > 0 ? { phone } : {},
    }
  } catch {
    return {}
  }
}
