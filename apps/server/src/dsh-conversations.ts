import { BadRequestException, ConflictException, Controller, Body, ForbiddenException, Get, Header, HttpCode,
  HttpException, HttpStatus, NotFoundException, Param, PayloadTooLargeException, Post, Req, Res } from '@nestjs/common'
import { createHash, randomUUID } from 'node:crypto'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import { accountHash, readInstance, rememberInstance } from './agent-plugin-sessions.js'
import { pool } from './database.js'
import { uuid } from './identity.js'
import { requireWorkspaceAccess, type WorkspaceRequest } from './workspace-access.js'
import { readFileRelaySettings, type FileRelaySettings } from './file-relay-settings.js'

type Scope = { id: string; userId: string; name: string }
type SharedSession = { id: string; title: string }
type Delivery = 'pending' | 'accepted' | 'rejected' | 'unknown'
type FileCard = { name: string; bytes: number }
type Message = { seq: number; role: 'user' | 'assistant'; text: string; files?: FileCard[] }
type Frame = { type: 'snapshot'; messages: Message[]; draft: string; running?: boolean }
  | { type: 'message'; message: Message }
  | { type: 'draft'; text: string } | { type: 'draft'; reset: true }
  | { type: 'activity' }
  | { type: 'state'; result: string }
type Watch = { session: string; emit: (frame: Frame) => void; end: () => void }
type Device = Scope & {
  routeId: string; instanceId?: string; hostName?: string
  workspace: string; ws: WebSocket; ready: boolean; files: boolean; sessions: Map<string, SharedSession>
  watches: Map<string, Watch>; prompts: Map<string, (status: Delivery) => void>
}

const devices = new Map<string, Device>()
const deviceKey = (workspace: string, account: string) => workspace + '/' + account
const sessionId = (id: unknown): id is string => typeof id === 'string' && /^[a-z0-9_-]{1,160}$/i.test(id)
const wireLimit = 512 * 1024
let activeFileRelays = 0
const validFilename = (name: unknown): name is string => typeof name === 'string' &&
  name.trim() !== '' && name.length <= 160 && !/[\\/\u0000-\u001f\u007f]/u.test(name) && name !== '.' && name !== '..'

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function readMessage(value: unknown): Message | undefined {
  const {seq, role, text, files: rawFiles} = object(value)
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0 ||
    (role !== 'user' && role !== 'assistant') || typeof text !== 'string' || text.length > 8000) return
  const files = Array.isArray(rawFiles) ? rawFiles.slice(0, 12).flatMap(item => {
    const { name, bytes } = object(item)
    return validFilename(name) && typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes >= 0 ? [{ name, bytes }] : []
  }) : []
  return {seq, role, text, ...(files.length ? { files } : {})}
}

function promptFiles(input: unknown, settings: FileRelaySettings) {
  if (!Array.isArray(input)) throw new BadRequestException('附件格式无效')
  if (!settings.enabled) throw new ForbiddenException('系统已停用 DSH 附件中转')
  if (input.length > settings.maxFiles) throw new BadRequestException('每条消息最多发送 ' + settings.maxFiles + ' 个文件')
  const uploadLimit = settings.maxTotalKiB * 1024
  const error = '每条消息的文件总大小不能超过 ' + settings.maxTotalKiB + ' KiB'
  let bytes = 0
  return input.map(item => {
    const {name, data} = object(item)
    if (!validFilename(name) || typeof data !== 'string' || !data.length) {
      throw new BadRequestException('文件名或内容无效')
    }
    if (data.length > 4 * Math.ceil(uploadLimit / 3)) throw new PayloadTooLargeException(error)
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new BadRequestException('文件编码无效')
    const decoded = Buffer.from(data, 'base64')
    if (decoded.toString('base64') !== data) throw new BadRequestException('文件编码无效')
    bytes += decoded.length
    if (bytes > uploadLimit) throw new PayloadTooLargeException(error)
    return { name, data }
  })
}

function readFrame(value: unknown): Frame | undefined {
  const frame = object(value)
  if (frame.type === 'snapshot' && Array.isArray(frame.messages) && frame.messages.length <= 32 &&
    typeof frame.draft === 'string' && frame.draft.length <= 8000) {
    return { type: 'snapshot', messages: frame.messages.map(readMessage).filter(message => message !== undefined),
      draft: frame.draft, ...(frame.running === true ? { running: true } : {}) }
  }
  if (frame.type === 'activity') return { type: 'activity' }
  if (frame.type === 'message') {
    const message = readMessage(frame.message)
    if (message) return {type: 'message', message}
  }
  if (frame.type === 'draft') {
    if (frame.reset === true) return { type: 'draft', reset: true }
    if (typeof frame.text === 'string' && frame.text.length <= 8000) return { type: 'draft', text: frame.text }
  }
  if (frame.type === 'state' && typeof frame.result === 'string' && frame.result.length <= 40) {
    return { type: 'state', result: frame.result }
  }
}

async function scope(workspace: string, account: { tokenHash: string } | { id: string }) {
  const { rows: [result] } = await pool.query<Scope>(`
    SELECT a.id,a.user_id AS "userId",a.device AS name
    FROM vacp_plugin_accounts a JOIN vacp_members m ON m.user_id=a.user_id AND m.workspace_id=$1
    WHERE a.${'id' in account ? 'id' : 'token_hash'}=$2 AND a.plugin='dsh'
      AND a.expires_at>now() AND m.role<>'viewer' AND NOT EXISTS (
        SELECT 1 FROM vacp_plugin_workspace_revocations r WHERE r.account_id=a.id AND r.workspace_id=$1
      )
  `, [workspace, 'id' in account ? account.id : account.tokenHash])
  return result
}

function tell(device: Device, msg: object) {
  if (device.ws.readyState !== WebSocket.OPEN || device.ws.bufferedAmount > wireLimit) return false
  device.ws.send(JSON.stringify(msg))
  return true
}

function receive(device: Device, msg: Record<string, unknown>) {
  if (msg.type === 'catalog' && Array.isArray(msg.sessions) && msg.sessions.length <= 20) {
    const sessions = new Map<string, SharedSession>()
    for (const item of msg.sessions) {
      if (sessionId(item?.id) && typeof item.title === 'string') {
        sessions.set(item.id, { id: item.id, title: item.title.slice(0, 160) })
      }
    }
    device.sessions = sessions
    device.ready = true
    for (const watch of device.watches.values()) if (!sessions.has(watch.session)) watch.end()
  }
  if (typeof msg.id !== 'string') return
  if (msg.type === 'frame') {
    const watch = device.watches.get(msg.id)
    if (!watch || !device.sessions.has(watch.session)) return
    const frame = readFrame(msg.frame)
    if (frame) watch.emit(frame)
  }
  if (msg?.type === 'watch-ended') device.watches.get(msg.id)?.end()
  if (msg?.type === 'receipt' && (msg.status === 'accepted' || msg.status === 'rejected')) {
    device.prompts.get(msg.id)?.(msg.status)
  }
}

export function installDshConnector(server: Server) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: wireLimit })
  function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    if (req.url !== '/api/v1/dsh-connector/ws') return socket.destroy()
    if (req.headers.origin || sockets.clients.size >= 100) return socket.destroy()
    sockets.handleUpgrade(req, socket, head, ws => sockets.emit('connection', ws))
  }
  server.on('upgrade', upgrade)

  sockets.on('connection', (ws: WebSocket) => {
    let device: Device | undefined
    let authorizing = false
    let alive = true
    let checking = false
    const hello = setTimeout(() => ws.terminate(), 5000)
    ws.on('pong', () => { alive = true })
    ws.on('error', () => ws.terminate())
    const heartbeat = setInterval(async () => {
      if (!device || checking) return
      if (!alive) { ws.terminate(); return }
      alive = false
      ws.ping()
      checking = true
      try {
        if (!await scope(device.workspace, { id: device.id })) ws.close(1008)
        else tell(device, { type: 'heartbeat' })
      } catch { ws.terminate() }
      finally { checking = false }
    }, 5000)
    ws.on('close', () => {
      clearTimeout(hello)
      clearInterval(heartbeat)
      if (!device) return
      const key = deviceKey(device.workspace, device.routeId)
      if (devices.get(key) === device) devices.delete(key)
      for (const watch of device.watches.values()) watch.end()
      for (const settle of device.prompts.values()) settle('unknown')
    })
    ws.on('message', async (data, binary) => {
      try {
        if (binary) { ws.close(1003); return }
        const msg = object(JSON.parse(data.toString()))
        if (device) { receive(device, msg); return }
        if (authorizing || msg.type !== 'hello' || msg.v !== 1 || typeof msg.workspace !== 'string' ||
          !uuid.test(msg.workspace) || typeof msg.token !== 'string') {
          ws.close(1008)
          return
        }
        authorizing = true
        const account = await scope(msg.workspace, { tokenHash: accountHash({headers:{ authorization:'Bearer ' + msg.token }}) })
        if (ws.readyState !== WebSocket.OPEN) return
        if (!account) { ws.close(1008); return }
        const instance = msg.instance === undefined ? undefined : readInstance(msg.instance)
        if (instance) await rememberInstance(account.id,instance)
        if (ws.readyState !== WebSocket.OPEN) return
        clearTimeout(hello)
        device = { ...account, routeId: instance ? account.id + '~' + instance.id : account.id,
          instanceId: instance?.id, hostName: instance?.hostName, workspace: msg.workspace, ws, ready: false, files: msg.files === true,
          sessions: new Map(), watches: new Map(), prompts: new Map() }
        const key = deviceKey(device.workspace, device.routeId)
        devices.get(key)?.ws.close(4001, 'replaced')
        devices.set(key, device)
        tell(device, { type: 'welcome', v: 1 })
      } catch { ws.close(1008) }
    })
  })
  return () => {
    server.off('upgrade', upgrade)
    for (const ws of sockets.clients) ws.terminate()
    sockets.close()
  }
}

async function getDevice(req: WorkspaceRequest, workspace: string, id: string, session: string) {
  const user = await requireWorkspaceAccess(req, workspace)
  const device = devices.get(deviceKey(workspace, id))
  if (!device || device.userId !== user.id || !device.sessions.has(session) ||
    !await scope(workspace, { id: device.id }) || devices.get(deviceKey(workspace, id)) !== device ||
    device.ws.readyState !== WebSocket.OPEN || !device.sessions.has(session)) {
    throw new NotFoundException('设备离线或会话授权已失效')
  }
  return device
}

@Controller('api/v1/workspaces/:workspace/dsh-conversations')
export class DshConversationsController {
  @Get('file-relay-settings')
  @Header('Cache-Control','no-store')
  async fileRelay(@Req() req: WorkspaceRequest, @Param('workspace') workspace: string) {
    await requireWorkspaceAccess(req, workspace)
    const { enabled, maxFiles, maxTotalKiB } = await readFileRelaySettings()
    return { enabled, maxFiles, maxTotalKiB }
  }

  @Get()
  async list(@Req() req: WorkspaceRequest, @Param('workspace') workspace: string) {
    const user = await requireWorkspaceAccess(req, workspace)
    const owned = [...devices.values()].filter(device => device.ready && device.workspace === workspace &&
      device.userId === user.id && device.ws.readyState === WebSocket.OPEN)
    const allowed = await Promise.all(owned.map(device => scope(workspace, { id: device.id })))
    return owned.flatMap((device, index) => allowed[index] && devices.get(deviceKey(workspace,device.routeId)) === device
      ? [{ id: device.routeId, name: device.name, hostName: device.hostName, instanceId: device.instanceId ?? device.id,
        files: device.files, sessions: [...device.sessions.values()] }]
      : [])
  }

  @Get(':device/:session/stream')
  async stream(@Req() req: WorkspaceRequest, @Res() reply: { hijack(): void; raw: ServerResponse }, @Param('workspace') workspace: string,
    @Param('device') id: string, @Param('session') session: string) {
    const device = await getDevice(req, workspace, id, session)
    if (device.watches.size >= 10) throw new ConflictException('此设备已打开太多对话窗口')
    const watch = randomUUID()
    reply.hijack()
    const response = reply.raw
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no',
    })
    const end = () => {
      clearInterval(timer)
      device.watches.delete(watch)
      tell(device, { type: 'unwatch', id: watch })
      response.end()
    }
    const timer = setInterval(() => {
      void getDevice(req, workspace, id, session).then(() => {
        if (!response.writableEnded && !response.write(': heartbeat\n\n')) end()
      }).catch(end)
    }, 5000)
    response.on('close', () => { if (device.watches.has(watch)) end() })
    device.watches.set(watch, { session, end, emit(frame) {
      if (!response.writableEnded && !response.write('data: ' + JSON.stringify(frame) + '\n\n')) end()
    } })
    if (!tell(device, { type: 'watch', id: watch, session })) end()
    else response.flushHeaders()
  }

  @Post(':device/:session/messages')
  @HttpCode(200)
  async prompt(@Req() req: WorkspaceRequest, @Param('workspace') workspace: string,
    @Param('device') id: string, @Param('session') session: string, @Body() body?: { id?: unknown; text?: unknown; files?: unknown }) {
    const device = await getDevice(req, workspace, id, session)
    if (typeof body?.id !== 'string' || !uuid.test(body.id) || typeof body.text !== 'string' ||
      body.text.length > 8000) throw new BadRequestException('请输入有效消息，正文最多 8000 字符')
    const hasFiles = body.files !== undefined && !(Array.isArray(body.files) && !body.files.length)
    const settings = hasFiles ? await readFileRelaySettings() : undefined
    const files = settings ? promptFiles(body.files, settings) : []
    if (!body.text.trim() && !files.length) throw new BadRequestException('请输入消息或添加文件')
    if (files.length && !device.files) throw new BadRequestException('该 DSH 插件版本暂不支持文件，请升级')
    const requestId = body.id
    const fingerprint = createHash('sha256').update(JSON.stringify(
      files.length ? [id, session, body.text, files] : [id, session, body.text],
    )).digest('hex')
    const keys = [workspace, device.userId, requestId]
    const inserted = await pool.query(`
      INSERT INTO vacp_remote_prompts(workspace_id,user_id,id,fingerprint,status)
      VALUES($1,$2,$3,$4,'pending') ON CONFLICT DO NOTHING
    `, [...keys, fingerprint])
    if (!inserted.rowCount) {
      const { rows: [previous] } = await pool.query<{ fingerprint: string; status: Delivery }>(`
        SELECT fingerprint,CASE WHEN status='pending' AND created_at<now()-interval '15 seconds'
          THEN 'unknown' ELSE status END AS status FROM vacp_remote_prompts WHERE workspace_id=$1 AND user_id=$2 AND id=$3
      `, keys)
      if (previous?.fingerprint !== fingerprint) throw new ConflictException('消息 ID 已用于其他内容')
      return { status: previous.status }
    }
    if (settings && activeFileRelays >= settings.maxConcurrent) {
      await pool.query(`UPDATE vacp_remote_prompts SET status='rejected' WHERE workspace_id=$1 AND user_id=$2 AND id=$3`, keys)
      throw new HttpException('附件中转繁忙，请稍后重试', HttpStatus.TOO_MANY_REQUESTS)
    }
    if (settings) activeFileRelays++
    let delivery: Delivery
    try {
      delivery = await new Promise<Delivery>(resolve => {
        const timer = setTimeout(() => settle('unknown'), 8000)
        function settle(status: Delivery) {
          clearTimeout(timer)
          device.prompts.delete(requestId)
          resolve(status)
        }
        device.prompts.set(requestId, settle)
        if (!device.sessions.has(session) || devices.get(deviceKey(workspace,id)) !== device) settle('rejected')
        else if (!tell(device, { type: 'prompt', id: requestId, session, text: body.text, ...(files.length ? {files} : {}) })) settle('rejected')
      })
    } finally {
      if (settings) activeFileRelays--
    }
    await pool.query('UPDATE vacp_remote_prompts SET status=$4 WHERE workspace_id=$1 AND user_id=$2 AND id=$3',
      [...keys, delivery])
    return { status: delivery }
  }
}
