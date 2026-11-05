// 命令行用：不启动 DSH，直接读 ~/.dsh/sessions 生成一份周报。
//   预览（默认不发信）：node tools/weekly-report.mjs --to you@example.com --secrets secrets.json
//   发一封测试信：      node tools/weekly-report.mjs --to you@example.com --secrets secrets.json --send
//   指定统计窗口：      node tools/weekly-report.mjs --days 7 --end schedule
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { readSettings } from '../src/config.mjs'
import { loadSessions } from '../src/source-fs.mjs'
import { buildReport } from '../src/collect.mjs'
import { renderHtml, renderSubject, renderText } from '../src/report.mjs'
import { sendWeeklyMail } from '../src/mail/send.mjs'
import { DAY_MS, formatInZone, nextOccurrence, previousOccurrence } from '../src/schedule.mjs'

const SECRETS = process.env.WEEKLY_REPORT_SECRETS ?? 'secrets.json'

const BASE_CONFIG = {
  address: process.env.WEEKLY_REPORT_FROM ?? 'sender@example.com',
  to: process.env.WEEKLY_REPORT_TO ?? 'you@example.com',
  secretsFile: SECRETS,
}

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      options[key] = true
    } else {
      options[key] = next
      index += 1
    }
  }
  return options
}

const args = parseArgs(process.argv.slice(2))
const config = { ...BASE_CONFIG }
if (typeof args.to === 'string') config.to = args.to
if (typeof args.address === 'string') config.address = args.address
if (typeof args.secrets === 'string') config.secretsFile = resolve(args.secrets)
if (typeof args['subject-prefix'] === 'string') config.subjectPrefix = args['subject-prefix']
if (typeof args.days === 'string') config.windowDays = Number(args.days)
if (args['dry-run'] === true) config.dryRun = true

let settings
try {
  settings = readSettings(config)
} catch (error) {
  console.error(`配置有问题：${error?.message ?? error}`)
  process.exit(2)
}

const days = Number(args.days) || settings.windowDays
let end = Date.now()
if (args.end === 'schedule') {
  end = previousOccurrence(Date.now(), {
    weekday: settings.weekday,
    hour: settings.hour,
    minute: settings.minute,
    timeZone: settings.timeZone,
  })
} else if (typeof args.end === 'string') {
  const parsed = Number(args.end)
  end = Number.isFinite(parsed) && parsed > 0 ? parsed : Date.parse(args.end)
  if (!Number.isFinite(end)) {
    console.error(`--end 看不懂：${args.end}`)
    process.exit(2)
  }
}

const started = Date.now()
const sessions = loadSessions({ maxSessions: settings.maxSessions })
const readMs = Date.now() - started

const from = end - days * DAY_MS
const report = buildReport(sessions, {
  from,
  to: end,
  days,
  pricing: settings.pricing,
  timeZone: settings.timeZone,
  topProjects: settings.topProjects,
  sessionsPerProject: settings.sessionsPerProject,
  topTools: settings.topTools,
  promptChars: settings.promptChars,
  previous: { from: from - days * DAY_MS, to: from },
})

const subject = renderSubject(report, settings, { catchUp: false })
const next = formatInZone(
  nextOccurrence(Date.now(), {
    weekday: settings.weekday,
    hour: settings.hour,
    minute: settings.minute,
    timeZone: settings.timeZone,
  }),
  settings.timeZone,
)
const text = renderText(report, settings, { state: { nextRunLocal: next } })
const html = renderHtml(report, settings, { state: { nextRunLocal: next } })

console.error(
  `[weekly-report] ${sessions.length} 个会话，读取 ${readMs}ms，窗口 ${formatInZone(from, settings.timeZone)} → ` +
    `${formatInZone(end, settings.timeZone)}（${days} 天）`,
)
console.log(`Subject: ${subject}`)
console.log('')
console.log(text)

if (typeof args.html === 'string') {
  const target = resolve(args.html)
  writeFileSync(target, html, 'utf8')
  console.error(`[weekly-report] HTML 预览写到 ${target}`)
}
if (args.json === true) {
  console.log(JSON.stringify({ subject, from, to: end, totals: report.totals }, null, 2))
}

if (args.send === true) {
  if (settings.dryRun) {
    console.error('[weekly-report] dryRun=true，不投信')
  } else {
    const result = await sendWeeklyMail({ settings, subject, text, html, log: (m) => console.error(`[smtp] ${m}`) })
    console.error(`[weekly-report] 已发送：${result.messageId}`)
  }
}
