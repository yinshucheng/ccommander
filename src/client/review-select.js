// 批阅视图「钉住」逻辑：纯函数，便于单测（test/review-select.test.mjs）。
//
// 批阅视图默认跟随队列头部 current。从面板点「📖 批阅」会钉住某个 task（selectedId），
// 此后批阅页固定显示它，直到它离开活跃队列（被完成/移除）才回落到 current。
// 活跃队列 = current + waiting + deferred（done 不在内，钉住的 task 完成即视为消失）。

function activeTasks(queue) {
  return [queue?.current, ...(queue?.waiting || []), ...(queue?.deferred || [])].filter(Boolean)
}

// 钉住的 task 是否仍在活跃队列里。selectedId 为 null 视为「没钉住」→ false。
export function selectedExists(queue, selectedId) {
  if (selectedId == null) return false
  return activeTasks(queue).some((t) => t.id === selectedId)
}

// 批阅视图当前该显示哪个 task：钉住且仍在队列→钉住的；否则→队列头部 current。
export function resolveCurrent(queue, selectedId) {
  if (selectedId != null) {
    const hit = activeTasks(queue).find((t) => t.id === selectedId)
    if (hit) return hit
  }
  return queue?.current || null
}
