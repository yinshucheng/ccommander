// Session fork/compact 跟踪（第 3 项的根因层，纯函数，可单测）。
//
// /compact 或 fork 后 claude 写出新 sessionId 的 jsonl 文件，但是「这件事是从哪个
// 老 sid 来的」只有进程自己知道（stream-json 里会带新 session_id；hook 的
// SessionStart 也会触发并报新 sid）。我们用一张 alias 表把 old→new 串起来：
//   - sessions.json 里给 session 加 aliases: [oldSid, ...]
//   - findSessionFile / transcript 查询时按「先查当前 sid，再 fallback aliases」
//
// 这里只管 alias 表的纯逻辑；converse.js 监听到 sid 变化后调 reassignSession()，
// 它负责改 procs map 的 key + 调 upsertFromAgent + persist。

import { getSessions, persist } from './store.js'
import { broadcast } from './bus.js'

// 已记录过的 alias：避免 hook + stream-json 双源对同一对 (old,new) 重复触发
const seenPairs = new Set()
const pairKey = (a, b) => `${a}->${b}`

// 把 oldSid 作为 newSid 的 alias 记下来（sessions.json 持久化）。
// 返回是否真的写入了（重复忽略）。
export function recordAlias(oldSid, newSid) {
  if (!oldSid || !newSid || oldSid === newSid) return false
  if (seenPairs.has(pairKey(oldSid, newSid))) return false
  const { sessions } = getSessions()
  // 优先找 newSid 对应的 session：通常 hook 触发时已 upsert
  let target = sessions.find((s) => s.claudeSessionId === newSid)
  if (!target) {
    // 退化：还没有新 session 记录 —— 把 old 的就地改名为 new，把 old 转为别名
    target = sessions.find((s) => s.claudeSessionId === oldSid)
    if (!target) return false
    target.claudeSessionId = newSid
    target.sessionId = newSid
  }
  target.aliases = Array.from(new Set([...(target.aliases || []), oldSid]))
  seenPairs.add(pairKey(oldSid, newSid))
  persist('sessions')
  broadcast({ type: 'session_aliased', oldSid, newSid })
  return true
}

// 把 sid 解析成「当前活的 sid」：如果它是别名，返回它指向的活 sid；否则原样返回。
// 用于 findSessionFile 等只认当前 sid 的旧路径补丁。
export function resolveAlias(sid) {
  if (!sid) return sid
  const { sessions } = getSessions()
  // 当前 sid 直接命中
  if (sessions.some((s) => s.claudeSessionId === sid)) return sid
  // 是别名 → 找包含它的活 session
  const hit = sessions.find((s) => (s.aliases || []).includes(sid))
  return hit ? hit.claudeSessionId : sid
}

// 主动迁移：把 procs map 的 key 从 old 换成 new、记 alias、保留进程不重启。
// converse.js 在 parseStreamLine 发现 sid 变化时调它。
// procsMap：converse.js 的 procs，传进来便于纯逻辑（不直接 import 互引）。
export function reassignSession(procsMap, oldSid, newSid) {
  if (!oldSid || !newSid || oldSid === newSid) return false
  // procs map key 迁移（进程不动）
  if (procsMap.has(oldSid) && !procsMap.has(newSid)) {
    const rec = procsMap.get(oldSid)
    procsMap.delete(oldSid)
    procsMap.set(newSid, rec)
  }
  recordAlias(oldSid, newSid)
  return true
}

// 测试用：清掉记忆（避免测试间互相污染）
export function _resetForTest() {
  seenPairs.clear()
}
