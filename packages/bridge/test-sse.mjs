// 测试 SSE 事件流 + 发送 prompt
import http from 'node:http'

const BASE = 'http://localhost:4096'

// 1. 连接 SSE
const events = []
const sseReq = http.get(`${BASE}/global/event`, (res) => {
  let buf = ''
  res.on('data', (chunk) => {
    buf += chunk.toString()
    const parts = buf.split('\n\n')
    buf = parts.pop()
    for (const part of parts) {
      const match = part.match(/^data:\s*(.+)$/m)
      if (match) {
        try {
          const evt = JSON.parse(match[1])
          const type = evt.payload?.type
          if (type === 'server.heartbeat' || type === 'server.connected') continue
          events.push(evt)
          console.log(`[SSE] dir=${evt.directory} type=${type}`)
          if (type === 'message.updated') {
            const info = evt.payload.properties.info
            console.log(`  → role=${info.role} id=${info.id} sessionID=${info.sessionID}`)
          }
          if (type === 'message.part.updated') {
            const part = evt.payload.properties.part
            console.log(`  → part.id=${part.id} part.messageID=${part.messageID} type=${part.type} text="${(part.text || '').substring(0, 50)}"`)
          }
          if (type === 'message.part.delta') {
            const p = evt.payload.properties
            console.log(`  → messageID=${p.messageID} partID=${p.partID} delta="${p.delta}"`)
          }
        } catch {}
      }
    }
  })
})

// 2. 等一下让 SSE 连接建立
await new Promise(r => setTimeout(r, 500))

// 3. 创建 session
const sessionRes = await fetch(`${BASE}/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
const session = await sessionRes.json()
console.log('\n[TEST] Created session:', session.id)

// 4. 发送 prompt
console.log('[TEST] Sending prompt...')
await fetch(`${BASE}/session/${session.id}/prompt_async`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ parts: [{ type: 'text', text: 'say hi' }] })
})

// 5. 等待回复
await new Promise(r => setTimeout(r, 15000))
sseReq.destroy()

console.log('\n\n=== SUMMARY ===')
console.log(`Total events: ${events.length}`)
const types = {}
for (const e of events) {
  const t = e.payload.type
  types[t] = (types[t] || 0) + 1
}
console.log('Event types:', types)

// 检查 message.updated 中 assistant 消息的格式
const assistantMsgs = events.filter(e => e.payload.type === 'message.updated' && e.payload.properties.info.role === 'assistant')
if (assistantMsgs.length > 0) {
  console.log('\n=== ASSISTANT MESSAGE FORMAT ===')
  console.log(JSON.stringify(assistantMsgs[0].payload.properties.info, null, 2))
}

// 检查 message.part.updated 的格式
const partUpdates = events.filter(e => e.payload.type === 'message.part.updated')
if (partUpdates.length > 0) {
  console.log('\n=== FIRST PART UPDATE FORMAT ===')
  console.log(JSON.stringify(partUpdates[0].payload.properties, null, 2))
}

process.exit(0)
