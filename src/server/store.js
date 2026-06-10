import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(__dirname, '../../data')

const FILES = {
  tasks: join(DATA_DIR, 'tasks.json'),
  sessions: join(DATA_DIR, 'sessions.json'),
  history: join(DATA_DIR, 'history.json'),
}

const DEFAULTS = {
  tasks: { tasks: [], activeTaskId: null, version: 1 },
  sessions: { sessions: [], version: 1 },
  history: { tasks: [], version: 1 },
}

// 原子写：写临时文件再 rename，避免半截写入损坏数据
function atomicWrite(path, obj) {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(obj, null, 2))
  renameSync(tmp, path)
}

function load(name) {
  const path = FILES[name]
  if (!existsSync(path)) return structuredClone(DEFAULTS[name])
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    console.error(`[store] ${name}.json 解析失败，使用默认值:`, e.message)
    return structuredClone(DEFAULTS[name])
  }
}

// 内存状态，启动时从磁盘加载
const state = {
  tasks: null,
  sessions: null,
  history: null,
}

export function init() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
  state.tasks = load('tasks')
  state.sessions = load('sessions')
  state.history = load('history')
}

// getters 返回内存中的活动对象（直接改后调 persist）
export const getTasks = () => state.tasks
export const getSessions = () => state.sessions
export const getHistory = () => state.history

export function persist(name) {
  atomicWrite(FILES[name], state[name])
}

export function persistAll() {
  for (const name of Object.keys(FILES)) persist(name)
}
