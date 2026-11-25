import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, HttpCode, NotFoundException, Param, Patch, Post, Put, Query, Req, Res, ServiceUnavailableException } from '@nestjs/common'
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { pool } from './database.js'
import { field, uuid } from './identity.js'
import { requireWorkspaceAccess, type WorkspaceRequest } from './workspace-access.js'
import { accountHash, type PluginRequest } from './agent-plugin-sessions.js'
import { configureUpstream, upstreamRequest, type UpstreamSecret } from './gateway-target.js'
import { gatewayUsage, trackGatewayUsage } from './gateway-usage.js'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const routeColumns = `id,alias,base_url AS "baseUrl",upstream_model AS "upstreamModel",enabled,
  context_window AS "contextWindow",max_output_tokens AS "maxOutputTokens",
  compaction_headroom_tokens AS "compactionHeadroomTokens",reasoning_efforts AS "reasoningEfforts"`
const keyColumns = 'id,route_id AS "routeId",label,use_case AS "useCase",plugin_session_id IS NULL AS shared,prefix,rpm,created_at AS "createdAt",revoked_at AS "revokedAt"'
const activePluginKey = `(k.plugin_session_id IS NULL OR EXISTS (
  SELECT 1 FROM vacp_plugin_sessions s
  JOIN vacp_members m ON m.workspace_id=s.workspace_id AND m.user_id=s.user_id AND m.role<>'viewer'
  LEFT JOIN vacp_plugin_profiles p ON p.workspace_id=s.workspace_id AND p.plugin=s.plugin
  WHERE s.id=k.plugin_session_id AND s.workspace_id=k.workspace_id AND s.revoked_at IS NULL
    AND s.expires_at>now() AND (s.account_id IS NOT NULL OR (p.route_id=k.route_id AND p.rpm=k.rpm))
))`
type GatewayRoute = { id:string;workspace_id:string;alias:string;base_url:string;upstream_model:string;secret_cipher:string;max_output_tokens:number }
type GatewayCall = GatewayRoute & { user_id:string|null; use_case:string }
type GatewayRequest = {headers:{authorization?:string}}
type GatewayReply = {raw:ServerResponse; code(status:number):GatewayReply; header(name:string,value:string):GatewayReply; send(body:unknown):unknown}

function masterKey(create: boolean) {
  const supplied = process.env.VACP_GATEWAY_ENCRYPTION_KEY
  if (supplied !== undefined) {
    if (!/^[a-f0-9]{64}$/i.test(supplied)) throw new ServiceUnavailableException('模型网关加密密钥配置无效')
    return Buffer.from(supplied,'hex')
  }
  if (process.env.NODE_ENV === 'production') throw new ServiceUnavailableException('尚未配置模型网关加密密钥')
  const path = fileURLToPath(new URL('../../../.gateway-key',import.meta.url))
  try {
    if (create) {
      try { writeFileSync(path,randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'}) }
      catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code==='EEXIST')) throw error
      }
    }
    const saved = readFileSync(path,'utf8')
    if (!/^[a-f0-9]{64}$/i.test(saved)) throw Error('Invalid key')
    return Buffer.from(saved,'hex')
  } catch { throw new ServiceUnavailableException('模型网关加密密钥不可用') }
}

function secretField(value: unknown) {
  if (value === undefined || value === '') return
  if (typeof value !== 'string' || !/^[!-~]{1,4096}$/.test(value)) {
    throw new BadRequestException('上游 Key 须为不超过 4096 字符的单行文本')
  }
  return value
}

function useCaseField(body: unknown) {
  const value = (body as {useCase?:unknown} | null)?.useCase
  if (value === undefined) return null
  if (typeof value !== 'string' || value.length > 80 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new BadRequestException('用例名称须为不超过 80 字符的单行文本')
  }
  return value.trim() || null
}

function modelLimits(body: unknown, defaults = false) {
  const input = body as Record<string, unknown> | null
  function tokens(key: string, label: string, min: number, fallback: number) {
    const value = defaults && input?.[key] === undefined ? fallback : input?.[key]
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > 2147483647) {
      throw new BadRequestException(label + '须为不小于 ' + min + ' 的整数')
    }
    return value
  }
  const contextWindow = tokens('contextWindow','上下文窗口',2,32768)
  const maxOutputTokens = tokens('maxOutputTokens','最大输出',1,4096)
  const compactionHeadroomTokens = tokens('compactionHeadroomTokens','压缩预留',0,4096)
  if (maxOutputTokens + compactionHeadroomTokens >= contextWindow) {
    throw new BadRequestException('最大输出与压缩预留之和必须小于上下文窗口')
  }
  return [contextWindow,maxOutputTokens,compactionHeadroomTokens]
}

const thinkingLevels = ['off','minimal','low','medium','high','xhigh','max'] as const

function reasoningEfforts(body: unknown) {
  const values = (body as {reasoningEfforts?: unknown} | null)?.reasoningEfforts
  if (values === undefined) return null
  if (!Array.isArray(values) || values.length > thinkingLevels.length ||
    values.some(value => !thinkingLevels.includes(value)) || new Set(values).size !== values.length) {
    throw new BadRequestException('思考强度包含未知或重复的档位')
  }
  return thinkingLevels.filter(level => values.includes(level))
}

function binding(workspaceId:string,id:string,baseUrl:string) {
  return Buffer.from(JSON.stringify([workspaceId,id,baseUrl]))
}

function seal(secret:UpstreamSecret, workspaceId:string, id:string, baseUrl:string) {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm',masterKey(true),nonce)
  cipher.setAAD(binding(workspaceId,id,baseUrl))
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(secret),'utf8'),cipher.final()])
  return ['v2',nonce.toString('base64url'),cipher.getAuthTag().toString('base64url'),encrypted.toString('base64url')].join('.')
}

function openSecret(route: Pick<GatewayRoute,'secret_cipher'|'workspace_id'|'id'|'base_url'>): UpstreamSecret {
  const [version,nonce,tag,data] = route.secret_cipher.split('.')
  if ((version !== 'v1' && version !== 'v2') || !nonce || !tag || !data) throw Error('Invalid credential')
  const decipher = createDecipheriv('aes-256-gcm',masterKey(false),Buffer.from(nonce,'base64url'))
  decipher.setAAD(binding(route.workspace_id,route.id,route.base_url))
  decipher.setAuthTag(Buffer.from(tag,'base64url'))
  const value = Buffer.concat([decipher.update(Buffer.from(data,'base64url')),decipher.final()]).toString('utf8')
  return version === 'v1' ? { key: value } : JSON.parse(value) as UpstreamSecret
}

async function addRoute(workspaceId: string, userId: string, body: unknown, accountId: string | null = null) {
  const alias = field(body,'alias',1,80)
  if (!/^[\w./:-]+$/.test(alias)) throw new BadRequestException('模型别名只支持字母、数字及常见分隔符')
  const upstreamKey = secretField((body as { upstreamKey?: unknown }).upstreamKey)
  const { baseUrl, secret } = configureUpstream(field(body,'baseUrl',8,1000), upstreamKey)
  const upstreamModel = field(body,'upstreamModel',1,200)
  const limits = modelLimits(body,true)
  const efforts = reasoningEfforts(body) ?? []
  const id = randomUUID()
  const encrypted = seal(secret,workspaceId,id,baseUrl)
  const {rows:[route]} = await pool.query(`
    INSERT INTO vacp_gateway_routes(id,workspace_id,alias,base_url,upstream_model,secret_cipher,
      context_window,max_output_tokens,compaction_headroom_tokens,reasoning_efforts)
    SELECT $1,$2,$3,$4,$5,$6,$9,$10,$11,$12 WHERE EXISTS (
      SELECT 1 FROM vacp_members WHERE workspace_id=$2 AND user_id=$7 AND role IN ('admin','owner')
    ) AND ($8::uuid IS NULL OR EXISTS (
      SELECT 1 FROM vacp_plugin_accounts a WHERE a.id=$8 AND a.user_id=$7 AND a.expires_at>now()
      AND NOT EXISTS (
        SELECT 1 FROM vacp_plugin_workspace_revocations r WHERE r.account_id=a.id AND r.workspace_id=$2
      )
    )) ON CONFLICT(workspace_id,alias) DO NOTHING RETURNING ${routeColumns}
  `,[id,workspaceId,alias,baseUrl,upstreamModel,encrypted,userId,accountId,...limits,efforts])
  if (!route) throw new ConflictException('模型别名已存在或工作空间权限已变更')
  return route
}

@Controller('api/v1/agent-plugin-auth/account/workspaces/:workspaceId/model-gateway')
export class AgentPluginModelsController {
  @Post('routes')
  @Header('Cache-Control','no-store')
  async create(@Req() req:PluginRequest,@Param('workspaceId') workspaceId:string,@Body() body:unknown) {
    const hash = accountHash(req)
    if (!uuid.test(workspaceId)) throw new NotFoundException()
    const {rows:[account]} = await pool.query<{id:string;userId:string}>(`
      SELECT a.id,a.user_id AS "userId"
      FROM vacp_plugin_accounts a JOIN vacp_members m ON m.user_id=a.user_id AND m.workspace_id=$1
      WHERE a.token_hash=$2 AND a.plugin='dsh' AND a.expires_at>now() AND m.role IN ('owner','admin')
        AND NOT EXISTS (
          SELECT 1 FROM vacp_plugin_workspace_revocations r WHERE r.account_id=a.id AND r.workspace_id=$1
        )
    `,[workspaceId,hash])
    if (!account) throw new ForbiddenException('仅工作空间所有者或管理员可以配置网关模型')
    const { id, alias } = await addRoute(workspaceId, account.userId, body, account.id)
    return { id, alias }
  }
}

@Controller('api/v1/workspaces/:workspaceId/model-gateway')
export class ModelGatewayAdminController {
  @Get()
  async list(@Req() req:WorkspaceRequest,@Param('workspaceId') workspaceId:string) {
    await requireWorkspaceAccess(req,workspaceId,true)
    const [routes,keys] = await Promise.all([
      pool.query(`SELECT ${routeColumns} FROM vacp_gateway_routes WHERE workspace_id=$1 ORDER BY alias`,[workspaceId]),
      pool.query(`SELECT ${keyColumns} FROM vacp_gateway_keys WHERE workspace_id=$1 ORDER BY created_at DESC,id`,[workspaceId]),
    ])
    return {routes:routes.rows,keys:keys.rows}
  }

  @Get('usage')
  @Header('Cache-Control','private, no-store')
  async usage(@Req() req:WorkspaceRequest,@Param('workspaceId') workspaceId:string,
    @Query('days') days = '7',@Query('model') model?:string) {
    await requireWorkspaceAccess(req,workspaceId,true)
    if (!['1','7','30'].includes(days) || (model !== undefined &&
      (typeof model !== 'string' || !/^[\w./:-]{1,80}$/.test(model)))) {
      throw new BadRequestException('统计筛选条件无效')
    }
    return gatewayUsage(workspaceId,Number(days)*24,model ?? null)
  }

  @Post('routes')
  async create(@Req() req:WorkspaceRequest,@Param('workspaceId') workspaceId:string,@Body() body:unknown) {
    const user = await requireWorkspaceAccess(req,workspaceId,true)
    return addRoute(workspaceId,user.id,body)
  }

  @Patch('routes/:id/limits')
  async updateLimits(@Req() req:WorkspaceRequest,@Param('workspaceId') workspaceId:string,@Param('id') id:string,@Body() body:unknown) {
    const user = await requireWorkspaceAccess(req,workspaceId,true)
    if (!uuid.test(id)) throw new NotFoundException()
    const limits = modelLimits(body)
    const efforts = reasoningEfforts(body)
    const {rows:[route]} = await pool.query(`
      UPDATE vacp_gateway_routes SET context_window=$4,max_output_tokens=$5,compaction_headroom_tokens=$6,
        reasoning_efforts=COALESCE($7::text[],reasoning_efforts)
      WHERE workspace_id=$1 AND id=$2 AND EXISTS (
        SELECT 1 FROM vacp_members WHERE workspace_id=$1 AND user_id=$3 AND role IN ('admin','owner')
      ) RETURNING ${routeColumns}
    `,[workspaceId,id,user.id,...limits,efforts])
    if (!route) throw new NotFoundException()
    return route
  }

  @Put('routes/:id')
  async update(@Req() req:WorkspaceRequest,@Param('workspaceId') workspaceId:string,@Param('id') id:string,@Body() body:unknown) {
    const user = await requireWorkspaceAccess(req,workspaceId,true)
    if (!uuid.test(id)) throw new NotFoundException()
    const input = body as {enabled?:unknown;upstreamKey?:unknown} | null
    if (typeof input?.enabled !== 'boolean') throw new BadRequestException('无效启用状态')
    const {rows:[current]} = await pool.query<Pick<GatewayRoute,'secret_cipher'|'workspace_id'|'id'|'base_url'>>(
      'SELECT id,workspace_id,base_url,secret_cipher FROM vacp_gateway_routes WHERE workspace_id=$1 AND id=$2',[workspaceId,id],
    )
    if (!current) throw new NotFoundException()
    let encrypted: string | null = null
    if (input.upstreamKey !== undefined) {
      const existing = openSecret(current)
      const key = secretField(input.upstreamKey)
      if (!key) throw new BadRequestException('请输入新的上游 Key')
      encrypted = seal({ key, search: existing.search },workspaceId,id,current.base_url)
    }
    const {rows:[route]} = await pool.query(`
      UPDATE vacp_gateway_routes SET enabled=$3,secret_cipher=COALESCE($4,secret_cipher)
      WHERE workspace_id=$1 AND id=$2 AND EXISTS (
        SELECT 1 FROM vacp_members WHERE workspace_id=$1 AND user_id=$5 AND role IN ('admin','owner')
      ) RETURNING ${routeColumns}
    `,[workspaceId,id,input.enabled,encrypted,user.id])
    if (!route) throw new NotFoundException()
    return route
  }

  @Post('keys')
  @Header('Cache-Control','no-store')
  async issue(@Req() req:WorkspaceRequest,@Param('workspaceId') workspaceId:string,@Body() body:unknown) {
    const user = await requireWorkspaceAccess(req,workspaceId,true)
    const routeId = field(body,'routeId',36,36)
    if (!uuid.test(routeId)) throw new NotFoundException()
    const label = field(body,'label',1,80)
    const useCase = useCaseField(body)
    const rpm = (body as {rpm?:number}).rpm
    if (typeof rpm !== 'number' || !Number.isSafeInteger(rpm) || rpm<1 || rpm>600) throw new BadRequestException('每分钟请求数须在 1–600 之间')
    const token = 'vacp_gw_' + randomBytes(32).toString('base64url')
    const {rows:[key]} = await pool.query(`
      INSERT INTO vacp_gateway_keys(id,workspace_id,route_id,label,prefix,token_hash,rpm,use_case)
      SELECT $1,workspace_id,id,$4,$5,$6,$7,$9 FROM vacp_gateway_routes WHERE workspace_id=$2 AND id=$3 AND enabled
      AND EXISTS (SELECT 1 FROM vacp_members WHERE workspace_id=$2 AND user_id=$8 AND role IN ('admin','owner'))
      RETURNING ${keyColumns}
    `,[randomUUID(),workspaceId,routeId,label,token.slice(0,14),digest(token),rpm,user.id,useCase])
    if (!key) throw new NotFoundException('模型路线不可用')
    return {...key,token}
  }

  @Patch('keys/:id/use-case')
  async updateUseCase(@Req() req:WorkspaceRequest,@Param('workspaceId') workspaceId:string,@Param('id') id:string,@Body() body:unknown) {
    const user = await requireWorkspaceAccess(req,workspaceId,true)
    if (!uuid.test(id)) throw new NotFoundException()
    const {rows:[key]} = await pool.query(`
      UPDATE vacp_gateway_keys SET use_case=$3 WHERE workspace_id=$1 AND id=$2 AND revoked_at IS NULL
      AND plugin_session_id IS NULL AND EXISTS (
        SELECT 1 FROM vacp_members WHERE workspace_id=$1 AND user_id=$4 AND role IN ('admin','owner')
      ) RETURNING ${keyColumns}
    `,[workspaceId,id,useCaseField(body),user.id])
    if (!key) throw new NotFoundException('共享 Key 不可用')
    return key
  }

  @Post('keys/:id/revoke')
  @HttpCode(204)
  async revoke(@Req() req:WorkspaceRequest,@Param('workspaceId') workspaceId:string,@Param('id') id:string) {
    const user = await requireWorkspaceAccess(req,workspaceId,true)
    if (!uuid.test(id)) throw new NotFoundException()
    const result = await pool.query(`
      UPDATE vacp_gateway_keys SET revoked_at=COALESCE(revoked_at,now())
      WHERE workspace_id=$1 AND id=$2 AND EXISTS (
        SELECT 1 FROM vacp_members WHERE workspace_id=$1 AND user_id=$3 AND role IN ('admin','owner')
      )
    `,[workspaceId,id,user.id])
    if (!result.rowCount) throw new NotFoundException()
  }
}

function gatewayCredential(req: GatewayRequest) {
  const match = /^Bearer (vacp_(gw|plugin)_[\w-]{43})$/.exec(req.headers.authorization ?? '')
  return match ? { hash: digest(match[1]), plugin: match[2] === 'plugin' } : null
}

const workspaceSession = `
  SELECT s.workspace_id,s.user_id,s.plugin
  FROM vacp_plugin_sessions s
  JOIN vacp_members m ON m.workspace_id=s.workspace_id AND m.user_id=s.user_id AND m.role<>'viewer'
  WHERE s.token_hash=$1 AND s.account_id IS NOT NULL AND s.revoked_at IS NULL AND s.expires_at>now()
`
const workspacePluginRpm = 60

function sendError(res:GatewayReply,status:number,message:string,code:string) {
  return res.code(status).send({error:{message,type:status===429?'rate_limit_error':'invalid_request_error',code}})
}

@Controller('v1')
export class ModelGatewayController {
  @Get('models')
  async models(@Req() req:GatewayRequest,@Res() res:GatewayReply) {
    const auth = gatewayCredential(req)
    if (!auth) return sendError(res,401,'Invalid gateway API key','invalid_api_key')
    if (auth.plugin) {
      const {rows:[result]} = await pool.query(`
        SELECT ARRAY(SELECT alias FROM vacp_gateway_routes r
          WHERE r.workspace_id=s.workspace_id AND r.enabled ORDER BY alias) AS aliases
        FROM (${workspaceSession}) s
      `,[auth.hash])
      if (!result) return sendError(res,401,'Invalid workspace session','invalid_api_key')
      return res.header('Cache-Control','no-store').send({
        object:'list',data:result.aliases.map((id:string)=>({id,object:'model',owned_by:'vacp'})),
      })
    }
    const {rows:[route]} = await pool.query(`
      SELECT r.alias,k.revoked_at,r.enabled FROM vacp_gateway_keys k
      JOIN vacp_gateway_routes r ON r.id=k.route_id WHERE k.token_hash=$1 AND ${activePluginKey}
    `,[auth.hash])
    if (!route || route.revoked_at) return sendError(res,401,'Invalid gateway API key','invalid_api_key')
    return res.header('Cache-Control','no-store').send({
      object:'list',data:route.enabled?[{id:route.alias,object:'model',owned_by:'vacp'}]:[],
    })
  }

  @Post('chat/completions')
  @HttpCode(200)
  async chat(@Req() req:GatewayRequest,@Res() res:GatewayReply,@Body() body:unknown) {
    const auth = gatewayCredential(req)
    if (!auth) return sendError(res,401,'Invalid gateway API key','invalid_api_key')
    const input = body as {model?:unknown;messages?:unknown;stream?:unknown;max_tokens?:unknown;max_completion_tokens?:unknown} | null
    if (typeof input?.model !== 'string' || !Array.isArray(input.messages) || !input.messages.length ||
      (input.stream !== undefined && typeof input.stream !== 'boolean')) {
      return sendError(res,400,'model and messages are required','invalid_request')
    }
    const requestedOutput = input.max_completion_tokens ?? input.max_tokens
    if (requestedOutput !== undefined && requestedOutput !== null &&
      (typeof requestedOutput !== 'number' || !Number.isSafeInteger(requestedOutput) || requestedOutput < 1)) {
      return sendError(res,400,'Output token limit must be a positive integer','invalid_request')
    }

    let route:GatewayCall | undefined
    if (auth.plugin) {
      const {rows:[result]} = await pool.query<{valid:boolean;available:boolean;route:GatewayCall|null}>(`
        WITH session AS (${workspaceSession}), candidate AS (
          SELECT r.id,r.workspace_id,r.alias,r.base_url,r.upstream_model,r.secret_cipher,r.max_output_tokens,s.user_id,
            CASE s.plugin WHEN 'dsh' THEN 'DeepSeek Harness' ELSE 'OpenCode' END AS use_case
          FROM session s JOIN vacp_gateway_routes r ON r.workspace_id=s.workspace_id
          WHERE r.enabled AND r.alias=$2
        ), admitted AS (
          INSERT INTO vacp_gateway_plugin_rate AS rate(workspace_id,user_id,minute_bucket,minute_count)
          SELECT workspace_id,user_id,date_trunc('minute',statement_timestamp()),1 FROM candidate
          ON CONFLICT(workspace_id,user_id) DO UPDATE
          SET minute_bucket=EXCLUDED.minute_bucket,
            minute_count=CASE WHEN rate.minute_bucket=EXCLUDED.minute_bucket THEN rate.minute_count+1 ELSE 1 END
          WHERE rate.minute_bucket<EXCLUDED.minute_bucket OR
            (rate.minute_bucket=EXCLUDED.minute_bucket AND rate.minute_count<$3)
          RETURNING workspace_id,user_id
        )
        SELECT EXISTS(SELECT 1 FROM session) AS valid,EXISTS(SELECT 1 FROM candidate) AS available,
          (SELECT to_jsonb(c) FROM candidate c JOIN admitted a USING(workspace_id,user_id)) AS route
      `,[auth.hash,input.model,workspacePluginRpm])
      if (!result.valid) return sendError(res,401,'Invalid workspace session','invalid_api_key')
      if (!result.available) return sendError(res,404,'Model not available in this workspace','model_not_found')
      route=result.route ?? undefined
      if (!route) return sendError(res.header('Retry-After',String(60-new Date().getUTCSeconds())),429,'Workspace member rate limit reached','rate_limit_exceeded')
    } else {
      const {rows:[keyRoute]} = await pool.query<GatewayCall>(`
        UPDATE vacp_gateway_keys k SET minute_bucket=date_trunc('minute',now()),
          minute_count=CASE WHEN k.minute_bucket=date_trunc('minute',now()) THEN k.minute_count+1 ELSE 1 END
        FROM vacp_gateway_routes r
        WHERE r.id=k.route_id AND k.token_hash=$1 AND k.revoked_at IS NULL AND r.enabled AND r.alias=$2
          AND ${activePluginKey}
          AND (k.minute_bucket IS DISTINCT FROM date_trunc('minute',now()) OR k.minute_count<k.rpm)
        RETURNING r.id,r.workspace_id,r.alias,r.base_url,r.upstream_model,r.secret_cipher,r.max_output_tokens,
          (SELECT s.user_id FROM vacp_plugin_sessions s WHERE s.id=k.plugin_session_id) AS user_id,
          CASE (SELECT s.plugin FROM vacp_plugin_sessions s WHERE s.id=k.plugin_session_id)
            WHEN 'dsh' THEN 'DeepSeek Harness' WHEN 'opencode' THEN 'OpenCode'
            ELSE COALESCE(k.use_case,k.label) END AS use_case
      `,[auth.hash,input.model])
      if (!keyRoute) {
        const {rows:[diagnosis]} = await pool.query(`
          SELECT k.revoked_at,r.enabled,r.alias FROM vacp_gateway_keys k
          JOIN vacp_gateway_routes r ON r.id=k.route_id WHERE k.token_hash=$1 AND ${activePluginKey}
        `,[auth.hash])
        if (!diagnosis || diagnosis.revoked_at) return sendError(res,401,'Invalid gateway API key','invalid_api_key')
        if (!diagnosis.enabled || diagnosis.alias !== input.model) return sendError(res,404,'Model not available for this key','model_not_found')
        return sendError(res.header('Retry-After',String(60-new Date().getUTCSeconds())),429,'Workspace API key rate limit reached','rate_limit_exceeded')
      }
      route=keyRoute
    }

    const closed = new AbortController()
    const relay = trackGatewayUsage(res.raw,route,closed)
    if (closed.signal.aborted) return
    try {
      const {url, headers, dispatcher} = upstreamRequest(route.base_url, openSecret(route))
      const {max_tokens, max_completion_tokens, ...upstreamInput} = input
      const cap = Math.min(typeof requestedOutput === 'number' ? requestedOutput : route.max_output_tokens, route.max_output_tokens)
      const outputField = max_completion_tokens != null ? 'max_completion_tokens' : 'max_tokens'
      const request = {
        method:'POST',redirect:'error',
        headers,dispatcher,
        body:JSON.stringify({...upstreamInput,model:route.upstream_model,[outputField]:cap}),
        signal:AbortSignal.any([closed.signal,AbortSignal.timeout(120000)]),
      } as const
      const upstream = await fetch(url,request)
      if (!upstream.ok || !upstream.body) {
        await upstream.body?.cancel()
        return upstream.status===429
          ? sendError(res,429,'Upstream provider rate limit reached','upstream_rate_limit')
          : sendError(res,502,'Upstream model request failed','upstream_error')
      }
      const contentType = upstream.headers.get('content-type')?.split(';')[0]
      const expected = input.stream ? 'text/event-stream' : 'application/json'
      if (contentType !== expected) {
        await upstream.body.cancel()
        return sendError(res,502,'Unexpected upstream response format','upstream_format')
      }
      return res.header('Content-Type',expected).header('Cache-Control','no-store')
        .header('X-Accel-Buffering','no').send(Readable.from(relay(upstream.body,input.stream === true)))
    } catch {
      if (closed.signal.aborted) return
      return sendError(res,502,'Unable to reach the configured model','upstream_error')
    }
  }
}
