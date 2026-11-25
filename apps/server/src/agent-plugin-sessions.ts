import { Body, Controller, Delete, ForbiddenException, Get, Header, HttpCode, NotFoundException, Param, Post, Put, Req, UnauthorizedException, BadRequestException } from '@nestjs/common'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { authenticateCredentials, field, uuid } from './identity.js'
import { pool } from './database.js'
import { requireWorkspaceAccess, type WorkspaceRequest } from './workspace-access.js'

const digest = (value:string) => createHash('sha256').update(value).digest('hex')
const token = (prefix:string) => prefix + randomBytes(32).toString('base64url')
const codePattern = /^vacp_pair_[\w-]{43}$/

@Controller('api/v1/workspaces/:workspaceId/agent-plugin-sessions')
export class AgentPluginSessionsController {
  @Get()
  @Header('Cache-Control','no-store')
  async list(@Req() req:WorkspaceRequest,@Param('workspaceId') workspace:string) {
    const user = await requireWorkspaceAccess(req,workspace)
    const {rows} = await pool.query(`
      WITH viewer AS (
        SELECT role FROM vacp_members WHERE workspace_id=$1 AND user_id=$2
      ), devices AS (
        SELECT a.id,a.user_id,u.email,a.plugin,a.device,a.plugin_version,a.created_at,
          GREATEST(a.last_seen,latest.last_seen) AS last_seen,a.expires_at,
          CASE WHEN blocked.account_id IS NOT NULL OR latest.revoked_at IS NOT NULL THEN 'revoked'
            WHEN a.expires_at<=now() THEN 'expired' ELSE 'active' END AS status
        FROM viewer CROSS JOIN vacp_members m
        JOIN vacp_plugin_accounts a ON a.user_id=m.user_id
        JOIN vacp_users u ON u.id=a.user_id
        LEFT JOIN vacp_plugin_workspace_revocations blocked ON blocked.workspace_id=$1 AND blocked.account_id=a.id
        LEFT JOIN LATERAL (
          SELECT s.last_seen,s.revoked_at FROM vacp_plugin_sessions s
          WHERE s.account_id=a.id AND s.workspace_id=$1
          ORDER BY s.created_at DESC,s.id DESC LIMIT 1
        ) latest ON true
        WHERE m.workspace_id=$1 AND m.role<>'viewer' AND (m.user_id=$2 OR viewer.role IN ('owner','admin'))
        UNION ALL
        SELECT s.id,s.user_id,u.email,s.plugin,s.device,s.plugin_version,s.created_at,s.last_seen,s.expires_at,
          CASE WHEN s.revoked_at IS NOT NULL OR m.user_id IS NULL THEN 'revoked'
            WHEN s.expires_at<=now() THEN 'expired' ELSE 'active' END
        FROM viewer CROSS JOIN vacp_plugin_sessions s
        JOIN vacp_users u ON u.id=s.user_id
        LEFT JOIN vacp_members m ON m.workspace_id=s.workspace_id AND m.user_id=s.user_id
        WHERE s.workspace_id=$1 AND s.account_id IS NULL AND (s.user_id=$2 OR viewer.role IN ('owner','admin'))
      )
      SELECT id,user_id AS "userId",email,plugin,device,plugin_version AS "pluginVersion",
        created_at AS "createdAt",d.last_seen AS "lastSeen",expires_at AS "expiresAt",status,
        COALESCE(instance_data.items,'[]'::jsonb) AS instances
      FROM devices d LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object('id',i.id,'hostName',i.host_name,'pluginVersion',i.plugin_version,'lastSeen',i.last_seen)
          ORDER BY i.last_seen DESC,i.id) AS items
        FROM (
          SELECT *,row_number() OVER (ORDER BY last_seen DESC,id) AS position
          FROM vacp_plugin_account_instances WHERE account_id=d.id
          ORDER BY last_seen DESC,id LIMIT 20
        ) i WHERE i.position=1 OR i.last_seen>now()-interval '3 minutes'
      ) instance_data ON true ORDER BY d.last_seen DESC,d.id DESC
    `,[workspace,user.id])
    return rows
  }

  @Post('pairings')
  @Header('Cache-Control','no-store')
  async pair(@Req() req:WorkspaceRequest,@Param('workspaceId') workspace:string,@Body() body:unknown) {
    const user = await requireWorkspaceAccess(req,workspace)
    const plugin = field(body,'plugin',3,8)
    if (plugin!=='dsh' && plugin!=='opencode') throw new BadRequestException('未知插件')
    const code = token('vacp_pair_')
    const {rows:[entry]} = await pool.query(`
      INSERT INTO vacp_plugin_pairings(code_hash,workspace_id,user_id,plugin,expires_at)
      SELECT $1,$2,$3,$4,now()+interval '5 minutes'
      FROM vacp_members WHERE workspace_id=$2 AND user_id=$3 AND role<>'viewer' FOR SHARE
      RETURNING expires_at AS "expiresAt"
    `,[digest(code),workspace,user.id,plugin])
    if (!entry) throw new ForbiddenException('只读角色无法连接插件')
    return { code,expiresAt:entry.expiresAt }
  }

  @Delete(':id')
  @HttpCode(204)
  async revoke(@Req() req:WorkspaceRequest,@Param('workspaceId') workspace:string,@Param('id') id:string) {
    const user = await requireWorkspaceAccess(req,workspace)
    if (!uuid.test(id)) throw new NotFoundException()
    const db = await pool.connect()
    try {
      await db.query('BEGIN')
      const {rows:[account]} = await db.query(`
        SELECT a.id FROM vacp_plugin_accounts a
        JOIN vacp_members owner ON owner.user_id=a.user_id AND owner.workspace_id=$2 AND owner.role<>'viewer'
        JOIN vacp_members actor ON actor.workspace_id=$2 AND actor.user_id=$3
        WHERE (a.id=$1 OR EXISTS (
          SELECT 1 FROM vacp_plugin_sessions s WHERE s.id=$1 AND s.workspace_id=$2 AND s.account_id=a.id
        )) AND (a.user_id=$3 OR actor.role IN ('owner','admin'))
        FOR UPDATE OF a
      `,[id,workspace,user.id])
      if (account) await db.query(`
        INSERT INTO vacp_plugin_workspace_revocations(account_id,workspace_id) VALUES($1,$2) ON CONFLICT DO NOTHING
      `,[account.id,workspace])
      const updated = await db.query(`
        UPDATE vacp_plugin_sessions s SET revoked_at=COALESCE(s.revoked_at,now())
        FROM vacp_members m WHERE s.workspace_id=$2 AND m.workspace_id=s.workspace_id AND m.user_id=$3
          AND (s.user_id=$3 OR m.role IN ('owner','admin'))
          AND (s.account_id=$4 OR (s.id=$1 AND s.account_id IS NULL))
      `,[id,workspace,user.id,account?.id ?? null])
      if (!account && !updated.rowCount) throw new NotFoundException()
      await db.query('COMMIT')
    } catch(error) {
      await db.query('ROLLBACK')
      throw error
    } finally { db.release() }
  }
}

export type PluginRequest = { headers:{ authorization?:string } }
export type PluginSession = { id:string; workspaceId:string; userId:string; plugin:'dsh'|'opencode'; expiresAt:Date; accountId:string|null }

export async function requirePluginSession(req: PluginRequest): Promise<PluginSession> {
  const value = /^Bearer (vacp_plugin_[\w-]{43})$/.exec(req.headers.authorization ?? '')?.[1]
  if (!value) throw new UnauthorizedException()
  const {rows:[session]} = await pool.query<PluginSession>(`
    UPDATE vacp_plugin_sessions s SET last_seen=now() FROM vacp_members m
    WHERE s.token_hash=$1 AND s.expires_at>now() AND s.revoked_at IS NULL
      AND m.workspace_id=s.workspace_id AND m.user_id=s.user_id AND m.role<>'viewer'
    RETURNING s.id,s.workspace_id AS "workspaceId",s.user_id AS "userId",s.plugin,s.expires_at AS "expiresAt",s.account_id AS "accountId"
  `,[digest(value)])
  if (!session) throw new UnauthorizedException()
  return session
}

export function accountHash(req: PluginRequest) {
  const value=/^Bearer (vacp_account_[\w-]{43})$/.exec(req.headers.authorization ?? '')?.[1]
  if (!value) throw new UnauthorizedException()
  return digest(value)
}

export function readInstance(body: unknown) {
  const id = field(body,'instanceId',36,36)
  const hostName = field(body,'hostName',1,160)
  const pluginVersion = field(body,'version',1,40)
  if (!uuid.test(id) || /[\u0000-\u001f\u007f]/u.test(hostName + pluginVersion)) {
    throw new BadRequestException('客户端实例信息无效')
  }
  return {id,hostName,pluginVersion}
}

export async function rememberInstance(accountId: string, instance: ReturnType<typeof readInstance>) {
  const changed = await pool.query(`
    INSERT INTO vacp_plugin_account_instances(account_id,id,host_name,plugin_version)
    SELECT id,$2,$3,$4 FROM vacp_plugin_accounts WHERE id=$1 AND expires_at>now() FOR SHARE
    ON CONFLICT(account_id,id) DO UPDATE SET host_name=EXCLUDED.host_name,
      plugin_version=EXCLUDED.plugin_version,last_seen=now()
  `,[accountId,instance.id,instance.hostName,instance.pluginVersion])
  if (!changed.rowCount) throw new UnauthorizedException()
}

@Controller('api/v1/agent-plugin-auth/account')
export class AgentPluginAccountController {
  @Put('instance')
  @HttpCode(204)
  async reportInstance(@Req() req:PluginRequest,@Body() body:unknown) {
    const instance = readInstance(body)
    const {rows:[account]} = await pool.query<{id:string}>(`
      UPDATE vacp_plugin_accounts SET last_seen=now() WHERE token_hash=$1 AND expires_at>now() RETURNING id
    `,[accountHash(req)])
    if (!account) throw new UnauthorizedException()
    await rememberInstance(account.id,instance)
  }

  @Post('login')
  @HttpCode(200)
  @Header('Cache-Control','no-store')
  async login(@Body() body:unknown) {
    const plugin=field(body,'plugin',3,8)
    if (plugin!=='dsh' && plugin!=='opencode') throw new BadRequestException('未知插件')
    const device=field(body,'device',1,80)
    const version=field(body,'version',1,40)
    const user=await authenticateCredentials(body)
    const accountToken=token('vacp_account_')
    const {rows:[account]}=await pool.query(`
      INSERT INTO vacp_plugin_accounts(id,user_id,plugin,device,plugin_version,token_hash)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING expires_at AS "expiresAt"
    `,[randomUUID(),user.id,plugin,device,version,digest(accountToken)])
    return {user:{id:user.id,email:user.email},accountToken,expiresAt:account.expiresAt}
  }

  @Get('workspaces')
  @Header('Cache-Control','no-store')
  async workspaces(@Req() req:PluginRequest) {
    const {rows:[account]}=await pool.query(`
      UPDATE vacp_plugin_accounts SET last_seen=now() WHERE token_hash=$1 AND expires_at>now()
      RETURNING id,user_id
    `,[accountHash(req)])
    if (!account) throw new UnauthorizedException()
    const {rows}=await pool.query(`
      SELECT w.id,w.name,m.role,
        ARRAY(SELECT r.alias FROM vacp_gateway_routes r WHERE r.workspace_id=w.id AND r.enabled ORDER BY r.alias) AS models,
        COALESCE((SELECT jsonb_object_agg(r.alias,jsonb_build_object(
          'contextWindow',r.context_window,'maxOutputTokens',r.max_output_tokens,
          'compactionHeadroomTokens',r.compaction_headroom_tokens,'reasoningEfforts',r.reasoning_efforts))
          FROM vacp_gateway_routes r WHERE r.workspace_id=w.id AND r.enabled), '{}'::jsonb) AS "modelLimits"
      FROM vacp_members m JOIN vacp_workspaces w ON w.id=m.workspace_id
      WHERE m.user_id=$1 AND m.role<>'viewer' AND NOT EXISTS (
        SELECT 1 FROM vacp_plugin_workspace_revocations WHERE account_id=$2 AND workspace_id=w.id
      ) ORDER BY w.name,w.id
    `,[account.user_id,account.id])
    return rows
  }

  @Get('workspaces/:id/resources')
  @Header('Cache-Control','no-store')
  async resources(@Req() req:PluginRequest,@Param('id') workspace:string) {
    const hash=accountHash(req)
    if (!uuid.test(workspace)) throw new NotFoundException()
    const {rows:[result]}=await pool.query(`
      WITH account AS (
        UPDATE vacp_plugin_accounts SET last_seen=now() WHERE token_hash=$1 AND expires_at>now()
        RETURNING id,user_id
      ), eligible AS (
        SELECT m.workspace_id FROM account a JOIN vacp_members m ON m.user_id=a.user_id
        WHERE m.workspace_id=$2 AND m.role<>'viewer' AND NOT EXISTS (
          SELECT 1 FROM vacp_plugin_workspace_revocations WHERE account_id=a.id AND workspace_id=m.workspace_id
        )
      ), releases AS (
        SELECT r.id FROM eligible e JOIN vacp_skills s ON s.workspace_id=e.workspace_id
        JOIN vacp_skill_releases r ON r.skill_id=s.id
        UNION
        SELECT i.release_id FROM eligible e JOIN vacp_skill_installs i ON i.workspace_id=e.workspace_id
      ), skills AS (
        SELECT r.id,r.name,r.version,r.description,
          (i.release_id IS NOT NULL) AS installed,r.published_at
        FROM eligible e CROSS JOIN releases visible
        JOIN vacp_skill_releases r ON r.id=visible.id AND r.review_status='approved'
        LEFT JOIN vacp_skill_installs i ON i.workspace_id=e.workspace_id AND i.release_id=r.id
      ), mcps AS (
        SELECT m.id,m.name,m.auth FROM eligible e
        JOIN vacp_mcp_servers m ON m.workspace_id=e.workspace_id AND m.enabled
      )
      SELECT EXISTS(SELECT 1 FROM account) AS valid, EXISTS(SELECT 1 FROM eligible) AS allowed,
        COALESCE((SELECT jsonb_agg(to_jsonb(s)-'published_at' ORDER BY s.name,s.published_at DESC,s.id) FROM skills s),'[]') AS skills,
        COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.name,m.id) FROM mcps m),'[]') AS mcps
    `,[hash,workspace])
    if (!result.valid) throw new UnauthorizedException()
    if (!result.allowed) throw new NotFoundException('工作空间不可用')
    return {skills:result.skills,mcps:result.mcps}
  }

  @Post('workspaces/:id/session')
  @Header('Cache-Control','no-store')
  async connect(@Req() req:PluginRequest,@Param('id') workspace:string) {
    const hash=accountHash(req)
    if (!uuid.test(workspace)) throw new NotFoundException()
    const accessToken=token('vacp_plugin_')
    const db=await pool.connect()
    try {
      await db.query('BEGIN')
      const {rows:[account]}=await db.query(`
        SELECT * FROM vacp_plugin_accounts WHERE token_hash=$1 AND expires_at>now() FOR UPDATE
      `,[hash])
      if (!account) throw new UnauthorizedException()
      const member=await db.query(`
        SELECT 1 FROM vacp_members WHERE workspace_id=$1 AND user_id=$2 AND role<>'viewer' FOR SHARE
      `,[workspace,account.user_id])
      if (!member.rowCount) throw new NotFoundException('工作空间不可用')
      const blocked=await db.query(`
        SELECT 1 FROM vacp_plugin_workspace_revocations WHERE account_id=$1 AND workspace_id=$2
      `,[account.id,workspace])
      if (blocked.rowCount) throw new ForbiddenException('该设备的工作空间访问已撤销，请重新登录')
      const {rows:[previous]}=await db.query(`
        SELECT id,revoked_at FROM vacp_plugin_sessions WHERE account_id=$1 AND workspace_id=$2
        ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE
      `,[account.id,workspace])
      if (previous?.revoked_at) throw new ForbiddenException('该设备的工作空间访问已撤销，请重新登录')
      if (previous) await db.query('UPDATE vacp_plugin_sessions SET revoked_at=now() WHERE id=$1',[previous.id])
      const {rows:[session]}=await db.query(`
        INSERT INTO vacp_plugin_sessions(id,workspace_id,user_id,plugin,device,plugin_version,token_hash,account_id,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
        RETURNING id,workspace_id AS "workspaceId",plugin,expires_at AS "expiresAt"
      `,[randomUUID(),workspace,account.user_id,account.plugin,account.device,account.plugin_version,
        digest(accessToken),account.id,account.expires_at])
      await db.query('UPDATE vacp_plugin_accounts SET last_seen=now() WHERE id=$1',[account.id])
      await db.query('COMMIT')
      return {...session,accessToken}
    } catch (error) {
      await db.query('ROLLBACK')
      throw error
    } finally { db.release() }
  }

  @Delete('session')
  @HttpCode(204)
  async logout(@Req() req:PluginRequest) {
    await pool.query('DELETE FROM vacp_plugin_accounts WHERE token_hash=$1',[accountHash(req)])
  }
}

@Controller('api/v1/agent-plugin-auth')
export class AgentPluginAuthController {
  @Post('redeem')
  @Header('Cache-Control','no-store')
  async redeem(@Body() body:unknown) {
    const code = field(body,'code',53,53)
    if (!codePattern.test(code)) throw new UnauthorizedException('连接码无效或已过期')
    const device = field(body,'device',1,80)
    const version = field(body,'version',1,40)
    const accessToken = token('vacp_plugin_')
    const {rows:[session]} = await pool.query(`
      WITH eligible AS (
        SELECT p.code_hash FROM vacp_plugin_pairings p JOIN vacp_members m
          ON m.workspace_id=p.workspace_id AND m.user_id=p.user_id
        WHERE p.code_hash=$1 AND p.expires_at>now() AND m.role<>'viewer' FOR SHARE OF m
      ), redeemed AS (
        DELETE FROM vacp_plugin_pairings p USING eligible
        WHERE p.code_hash=eligible.code_hash AND p.expires_at>now()
        RETURNING p.workspace_id,p.user_id,p.plugin
      )
      INSERT INTO vacp_plugin_sessions(id,workspace_id,user_id,plugin,device,plugin_version,token_hash)
      SELECT $2,workspace_id,user_id,plugin,$3,$4,$5 FROM redeemed
      RETURNING id,workspace_id AS "workspaceId",user_id AS "userId",plugin,expires_at AS "expiresAt"
    `,[digest(code),randomUUID(),device,version,digest(accessToken)])
    if (!session) throw new UnauthorizedException('连接码无效或已过期')
    return { ...session,accessToken }
  }

  @Get('session')
  @Header('Cache-Control','no-store')
  async session(@Req() req:PluginRequest) {
    return requirePluginSession(req)
  }
}
