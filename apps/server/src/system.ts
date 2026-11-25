import { Body, ConflictException, Controller, ForbiddenException, Get, NotFoundException, Param, Put, Req } from '@nestjs/common'
import { pool } from './database.js'
import { actor, field, uuid } from './identity.js'
import { readFileRelaySettings, updateFileRelaySettings } from './file-relay-settings.js'
import type { WorkspaceRequest } from './workspace-access.js'

async function admin(req: WorkspaceRequest) {
  const user = await actor(req)
  if (user.platformRole !== 'super_admin') throw new ForbiddenException('仅超管可访问系统管理')
  return user
}

@Controller('api/v1/system')
export class SystemController {
  @Get('settings/file-relay')
  async fileRelay(@Req() req: WorkspaceRequest) {
    await admin(req)
    return readFileRelaySettings()
  }

  @Put('settings/file-relay')
  async saveFileRelay(@Req() req: WorkspaceRequest, @Body() body: unknown) {
    const user = await admin(req)
    return updateFileRelaySettings(body, user.id)
  }

  @Get('workspaces')
  async spaces(@Req() req: WorkspaceRequest) {
    await admin(req)
    const { rows } = await pool.query(`
      SELECT w.id,w.name,count(m.user_id)::int AS "memberCount",
        max(u.email) FILTER (WHERE m.role='owner') AS "ownerEmail"
      FROM vacp_workspaces w
      LEFT JOIN vacp_members m ON m.workspace_id=w.id
      LEFT JOIN vacp_users u ON u.id=m.user_id
      GROUP BY w.id,w.name ORDER BY w.name,w.id
    `)
    return rows
  }

  @Get('users')
  async users(@Req() req: WorkspaceRequest) {
    await admin(req)
    const { rows } = await pool.query(`
      SELECT u.id,u.email,u.platform_role AS "platformRole",count(m.workspace_id)::int AS "workspaceCount"
      FROM vacp_users u LEFT JOIN vacp_members m ON m.user_id=u.id
      GROUP BY u.id ORDER BY u.email
    `)
    return rows
  }

  @Put('users/:id/role')
  async assignRole(@Req() req: WorkspaceRequest, @Param('id') id: string, @Body() body: unknown) {
    const user = await admin(req)
    if (!uuid.test(id)) throw new NotFoundException()
    const role = field(body,'role',4,11)
    if (role !== 'user' && role !== 'super_admin') throw new ConflictException('未知的平台角色')
    const db = await pool.connect()
    try {
      await db.query('BEGIN')
      await db.query('SELECT pg_advisory_xact_lock(643211)')
      const { rows:[current] } = await db.query('SELECT platform_role FROM vacp_users WHERE id=$1', [user.id])
      if (current?.platform_role !== 'super_admin') throw new ForbiddenException('超管权限已撤销')
      const { rows:[target] } = await db.query('SELECT platform_role FROM vacp_users WHERE id=$1', [id])
      if (!target) throw new NotFoundException()
      if (target.platform_role === 'super_admin' && role === 'user') {
        const { rows:[other] } = await db.query("SELECT id FROM vacp_users WHERE platform_role='super_admin' AND id<>$1 LIMIT 1", [id])
        if (!other) throw new ConflictException('必须保留至少一位超管')
      }
      await db.query('UPDATE vacp_users SET platform_role=$2 WHERE id=$1', [id,role])
      await db.query('COMMIT')
      return {id,platformRole:role}
    } catch (error) {
      await db.query('ROLLBACK')
      throw error
    } finally { db.release() }
  }

  @Get('roles')
  async roles(@Req() req: WorkspaceRequest) {
    await admin(req)
    const { rows } = await pool.query('SELECT platform_role AS id,count(*)::int AS count FROM vacp_users GROUP BY platform_role')
    return [
      {id:'super_admin',name:'超管',description:'访问系统管理和分配平台角色',count:rows.find(row => row.id==='super_admin')?.count ?? 0},
      {id:'user',name:'默认用户',description:'使用获得授权的工作空间',count:rows.find(row => row.id==='user')?.count ?? 0},
    ]
  }

  @Get('menus')
  async menus(@Req() req: WorkspaceRequest) {
    await admin(req)
    return [
      {id:'workspace',name:'工作空间',group:'工作台',access:'工作空间成员'},
      {id:'chat',name:'Chat',group:'工作台',access:'非只读的工作空间成员'},
      {id:'agent-teams',name:'Team',group:'工作台',access:'会话参与者'},
      {id:'agent',name:'Agent',group:'工作台',access:'工作空间成员'},
      {id:'plugin-market',name:'插件',group:'工作台',access:'工作空间成员'},
      {id:'mcp',name:'MCP',group:'工具',access:'工作空间成员'},
      {id:'skills',name:'Skill',group:'工具',access:'工作空间成员'},
      {id:'models',name:'模型',group:'工作台',access:'工作空间 Owner / Admin'},
      ...['工作空间','用户','角色','菜单','系统'].map((name,index) => ({
        id:['system-workspaces','system-users','system-roles','system-menus','system-status'][index],
        name,group:'系统',access:'超管',
      })),
    ]
  }

  @Get('status')
  async status(@Req() req: WorkspaceRequest) {
    await admin(req)
    const { rows:[counts] } = await pool.query(`SELECT
      (SELECT count(*)::int FROM vacp_users) AS users,
      (SELECT count(*)::int FROM vacp_workspaces) AS workspaces,
      (SELECT count(*)::int FROM vacp_users WHERE platform_role='super_admin') AS "superAdmins"
    `)
    return {database:'ready',...counts}
  }
}
