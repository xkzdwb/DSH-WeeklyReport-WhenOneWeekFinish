// 少量持久状态：上次发送时间、补发记录、上次错误。
// 放在插件目录 state.json（可用 config.stateFile 改）；写临时文件再 rename，断电不会留下半个 JSON。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * 读取状态；文件不存在或损坏都当空状态（损坏时把原因带出来，交给调用方记日志）。
 * @param file - 状态文件路径。
 * @returns { state, error }
 */
export function loadState(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { state: {}, error: `状态文件不是对象：${file}` }
    }
    return { state: parsed, error: undefined }
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: {}, error: undefined }
    return { state: {}, error: `读取状态文件失败（${file}）：${error?.message ?? error}` }
  }
}

/** 原子写出（同目录临时文件 + rename）。 */
export function saveState(file, state) {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  renameSync(temp, file)
}
