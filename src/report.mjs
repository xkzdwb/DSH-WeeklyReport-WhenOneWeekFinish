// 把折好的周报数据渲染成邮件正文：纯文本 + HTML 两个版本。
// 不引用任何外部资源（图片/CSS），163 与各家网页端/手机端都能直接看。
import { formatDate, formatInZone } from './schedule.mjs'

const SYMBOLS = { CNY: '¥', USD: '$', EUR: '€', JPY: '¥', GBP: '£' }

/** 千分位整数。 */
export function fmtInt(value) {
  const n = Math.round(Number(value) || 0)
  return n.toLocaleString('en-US')
}

/** 紧凑写法：1.2 亿 / 12.3 万 / 4,521。 */
export function fmtCompact(value) {
  const n = Number(value) || 0
  if (n >= 1e8) return `${trim(n / 1e8)} 亿`
  if (n >= 1e4) return `${trim(n / 1e4)} 万`
  return fmtInt(n)
}

function trim(n) {
  const fixed = n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)
  return fixed.replace(/\.0+$/, '').replace(/(\.\d)0$/, '$1')
}

/** 金额：¥148.12（小额保留 4 位）。 */
export function fmtMoney(value, currency = 'CNY') {
  const n = Number(value) || 0
  const symbol = SYMBOLS[currency] ?? `${currency} `
  const digits = n !== 0 && Math.abs(n) < 1 ? 4 : 2
  return `${symbol}${n.toFixed(digits)}`
}

function share(part, whole) {
  if (!whole) return 0
  return Math.round((part / whole) * 1000) / 10
}

function fmtDelta(current, previous) {
  const c = Number(current) || 0
  const p = Number(previous) || 0
  if (p === 0) return c === 0 ? '持平' : '新增'
  const ratio = ((c - p) / p) * 100
  if (Math.abs(ratio) < 0.5) return '持平'
  const sign = ratio > 0 ? '+' : ''
  return `${sign}${ratio.toFixed(0)}%`
}

/** 会话在邮件里的显示名：优先标题，其次首条请求，最后会话 id。 */
export function sessionLabel(conversation) {
  if (conversation.title !== undefined && conversation.title !== '') return conversation.title
  if (conversation.prompt !== undefined && conversation.prompt !== '') return conversation.prompt
  const short = String(conversation.id ?? '').replace(/^session-/, '').slice(0, 8)
  return `${conversation.subagent === true ? '子代理' : '会话'} ${short}`
}

function modelLabel(key) {
  return key
}

function dayLabel(day) {
  return String(day).slice(5) // MM-DD
}

/**
 * 邮件主题。
 * @param report - buildReport() 的结果。
 * @param settings - 归一化配置。
 * @param options - { catchUp }
 */
export function renderSubject(report, settings, { catchUp = false } = {}) {
  const from = formatDate(report.from, report.timeZone)
  const to = formatDate(Math.max(report.from, report.to - 1), report.timeZone)
  const head = `${settings.subjectPrefix} ${from} ~ ${to}`
  const body =
    report.totals.sessions === 0
      ? '本周无记录'
      : `${fmtCompact(report.totals.total)} tokens / ${fmtMoney(report.totals.cost, settings.currency)}`
  return `${head}${catchUp ? '（补发）' : ''} · ${body}`
}

/**
 * 纯文本版。
 * @param report - buildReport() 的结果。
 * @param settings - 归一化配置。
 * @param options - { catchUp, state }
 */
export function renderText(report, settings, { catchUp = false, state } = {}) {
  const tz = report.timeZone
  const currency = settings.currency
  const from = formatDate(report.from, tz)
  const to = formatDate(Math.max(report.from, report.to - 1), tz)
  const totals = report.totals
  const lines = []

  lines.push(`DSH 周报 · ${from} ~ ${to}`)
  lines.push('')
  lines.push(`统计口径：${formatInZone(report.from, tz)} → ${formatInZone(report.to, tz)}（${tz}），费用按配置单价估算。`)
  if (catchUp) lines.push('注：本封是补发 —— 原定发送时刻 Harness 没有在运行。')
  lines.push('')

  if (totals.sessions === 0) {
    lines.push('这一周没有任何模型调用记录。')
    return lines.join('\n')
  }

  const compared =
    report.previous === undefined
      ? ''
      : report.previous.totals.total === 0
        ? '（上周没有记录，本周是新增）'
        : `（较上周 tokens ${fmtDelta(totals.total, report.previous.totals.total)}，` +
          `费用 ${fmtDelta(totals.cost, report.previous.totals.cost)}）`
  lines.push('【一句话】')
  lines.push(
    `  本周 ${fmtInt(totals.sessions)} 个会话、${fmtInt(totals.calls)} 次模型调用，共 ${fmtCompact(totals.total)} tokens，` +
      `预估 ${fmtMoney(totals.cost, currency)}${compared}。`,
  )
  lines.push('')

  lines.push('【Token 用量】')
  lines.push(`  总量      ${fmtInt(totals.total)} tokens`)
  lines.push(`  输入      ${fmtInt(totals.input)}`)
  lines.push(`  输出      ${fmtInt(totals.output)}`)
  lines.push(`  缓存读    ${fmtInt(totals.cacheRead)}`)
  lines.push(`  缓存写    ${fmtInt(totals.cacheWrite)}`)
  lines.push(`  模型调用  ${fmtInt(totals.calls)} 次`)
  lines.push(`  会话      ${fmtInt(totals.sessions)} 个（主会话 ${fmtInt(totals.rootSessions)}，子代理 ${fmtInt(totals.subagentSessions)}）`)
  lines.push(`  用户发言  ${fmtInt(totals.userMessages)} 条，工具调用 ${fmtInt(totals.toolCalls)} 次`)
  lines.push('')

  if (report.byDay.length > 0) {
    lines.push('【每天】')
    const max = Math.max(...report.byDay.map((day) => day.total), 1)
    for (const day of report.byDay) {
      const bar = '▇'.repeat(Math.max(1, Math.round((day.total / max) * 12)))
      lines.push(
        `  ${dayLabel(day.day)}  ${fmtCompact(day.total).padStart(8)}  ${fmtMoney(day.cost, currency).padStart(9)}  ${bar}`,
      )
    }
    lines.push('')
  }

  if (report.byModel.length > 0) {
    lines.push('【按模型】')
    for (const model of report.byModel) {
      lines.push(
        `  ${model.key}  ${fmtInt(model.calls)} 次  ${fmtCompact(model.total)}  ` +
          `${fmtMoney(model.cost, currency)}（占 ${share(model.cost, totals.cost)}%）`,
      )
    }
    lines.push('')
  }

  lines.push(`【工作汇总】${report.projects.length > 0 ? '按花费排序' : ''}`)
  if (report.projects.length === 0) {
    lines.push('  这一周没有可汇总的会话。')
  }
  for (const project of report.projects) {
    lines.push(
      `  ▸ ${project.name}  ${fmtInt(project.conversationCount)} 个会话 · ${fmtCompact(project.total)} tokens · ` +
        `${fmtMoney(project.cost, currency)}`,
    )
    if (typeof project.cwd === 'string' && project.cwd !== '') lines.push(`    ${project.cwd}`)
    for (const conversation of project.conversations) {
      const when = conversation.lastAt === undefined ? '' : formatDate(conversation.lastAt, tz)
      const size = `${fmtCompact(conversation.total)} tokens`
      const title = sessionLabel(conversation)
      lines.push(`    · ${title}（${when}，${size}，${fmtMoney(conversation.cost, currency)}）`)
      if (conversation.prompt !== undefined && conversation.prompt !== title) {
        lines.push(`      请求：${conversation.prompt}`)
      }
    }
    if (project.hiddenConversations > 0) lines.push(`    · 另有 ${project.hiddenConversations} 个会话未列出`)
    lines.push('')
  }
  if (report.hidden.count > 0) {
    lines.push(
      `  另有 ${report.hidden.count} 个项目（${report.hidden.sessions} 个会话，` +
        `${fmtCompact(report.hidden.total)} tokens，${fmtMoney(report.hidden.cost, currency)}）未列出。`,
    )
    lines.push('')
  }

  if (report.tools.length > 0) {
    lines.push('【工具调用 Top】')
    lines.push(`  ${report.tools.map((tool) => `${tool.name} ${fmtInt(tool.count)}`).join(' · ')}`)
    lines.push('')
  }

  lines.push('—')
  lines.push(`由 DSH 插件 weekly-report 生成 · ${formatDate(report.generatedAt, tz)}`)
  if (state?.nextRunLocal !== undefined) {
    lines.push(`下次发送：${state.nextRunLocal}`)
  }
  return lines.join('\n')
}

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * HTML 版。
 * @param report - buildReport() 的结果。
 * @param settings - 归一化配置。
 * @param options - { catchUp, state }
 */
export function renderHtml(report, settings, { catchUp = false, state } = {}) {
  const tz = report.timeZone
  const currency = settings.currency
  const totals = report.totals
  const cell = 'padding:7px 10px;border-bottom:1px solid #eceef2;font-size:13px;color:#24292f;'
  const headCell = 'padding:7px 10px;border-bottom:1px solid #d7dbe2;font-size:12px;color:#57606a;text-align:left;font-weight:600;'
  const numCell = `${cell}text-align:right;font-variant-numeric:tabular-nums;`
  const section = 'margin:22px 0 8px;font-size:14px;font-weight:700;color:#111827;'
  const muted = 'color:#6b7280;font-size:12px;'
  const parts = []

  parts.push('<!doctype html><html><head><meta charset="utf-8">')
  parts.push(
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(
      renderSubject(report, settings, { catchUp }),
    )}</title></head><body style="margin:0;padding:0;background:#f6f7f9;">`,
  )
  parts.push(
    '<div style="max-width:680px;margin:0 auto;padding:20px 14px 8px;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',\'Microsoft YaHei\',sans-serif;">',
  )
  parts.push('<div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;padding:18px 18px 6px;">')
  parts.push(`<div style="font-size:18px;font-weight:700;color:#0f172a;">DSH 周报</div>`)
  parts.push(
    `<div style="${muted}margin-top:4px;">${escapeHtml(formatInZone(report.from, tz))} → ` +
      `${escapeHtml(formatInZone(report.to, tz))}（${escapeHtml(tz)}）· 费用按配置单价估算</div>`,
  )
  if (catchUp) {
    parts.push(
      '<div style="margin-top:8px;padding:7px 10px;background:#fff7e6;border:1px solid #ffe0a3;border-radius:6px;font-size:12px;color:#8a5a00;">' +
        '本封是补发：原定发送时刻 Harness 没有在运行。' +
        '</div>',
    )
  }

  if (totals.sessions === 0) {
    parts.push('<p style="font-size:13px;color:#24292f;margin:16px 0;">这一周没有任何模型调用记录。</p>')
  } else {
    // 四个数字卡片
    const cards = [
      ['Tokens', fmtCompact(totals.total), fmtInt(totals.total)],
      ['预估费用', fmtMoney(totals.cost, currency), report.previous === undefined || report.previous.totals.total === 0 ? '' : `较上周 ${fmtDelta(totals.cost, report.previous.totals.cost)}`],
      ['模型调用', `${fmtInt(totals.calls)} 次`, `${fmtInt(totals.messages)} 条回复`],
      ['会话', `${fmtInt(totals.sessions)} 个`, `主 ${fmtInt(totals.rootSessions)} / 子 ${fmtInt(totals.subagentSessions)}`],
    ]
    parts.push('<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:14px;border-collapse:separate;border-spacing:8px 0;"><tr>')
    for (const [label, value, note] of cards) {
      parts.push(
        '<td width="25%" style="background:#f8fafc;border:1px solid #eef0f4;border-radius:8px;padding:10px 10px 9px;vertical-align:top;">' +
          `<div style="font-size:11px;color:#6b7280;">${escapeHtml(label)}</div>` +
          `<div style="font-size:16px;font-weight:700;color:#0f172a;margin-top:3px;white-space:nowrap;">${escapeHtml(value)}</div>` +
          (note === '' ? '' : `<div style="font-size:11px;color:#8b949e;margin-top:2px;">${escapeHtml(note)}</div>`) +
          '</td>',
      )
    }
    parts.push('</tr></table>')

    if (report.previous !== undefined) {
      const previous = report.previous.totals
      const compareText =
        previous.total === 0
          ? '上周没有记录，本周是新增。'
          : `token 总量较上周 ${fmtDelta(totals.total, previous.total)}，` +
            `会话数较上周 ${fmtDelta(totals.sessions, previous.sessions)}，` +
            `费用较上周 ${fmtDelta(totals.cost, previous.cost)}。`
      parts.push(`<div style="${muted}margin-top:10px;">${escapeHtml(compareText)}</div>`)
    }

    // 每天
    if (report.byDay.length > 0) {
      const max = Math.max(...report.byDay.map((day) => day.total), 1)
      parts.push(`<div style="${section}">每天用量</div>`)
      parts.push('<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">')
      parts.push(
        `<tr><th style="${headCell}">日期</th><th style="${headCell}text-align:right;">tokens</th>` +
          `<th style="${headCell}text-align:right;">费用</th><th style="${headCell}" width="34%">相对量</th></tr>`,
      )
      for (const day of report.byDay) {
        const width = Math.max(2, Math.round((day.total / max) * 100))
        parts.push(
          `<tr><td style="${cell}">${escapeHtml(dayLabel(day.day))}</td>` +
            `<td style="${numCell}">${escapeHtml(fmtInt(day.total))}</td>` +
            `<td style="${numCell}">${escapeHtml(fmtMoney(day.cost, currency))}</td>` +
            `<td style="${cell}"><div style="background:#e8eefb;border-radius:3px;height:8px;width:100%;">` +
            `<div style="background:#4a7cf6;border-radius:3px;height:8px;width:${width}%;"></div></div></td></tr>`,
        )
      }
      parts.push('</table>')
    }

    // 按模型
    if (report.byModel.length > 0) {
      parts.push(`<div style="${section}">按模型</div>`)
      parts.push('<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">')
      parts.push(
        `<tr><th style="${headCell}">模型</th><th style="${headCell}text-align:right;">调用</th>` +
          `<th style="${headCell}text-align:right;">tokens</th><th style="${headCell}text-align:right;">费用</th>` +
          `<th style="${headCell}text-align:right;">占比</th></tr>`,
      )
      for (const model of report.byModel) {
        parts.push(
          `<tr><td style="${cell}">${escapeHtml(modelLabel(model.key))}</td>` +
            `<td style="${numCell}">${escapeHtml(fmtInt(model.calls))}</td>` +
            `<td style="${numCell}">${escapeHtml(fmtInt(model.total))}</td>` +
            `<td style="${numCell}">${escapeHtml(fmtMoney(model.cost, currency))}</td>` +
            `<td style="${numCell}">${escapeHtml(`${share(model.cost, totals.cost)}%`)}</td></tr>`,
        )
      }
      parts.push('</table>')
    }

    // 工作汇总
    parts.push(`<div style="${section}">工作汇总</div>`)
    if (report.projects.length === 0) {
      parts.push('<div style="font-size:13px;color:#24292f;">这一周没有可汇总的会话。</div>')
    }
    for (const project of report.projects) {
      parts.push(
        '<div style="margin-top:12px;padding:12px 12px 6px;border:1px solid #eef0f4;border-radius:8px;background:#fcfcfd;">',
      )
      parts.push(
        `<div style="font-size:13px;font-weight:700;color:#0f172a;">${escapeHtml(project.name)}` +
          `<span style="font-weight:400;color:#6b7280;font-size:12px;"> · ${escapeHtml(fmtInt(project.conversationCount))} 个会话 · ` +
          `${escapeHtml(fmtCompact(project.total))} tokens · ${escapeHtml(fmtMoney(project.cost, currency))}</span></div>`,
      )
      if (typeof project.cwd === 'string' && project.cwd !== '') {
        parts.push(`<div style="font-size:11px;color:#8b949e;margin-top:2px;word-break:break-all;">${escapeHtml(project.cwd)}</div>`)
      }
      parts.push('<div style="margin-top:8px;">')
      for (const conversation of project.conversations) {
        const when = conversation.lastAt === undefined ? '' : formatDate(conversation.lastAt, tz)
        parts.push(
          '<div style="margin:0 0 8px;font-size:13px;color:#24292f;line-height:1.5;">' +
            `<span style="color:#4a7cf6;">•</span> ${escapeHtml(sessionLabel(conversation))}` +
            `<span style="color:#8b949e;font-size:11px;">（${escapeHtml(when)}，${escapeHtml(fmtCompact(conversation.total))} tokens，` +
            `${escapeHtml(fmtMoney(conversation.cost, currency))}）</span>`,
        )
        const prompt = conversation.prompt
        if (prompt !== undefined && prompt !== '' && prompt !== sessionLabel(conversation)) {
          parts.push(
            `<div style="font-size:12px;color:#57606a;margin:2px 0 0 14px;line-height:1.5;">请求：${escapeHtml(prompt)}</div>`,
          )
        }
        parts.push('</div>')
      }
      if (project.hiddenConversations > 0) {
        parts.push(
          `<div style="font-size:11px;color:#8b949e;margin-bottom:6px;">另有 ${escapeHtml(fmtInt(project.hiddenConversations))} 个会话未列出</div>`,
        )
      }
      parts.push('</div></div>')
    }
    if (report.hidden.count > 0) {
      parts.push(
        `<div style="${muted}margin-top:10px;">另有 ${escapeHtml(fmtInt(report.hidden.count))} 个项目（` +
          `${escapeHtml(fmtInt(report.hidden.sessions))} 个会话，${escapeHtml(fmtCompact(report.hidden.total))} tokens，` +
          `${escapeHtml(fmtMoney(report.hidden.cost, currency))}）未列出。</div>`,
      )
    }

    if (report.tools.length > 0) {
      parts.push(`<div style="${section}">工具调用</div>`)
      parts.push(
        `<div style="font-size:12px;color:#24292f;line-height:1.7;">${report.tools
          .map((tool) => `${escapeHtml(tool.name)} <span style="color:#8b949e;">${escapeHtml(fmtInt(tool.count))}</span>`)
          .join(' · ')}</div>`,
      )
    }
  }

  parts.push('<div style="margin:20px 0 14px;padding-top:12px;border-top:1px solid #eef0f4;font-size:11px;color:#8b949e;line-height:1.7;">')
  parts.push('由 DSH 插件 weekly-report 生成')
  if (state?.nextRunLocal !== undefined) parts.push(`<br>下次发送：${escapeHtml(state.nextRunLocal)}`)
  parts.push('</div>')
  parts.push('</div></div></body></html>')
  return parts.join('\n')
}
