/**
 * Raccoon 登录链路调试日志（JSON Lines，追加写）。
 *
 * ## 为什么需要落盘日志
 *
 * 桌面版服务进程**没有任何文件日志**：登录页的每次轮询结果、IAM 域的原始
 * 响应、防抖计数与换码决策原先全部不可见——「第一次登录成功后二维码仍被
 * 换、新码再扫失败」这类**时序竞态**没有现场就无从定位（实测 2026-11-19，
 * 连续三轮修复仍未根治）。本模块把关键事件追加写到数据目录的
 * `raccoon-login-debug.log`（一行一个 JSON 事件），用户复现一次问题后把
 * 该文件交给开发者即可精确还原服务端行为序列。
 *
 * ## 约束
 *
 * - **静默失败**：日志写入绝不能影响登录流程本身（包 try/catch）。
 * - **脱敏**：`access_token` / `refresh_token` 等 token 字段截断脱敏后再落盘。
 * - **截断**：单条正文上限 1200 字符（IAM 响应含 JWT，整条落盘既臃肿也有泄密面）。
 * - **目录**：`OFM_HOME`（桌面版数据目录）→ `DSH_HOME` → `~/.our-free-model`，
 *   与桌面版服务进程的数据目录解析保持一致。
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 单条日志正文的最大长度（超过截断）。 */
const MAX_BODY_LENGTH = 1200

/** 解析日志目录（与桌面版数据目录同源）。 */
function resolveLogDir(): string {
  const fromEnv = process.env.OFM_HOME?.trim() || process.env.DSH_HOME?.trim()
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  return join(homedir(), '.our-free-model')
}

/** 把 JSON 文本里的 token 值脱敏（保留前 12 字符用于人工比对）。 */
function scrubTokens(text: string): string {
  return text.replace(
    /("(?:access_token|refresh_token|id_token|token|office_identity)"\s*:\s*")([^"]{0,12})[^"]*(")/g,
    '$1$2…$3',
  )
}

/** 脱敏 + 截断一段正文。 */
function scrubBody(text: string): string {
  const masked = scrubTokens(text)
  return masked.length > MAX_BODY_LENGTH ? `${masked.slice(0, MAX_BODY_LENGTH)}…(截断)` : masked
}

/**
 * 追加一条登录调试事件（JSON Lines）。
 *
 * 任何失败都静默——日志是诊断辅助，绝不能让登录流程因为它挂掉。
 */
export function appendRaccoonDebugLog(event: Record<string, unknown>): void {
  try {
    const dir = resolveLogDir()
    mkdirSync(dir, { recursive: true })
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`
    appendFileSync(join(dir, 'raccoon-login-debug.log'), line, 'utf-8')
  } catch {
    // 静默：日志失败不影响登录
  }
}

/** 脱敏并截断一段响应/请求正文（供调用方组装事件用）。 */
export { scrubBody }
