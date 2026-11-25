import { All, BadRequestException, Body, ConflictException, Controller, Get, Header, NotFoundException, Param, Post, Put, Req, Res } from '@nestjs/common'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { IncomingHttpHeaders, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pool } from './database.js'
import { uuid } from './identity.js'
import { requireWorkspaceAccess, type WorkspaceRequest } from './workspace-access.js'
import { requirePluginSession, type PluginRequest } from './agent-plugin-sessions.js'
import { mcpAuthHeaders, mcpProxyAllowed, mcpSessionProof, openMcpSessionId, type McpTarget } from './mcp.js'

type McpRequest = { method: string; headers: IncomingHttpHeaders }
type McpReply = {
  raw: ServerResponse
  header(name: string, value: string): McpReply
  type(contentType: string): McpReply
  code(status: number): McpReply
  send(body?: unknown): unknown
}

const pluginType = (value: string) => {
  if (value !== 'dsh' && value !== 'opencode') throw new BadRequestException('未知插件')
  return value
}

function ids(input:unknown) {
  if (!Array.isArray(input) || input.length>50 || input.some(id=>typeof id!=='string'||!uuid.test(id))) {
    throw new BadRequestException('资源列表无效，每种最多可选择 50 项')
  }
  return [...new Set<string>(input.map(id=>id.toLowerCase()))]
}

// Only versions installed and still approved in this workspace are eligible.
const skillQuery = `
  SELECT r.id,r.name,r.version,r.digest
  FROM vacp_skill_installs i JOIN vacp_skill_releases r ON r.id=i.release_id
  WHERE i.workspace_id=$1 AND r.review_status='approved'
`
const mcpQuery = 'SELECT id,name,auth,endpoint FROM vacp_mcp_servers WHERE workspace_id=$1 AND enabled'

@Controller('api/v1/workspaces/:workspaceId/agent-plugin-profiles')
export class AgentPluginProfilesController {
  @Get()
  async options(@Req() req:WorkspaceRequest,@Param('workspaceId') workspace:string) {
    await requireWorkspaceAccess(req,workspace,true)
    const [profiles,models,skills,mcps] = await Promise.all([
      pool.query('SELECT plugin,route_id AS "routeId",skill_ids AS "skillIds",mcp_ids AS "mcpIds",rpm FROM vacp_plugin_profiles WHERE workspace_id=$1',[workspace]),
      pool.query('SELECT id,alias FROM vacp_gateway_routes WHERE workspace_id=$1 AND enabled ORDER BY alias',[workspace]),
      pool.query(skillQuery + ' ORDER BY r.name,r.version',[workspace]),
      pool.query(mcpQuery + ' ORDER BY name',[workspace]),
    ])
    return {profiles:profiles.rows,models:models.rows,skills:skills.rows,
      mcps:mcps.rows.map(({id,name,auth,endpoint}) => ({id,name,auth,available:auth==='none'||mcpProxyAllowed(endpoint)}))}
  }

  @Put(':plugin')
  async save(@Req() req:WorkspaceRequest,@Param('workspaceId') workspace:string,@Param('plugin') value:string,@Body() body:unknown) {
    const user=await requireWorkspaceAccess(req,workspace,true)
    const plugin=pluginType(value)
    if (!body || typeof body!=='object') throw new BadRequestException('配置格式无效')
    const input=body as Record<string,unknown>
    const skillIds=ids(input.skillIds),mcpIds=ids(input.mcpIds)
    const routeId = input.routeId ?? null
    if (routeId!==null && (typeof routeId!=='string'||!uuid.test(routeId))) throw new BadRequestException('无效模型')
    const rpm=input.rpm
    if (typeof rpm!=='number'||!Number.isSafeInteger(rpm)||rpm<1||rpm>600) throw new BadRequestException('每分钟请求数须在 1–600 之间')
    const {rows:[profile]}=await pool.query(`
      WITH saved AS (
      INSERT INTO vacp_plugin_profiles(workspace_id,plugin,route_id,skill_ids,mcp_ids,rpm)
      SELECT $1,$2,$3,$4,$5,$6
      WHERE EXISTS (SELECT 1 FROM vacp_members WHERE workspace_id=$1 AND user_id=$7 AND role IN ('owner','admin'))
        AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM vacp_gateway_routes WHERE workspace_id=$1 AND id=$3 AND enabled))
        AND cardinality($4::uuid[])=(SELECT count(*) FROM vacp_skill_installs i
          JOIN vacp_skill_releases r ON r.id=i.release_id
          WHERE i.workspace_id=$1 AND r.review_status='approved' AND r.id=ANY($4))
        AND cardinality($5::uuid[])=(SELECT count(*) FROM vacp_mcp_servers WHERE workspace_id=$1 AND enabled AND id=ANY($5))
      ON CONFLICT(workspace_id,plugin) DO UPDATE SET route_id=excluded.route_id,skill_ids=excluded.skill_ids,
        mcp_ids=excluded.mcp_ids,rpm=excluded.rpm
      RETURNING workspace_id,plugin,route_id,skill_ids,mcp_ids,rpm
      ), invalidated AS (
        UPDATE vacp_gateway_keys k SET revoked_at=now()
        FROM saved p JOIN vacp_plugin_sessions s ON s.workspace_id=p.workspace_id AND s.plugin=p.plugin
        WHERE k.plugin_session_id=s.id AND s.account_id IS NULL AND k.revoked_at IS NULL
          AND (k.route_id IS DISTINCT FROM p.route_id OR k.rpm<>p.rpm)
      )
      SELECT plugin,route_id AS "routeId",skill_ids AS "skillIds",mcp_ids AS "mcpIds",rpm FROM saved
    `,[workspace,plugin,routeId,skillIds,mcpIds,rpm,user.id])
    if (!profile) throw new ConflictException('所选资源已停用、撤销或不属于当前工作空间')
    return profile
  }
}

@Controller('api/v1/agent-plugin-auth')
export class AgentPluginConfigController {
  @Get('config')
  @Header('Cache-Control','no-store')
  async config(@Req() req:PluginRequest) {
    const session=await requirePluginSession(req)
    const {rows:[profile]}=await pool.query(`
      SELECT p.skill_ids,p.mcp_ids,p.rpm,r.alias FROM vacp_plugin_profiles p
      LEFT JOIN vacp_gateway_routes r ON r.workspace_id=p.workspace_id AND r.id=p.route_id AND r.enabled
      WHERE p.workspace_id=$1 AND p.plugin=$2
    `,[session.workspaceId,session.plugin])
    const [skills,mcps,models]=session.accountId ? await Promise.all([
      pool.query(skillQuery + ' ORDER BY r.name,r.version',[session.workspaceId]),
      pool.query(mcpQuery + ' ORDER BY name',[session.workspaceId]),
      pool.query('SELECT alias AS id FROM vacp_gateway_routes WHERE workspace_id=$1 AND enabled ORDER BY alias',[session.workspaceId]),
    ]) : profile ? await Promise.all([
      pool.query(skillQuery + ' AND r.id=ANY($2::uuid[]) ORDER BY r.name,r.version',[session.workspaceId,profile.skill_ids]),
      pool.query(`SELECT id,name,auth,endpoint
        FROM vacp_mcp_servers WHERE workspace_id=$1 AND enabled AND id=ANY($2::uuid[]) ORDER BY name`,
        [session.workspaceId,profile.mcp_ids]),
      Promise.resolve({rows:profile.alias?[{id:profile.alias}]:[]}),
    ]) : [{rows:[]},{rows:[]},{rows:[]}]
    const modelOptions=models.rows.map(({id})=>({id,basePath:'/v1',keyPath:'/api/v1/agent-plugin-auth/model-key',rpm:session.accountId?60:profile.rpm}))
    return {
      schemaVersion:1,workspaceId:session.workspaceId,plugin:session.plugin,
      model:session.accountId?null:modelOptions[0]??null,
      models:modelOptions,
      skills:skills.rows.map(row=>({...row,path:'/api/v1/agent-plugin-auth/skills/'+row.id})),
      mcps:mcps.rows.map(({id,name,auth,endpoint})=>({
        id,name,auth,
        mode:auth==='none' ? 'direct' : mcpProxyAllowed(endpoint) ? 'proxy' : 'requires_proxy',
        endpoint:auth==='none' ? endpoint : null,
        path:auth!=='none' && mcpProxyAllowed(endpoint) ? '/api/v1/agent-plugin-auth/mcps/'+id : null,
      })),
    }
  }

  @All('mcps/:id')
  async proxyMcp(@Req() req:McpRequest,@Res() reply:McpReply,@Param('id') id:string,@Body() body:unknown) {
    const session=await requirePluginSession(req)
    if (!['GET','POST','DELETE'].includes(req.method)) return reply.header('Allow','GET, POST, DELETE').code(405).send()
    if (!uuid.test(id)) throw new NotFoundException()
    const {rows:[target]}=await pool.query<McpTarget>(`
      SELECT m.id,m.workspace_id,m.endpoint,m.auth,m.header,m.secret_cipher
      FROM vacp_mcp_servers m
      WHERE m.workspace_id=$1 AND m.id=$3 AND m.enabled AND m.auth<>'none'
        AND ($4::boolean OR EXISTS(SELECT 1 FROM vacp_plugin_profiles p
          WHERE p.workspace_id=m.workspace_id AND p.plugin=$2 AND m.id=ANY(p.mcp_ids)))
    `,[session.workspaceId,session.plugin,id,Boolean(session.accountId)])
    if (!target || !mcpProxyAllowed(target.endpoint)) throw new NotFoundException('MCP 服务未授权或代理来源未配置')
    const headers=new Headers({Accept:'application/json, text/event-stream'})
    const protocol=req.headers['mcp-protocol-version']
    if (typeof protocol==='string' && /^\d{4}-\d{2}-\d{2}$/.test(protocol)) headers.set('MCP-Protocol-Version',protocol)
    const upstreamSession=req.headers['mcp-session-id']
    if (typeof upstreamSession==='string') headers.set('MCP-Session-Id',openMcpSessionId(upstreamSession,session.id,target))
    const lastEvent=req.headers['last-event-id']
    if (req.method==='GET' && typeof lastEvent==='string' && /^[ -~]{1,512}$/.test(lastEvent)) {
      headers.set('Last-Event-ID',lastEvent)
    }
    if (req.method==='POST') {
      if (!body || typeof body!=='object') throw new BadRequestException('需要 MCP JSON 请求')
      headers.set('Content-Type','application/json')
    }
    const abort=new AbortController()
    const close=()=>abort.abort()
    reply.raw.once('close',close)
    try {
      mcpAuthHeaders(target,headers)
      const response=await fetch(target.endpoint,{
        method:req.method,headers,redirect:'error',
        body:req.method==='POST'?JSON.stringify(body):undefined,
        signal:AbortSignal.any([abort.signal,AbortSignal.timeout(120000)]),
      })
      reply.header('Cache-Control','no-store')
      if (!response.ok) {
        await response.body?.cancel()
        const status=[400,404,405,429].includes(response.status)?response.status:502
        return reply.code(status).send({message:'MCP 服务请求失败'})
      }
      const sessionId=response.headers.get('mcp-session-id')
      if (sessionId && /^[!-~]{1,512}$/.test(sessionId)) {
        const signed=mcpSessionProof(session.id,target,sessionId).toString('base64url')
        reply.header('MCP-Session-Id',Buffer.from(sessionId).toString('base64url')+'.'+signed)
      }
      if (!response.body || response.status===202 || response.status===204) {
        await response.body?.cancel()
        return reply.code(response.status).send()
      }
      const contentType=response.headers.get('content-type')?.split(';')[0]
      if (contentType!=='application/json' && contentType!=='text/event-stream') {
        await response.body.cancel()
        return reply.code(502).send({message:'MCP 服务返回了不支持的格式'})
      }
      return reply.type(contentType).header('X-Accel-Buffering','no').code(response.status).send(Readable.from(response.body))
    } catch {
      return reply.code(502).send({message:'无法连接 MCP 服务'})
    }
  }

  @Get('skills/:id')
  @Header('Cache-Control','no-store')
  async skill(@Req() req:PluginRequest,@Param('id') id:string) {
    const session=await requirePluginSession(req)
    if (!uuid.test(id)) throw new NotFoundException()
    const {rows:[skill]}=await pool.query(`
      SELECT r.id,r.name,r.version,r.digest,r.content
      FROM vacp_skill_installs i
      JOIN vacp_skill_releases r ON r.id=i.release_id
      WHERE i.workspace_id=$1 AND r.id=$3 AND r.review_status='approved'
        AND ($4::boolean OR EXISTS(SELECT 1 FROM vacp_plugin_profiles p
          WHERE p.workspace_id=i.workspace_id AND p.plugin=$2 AND r.id=ANY(p.skill_ids)))
    `,[session.workspaceId,session.plugin,id,Boolean(session.accountId)])
    if (!skill) throw new NotFoundException('未授权该技能版本')
    return skill
  }

  @Post('model-key')
  @Header('Cache-Control','no-store')
  async issue(@Req() req:PluginRequest,@Body() body?:{model?:unknown}) {
    const session=await requirePluginSession(req)
    const model=body?.model
    if (session.accountId && (typeof model!=='string'||!model||model.length>80)) throw new BadRequestException('请选择模型')
    const token='vacp_gw_'+randomBytes(32).toString('base64url')
    const db=await pool.connect()
    try {
      await db.query('BEGIN')
      const {rows:[active]}=await db.query(`
        SELECT r.id,r.alias,CASE WHEN s.account_id IS NOT NULL THEN 60 ELSE p.rpm END AS rpm,s.expires_at FROM vacp_plugin_sessions s
        JOIN vacp_members m ON m.workspace_id=s.workspace_id AND m.user_id=s.user_id AND m.role<>'viewer'
        LEFT JOIN vacp_plugin_profiles p ON p.workspace_id=s.workspace_id AND p.plugin=s.plugin
        JOIN vacp_gateway_routes r ON r.workspace_id=s.workspace_id AND r.enabled AND
          ((s.account_id IS NOT NULL AND r.alias=$2) OR (s.account_id IS NULL AND r.id=p.route_id))
        WHERE s.id=$1 AND s.revoked_at IS NULL AND s.expires_at>now()
        FOR UPDATE OF s FOR SHARE OF m,r
      `,[session.id,session.accountId?model:null])
      if (!active) throw new ConflictException('当前插件没有可用的模型配置')
      await db.query('UPDATE vacp_gateway_keys SET revoked_at=now() WHERE plugin_session_id=$1 AND revoked_at IS NULL',[session.id])
      await db.query(`
        INSERT INTO vacp_gateway_keys(id,workspace_id,route_id,label,prefix,token_hash,rpm,plugin_session_id,minute_bucket,minute_count)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,prior.minute_bucket,COALESCE(prior.minute_count,0)
        FROM (SELECT 1) seed LEFT JOIN LATERAL (
          SELECT k.minute_bucket,k.minute_count FROM vacp_gateway_keys k
          JOIN vacp_plugin_sessions s ON s.id=k.plugin_session_id
          WHERE (s.id=$8 OR (s.account_id=$9 AND s.workspace_id=$2))
            AND k.minute_bucket=date_trunc('minute',now())
          ORDER BY k.minute_count DESC LIMIT 1
        ) prior ON true
      `,[randomUUID(),session.workspaceId,active.id,'插件 · '+session.plugin,token.slice(0,14),
        createHash('sha256').update(token).digest('hex'),active.rpm,session.id,session.accountId])
      await db.query('COMMIT')
      return {token,model:active.alias,basePath:'/v1',expiresAt:active.expires_at}
    } catch(error) {
      await db.query('ROLLBACK')
      throw error
    } finally { db.release() }
  }
}
