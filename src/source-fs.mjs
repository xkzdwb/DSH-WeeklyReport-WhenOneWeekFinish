// 离线数据源：直接读 ~/.dsh/sessions/*/*/session.v4.jsonl.zstd。
// 插件在 HOST 里用 ctx.sessionQuery；这条路径只给命令行预览 / 测试用，两者折出来的数字应一致。
//
// 注意：DSH 把每个事件写成独立的 zstd 帧再追加，Node 的 zstdDecompressSync 只解第一帧，
// 所以这里按帧魔数逐个解，并用「解出来必须是完整 JSON 行」筛掉压缩数据里偶然出现的魔数。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 会话根目录：$DSH_HOME/sessions（没设就是 ~/.dsh/sessions）。 */
export function sessionsRoot() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'sessions')
}

/** 递归找所有 session.v4.jsonl.zstd。 */
export function listSessionFiles(root = sessionsRoot()) {
  const files = []
  const walk = (dir, depth) => {
    if (depth > 3) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.name === 'session.v4.jsonl.zstd') files.push(full)
    }
  }
  walk(root, 0)
  return files
}

/** 逐帧解一个会话日志 → 事件数组。 */
export function readSessionFile(file) {
  const buffer = readFileSync(file)
  const events = []
  let offset = 0
  for (;;) {
    const at = buffer.indexOf(MAGIC, offset)
    if (at < 0) break
    offset = at + MAGIC.length
    let text
    try {
      text = zstdDecompressSync(buffer.subarray(at)).toString('utf8')
    } catch {
      continue
    }
    if (!text.endsWith('\n')) continue
    const parsed = []
    let ok = true
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        parsed.push(JSON.parse(line))
      } catch {
        ok = false
        break
      }
    }
    if (ok) events.push(...parsed)
  }
  return events
}

/**
 * 加载全部会话（按最后写入时间倒序，最多 maxSessions 个）。
 * @param options - { root, maxSessions }
 * @returns [{ id, header, events }]
 */
export function loadSessions({ root = sessionsRoot(), maxSessions = 2000 } = {}) {
  const files = listSessionFiles(root)
    .map((file) => {
      let mtime = 0
      try {
        mtime = statSync(file).mtimeMs
      } catch {}
      return { file, mtime }
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, maxSessions)

  const sessions = []
  for (const { file } of files) {
    const events = readSessionFile(file)
    if (events.length === 0) continue
    const headerEvent = events.find((event) => event?.type === 'session')
    sessions.push({
      id: String(headerEvent?.id ?? file),
      header: headerEvent === undefined ? { id: file } : { ...headerEvent, id: headerEvent.id },
      events,
    })
  }
  return sessions
}
