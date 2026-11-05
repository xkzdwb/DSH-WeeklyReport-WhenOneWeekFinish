// 发信封装：把归一化配置 + 渲染好的正文交给零依赖 SMTP 客户端。
import { randomUUID } from 'node:crypto'
import { sendMail } from './mail-smtp.mjs'

/**
 * 发送周报邮件。
 * @param options - { settings, subject, text, html, log }
 * @returns { messageId }
 */
export async function sendWeeklyMail({ settings, subject, text, html, log = () => {} }) {
  const domain = String(settings.address).split('@')[1] ?? 'localhost'
  const messageId = `<dsh-weekly-report-${randomUUID()}@${domain}>`
  log(`SMTP ${settings.smtp.host}:${settings.smtp.port} 发送中（${settings.address} → ${settings.to}）`)
  await sendMail({
    host: settings.smtp.host,
    port: settings.smtp.port,
    secure: settings.smtp.secure,
    starttls: settings.smtp.starttls,
    user: settings.user,
    pass: settings.authCode,
    from: settings.address,
    fromName: settings.displayName,
    to: settings.to,
    subject,
    text,
    html,
    messageId,
    log,
  })
  return { messageId }
}
