// 离线回归测试：不联网、不碰真实邮箱、不启动 DSH。
// 运行：node test/run-tests.mjs
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSettings, parseTimeOfDay, assertTimeZone } from '../src/config.mjs'
import {
  nextOccurrence,
  previousOccurrence,
  formatInZone,
  zoneOffsetMs,
  describeSchedule,
} from '../src/schedule.mjs'
import { buildReport, foldWindow, rateFor, condense } from '../src/collect.mjs'
import { renderHtml, renderSubject, renderText, fmtCompact, fmtMoney } from '../src/report.mjs'
import { loadState, saveState } from '../src/state.mjs'
import { createRunner } from '../src/runner.mjs'

let passed = 0
let failed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed += 1
    failures.push({ name, error })
    console.log(`FAIL  ${name}\n      ${error?.message ?? error}`)
  }
}

async function testAsync(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed += 1
    failures.push({ name, error })
    console.log(`FAIL  ${name}\n      ${error?.message ?? error}`)
  }
}

const SHANGHAI = 'Asia/Shanghai'
const at = (iso) => Date.parse(iso)

// ───────────────────────────── 定时 ─────────────────────────────
console.log('\n[定时]')
const schedule = { weekday: 0, hour: 0, minute: 0, timeZone: SHANGHAI }

test('2026-11-05 23:01（周四）的下一次是 11-08 00:00', () => {
  const now = at('2026-11-05T23:01:00+08:00')
  assert.equal(nextOccurrence(now, schedule), at('2026-11-08T00:00:00+08:00'))
})

test('2026-11-05 23:01 的上一届是 11-01 00:00', () => {
  const now = at('2026-11-05T23:01:00+08:00')
  assert.equal(previousOccurrence(now, schedule), at('2026-11-01T00:00:00+08:00'))
})

test('正好在发送时刻：next 严格往后推一周', () => {
  const now = at('2026-11-08T00:00:00+08:00')
  assert.equal(nextOccurrence(now, schedule), at('2026-11-15T00:00:00+08:00'))
  assert.equal(previousOccurrence(now, schedule), now)
})

test('周六 23:59 只差 1 分钟', () => {
  const now = at('2026-11-07T23:59:00+08:00')
  assert.equal(nextOccurrence(now, schedule) - now, 60_000)
})

test('周六 00:00（weekday=6）是另一个含义', () => {
  const now = at('2026-11-05T23:01:00+08:00')
  assert.equal(
    nextOccurrence(now, { weekday: 6, hour: 0, minute: 0, timeZone: SHANGHAI }),
    at('2026-11-07T00:00:00+08:00'),
  )
})

test('时区偏移：上海恒为 +8 小时', () => {
  assert.equal(zoneOffsetMs(at('2026-11-05T12:00:00Z'), SHANGHAI), 8 * 3600_000)
  assert.equal(zoneOffsetMs(at('2026-07-05T12:00:00Z'), SHANGHAI), 8 * 3600_000)
})

test('换时区算：纽约 00:00 与上海 00:00 不是同一时刻', () => {
  const now = at('2026-11-05T23:01:00+08:00')
  const ny = nextOccurrence(now, { weekday: 0, hour: 0, minute: 0, timeZone: 'America/New_York' })
  assert.equal(formatInZone(ny, 'America/New_York'), '2026-11-08 00:00')
  assert.notEqual(ny, at('2026-11-08T00:00:00+08:00'))
})

test('formatInZone / describeSchedule', () => {
  assert.equal(formatInZone(at('2026-11-08T00:00:00+08:00'), SHANGHAI), '2026-11-08 00:00')
  assert.equal(formatInZone(at('2026-11-08T00:00:30+08:00'), SHANGHAI, { seconds: true }), '2026-11-08 00:00:30')
  assert.equal(describeSchedule(schedule), '每周日 00:00（Asia/Shanghai）')
})

// ───────────────────────────── 配置 ─────────────────────────────
console.log('\n[配置]')
const baseConfig = { to: 'lzx_xkzdwb@163.com', authCode: 'test-auth-code' }

test('默认值：周日 00:00、7 天窗口', () => {
  const settings = readSettings(baseConfig)
  assert.equal(settings.weekday, 0)
  assert.equal(settings.hour, 0)
  assert.equal(settings.minute, 0)
  assert.equal(settings.windowDays, 7)
  assert.equal(settings.timeZone, SHANGHAI)
  assert.equal(settings.address, 'xkdobepc@163.com')
  assert.equal(settings.catchUp, true)
  assert.equal(settings.smtp.port, 465)
})

test('收件人缺失/非法要报错', () => {
  assert.throws(() => readSettings({ authCode: 'x' }), /config\.to/)
  assert.throws(() => readSettings({ to: 'not-an-email', authCode: 'x' }), /config\.to/)
})

test('时间/时区/授权码非法要报错', () => {
  assert.throws(() => readSettings({ ...baseConfig, time: '25:00' }), /config\.time/)
  assert.throws(() => readSettings({ ...baseConfig, time: 'moon' }), /config\.time/)
  assert.throws(() => readSettings({ ...baseConfig, timeZone: 'Mars/Olympus' }), /config\.timeZone/)
  assert.throws(() => readSettings({ to: 'a@b.cn' }), /授权码/)
  assert.doesNotThrow(() => parseTimeOfDay('23:59'))
  assert.doesNotThrow(() => assertTimeZone('UTC'))
})

test('pricing 默认值与面板一致，可按模型覆盖', () => {
  const settings = readSettings({
    ...baseConfig,
    pricing: { models: { 'deepseek-v4.1-flash': { input: 1, output: 4 } } },
  })
  assert.deepEqual(settings.pricing.default, { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 })
  assert.equal(rateFor(settings.pricing, 'xh-v1api/deepseek-v4.1-flash').output, 4, '只写 model 也能命中带 provider 的日志键')
  assert.equal(rateFor(settings.pricing, 'deepseek-account/deepseek-flash').output, 8)

  const exact = readSettings({ ...baseConfig, pricing: { models: { 'xh-v1api/deepseek-v4.1-flash': { input: 1 } } } })
  assert.equal(rateFor(exact.pricing, 'xh-v1api/deepseek-v4.1-flash').input, 1)
  assert.equal(rateFor(exact.pricing, 'deepseek-v4.1-flash').input, 2, '反向不匹配，回落到 default')
})

// ───────────────────────────── 折数据 ─────────────────────────────
console.log('\n[折数据]')
const FROM = at('2026-11-01T00:00:00+08:00')
const TO = at('2026-11-08T00:00:00+08:00')
const pricing = readSettings(baseConfig).pricing

function event(type, time, data, extra = {}) {
  return { type, time, data, seq: 1, ...extra }
}
function assistant(time, usage, model = 'deepseek-flash', provider = 'deepseek-account') {
  return event('assistant/message', time, {
    message: { role: 'assistant', source: { kind: 'model', provider, model } },
    usage,
  })
}
function user(time, text, kind = 'user') {
  return event('user/message', time, {
    content: [{ type: 'text', text }],
    source: { kind },
    role: 'user',
  })
}
function tool(time, name) {
  return event('tool/call', time, { name })
}
function title(time, text) {
  return event('session/title', time, { title: text })
}

const sessions = [
  {
    id: 's1',
    header: { id: 's1', cwd: 'P:\\工程\\A' },
    events: [
      event('session', undefined, undefined, { cwd: 'P:\\工程\\A' }),
      title(at('2026-11-02T10:00:00+08:00'), '改造 A 模块'),
      user(at('2026-11-02T10:00:00+08:00'), '把 A 模块改成异步\n顺便补测试'),
      assistant(at('2026-11-02T10:01:00+08:00'), { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
      tool(at('2026-11-02T10:01:30+08:00'), 'pwsh'),
      tool(at('2026-11-02T10:02:00+08:00'), 'pwsh'),
      tool(at('2026-11-02T10:03:00+08:00'), 'edit'),
    ],
  },
  {
    id: 's2',
    header: { id: 's2', cwd: 'P:\\工程\\B', delegationDepth: 1 },
    events: [
      user(at('2026-11-03T09:00:00+08:00'), '子代理的活', 'subagent'),
      assistant(at('2026-11-03T09:01:00+08:00'), { inputTokens: 500_000, outputTokens: 100_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 0 }, 'deepseek-flash', 'auto-time'),
      // 窗口外：不该被算进去
      assistant(at('2026-10-31T23:59:00+08:00'), { inputTokens: 9_000_000, outputTokens: 9_000_000 }),
      // 正好等于 to：左闭右开，不算
      assistant(at('2026-11-08T00:00:00+08:00'), { inputTokens: 7_000_000, outputTokens: 0 }),
    ],
  },
]

test('窗口内只算窗口内的事件（左闭右开）', () => {
  const folded = foldWindow(sessions, { from: FROM, to: TO, pricing, timeZone: SHANGHAI })
  assert.equal(folded.totals.calls, 2)
  assert.equal(folded.totals.input, 1_500_000)
  assert.equal(folded.totals.output, 100_000)
  assert.equal(folded.totals.cacheRead, 2_000_000)
  assert.equal(folded.totals.total, 3_600_000)
  assert.equal(folded.totals.sessions, 2)
  assert.equal(folded.totals.rootSessions, 1)
  assert.equal(folded.totals.subagentSessions, 1)
  assert.equal(folded.totals.userMessages, 1, 'subagent 的 user/message 不算人类发言')
  assert.equal(folded.totals.toolCalls, 3)
})

test('费用按四类 token 分别计价', () => {
  const folded = foldWindow(sessions, { from: FROM, to: TO, pricing, timeZone: SHANGHAI })
  const expected = (1_000_000 * 2 + (500_000 * 2 + 100_000 * 8 + 2_000_000 * 0.5)) / 1e6
  assert.ok(Math.abs(folded.totals.cost - expected) < 1e-9, `${folded.totals.cost} != ${expected}`)
  assert.equal(folded.byModel.length, 2)
})

test('按天分桶连续、缺的那天补 0', () => {
  const folded = foldWindow(sessions, { from: FROM, to: TO, pricing, timeZone: SHANGHAI })
  assert.equal(folded.byDay.length, 7)
  assert.deepEqual(folded.byDay.map((day) => day.day), [
    '2026-11-01',
    '2026-11-02',
    '2026-11-03',
    '2026-11-04',
    '2026-11-05',
    '2026-11-06',
    '2026-11-07',
  ])
  assert.equal(folded.byDay[0].total, 0)
  assert.equal(folded.byDay[1].total, 1_000_000)
  assert.equal(folded.byDay[2].total, 2_600_000)
})

test('标题取会话日志里的 session/title', () => {
  const folded = foldWindow(sessions, { from: FROM, to: TO, pricing, timeZone: SHANGHAI })
  const first = folded.conversations.find((item) => item.id === 's1')
  assert.equal(first.title, '改造 A 模块')
  assert.equal(first.project, 'A')
  assert.equal(first.toolCalls, 3)
})

test('工作汇总：按项目分组 + 截断', () => {
  const report = buildReport(sessions, {
    from: FROM,
    to: TO,
    days: 7,
    pricing,
    timeZone: SHANGHAI,
    topProjects: 1,
    sessionsPerProject: 1,
    topTools: 5,
    promptChars: 10,
    previous: { from: FROM - 7 * 86_400_000, to: FROM },
  })
  assert.equal(report.projects.length, 1)
  assert.equal(report.projects[0].name, 'B', '按花费排序，B 更贵')
  assert.equal(report.hidden.count, 1)
  assert.equal(report.hidden.sessions, 1)
  assert.equal(report.tools[0].name, 'pwsh')
  assert.equal(report.tools[0].count, 2)
})

test('condense 压成一行并截断', () => {
  assert.equal(condense('a\nb   c', 100), 'a b c')
  assert.equal(condense('x'.repeat(20), 5), 'xxxx…')
})

test('首条请求里的密钥会被打码', () => {
  const raw = '帮我配一下 sk-d547ff0c1b18ff7cec6efeca1bfe9b30aa26e1c9da126ab49235aa35d2788373 kakouai.com'
  const out = condense(raw, 300)
  assert.ok(!out.includes('d547ff0c'), out)
  assert.match(out, /\[已隐去密钥\]/)
  assert.match(out, /kakouai\.com/, '正常文字不受影响')
  assert.match(condense('password: hunter2hunter2', 200), /password: \[已隐去\]/)
  assert.match(condense('token=ghp_abcdefghijklmnopqrstuvwx', 200), /\[已隐去令牌\]/)
  assert.equal(condense('把 A 模块改成异步', 100), '把 A 模块改成异步')
})

// ───────────────────────────── 渲染 ─────────────────────────────
console.log('\n[渲染]')
const settings = readSettings(baseConfig)
const report = buildReport(sessions, {
  from: FROM,
  to: TO,
  days: 7,
  pricing,
  timeZone: SHANGHAI,
  topProjects: 6,
  sessionsPerProject: 6,
  topTools: 5,
  promptChars: 140,
  previous: { from: FROM - 7 * 86_400_000, to: FROM },
})

test('主题含日期与用量', () => {
  const subject = renderSubject(report, settings)
  assert.match(subject, /^\[DSH 周报\] 2026-11-01 ~ 2026-11-07/)
  assert.match(subject, /tokens/)
  assert.match(renderSubject(report, settings, { catchUp: true }), /（补发）/)
})

test('纯文本含关键数字与请求原文', () => {
  const text = renderText(report, settings, { state: { nextRunLocal: '2026-11-08 00:00' } })
  assert.match(text, /3,600,000 tokens/)
  assert.match(text, /改造 A 模块/)
  assert.match(text, /把 A 模块改成异步 顺便补测试/)
  assert.match(text, /pwsh 2/)
  assert.match(text, /下次发送：2026-11-08 00:00/)
})

test('HTML 转义标题与请求里的尖括号', () => {
  const evil = {
    id: 's3',
    header: { id: 's3', cwd: 'C:\\x' },
    events: [
      title(at('2026-11-04T10:00:00+08:00'), '<script>alert(1)</script>'),
      user(at('2026-11-04T10:00:00+08:00'), '<b>不要执行</b>'),
      assistant(at('2026-11-04T10:01:00+08:00'), { inputTokens: 10, outputTokens: 5 }),
    ],
  }
  const rendered = renderHtml(
    buildReport([evil], {
      from: FROM,
      to: TO,
      days: 7,
      pricing,
      timeZone: SHANGHAI,
      topProjects: 6,
      sessionsPerProject: 6,
      topTools: 5,
      promptChars: 140,
    }),
    settings,
  )
  assert.ok(!rendered.includes('<script>alert(1)</script>'))
  assert.match(rendered, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.ok(!/<img|<link/i.test(rendered), '不含外部资源')
})

test('空窗口也有兜底文案', () => {
  const empty = buildReport([], {
    from: FROM,
    to: TO,
    days: 7,
    pricing,
    timeZone: SHANGHAI,
    topProjects: 6,
    sessionsPerProject: 6,
    topTools: 5,
    promptChars: 140,
  })
  assert.match(renderText(empty, settings), /没有任何模型调用记录/)
  assert.match(renderSubject(empty, settings), /本周无记录/)
})

test('数字格式', () => {
  assert.equal(fmtCompact(1234), '1,234')
  assert.equal(fmtCompact(12345), '1.23 万')
  assert.equal(fmtCompact(123456789), '1.23 亿')
  assert.equal(fmtMoney(148.1234), '¥148.12')
  assert.equal(fmtMoney(0.5), '¥0.5000')
})

// ───────────────────────────── 运行器 ─────────────────────────────
console.log('\n[运行器]')
const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-weekly-report-'))

function makeRunner({ now, sends, failFirst = 0, dryRun = false, catchUp = true, name = 'run' }) {
  const stateFile = join(tempRoot, `${name}.json`)
  const auditFile = join(tempRoot, `${name}.jsonl`)
  let failures = 0
  const runner = createRunner({
    settings: { ...readSettings(baseConfig), stateFile, auditFile, dryRun, catchUp },
    deps: {
      now,
      readSessions: async () => sessions,
      send: async ({ subject }) => {
        if (failures < failFirst) {
          failures += 1
          throw new Error('SMTP 530 认证失败')
        }
        sends.push(subject)
        return { messageId: '<test@163.com>' }
      },
      loadState,
      saveState,
      appendAudit: (file, entry) => {
        mkdirSync(join(tempRoot), { recursive: true })
        appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8')
      },
      log: () => {},
      stateFile,
      auditFile,
    },
  })
  return { runner, stateFile, auditFile }
}

await testAsync('第一次启动不补发，只排下一次', async () => {
  const sends = []
  const clock = { now: at('2026-11-05T23:01:00+08:00') }
  const { runner, stateFile } = makeRunner({ now: () => clock.now, sends, name: 'first' })
  await runner.start()
  runner.stop()
  assert.equal(sends.length, 0)
  assert.equal(formatInZone(runner.nextDue, SHANGHAI), '2026-11-08 00:00')
  assert.equal(loadState(stateFile).state.sends, 0)
})

await testAsync('到点发一次，重复 tick 不再发', async () => {
  const sends = []
  const clock = { now: at('2026-11-05T23:01:00+08:00') }
  const { runner, stateFile } = makeRunner({ now: () => clock.now, sends, name: 'due' })
  await runner.start()
  clock.now = at('2026-11-08T00:00:30+08:00')
  await runner.tick()
  assert.equal(sends.length, 1)
  assert.match(sends[0], /^\[DSH 周报\] 2026-11-01 ~ 2026-11-07/)
  assert.ok(!sends[0].includes('补发'), '按时发送不该标补发')
  assert.equal(loadState(stateFile).state.sends, 1)
  await runner.tick()
  assert.equal(sends.length, 1, '同一时刻不该重复发')
  runner.stop()
})

await testAsync('错过时刻后启动会补发，并标「补发」', async () => {
  const sends = []
  const clock = { now: at('2026-11-11T09:30:00+08:00') }
  saveState(join(tempRoot, 'catchup.json'), {
    installedAt: at('2026-11-01T12:00:00+08:00'),
    lastSentAt: at('2026-11-01T00:00:20+08:00'),
    lastPeriodEnd: at('2026-11-01T00:00:00+08:00'),
    sends: 1,
  })
  const { runner } = makeRunner({ now: () => clock.now, sends, name: 'catchup' })
  await runner.start()
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(sends.length, 1)
  assert.match(sends[0], /（补发）/)
  assert.match(sends[0], /2026-11-01 ~ 2026-11-07/, '补发的是 11-08 00:00 结束的那一周')
  runner.stop()
})

await testAsync('catchUp: false 时错过就跳过', async () => {
  const sends = []
  const clock = { now: at('2026-11-09T09:30:00+08:00') }
  const { runner } = makeRunner({ now: () => clock.now, sends, catchUp: false, name: 'nocatchup' })
  await runner.start()
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(sends.length, 0)
  assert.equal(formatInZone(runner.nextDue, SHANGHAI), '2026-11-15 00:00')
  runner.stop()
})

await testAsync('dry-run 不发信，但照样推进周期', async () => {
  const sends = []
  const clock = { now: at('2026-11-14T23:59:00+08:00') }
  const { runner, stateFile } = makeRunner({ now: () => clock.now, sends, dryRun: true, catchUp: false, name: 'dry' })
  await runner.start()
  clock.now = at('2026-11-15T00:00:10+08:00')
  await runner.tick()
  assert.equal(sends.length, 0)
  assert.equal(loadState(stateFile).state.sends, 1, 'dry-run 也算「本轮已处理」')
  runner.stop()
})

await testAsync('发信失败会安排重试并记错误', async () => {
  const sends = []
  const clock = { now: at('2026-11-21T23:59:00+08:00') }
  const { runner, stateFile } = makeRunner({ now: () => clock.now, sends, failFirst: 1, catchUp: false, name: 'retry' })
  await runner.start()
  clock.now = at('2026-11-22T00:00:10+08:00')
  await runner.tick()
  assert.equal(sends.length, 0)
  assert.match(loadState(stateFile).state.lastError, /530/)
  assert.equal(loadState(stateFile).state.retry.attempts, 1)
  assert.equal(runner.nextDue - clock.now, 10 * 60_000)
  clock.now += 10 * 60_000
  await runner.tick()
  assert.equal(sends.length, 1)
  runner.stop()
})

// ───────────────────────────── 插件装配 ─────────────────────────────
console.log('\n[插件装配]')
const pluginTemp = mkdtempSync(join(tmpdir(), 'dsh-weekly-plugin-'))

/** 最小 cordis 替身：sessionQuery + webServer + effect。 */
function makeContext(sessionList) {
  const routes = new Map()
  const disposers = []
  const ctx = {
    sessionQuery: {
      listSessions: async () => sessionList.map((item) => ({ header: { id: item.id }, live: false })),
      readSession: async (id) => {
        const found = sessionList.find((item) => item.id === id)
        if (found === undefined) throw new Error(`no session ${id}`)
        return { session: found.header, events: found.events }
      },
    },
    webServer: {
      register: ({ path, handler, kind }) => {
        routes.set(path, { handler, kind })
        return () => routes.delete(path)
      },
    },
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
  }
  return { ctx, routes, disposers }
}

function fakeRequest(url, method = 'GET') {
  return { url, method }
}

function fakeResponse() {
  const chunks = []
  return {
    statusCode: 0,
    headers: undefined,
    body: '',
    writeHead(code, headers) {
      this.statusCode = code
      this.headers = headers
    },
    end(body) {
      if (body !== undefined) chunks.push(Buffer.isBuffer(body) ? body.toString('utf8') : String(body))
      this.body = chunks.join('')
    },
  }
}

await testAsync('apply() 能挂上两条路由，status 报出下次发送时间', async () => {
  const { apply } = await import('../src/plugin.js')
  const { ctx, routes, disposers } = makeContext(sessions)
  apply(ctx, {
    ...baseConfig,
    stateFile: join(pluginTemp, 'state.json'),
    auditFile: join(pluginTemp, 'sent.jsonl'),
    catchUp: false,
  })
  await new Promise((resolve) => setTimeout(resolve, 60))

  assert.ok(routes.has('/plugin-weekly-report/status'))
  assert.ok(routes.has('/plugin-weekly-report/preview'))

  const statusRes = fakeResponse()
  routes.get('/plugin-weekly-report/status').handler(fakeRequest('/plugin-weekly-report/status'), statusRes)
  assert.equal(statusRes.statusCode, 200)
  const status = JSON.parse(statusRes.body)
  assert.equal(status.to, 'lzx_xkzdwb@163.com')
  assert.equal(status.schedule, '每周日 00:00（Asia/Shanghai）')
  assert.ok(typeof status.nextRunLocal === 'string' && status.nextRunLocal.length === 16)

  for (const dispose of disposers) dispose()
})

await testAsync('preview 路由三种格式都能渲染，且不发信', async () => {
  const { apply } = await import('../src/plugin.js')
  const { ctx, routes, disposers } = makeContext(sessions)
  apply(ctx, {
    ...baseConfig,
    stateFile: join(pluginTemp, 'state2.json'),
    auditFile: join(pluginTemp, 'sent2.jsonl'),
    catchUp: false,
    dryRun: true,
  })
  await new Promise((resolve) => setTimeout(resolve, 60))
  const handler = routes.get('/plugin-weekly-report/preview').handler

  const textRes = fakeResponse()
  handler(fakeRequest('/plugin-weekly-report/preview?days=7&format=text'), textRes)
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(textRes.statusCode, 200)
  assert.match(textRes.body, /Subject: \[DSH 周报\]/)
  assert.match(textRes.body, /3,600,000 tokens/)

  const htmlRes = fakeResponse()
  handler(fakeRequest('/plugin-weekly-report/preview?days=7&format=html'), htmlRes)
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(htmlRes.statusCode, 200)
  assert.match(htmlRes.headers['content-type'], /text\/html/)
  assert.match(htmlRes.body, /<!doctype html>/)

  const jsonRes = fakeResponse()
  handler(fakeRequest('/plugin-weekly-report/preview?days=7'), jsonRes)
  await new Promise((resolve) => setTimeout(resolve, 100))
  const json = JSON.parse(jsonRes.body)
  assert.equal(json.totals.sessions, 2)
  assert.match(json.subject, /tokens/)

  const postRes = fakeResponse()
  handler(fakeRequest('/plugin-weekly-report/preview', 'POST'), postRes)
  assert.equal(postRes.statusCode, 405)

  for (const dispose of disposers) dispose()
})

rmSync(pluginTemp, { recursive: true, force: true })
rmSync(tempRoot, { recursive: true, force: true })

console.log(`\n${passed} 通过 / ${failed} 失败`)
if (failed > 0) {
  for (const failure of failures) {
    console.error(`\n${failure.name}\n${failure.error?.stack ?? failure.error}`)
  }
  process.exit(1)
}
