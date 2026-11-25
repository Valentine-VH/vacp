import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post, Put, Req, ServiceUnavailableException } from '@nestjs/common'
import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { pool } from './database.js'
import { field, uuid } from './identity.js'
import { requireWorkspaceAccess, type WorkspaceRequest } from './workspace-access.js'

type Auth = 'none' | 'bearer' | 'header'
type Config = { name: string; endpoint: string; auth: Auth; header: string | null; enabled: boolean; secret: string | null }
export type McpTarget = { id: string; workspace_id: string; endpoint: string; auth: Auth; header: string | null; secret_cipher: string | null }
const forbiddenHeaders = new Set([
  'authorization','proxy-authorization','host','cookie','set-cookie','connection','upgrade',
  'transfer-encoding','content-length','content-type','accept','origin','referer','forwarded',
  'te','trailer','expect','keep-alive',
])

function parse(body: unknown): Config {
  const name = field(body,'name',1,80)
  const raw = field(body,'endpoint',1,1500)
  let url: URL
  try { url = new URL(raw) } catch { throw new BadRequestException('请输入有效的 MCP 服务地址') }
  const loopback = ['localhost','127.0.0.1','[::1]'].includes(url.hostname)
  const localHttp = url.protocol === 'http:' && loopback && process.env.NODE_ENV !== 'production'
  if ((url.protocol !== 'https:' && !localHttp) || url.username || url.password || url.search || url.hash) {
    throw new BadRequestException('使用 HTTPS 地址，凭据放在认证字段。本地开发可使用回环 HTTP')
  }
  const auth = field(body,'auth',4,6)
  if (auth !== 'none' && auth !== 'bearer' && auth !== 'header') throw new BadRequestException('未知认证方式')
  const input = body as Record<string, unknown>
  if (typeof input.enabled !== 'boolean') throw new BadRequestException('无效启用状态')
  const header = auth === 'header' ? field(body,'header',1,64).toLowerCase() : null
  if (header && (!/^[a-z0-9][a-z0-9-]*$/.test(header) || forbiddenHeaders.has(header) ||
      header.startsWith('mcp-') || header.startsWith('x-forwarded-') || header.startsWith('sec-'))) {
    throw new BadRequestException('该 Header 名称保留给协议或代理，请使用服务商指定的 API Key Header')
  }
  const key = input.secret
  if (key !== undefined && (typeof key !== 'string' || !/^[!-~]{1,4096}$/.test(key) || auth === 'none')) {
    throw new BadRequestException('密钥必须是无空白及控制字符的单行文本')
  }
  return {name,endpoint:url.href,auth,header,enabled:input.enabled,secret:typeof key === 'string' ? key : null}
}

function encryptionKey() {
  const supplied = process.env.VACP_MCP_ENCRYPTION_KEY
  if (supplied !== undefined) {
    if (!/^[a-f0-9]{64}$/i.test(supplied)) throw new ServiceUnavailableException('MCP 加密密钥配置无效')
    return Buffer.from(supplied,'hex')
  }
  if (process.env.NODE_ENV === 'production') throw new ServiceUnavailableException('尚未配置 MCP 加密密钥')
  const path = fileURLToPath(new URL('../../../.mcp-key',import.meta.url))
  try {
    try {
      writeFileSync(path,randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'})
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
    }
    const saved = readFileSync(path,'utf8')
    if (!/^[a-f0-9]{64}$/i.test(saved)) throw Error('invalid local key')
    return Buffer.from(saved,'hex')
  } catch { throw new ServiceUnavailableException('无法安全保存 MCP 密钥') }
}

function seal(secret: string, workspaceId: string, id: string, config: Config) {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm',encryptionKey(),nonce)
  cipher.setAAD(Buffer.from(JSON.stringify([workspaceId,id,config.endpoint,config.auth,config.header])))
  const data = Buffer.concat([cipher.update(secret,'utf8'),cipher.final()])
  return ['v1',nonce.toString('base64url'),cipher.getAuthTag().toString('base64url'),data.toString('base64url')].join('.')
}

export function mcpProxyAllowed(endpoint: string) {
  const url = new URL(endpoint)
  const origins = (process.env.VACP_MCP_ALLOWED_ORIGINS ?? '').split(',').map(origin => origin.trim())
  return origins.includes(url.origin) && (url.protocol === 'https:' ||
    (url.protocol === 'http:' && process.env.NODE_ENV !== 'production' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname)))
}

export function mcpAuthHeaders(target: McpTarget, headers: Headers) {
  const [version,nonce,tag,data] = (target.secret_cipher ?? '').split('.')
  if (version !== 'v1' || !nonce || !tag || !data) throw new ServiceUnavailableException('MCP 认证配置不可用')
  const decipher = createDecipheriv('aes-256-gcm',encryptionKey(),Buffer.from(nonce,'base64url'))
  decipher.setAAD(Buffer.from(JSON.stringify([target.workspace_id,target.id,target.endpoint,target.auth,target.header])))
  decipher.setAuthTag(Buffer.from(tag,'base64url'))
  const secret = Buffer.concat([decipher.update(Buffer.from(data,'base64url')),decipher.final()]).toString('utf8')
  if (target.auth === 'bearer') headers.set('Authorization','Bearer '+secret)
  else if (target.header) headers.set(target.header,secret)
}

export function mcpSessionProof(pluginSessionId: string, target: McpTarget, sessionId: string) {
  return createHmac('sha256',encryptionKey())
    .update(JSON.stringify(['mcp-session',pluginSessionId,target.id,target.endpoint,target.secret_cipher,sessionId])).digest()
}

export function openMcpSessionId(value: string, pluginSessionId: string, target: McpTarget) {
  const match = /^([A-Za-z0-9_-]{1,684})\.([A-Za-z0-9_-]{43})$/.exec(value)
  if (!match) throw new BadRequestException('MCP 会话标识无效')
  const sessionId = Buffer.from(match[1],'base64url').toString('utf8')
  if (!/^[!-~]{1,512}$/.test(sessionId) ||
    !timingSafeEqual(mcpSessionProof(pluginSessionId,target,sessionId),Buffer.from(match[2],'base64url'))) {
    throw new BadRequestException('MCP 会话标识无效')
  }
  return sessionId
}

const columns = 'id,name,endpoint,auth,header,enabled,(secret_cipher IS NOT NULL) AS "hasSecret"'

@Controller('api/v1/workspaces/:workspaceId/mcp')
export class McpController {
  @Get()
  async list(@Req() req: WorkspaceRequest, @Param('workspaceId') workspaceId: string) {
    await requireWorkspaceAccess(req,workspaceId)
    const {rows} = await pool.query(`SELECT ${columns} FROM vacp_mcp_servers WHERE workspace_id=$1 ORDER BY name,id`,[workspaceId])
    return rows
  }

  @Post()
  async create(@Req() req: WorkspaceRequest, @Param('workspaceId') workspaceId: string, @Body() body: unknown) {
    const user = await requireWorkspaceAccess(req,workspaceId,true)
    const config = parse(body)
    const id = randomUUID()
    if (config.auth !== 'none' && !config.secret) throw new BadRequestException('请填写认证密钥')
    const encrypted = config.secret ? seal(config.secret,workspaceId,id,config) : null
    const {rows:[item]} = await pool.query(`
      INSERT INTO vacp_mcp_servers(id,workspace_id,name,endpoint,auth,header,enabled,secret_cipher)
      SELECT $1,$2,$3,$4,$5,$6,$7,$8 WHERE EXISTS (
        SELECT 1 FROM vacp_members WHERE workspace_id=$2 AND user_id=$9 AND role IN ('owner','admin')
      )
      ON CONFLICT(workspace_id,name) DO NOTHING RETURNING ${columns}
    `,[id,workspaceId,config.name,config.endpoint,config.auth,config.header,config.enabled,encrypted,user.id])
    if (!item) throw new ConflictException('已有同名 MCP 服务或工作空间权限已变更')
    return item
  }

  @Put(':id')
  async edit(@Req() req: WorkspaceRequest, @Param('workspaceId') workspaceId: string, @Param('id') id: string, @Body() body: unknown) {
    const user = await requireWorkspaceAccess(req,workspaceId,true)
    if (!uuid.test(id)) throw new NotFoundException()
    const config = parse(body)
    const db = await pool.connect()
    try {
      await db.query('BEGIN')
      const {rows:[current]} = await db.query(`
        SELECT endpoint,auth,header,secret_cipher FROM vacp_mcp_servers
        WHERE workspace_id=$1 AND id=$2 FOR UPDATE
      `, [workspaceId,id])
      if (!current) throw new NotFoundException()
      let encrypted: string | null = null
      if (config.auth !== 'none') {
        const sameDestination = current.endpoint === config.endpoint && current.auth === config.auth && current.header === config.header
        encrypted = config.secret ? seal(config.secret,workspaceId,id,config) : sameDestination ? current.secret_cipher : null
        if (!encrypted) throw new BadRequestException('新增或更改地址、认证方式或 Header 时，请重新填写密钥')
      }
      const {rows:[item]} = await db.query(`
        UPDATE vacp_mcp_servers SET name=$3,endpoint=$4,auth=$5,header=$6,enabled=$7,secret_cipher=$8
        WHERE workspace_id=$1 AND id=$2 AND EXISTS (
          SELECT 1 FROM vacp_members WHERE workspace_id=$1 AND user_id=$9 AND role IN ('owner','admin')
        ) RETURNING ${columns}
      `,[workspaceId,id,config.name,config.endpoint,config.auth,config.header,config.enabled,encrypted,user.id])
      if (!item) throw new NotFoundException()
      await db.query('COMMIT')
      return item
    } catch (error) {
      await db.query('ROLLBACK')
      if (error instanceof Error && 'code' in error && error.code === '23505') throw new ConflictException('已有同名 MCP 服务')
      throw error
    } finally { db.release() }
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Req() req: WorkspaceRequest, @Param('workspaceId') workspaceId: string, @Param('id') id: string) {
    const user = await requireWorkspaceAccess(req,workspaceId,true)
    if (!uuid.test(id)) throw new NotFoundException()
    await pool.query(`
      DELETE FROM vacp_mcp_servers WHERE workspace_id=$1 AND id=$2 AND EXISTS (
        SELECT 1 FROM vacp_members WHERE workspace_id=$1 AND user_id=$3 AND role IN ('owner','admin')
      )
    `,[workspaceId,id,user.id])
  }
}
