// 诊断用：看看会话日志里有哪些事件、最新一个会话长什么样。
// 用法：node tools/probe-session.mjs [session.v4.jsonl.zstd]
import { readSessionFile, sessionsRoot, loadSessions } from '../src/source-fs.mjs'

const target = process.argv[2]
const events = target === undefined ? (loadSessions({ maxSessions: 1 })[0]?.events ?? []) : readSessionFile(target)

console.log(target === undefined ? `sessions root: ${sessionsRoot()}` : `file: ${target}`)
console.log(`events: ${events.length}`)
const types = new Map()
for (const event of events) types.set(event.type, (types.get(event.type) ?? 0) + 1)
console.log(
  'types:',
  [...types.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `${type}=${count}`)
    .join(' '),
)

for (const type of ['session', 'session/title', 'user/message', 'assistant/message']) {
  const found = events.find((event) => event.type === type)
  console.log(`\n--- ${type}:`)
  console.log(found === undefined ? 'none' : JSON.stringify(found).slice(0, 1200))
}
