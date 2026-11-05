// 连通性探测：只握手认证、不投信（不发任何邮件）。
// 用法：node tools/probe-mail.mjs
import { readFileSync } from 'node:fs'
import { once } from 'node:events'
import tls from 'node:tls'
import { hostname } from 'node:os'

const SECRETS = 'P:\\工程\\DeepseekHarness\\系统\\email-approval\\secrets.json'
const HOST = 'smtp.163.com'
const PORT = 465
const USER = 'xkdobepc@163.com'

const secrets = JSON.parse(readFileSync(SECRETS, 'utf8'))
const socket = tls.connect({ host: HOST, port: PORT, servername: HOST })
socket.setEncoding('latin1')
let buffer = ''
socket.on('data', (chunk) => {
  buffer += chunk
})

async function line() {
  for (;;) {
    const index = buffer.indexOf('\n')
    if (index >= 0) {
      const out = buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
      return out
    }
    await once(socket, 'data')
  }
}

async function readResponse() {
  const lines = []
  for (;;) {
    const l = await line()
    lines.push(l)
    if (/^\d{3}(?: |$)/.test(l)) return { code: Number(l.slice(0, 3)), lines }
  }
}

async function cmd(text) {
  socket.write(`${text}\r\n`)
  const res = await readResponse()
  if (res.code >= 400) throw new Error(`${text.slice(0, 20)} -> ${res.code} ${res.lines.join(' | ')}`)
  return res
}

const started = Date.now()
await once(socket, 'secureConnect')
console.log('TLS ok', Date.now() - started, 'ms')
console.log('greeting:', (await readResponse()).lines.join(' | '))
const ehlo = await cmd(`EHLO ${hostname() || 'dsh.local'}`)
console.log('EHLO:', ehlo.lines.join(' | ').slice(0, 300))
await cmd('AUTH LOGIN')
await cmd(Buffer.from(USER, 'utf8').toString('base64'))
const auth = await cmd(Buffer.from(secrets.authCode, 'utf8').toString('base64'))
console.log('AUTH ok:', auth.lines.join(' | '))
console.log('NOOP:', (await cmd('NOOP')).lines.join(' | '))
try {
  await cmd('QUIT')
} catch {}
socket.destroy()
