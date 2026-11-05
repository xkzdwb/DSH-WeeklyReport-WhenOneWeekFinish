// 把会话日志折成「这一周」的用量与工作汇总。
// 只按事件时间过滤（不是整会话），所以跨周的会话也能算对：上周写的还在日志里，
// 但只有落在窗口内的 assistant/message 才计数。
import { formatDate, wallClockOf } from './schedule.mjs'

const EMPTY_TOKENS = () => ({ calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

function num(input) {
  const n = Number(input)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function totalOf(tokens) {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite
}

function addCounts(target, tokens, calls) {
  target.calls += calls
  target.input += num(tokens.input)
  target.output += num(tokens.output)
  target.cacheRead += num(tokens.cacheRead)
  target.cacheWrite += num(tokens.cacheWrite)
}

function addTokens(target, tokens) {
  addCounts(target, tokens, 1)
}

/** 单价行：先按 `provider/model` 精确匹配，再退回 model，最后 default。 */
export function rateFor(pricing, key) {
  const exact = pricing.models?.[key]
  if (exact !== undefined) return exact
  const model = key.includes('/') ? key.slice(key.indexOf('/') + 1) : key
  const byModel = pricing.models?.[model]
  if (byModel !== undefined) return byModel
  return pricing.default
}

/** 费用（币种由配置决定，单价是「每 100 万 token」）。 */
export function costOf(pricing, key, tokens) {
  const rate = rateFor(pricing, key)
  return (
    (num(tokens.input) * rate.input +
      num(tokens.output) * rate.output +
      num(tokens.cacheRead) * rate.cacheRead +
      num(tokens.cacheWrite) * rate.cacheWrite) /
    1e6
  )
}

/** 会话日志里 assistant/message 的来源键。 */
function modelKeyOf(data) {
  const source = data?.message?.source ?? {}
  return `${source.provider ?? 'unknown'}/${source.model ?? 'unknown'}`
}

/** 把一条 user/message 里的文本拼出来（内容块可能是 text / image / 其它）。 */
export function textOfMessage(data) {
  const content = data?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'image') parts.push('[图片]')
    else if (typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join(' ').trim()
}

/**
 * 邮件只引用「首条请求」，而请求里可能粘过 API key / 令牌 / 密码。
 * 这里做一次兜底打码：宁可在邮件里多几个「已隐去」，也不要把密钥带进邮箱。
 */
const SECRET_RULES = [
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}\b/g, '[已隐去密钥]'],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, '[已隐去令牌]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g, '[已隐去令牌]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[已隐去密钥]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[已隐去令牌]'],
  [/\b[A-Fa-f0-9]{32,}\b/g, '[已隐去长串]'],
  [/((?:api[_-]?key|access[_-]?key|token|secret|password|passwd|pwd|授权码|密码|口令)\s*[:=：]\s*)(?!\[)\S{6,}/gi, '$1[已隐去]'],
]

/** 把疑似密钥替换成占位文字。 */
export function redactSecrets(text) {
  let out = String(text ?? '')
  for (const [pattern, replacement] of SECRET_RULES) out = out.replace(pattern, replacement)
  return out
}

/** 压成一行，供邮件里当「首条请求」引用。 */
export function condense(text, limit) {
  const clean = redactSecrets(String(text ?? ''))
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  if (clean.length <= limit) return clean
  return `${clean.slice(0, Math.max(0, limit - 1)).trimEnd()}…`
}

function isSubagentHeader(header) {
  return (
    header?.origin === 'subagent' ||
    header?.parentSession !== undefined ||
    (Number(header?.delegationDepth) || 0) > 0
  )
}

function projectName(cwd) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return '(未知工作区)'
  const trimmed = cwd.replace(/[\\/]+$/, '')
  const base = trimmed.split(/[\\/]/).filter(Boolean).pop()
  return base === undefined || base === '' ? trimmed : base
}

/**
 * 把「按天」补成连续日期：一周里没用的那天也要有一行 0，柱状图才不会跳过日期。
 * 窗口超过 93 天就不补了（不值得为长窗口造一堆空行）。
 */
function fillDays(rows, from, to, timeZone) {
  if (rows.length === 0) return []
  const byKey = new Map(rows.map((row) => [row.day, row]))
  const start = wallClockOf(from, timeZone)
  const endClock = wallClockOf(Math.max(from, to - 1), timeZone)
  const startWall = Date.UTC(start.year, start.month - 1, start.day)
  const endWall = Date.UTC(endClock.year, endClock.month - 1, endClock.day)
  const pad = (n) => String(n).padStart(2, '0')
  const keys = []
  for (let wall = startWall; wall <= endWall; wall += 86_400_000) {
    const date = new Date(wall)
    keys.push(`${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`)
  }
  if (keys.length === 0 || keys.length > 93) {
    return rows.slice().sort((a, b) => (a.day < b.day ? -1 : 1))
  }
  return keys.map(
    (key) => byKey.get(key) ?? { day: key, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
  )
}

/**
 * 折一个时间窗口。
 * @param sessions - [{ id, header, events }]，来自 ctx.sessionQuery.readSession。
 * @param options - { from, to, pricing, timeZone, promptChars }
 */
export function foldWindow(sessions, { from, to, pricing, timeZone, promptChars = 140 }) {
  const totals = {
    ...EMPTY_TOKENS(),
    total: 0,
    cost: 0,
    sessions: 0,
    rootSessions: 0,
    subagentSessions: 0,
    messages: 0,
    userMessages: 0,
    toolCalls: 0,
  }
  const byModel = new Map()
  const byDay = new Map()
  const tools = new Map()
  const conversations = []

  for (const session of sessions) {
    const header = session?.header ?? {}
    const events = Array.isArray(session?.events) ? session.events : []
    let cwd = typeof header.cwd === 'string' ? header.cwd : undefined
    let title
    const byModelSession = new Map()
    const toolsSession = new Map()
    let prompt
    let firstAt
    let lastAt
    let messages = 0
    let userMessages = 0

    for (const event of events) {
      if (event === null || typeof event !== 'object') continue
      if (event.type === 'session' && cwd === undefined && typeof event.cwd === 'string') cwd = event.cwd

      // 标题不按窗口过滤：标题是会话级元数据，哪怕生在窗口外也照样拿来当名字。
      if (event.type === 'session/title') {
        const candidate = event.data?.title
        if (typeof candidate === 'string' && candidate.trim() !== '') title = redactSecrets(candidate.trim())
        continue
      }

      const time = Number(event.time)
      if (!Number.isFinite(time) || time < from || time >= to) continue

      if (event.type === 'assistant/message') {
        messages += 1
        if (firstAt === undefined || time < firstAt) firstAt = time
        if (lastAt === undefined || time > lastAt) lastAt = time
        const usage = event.data?.usage
        if (usage === null || typeof usage === 'undefined') continue
        const key = modelKeyOf(event.data)
        const tokens = {
          input: num(usage.inputTokens),
          output: num(usage.outputTokens),
          cacheRead: num(usage.cacheReadTokens),
          cacheWrite: num(usage.cacheWriteTokens),
        }
        let entry = byModelSession.get(key)
        if (entry === undefined) {
          entry = EMPTY_TOKENS()
          byModelSession.set(key, entry)
        }
        addTokens(entry, tokens)

        let model = byModel.get(key)
        if (model === undefined) {
          model = { key, ...EMPTY_TOKENS() }
          byModel.set(key, model)
        }
        addTokens(model, tokens)

        const dayKey = formatDate(time, timeZone)
        let day = byDay.get(dayKey)
        if (day === undefined) {
          day = { day: dayKey, ...EMPTY_TOKENS(), total: 0, cost: 0 }
          byDay.set(dayKey, day)
        }
        addTokens(day, tokens)
        day.cost += costOf(pricing, key, tokens)
        continue
      }

      if (event.type === 'user/message') {
        if (event.data?.source?.kind !== 'user') continue
        userMessages += 1
        if (firstAt === undefined || time < firstAt) firstAt = time
        if (lastAt === undefined || time > lastAt) lastAt = time
        if (prompt === undefined) {
          const text = textOfMessage(event.data)
          if (text !== '') prompt = text
        }
        continue
      }

      if (event.type === 'tool/call') {
        const name = event.data?.name
        if (typeof name !== 'string' || name === '') continue
        toolsSession.set(name, (toolsSession.get(name) ?? 0) + 1)
      }
    }

    let conversationToolCalls = 0
    for (const [name, count] of toolsSession) {
      tools.set(name, (tools.get(name) ?? 0) + count)
      conversationToolCalls += count
    }

    if (messages === 0 && userMessages === 0 && conversationToolCalls === 0) continue

    const conversation = {
      id: String(session?.id ?? header.id ?? ''),
      title: title ?? undefined,
      prompt: prompt === undefined ? undefined : condense(prompt, promptChars),
      cwd,
      project: projectName(cwd),
      firstAt,
      lastAt,
      messages,
      userMessages,
      tokens: { ...EMPTY_TOKENS() },
      total: 0,
      cost: 0,
      models: [],
      toolCalls: conversationToolCalls,
      subagent: isSubagentHeader(header) || undefined,
    }

    for (const [key, tokens] of byModelSession) {
      addCounts(conversation.tokens, tokens, tokens.calls)
      conversation.models.push({ key, ...tokens })
      conversation.cost += costOf(pricing, key, tokens)
    }

    conversation.total = totalOf(conversation.tokens)
    conversations.push(conversation)

    totals.sessions += 1
    if (conversation.subagent === true) totals.subagentSessions += 1
    else totals.rootSessions += 1
    totals.messages += messages
    totals.userMessages += userMessages
    totals.toolCalls += conversationToolCalls
    addCounts(totals, conversation.tokens, conversation.tokens.calls)
    totals.cost += conversation.cost
  }

  totals.total = totalOf(totals)
  totals.cost = round4(totals.cost)

  const modelRows = [...byModel.values()]
    .map((entry) => ({
      ...entry,
      total: totalOf(entry),
      cost: round4(costOf(pricing, entry.key, entry)),
    }))
    .sort((a, b) => b.cost - a.cost || b.total - a.total)

  const dayRows = fillDays([...byDay.values()], from, to, timeZone).map((day) => ({
    ...day,
    total: totalOf(day),
    cost: round4(day.cost),
  }))

  const toolRows = [...tools.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))

  return { totals, byModel: modelRows, byDay: dayRows, tools: toolRows, conversations }
}

/** 按项目分组，截断到 topProjects / sessionsPerProject。 */
export function groupProjects(conversations, { topProjects, sessionsPerProject }) {
  const projects = new Map()
  for (const conversation of conversations) {
    const key = conversation.cwd ?? conversation.project
    let project = projects.get(key)
    if (project === undefined) {
      project = {
        cwd: conversation.cwd,
        name: conversation.project,
        conversations: [],
        tokens: { ...EMPTY_TOKENS() },
        total: 0,
        cost: 0,
      }
      projects.set(key, project)
    }
    project.conversations.push(conversation)
    addCounts(project.tokens, conversation.tokens, conversation.tokens.calls)
    project.cost += conversation.cost
  }

  const rows = [...projects.values()]
    .map((project) => {
      const sorted = project.conversations
        .slice()
        .sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0) || b.cost - a.cost)
      return {
        ...project,
        total: totalOf(project.tokens),
        cost: round4(project.cost),
        conversationCount: sorted.length,
        hiddenConversations: Math.max(0, sorted.length - sessionsPerProject),
        conversations: sorted.slice(0, sessionsPerProject),
      }
    })
    .sort((a, b) => b.cost - a.cost || b.total - a.total)

  const kept = rows.slice(0, topProjects)
  const rest = rows.slice(topProjects)
  return {
    projects: kept,
    hidden: {
      count: rest.length,
      sessions: rest.reduce((sum, project) => sum + project.conversationCount, 0),
      cost: round4(rest.reduce((sum, project) => sum + project.cost, 0)),
      total: rest.reduce((sum, project) => sum + project.total, 0),
    },
  }
}

/**
 * 组装整份周报。
 * @param sessions - 全部会话（[{ id, header, events }]）。
 * @param options - { from, to, days, pricing, timeZone, topProjects, sessionsPerProject, topTools, promptChars, previous }
 */
export function buildReport(sessions, options) {
  const {
    from,
    to,
    days,
    pricing,
    timeZone,
    topProjects,
    sessionsPerProject,
    topTools,
    promptChars,
    previous,
  } = options
  const current = foldWindow(sessions, { from, to, pricing, timeZone, promptChars })
  const grouped = groupProjects(current.conversations, { topProjects, sessionsPerProject })

  let compare
  if (previous !== undefined && previous !== null) {
    const folded = foldWindow(sessions, {
      from: previous.from,
      to: previous.to,
      pricing,
      timeZone,
      promptChars,
    })
    compare = { from: previous.from, to: previous.to, totals: folded.totals }
  }

  return {
    from,
    to,
    days,
    timeZone,
    generatedAt: Date.now(),
    totals: current.totals,
    byModel: current.byModel,
    byDay: current.byDay,
    tools: current.tools.slice(0, topTools),
    projects: grouped.projects,
    hidden: grouped.hidden,
    previous: compare,
  }
}

function round4(value) {
  return Math.round(value * 10000) / 10000
}

export { round4, totalOf, EMPTY_TOKENS }
