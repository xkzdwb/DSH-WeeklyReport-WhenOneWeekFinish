// DSH 插件入口：每周固定时刻把「这一周的 token 用量 + 工作汇总」发到指定邮箱。
//
// 装配（~/.dsh/profiles/desktop/cordis.patch.yml 的 insert 列表）：
//   - id: weekly-report
//     name: "/absolute/path/to/DSH-WeeklyReport-WhenOneWeekFinish/src/plugin.js"
//     config:
//       to: you@example.com
//       address: sender@example.com
//       secretsFile: "/absolute/path/to/DSH-WeeklyReport-WhenOneWeekFinish/secrets.json"
//       weekday: 0        # 0=周日 … 6=周六
//       time: "00:00"
// 改完要重启 DSH 才会装载（插件在 HOST 启动时加载）。
//
// 另开两条只读 GET 路由，方便确认「插件真的装上了、下次什么时候发、邮件长什么样」：
//   /plugin-weekly-report/status
//   /plugin-weekly-report/preview?days=7[&format=html|text|json]
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readSettings } from './config.mjs'
import { createRunner } from './runner.mjs'
import { loadState, saveState } from './state.mjs'
import { sendWeeklyMail } from './mail/send.mjs'
import { renderHtml, renderSubject, renderText } from './report.mjs'

const name = 'weekly-report'
const inject = ['sessionQuery', 'webServer']
const here = dirname(fileURLToPath(import.meta.url))
const STATUS_PATH = '/plugin-weekly-report/status'
const PREVIEW_PATH = '/plugin-weekly-report/preview'

/**
 * 插件入口。配置写错不该把 DSH 启动拖下水：失败时只在 HOST 日志里说明。
 * @param ctx - cordis 上下文。
 * @param rawConfig - profile patch 里的 config。
 */
function apply(ctx, rawConfig) {
  const log = (message) => console.warn(`[${name}] ${message}`)

  let settings
  try {
    settings = readSettings(rawConfig)
  } catch (error) {
    log(`配置不可用，插件未挂载：${error?.message ?? error}`)
    return
  }

  const stateFile = settings.stateFile === '' ? join(here, '..', 'state.json') : settings.stateFile
  const auditFile = settings.auditFile === '' ? join(here, '..', 'audit', 'sent.jsonl') : settings.auditFile

  function appendAudit(file, entry) {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8')
  }

  /** 全部会话的 { id, header, events }；单条读失败只记日志，不影响整封周报。 */
  async function readSessions({ maxSessions }) {
    const records = await ctx.sessionQuery.listSessions()
    const listed = records.slice(0, maxSessions)
    const queue = [...listed]
    const sessions = []
    const worker = async () => {
      for (;;) {
        const record = queue.shift()
        if (record === undefined) return
        const id = String(record.header.id)
        try {
          const snapshot = await ctx.sessionQuery.readSession(id)
          sessions.push({ id, header: snapshot.session ?? record.header, events: snapshot.events ?? [] })
        } catch (error) {
          log(`读取会话 ${id} 失败：${error?.message ?? error}`)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, queue.length || 1) }, worker))
    return sessions
  }

  const runner = createRunner({
    settings,
    deps: {
      readSessions,
      send: (payload) => sendWeeklyMail({ settings, ...payload, log }),
      loadState,
      saveState,
      appendAudit,
      log,
      stateFile,
      auditFile,
    },
  })

  ctx.effect(() => () => {
    log('正在卸载：停掉周报定时器')
    runner.stop()
  }, `${name}: 周报定时器`)

  void runner
    .start()
    .then((status) => log(`下次发送 ${status.nextRunLocal ?? '（未定）'}，收件人 ${settings.to}`))
    .catch((error) => log(`启动失败：${error?.message ?? error}`))

  // 预览缓存：面板/浏览器连点不会反复重读全部会话日志。
  let previewCache

  function respond(res, statusCode, body, type = 'application/json; charset=utf-8') {
    const buffer = Buffer.from(body, 'utf8')
    res.writeHead(statusCode, {
      'content-type': type,
      'cache-control': 'no-store',
      'content-length': String(buffer.byteLength),
    })
    res.end(buffer)
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: STATUS_PATH,
        handler(req, res) {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'GET, HEAD' })
            res.end(JSON.stringify({ error: 'method not allowed' }))
            return
          }
          respond(res, 200, JSON.stringify(runner.status(), null, 2))
        },
      }),
    `${name}: status route`,
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: PREVIEW_PATH,
        handler(req, res) {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'GET, HEAD' })
            res.end(JSON.stringify({ error: 'method not allowed' }))
            return
          }
          void (async () => {
            const url = new URL(req.url ?? PREVIEW_PATH, 'http://localhost')
            const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || settings.windowDays))
            const format = (url.searchParams.get('format') ?? 'json').toLowerCase()
            const refresh = url.searchParams.get('refresh') === '1'
            const cacheKey = days
            if (!refresh && previewCache !== undefined && previewCache.key === cacheKey && Date.now() - previewCache.at < 30_000) {
              respondWith(previewCache.value)
              return
            }
            try {
              const periodEnd = runner.nextDue === 0 ? Date.now() : runner.nextDue
              const { report } = await runner.build({ periodEnd, days })
              const subject = renderSubject(report, settings, { catchUp: false })
              const text = renderText(report, settings, { state: { nextRunLocal: runner.status().nextRunLocal } })
              const html = renderHtml(report, settings, { state: { nextRunLocal: runner.status().nextRunLocal } })
              const value = { subject, text, html, totals: report.totals, from: report.from, to: report.to }
              previewCache = { key: cacheKey, at: Date.now(), value }
              respondWith(value)
            } catch (error) {
              respond(res, 500, JSON.stringify({ error: String(error?.message ?? error) }))
            }

            function respondWith(value) {
              if (format === 'html') {
                respond(res, 200, value.html, 'text/html; charset=utf-8')
                return
              }
              if (format === 'text') {
                respond(res, 200, `Subject: ${value.subject}\n\n${value.text}`, 'text/plain; charset=utf-8')
                return
              }
              respond(res, 200, JSON.stringify({ subject: value.subject, from: value.from, to: value.to, totals: value.totals }, null, 2))
            }
          })()
        },
      }),
    `${name}: preview route`,
  )

  log(
    `已挂载：${settings.address} → ${settings.to}，` +
      `${runner.status().schedule}，补发${settings.catchUp ? '开' : '关'}` +
      `${settings.dryRun ? '，dry-run' : ''}；状态 ${stateFile}`,
  )
}

export { apply, inject, name }
