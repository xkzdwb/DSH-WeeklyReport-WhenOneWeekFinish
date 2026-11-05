// 一次性自查：HTML 标签是否成对（邮件客户端对这种问题很敏感）。
import { readFileSync } from 'node:fs'

const html = readFileSync(process.argv[2], 'utf8')
const VOID = new Set(['br', 'hr', 'img', 'meta', 'link', 'input', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr'])
const stack = []
const lines = html.split('\n')
let line = 1
let column = 0
for (let index = 0; index < html.length; index += 1) {
  if (html[index] === '\n') {
    line += 1
    column = 0
    continue
  }
  column += 1
  if (html[index] !== '<') continue
  const end = html.indexOf('>', index)
  if (end < 0) break
  const raw = html.slice(index + 1, end).trim()
  if (raw.startsWith('!') || raw.startsWith('?')) {
    index = end
    continue
  }
  const closing = raw.startsWith('/')
  const name = raw.replace(/^\//, '').split(/[\s/]/)[0].toLowerCase()
  const selfClosing = raw.endsWith('/')
  if (closing) {
    const top = stack.pop()
    if (top?.name !== name) {
      console.log(`MISMATCH line ${line}: </${name}> 对上的是 <${top?.name}>(line ${top?.line})`)
      if (top !== undefined) stack.push(top)
    }
  } else if (!selfClosing && !VOID.has(name)) {
    stack.push({ name, line, column })
  }
  index = end
}
console.log(`unclosed: ${stack.length}`)
for (const entry of stack.slice(-12)) console.log(`  <${entry.name}> line ${entry.line}`)
