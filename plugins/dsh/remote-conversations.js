import { createHash } from 'node:crypto'
import { createVacpClient } from './account-client.js'

const route = '/api/vacp-plugin/conversations'
const workspaceId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const nativeId = /^[a-z0-9_-]{1,160}$/i
const grantLimit = 20
const textLimit = 8000
const fileLimit = 256 * 1024

function streamText(records) {
  return (records ?? []).map(record => record.type === 'text-chunks' ? record.texts.join('')
    : record.type === 'chunk' && record.chunk?.type === 'text-delta' ? record.chunk.text : '').join('')
}

function firstText(event) {
  const source = event.data?.message ?? event.data
  if (!source) return ''
  const text = (source.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('')
  return text || streamText(source.stream)
}

function message(record) {
  const event = record?.event
  if (!event || !['user/message', 'assistant/message'].includes(event.type)) return
  if (event.type === 'user/message' && event.data?.source?.kind !== 'user') return
  const text = firstText(event).slice(0, textLimit)
  const source = event.data?.message ?? event.data
  const files = (source?.content ?? []).filter(part => part.type === 'file' && part.attachment)
    .slice(0, 12).map(({ attachment }) => ({ name: attachment.name, bytes: attachment.bytes }))
  if (!text && !files.length) return
  return { seq: event.seq, role: event.type === 'user/message' ? 'user' : 'assistant', text,
    ...(files.length ? { files } : {}) }
}

function availableSessions(items) {
  return items.filter(item => !item.origin && !item.blank && item.formatStatus !== 'migration-required' && nativeId.test(item.sessionId))
    .map(item => ({
      id: item.sessionId,
      title: typeof item.projections?.values?.title === 'string' ? item.projections.values.title.slice(0, 160) : item.sessionId,
    }))
}

function connect(controller, fileUploads, account, id, shares, isAvailable, instance) {
  const url = new URL('/api/v1/dsh-connector/ws', account.address)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  let socket
  let timer
  let heartbeat
  let attempts = 0
  let disposed = false
  let online = false
  const watches = new Map()
  const allowed = session => shares.has(session) && isAvailable(session)

  function send(msg) {
    if (socket?.readyState !== WebSocket.OPEN) return
    if (socket.bufferedAmount >= 512 * 1024) { socket.close(); return }
    socket.send(JSON.stringify(msg))
  }

  function publish() {
    if (online) send({ type: 'catalog', sessions: [...shares.values()].filter(entry => allowed(entry.id)) })
  }

  async function follow({ id, session }, connection) {
    const abort = new AbortController()
    watches.set(id, { abort, session })
    const emit = frame => {
      if (!abort.signal.aborted && socket === connection && allowed(session)) send({ type: 'frame', id, frame })
    }
    try {
      for await (const frame of controller.follow({
        address: { kind: 'session', sessionId: session }, maxMessages: 16, assistantStream: true,
      }, abort.signal)) {
        if (frame.type === 'snapshot') {
          const latestTurn = frame.records.findLast(record => ['turn/start', 'turn/end'].includes(record.event?.type))
          const attempt = frame.assistantStream?.activeAttempt
          emit({ type: 'snapshot', messages: frame.records.map(message).filter(Boolean),
            draft: streamText(attempt?.stream).slice(0, textLimit),
            running: Boolean(attempt) || latestTurn?.event.type === 'turn/start' })
        } else if (frame.type === 'event') {
          const entry = message(frame)
          if (entry) emit({ type: 'message', message: entry })
          if (frame.event?.type === 'turn/start') emit({ type: 'activity' })
          if (frame.event?.type === 'turn/end') {
            emit({ type: 'state', result: frame.event.data?.reason?.kind })
          }
        } else if (frame.type === 'assistant-stream') {
          const part = frame.frame
          if (part.type === 'start') emit({ type: 'activity' })
          if (part.type === 'chunk' && part.chunk?.type === 'text-delta') {
            emit({ type: 'draft', text: part.chunk.text.slice(0, textLimit) })
          } else if (part.type !== 'chunk') emit({ type: 'draft', reset: true })
        }
      }
    } catch {
      // VACP will reopen an authorized stream with a fresh native history snapshot.
    } finally {
      watches.delete(id)
      if (!abort.signal.aborted && socket === connection) send({ type: 'watch-ended', id })
    }
  }

  async function prompt({ id, session, text, files = [] }, connection) {
    let status = 'rejected'
    if (allowed(session) && typeof text === 'string' && text.length <= textLimit &&
      Array.isArray(files) && files.length <= 3 && (text.trim() || files.length)) {
      try {
        const signal = AbortSignal.timeout(7500)
        const content = text.trim() ? [{ type: 'text', text }] : []
        let total = 0
        for (const file of files) {
          if (!allowed(session) || socket !== connection || !online) throw new Error('session unavailable')
          if (typeof file?.name !== 'string' || typeof file.data !== 'string' || file.name.length > 160 ||
            file.data.length > 4 * Math.ceil(fileLimit / 3)) throw new Error('invalid file')
          const bytes = Buffer.from(file.data, 'base64')
          total += bytes.length
          if (!bytes.length || total > fileLimit || bytes.toString('base64') !== file.data) throw new Error('invalid file')
          const { receiptId } = await fileUploads.uploadStream({
            sessionId: session, name: file.name, signal, data: (async function* () { yield bytes })(),
          })
          content.push({ type: 'file', receiptId })
        }
        if (!allowed(session) || socket !== connection || !online) throw new Error('session unavailable')
        await controller.prompt({ sessionId: session, requestId: id, mode: 'queue', content }, signal)
        status = 'accepted'
      } catch (error) {
        if (error?.name === 'TimeoutError') return
      }
    }
    if (socket === connection) send({ type: 'receipt', id, status })
  }

  function open() {
    if (disposed) return
    const connection = new WebSocket(url)
    socket = connection
    function renewHeartbeat() {
      clearTimeout(heartbeat)
      heartbeat = setTimeout(() => connection.close(), 17000)
    }
    renewHeartbeat()
    connection.onopen = () => send({ type: 'hello', v: 1, workspace: id, token: account.token, files: true, instance })
    connection.onmessage = ({ data }) => {
      if (disposed || socket !== connection || typeof data !== 'string') return
      renewHeartbeat()
      let msg
      try { msg = JSON.parse(data) } catch { return }
      if (msg.type === 'welcome' && msg.v === 1) {
        online = true
        attempts = 0
        publish()
      } else if (online && typeof msg.id === 'string') {
        if (msg.type === 'unwatch') watches.get(msg.id)?.abort.abort()
        if (msg.type === 'watch' && !watches.has(msg.id)) {
          if (allowed(msg.session)) void follow(msg, connection)
          else send({ type: 'watch-ended', id: msg.id })
        }
        if (msg.type === 'prompt') void prompt(msg, connection)
      }
    }
    connection.onerror = () => { connection.close() }
    connection.onclose = event => {
      if (socket !== connection) return
      clearTimeout(heartbeat)
      online = false
      for (const watch of watches.values()) watch.abort.abort()
      watches.clear()
      if (!disposed && event.code !== 1008 && event.code !== 4001) {
        timer = setTimeout(open, Math.min(10000, 1000 * (2 ** attempts++)))
      }
    }
  }

  open()
  return {
    online: () => online,
    refresh() {
      for (const watch of watches.values()) if (!allowed(watch.session)) watch.abort.abort()
      publish()
    },
    close() {
      disposed = true
      clearTimeout(timer)
      clearTimeout(heartbeat)
      for (const watch of watches.values()) watch.abort.abort()
      socket?.close()
    },
  }
}

export function mountRemoteConversations(ctx, readAccount, run, instance) {
  const key = 'vacp-remote/' + ctx.profileContext.name
  const connected = new Map()
  let saved = new Map()
  let identity
  let account
  let workspaces = new Set()
  let disposed = false
  const isAvailable = id => !ctx.workspaceRegistry.archivedSessionIds.includes(id)
  ctx.on('workspace/session-archived', syncConnections, { global: true })
  ctx.on('workspace/session-unarchived', syncConnections, { global: true })

  function syncConnections() {
    if (disposed) return
    for (const [id, link] of connected) {
      if (!workspaces.has(id) || !saved.get(id)?.size) {
        link.close()
        connected.delete(id)
      }
    }
    for (const [id, shares] of saved) {
      if (!workspaces.has(id) || !shares.size) continue
      const link = connected.get(id)
      if (link) link.refresh()
      else connected.set(id, connect(ctx.sessionController, ctx.fileUploads, account, id, shares, isAvailable, instance))
    }
  }

  async function sync(current, spaces = []) {
    const fingerprint = current && createHash('sha256').update(current.address + '\n' + current.token).digest('hex')
    if (identity !== fingerprint) {
      disconnect()
      identity = undefined
      const record = fingerprint ? await ctx.credentials.readRecord(key) : undefined
      saved = new Map()
      if (record?.kind === 'grant' && record.payload?.identity === fingerprint) {
        for (const [id, shares] of Object.entries(record.payload.shares)) {
          saved.set(id, new Map(shares.map(item => [item.id, item])))
        }
      }
      identity = fingerprint
    }
    account = current
    workspaces = new Set(spaces.map(space => space.id))
    syncConnections()
  }

  function disconnect() {
    for (const link of connected.values()) link.close()
    connected.clear()
  }

  function reply(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: route, auth: 'required',
    async handler(req, res, peer) {
      if (peer?.principal.kind !== 'owner') return reply(res, 403, { message: '仅 DSH 所有者可授权会话。' })
      if (!['GET', 'POST', 'DELETE'].includes(req.method)) return reply(res, 405, { message: '请求方式无效。' })
      const params = new URL(req.url, 'http://localhost').searchParams
      const workspace = params.get('workspace') ?? ''
      const id = params.get('session') ?? ''
      if (!workspaceId.test(workspace) || (req.method !== 'GET' &&
        (!nativeId.test(id) || req.headers['x-vacp-account-action'] !== '1'))) {
        return reply(res, 400, { message: '请求无效。' })
      }
      await run(async () => {
        try {
          const current = await readAccount()
          if (!current) return reply(res, 401, { message: '请先登录 VACP。' })
          const spaces = await createVacpClient(current.address).listWorkspaces(current.token)
          await sync(current, spaces)
          if (!workspaces.has(workspace)) return reply(res, 404, { message: '工作空间不可用。' })
          const entries = availableSessions((await ctx.sessionController.list({}, AbortSignal.timeout(8000))).items)
            .filter(entry => isAvailable(entry.id))
          const available = new Set(entries.map(entry => entry.id))
          const grants = saved.get(workspace) ?? new Map()
          if (req.method !== 'GET') {
            const pending = new Map(grants)
            if (req.method === 'POST') {
              const entry = entries.find(item => item.id === id)
              if (!entry) return reply(res, 404, { message: '会话不可用。' })
              if (!pending.has(id) && pending.size >= grantLimit) {
                return reply(res, 409, { message: '一个工作空间最多授权 20 个会话。' })
              }
              pending.set(id, entry)
            } else pending.delete(id)
            const next = new Map(saved).set(workspace, pending)
            await ctx.credentials.modifyRecord(key, async () => ({
              kind: 'grant', payload: { identity, shares: Object.fromEntries([...next].map(([id, entries]) => [id, [...entries.values()]])) },
            }))
            grants.clear()
            for (const item of pending.values()) grants.set(item.id, item)
            saved.set(workspace, grants)
            syncConnections()
          }
          const displayed = [...new Map([...grants, ...entries.slice(0, 100).map(item => [item.id, item])]).values()]
          return reply(res, 200, { online: connected.get(workspace)?.online() ?? false,
            sessions: displayed.map(item => ({ ...item, shared: grants.has(item.id), available: available.has(item.id) })) })
        } catch (error) {
          return reply(res, error?.status === 401 ? 401 : 502, { message: '无法读取或更新授权，请检查 VACP 连接。' })
        }
      })
    },
  }))
  return { sync, close() { disposed = true; disconnect() } }
}
