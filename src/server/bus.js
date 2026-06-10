// WebSocket 广播总线
const clients = new Set()

export function addClient(ws) {
  clients.add(ws)
  ws.on('close', () => clients.delete(ws))
}

export function broadcast(msg) {
  const data = JSON.stringify(msg)
  for (const ws of clients) {
    if (ws.readyState === 1 /* OPEN */) ws.send(data)
  }
}
