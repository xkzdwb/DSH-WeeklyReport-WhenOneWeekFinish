// 配置读取：profile patch 里的 config（可能是 cordis 的即时引用）拍平成普通对象，
// 再把 secrets 文件里的授权码叠进来。授权码不出现在 yml、日志、邮件里。
import { readFileSync } from 'node:fs'

/** 163 邮箱的 SMTP 参数（本插件就是为它写的；换邮箱改 smtp 三项即可）。 */
const DEFAULT_SMTP = { host: 'smtp.163.com', port: 465, secure: true, starttls: false }

export const DEFAULTS = {
  address: 'sender@example.com',  // 发信账号（换成你的邮箱；授权码请放进 secretsFile）
  to: '',                        // 收件人，必填
  displayName: 'DSH 周报',
  subjectPrefix: '[DSH 周报]',
  secretsFile: '',               // {"authCode":"…"}；也可直接在 config.authCode 里写
  authCode: '',
  smtp: DEFAULT_SMTP,
  // 发送时刻：weekday 用 JS 的 0=周日 … 6=周六；time 是当地 24 小时制。
  // 「周六晚上凌晨 0 点」= 周日 00:00，所以默认 0 / 00:00。
  weekday: 0,
  time: '00:00',
  timeZone: 'Asia/Shanghai',
  catchUp: true,                 // 到点时 DSH 没开：下次启动补发一次（主题带「补发」）
  windowDays: 7,                 // 邮件覆盖最近多少天（到发送时刻为止）
  tickIntervalMs: 60000,         // 多久检查一次是否到点
  maxSessions: 2000,             // 最多折多少个会话日志
  topProjects: 6,                // 「工作汇总」最多列几个项目
  sessionsPerProject: 6,         // 每个项目最多列几个会话
  topTools: 5,                   // 工具调用 Top N
  promptChars: 140,              // 每个会话引用首条请求的字数上限
  currency: 'CNY',
  // 每 100 万 token 的价格；和 04-统计插件（usage-stats 面板）的默认值一致，
  // 这样邮件里的费用和面板上的数字对得上。
  pricing: {
    default: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 },
    models: {},
  },
  stateFile: '',                 // 上次发送时间等状态；留空 = 插件目录 state.json
  auditFile: '',                 // 每次发送的审计行；留空 = 插件目录 audit/sent.jsonl
  dryRun: false,                 // true = 到点只写日志/审计，不真的投信
}

/** cordis 的 Config 字段可能是即时引用（.get()），也可能已是纯值。 */
function value(input, fallback) {
  const raw = input !== null && typeof input === 'object' && typeof input.get === 'function' ? input.get() : input
  return raw === undefined || raw === null ? fallback : raw
}

/** 把可能来自 yml 的对象拍平成正对象（只拍一层，够 yml 用）。 */
function plain(input) {
  const raw = value(input, undefined)
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const key of Object.keys(raw)) out[key] = value(raw[key], undefined)
  return out
}

function bool(input, fallback) {
  const raw = value(input, fallback)
  return raw === true || raw === 'true' || raw === 1
}

function numberOr(input, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER, integer = false } = {}) {
  const raw = Number(value(input, fallback))
  if (!Number.isFinite(raw)) return fallback
  const clamped = Math.min(max, Math.max(min, raw))
  return integer ? Math.round(clamped) : clamped
}

/** "HH:MM" → { hour, minute }；非法值抛错（配置错了要立刻看见，而不是默默半夜不发）。 */
export function parseTimeOfDay(text) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text).trim())
  if (match === null) throw new Error(`config.time 必须是 HH:MM，现在是 ${JSON.stringify(text)}`)
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) throw new Error(`config.time 超出范围（00:00–23:59）：${JSON.stringify(text)}`)
  return { hour, minute }
}

/** 时区是否被 Intl 认识；写错时区会让定时算错，所以直接报错。 */
export function assertTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date())
  } catch (error) {
    throw new Error(`config.timeZone 不是合法时区 ${JSON.stringify(timeZone)}：${error?.message ?? error}`)
  }
}

function readPricing(input) {
  const section = plain(input)
  const base = DEFAULTS.pricing.default
  const readOne = (raw) => {
    const one = plain(raw)
    return {
      input: numberOr(one.input, base.input),
      output: numberOr(one.output, base.output),
      cacheRead: numberOr(one.cacheRead, base.cacheRead),
      cacheWrite: numberOr(one.cacheWrite, base.cacheWrite),
    }
  }
  const models = {}
  const declared = plain(section.models)
  for (const [key, rate] of Object.entries(declared)) models[key] = readOne(rate)
  return { default: readOne(section.default), models }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * 读取有效配置。
 * @param rawConfig - cordis 传入的 config。
 * @returns 归一化后的配置（含从 secrets 文件读到的授权码）。
 * @throws 配置非法时抛错；apply() 会兜住并在 HOST 日志里说明原因。
 */
export function readSettings(rawConfig) {
  const input = rawConfig ?? {}
  const smtp = { ...DEFAULT_SMTP, ...plain(input.smtp) }

  const address = String(value(input.address, DEFAULTS.address)).trim()
  if (!EMAIL.test(address)) throw new Error(`config.address 必须是完整邮箱地址，现在是 ${JSON.stringify(address)}`)

  const to = String(value(input.to, DEFAULTS.to)).trim()
  if (!EMAIL.test(to)) {
    throw new Error(`config.to 必须是完整邮箱地址（周报发给谁），现在是 ${JSON.stringify(to)}`)
  }

  const secretsFile = String(value(input.secretsFile, DEFAULTS.secretsFile)).trim()
  let secrets = {}
  if (secretsFile !== '') {
    try {
      secrets = JSON.parse(readFileSync(secretsFile, 'utf8'))
    } catch (error) {
      throw new Error(`读取 secretsFile 失败（${secretsFile}）：${error?.message ?? error}`)
    }
  }

  const authCode = String(value(input.authCode, secrets.authCode ?? DEFAULTS.authCode)).trim()
  if (authCode === '') throw new Error('缺少邮箱授权码：在 config.authCode 或 secretsFile 的 authCode 里给一个')

  const timeZone = String(value(input.timeZone, DEFAULTS.timeZone))
  assertTimeZone(timeZone)
  const { hour, minute } = parseTimeOfDay(value(input.time, DEFAULTS.time))

  return {
    address,
    to,
    user: String(value(input.user, secrets.user ?? address)).trim(),
    authCode,
    displayName: String(value(input.displayName, DEFAULTS.displayName)),
    subjectPrefix: String(value(input.subjectPrefix, DEFAULTS.subjectPrefix)),
    smtp: {
      host: String(smtp.host),
      port: Number(smtp.port),
      secure: smtp.secure !== false,
      starttls: bool(smtp.starttls, false),
    },
    weekday: numberOr(value(input.weekday, DEFAULTS.weekday), DEFAULTS.weekday, { min: 0, max: 6, integer: true }),
    hour,
    minute,
    timeZone,
    catchUp: bool(input.catchUp, DEFAULTS.catchUp),
    windowDays: numberOr(input.windowDays, DEFAULTS.windowDays, { min: 1, max: 365, integer: true }),
    tickIntervalMs: numberOr(input.tickIntervalMs, DEFAULTS.tickIntervalMs, { min: 5000, max: 3600000, integer: true }),
    maxSessions: numberOr(input.maxSessions, DEFAULTS.maxSessions, { min: 1, max: 100000, integer: true }),
    topProjects: numberOr(input.topProjects, DEFAULTS.topProjects, { min: 1, max: 50, integer: true }),
    sessionsPerProject: numberOr(input.sessionsPerProject, DEFAULTS.sessionsPerProject, { min: 1, max: 50, integer: true }),
    topTools: numberOr(input.topTools, DEFAULTS.topTools, { min: 0, max: 50, integer: true }),
    promptChars: numberOr(input.promptChars, DEFAULTS.promptChars, { min: 20, max: 1000, integer: true }),
    currency: String(value(input.currency, DEFAULTS.currency)),
    pricing: readPricing(input.pricing),
    stateFile: String(value(input.stateFile, DEFAULTS.stateFile)),
    auditFile: String(value(input.auditFile, DEFAULTS.auditFile)),
    dryRun: bool(input.dryRun, DEFAULTS.dryRun),
  }
}
