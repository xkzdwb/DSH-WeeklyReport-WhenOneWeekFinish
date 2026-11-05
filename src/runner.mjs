// 定时器 + 状态机：到点（或补发）→ 读会话 → 折周报 → 发信 → 记账。
// 依赖全部从外面注入，测试里可以换掉时钟/时钟/发信，不联网也能跑完整流程。
import { buildReport } from './collect.mjs'
import { describeSchedule, formatInZone, nextOccurrence, previousOccurrence, DAY_MS } from './schedule.mjs'
import { renderHtml, renderSubject, renderText } from './report.mjs'

const RETRY_MS = 10 * 60_000
const MAX_RETRIES = 5

/**
 * 建一个周报运行器（不自动启动）。
 * @param options - { settings, deps }
 *   deps: { now, readSessions, send, loadState, saveState, appendAudit, log, stateFile, auditFile }
 */
export function createRunner({ settings, deps }) {
  const log = deps.log ?? (() => {})
  const now = deps.now ?? (() => Date.now())
  const scheduleOptions = {
    weekday: settings.weekday,
    hour: settings.hour,
    minute: settings.minute,
    timeZone: settings.timeZone,
  }

  let state = {}
  let nextDue = 0
  let timer
  let busy = false
  let stopped = false

  function persist() {
    try {
      deps.saveState(deps.stateFile, state)
    } catch (error) {
      log(`写状态文件失败：${error?.message ?? error}`)
    }
  }

  function audit(entry) {
    if (deps.appendAudit === undefined) return
    try {
      deps.appendAudit(deps.auditFile, entry)
    } catch (error) {
      log(`写审计失败：${error?.message ?? error}`)
    }
  }

  /** 到期的时刻：正常情况是下一次；如果错过了且允许补发，就是最近一次（过去时刻）。 */
  function computeDue(at) {
    if (settings.catchUp && state.lastSentAt !== undefined) {
      const recent = previousOccurrence(at, scheduleOptions)
      const installedAt = Number(state.installedAt) || 0
      if (state.lastSentAt < recent && installedAt <= recent) return recent
    }
    if (settings.catchUp && state.lastSentAt === undefined) {
      const recent = previousOccurrence(at, scheduleOptions)
      const installedAt = Number(state.installedAt) || 0
      // 装好之后一直没发过、而且已经错过至少一个发送时刻 → 补发最近一次。
      if (installedAt <= recent) return recent
    }
    return nextOccurrence(at, scheduleOptions)
  }

  function status(extra = {}) {
    return {
      schedule: describeSchedule(scheduleOptions),
      weekday: settings.weekday,
      time: `${String(settings.hour).padStart(2, '0')}:${String(settings.minute).padStart(2, '0')}`,
      timeZone: settings.timeZone,
      installedAt: state.installedAt,
      lastSentAt: state.lastSentAt,
      lastSentLocal: state.lastSentAt === undefined ? undefined : formatInZone(state.lastSentAt, settings.timeZone),
      lastPeriodEnd: state.lastPeriodEnd,
      lastError: state.lastError,
      sends: state.sends ?? 0,
      nextDue,
      nextRunLocal: nextDue === 0 ? undefined : formatInZone(nextDue, settings.timeZone),
      dryRun: settings.dryRun,
      to: settings.to,
      address: settings.address,
      ...extra,
    }
  }

  /** 读一次会话 → 折 → 渲染（不发信）。 */
  async function build({ periodEnd, days = settings.windowDays } = {}) {
    const to = periodEnd ?? nextDue ?? now()
    const spanDays = Math.max(1, Number(days) || settings.windowDays)
    const from = to - spanDays * DAY_MS
    const sessions = await deps.readSessions({ maxSessions: settings.maxSessions })
    const report = buildReport(sessions, {
      from,
      to,
      days: spanDays,
      pricing: settings.pricing,
      timeZone: settings.timeZone,
      topProjects: settings.topProjects,
      sessionsPerProject: settings.sessionsPerProject,
      topTools: settings.topTools,
      promptChars: settings.promptChars,
      previous: { from: from - spanDays * DAY_MS, to: from },
    })
    return { report, from, to }
  }

  /**
   * 生成并发送一份周报。
   * @param options - { periodEnd, days, catchUp, dryRun, reason }
   * @returns 结果摘要（含 messageId）；失败抛错。
   */
  async function send({ periodEnd, days, catchUp = false, dryRun = settings.dryRun, reason = 'scheduled' } = {}) {
    const startedAt = now()
    const { report, from, to } = await build({ periodEnd, days })
    const subject = renderSubject(report, settings, { catchUp })
    const nextAfter = nextOccurrence(now(), scheduleOptions)
    const text = renderText(report, settings, {
      catchUp,
      state: { nextRunLocal: formatInZone(nextAfter, settings.timeZone) },
    })
    const html = renderHtml(report, settings, {
      catchUp,
      state: { nextRunLocal: formatInZone(nextAfter, settings.timeZone) },
    })

    const summary = {
      periodStart: from,
      periodEnd: to,
      subject,
      sessions: report.totals.sessions,
      tokens: report.totals.total,
      cost: report.totals.cost,
      text,
      html,
      report,
    }

    if (dryRun) {
      log(`[dry-run] 不投信：${subject}`)
      audit({
        at: new Date(startedAt).toISOString(),
        kind: 'dry-run',
        reason,
        catchUp,
        subject,
        periodStart: from,
        periodEnd: to,
        sessions: summary.sessions,
        tokens: summary.tokens,
        cost: summary.cost,
        to: settings.to,
      })
      // dry-run 也算「这一轮处理过了」，否则每次 tick 都会再算一遍。
      state.lastSentAt = startedAt
      state.lastPeriodEnd = to
      state.sends = (Number(state.sends) || 0) + 1
      state.lastError = undefined
      persist()
      return { ...summary, dryRun: true }
    }

    const { messageId } = await deps.send({ subject, text, html })
    const finishedAt = now()

    state.lastSentAt = finishedAt
    state.lastPeriodEnd = to
    state.sends = (Number(state.sends) || 0) + 1
    state.lastError = undefined
    persist()
    audit({
      at: new Date(finishedAt).toISOString(),
      kind: 'sent',
      reason,
      catchUp,
      subject,
      periodStart: from,
      periodEnd: to,
      sessions: summary.sessions,
      tokens: summary.tokens,
      cost: summary.cost,
      to: settings.to,
      messageId,
      tookMs: finishedAt - startedAt,
    })
    log(`已发送：${subject}（${messageId}）`)
    return { ...summary, messageId, dryRun: false }
  }

  /** 一次到点检查；导出给测试用。 */
  async function tick() {
    if (busy || stopped) return false
    const at = now()
    if (nextDue === 0 || at < nextDue) return false
    busy = true
    const catchUp = at - nextDue > 60_000
    try {
      await send({ periodEnd: nextDue, catchUp, reason: catchUp ? 'catch-up' : 'scheduled' })
      state.retry = undefined
      persist()
      nextDue = nextOccurrence(now(), scheduleOptions)
      log(`下次发送：${formatInZone(nextDue, settings.timeZone)}`)
      return true
    } catch (error) {
      const attempts = (Number(state.retry?.attempts) || 0) + 1
      state.lastError = `${new Date(at).toISOString()} ${error?.message ?? error}`
      log(`发送失败（第 ${attempts} 次）：${error?.message ?? error}`)
      if (attempts <= MAX_RETRIES) {
        state.retry = { attempts, anchor: state.retry?.anchor ?? nextDue }
        nextDue = at + RETRY_MS
        log(`${Math.round(RETRY_MS / 60_000)} 分钟后重试`)
      } else {
        state.retry = undefined
        nextDue = nextOccurrence(now(), scheduleOptions)
        log(`连续失败 ${attempts} 次，放弃本次，下次发送：${formatInZone(nextDue, settings.timeZone)}`)
      }
      persist()
      return false
    } finally {
      busy = false
    }
  }

  /** 启动：载入状态、算第一次到期、开定时器；如果已经过期会立刻补发一次。 */
  async function start() {
    const at = now()
    const loaded = deps.loadState(deps.stateFile)
    if (loaded.error !== undefined) log(loaded.error)
    state = loaded.state
    if (state.installedAt === undefined) state.installedAt = at
    if (state.sends === undefined) state.sends = 0

    nextDue = computeDue(at)
    const catchUp = nextDue < at - 60_000
    persist()
    log(
      `已启动：${describeSchedule(scheduleOptions)}，下次 ${formatInZone(nextDue, settings.timeZone)}` +
        (catchUp ? '（已过期，立即补发一次）' : '') +
        (settings.dryRun ? '，dry-run 模式' : ''),
    )

    if (catchUp) {
      // 启动即补发：不阻塞插件装载，失败也只在日志里说。
      void tick().catch((error) => log(`补发失败：${error?.message ?? error}`))
    }

    timer = setInterval(() => {
      void tick().catch((error) => log(`定时检查异常：${error?.message ?? error}`))
    }, settings.tickIntervalMs)
    if (typeof timer.unref === 'function') timer.unref()
    return status()
  }

  function stop() {
    stopped = true
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }

  return { start, stop, tick, send, build, status, get nextDue() { return nextDue } }
}
