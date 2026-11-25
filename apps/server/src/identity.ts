import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Req, Res, BadRequestException, ConflictException, ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common'
import { randomBytes, randomUUID, scrypt, timingSafeEqual, createHash } from 'node:crypto'
import { promisify } from 'node:util'
type FastifyRequest = { headers: { cookie?: string } }
type FastifyReply = { header(name: string, value: string): unknown }
import { pool } from './database.js'

const derive = promisify(scrypt)
const hash = (token: string) => createHash('sha256').update(token).digest('hex')
const ttl = 60 * 60 * 24
const roles = ['owner', 'admin', 'member', 'viewer'] as const
type Role = typeof roles[number]
const permissions: Record<Role, readonly string[]> = {
  owner: ['workspace:read', 'workspace:rename', 'members:read', 'members:manage', 'admins:manage', 'ownership:transfer', 'ownership:history'],
  admin: ['workspace:read', 'workspace:rename', 'members:read', 'members:manage', 'ownership:history'],
  member: ['workspace:read', 'members:read'],
  viewer: ['workspace:read'],
}
export const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i

export function field(body: unknown, key: string, min: number, max: number, trim = true) {
  const value = body && typeof body === 'object' ? Reflect.get(body, key) : undefined
  const text = typeof value === 'string' ? (trim ? value.trim() : value) : ''
  if (text.length < min || text.length > max) throw new BadRequestException('Invalid ' + key)
  return text
}

function email(body: unknown) {
  const value = field(body, 'email', 3, 254).toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new BadRequestException('Invalid email')
  return value
}

function cookie(req: FastifyRequest) {
  return /(?:^|;\s*)vacp_session=([\w-]{43})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1]
}

export type PlatformRole = 'super_admin' | 'user'

export async function actor(req: FastifyRequest): Promise<{id: string, email: string, platformRole: PlatformRole}> {
  const token = cookie(req)
  if (!token) throw new UnauthorizedException()
  const { rows } = await pool.query('SELECT u.id,u.email,u.platform_role AS "platformRole" FROM vacp_sessions s JOIN vacp_users u ON u.id=s.user_id WHERE s.token=$1 AND s.expires_at > now()', [hash(token)])
  if (!rows[0]) throw new UnauthorizedException()
  return rows[0]
}

function sessionCookie(res: FastifyReply, value: string, age: number) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  res.header('Set-Cookie', `vacp_session=${value}; Path=/api/v1; HttpOnly; SameSite=Strict; Max-Age=${age}${secure}`)
}

export async function authenticateCredentials(body: unknown): Promise<{id:string;email:string;platformRole:PlatformRole}> {
  const address = email(body)
  const password = field(body, 'password', 1, 128, false)
  const { rows: [user] } = await pool.query('SELECT id,email,salt,secret,platform_role AS "platformRole" FROM vacp_users WHERE email=$1', [address])
  const secret = await derive(password, user?.salt ?? 'vacp-invalid-user', 64) as Buffer
  if (!user || !timingSafeEqual(secret, user.secret)) throw new UnauthorizedException('Invalid credentials')
  return { id: user.id, email: user.email, platformRole: user.platformRole }
}

@Controller('api/v1')
export class IdentityController {
  @Post('auth/register')
  async register(@Body() body: unknown) {
    const address = email(body)
    const password = field(body, 'password', 1, 128, false)
    if (Array.from(password).length < 8) throw new BadRequestException('新账户密码至少 8 个字符')
    const salt = randomBytes(16).toString('hex')
    const secret = await derive(password, salt, 64) as Buffer
    const db = await pool.connect()
    try {
      await db.query('BEGIN')
      await db.query('SELECT pg_advisory_xact_lock(643211)')
      const { rows: [created] } = await db.query(`
        INSERT INTO vacp_users(id,email,salt,secret,platform_role)
        VALUES($1,$2,$3,$4,CASE WHEN EXISTS (SELECT 1 FROM vacp_users) THEN 'user' ELSE 'super_admin' END)
        ON CONFLICT(email) DO NOTHING RETURNING id,email,platform_role AS "platformRole"
      `, [randomUUID(), address, salt, secret])
      if (!created) throw new ConflictException('Email already registered')
      await db.query('COMMIT')
      return created
    } catch (error) {
      await db.query('ROLLBACK')
      throw error
    } finally {
      db.release()
    }
  }

  @Post('auth/login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Res({passthrough:true}) res: FastifyReply) {
    const user = await authenticateCredentials(body)
    const token = randomBytes(32).toString('base64url')
    await pool.query('INSERT INTO vacp_sessions VALUES($1,$2,$3)', [hash(token), user.id, new Date(Date.now()+ttl*1000)])
    sessionCookie(res, token, ttl)
    return user
  }

  @Post('auth/logout')
  @HttpCode(204)
  async logout(@Req() req: FastifyRequest, @Res({passthrough:true}) res: FastifyReply) {
    const token = cookie(req)
    if (token) await pool.query('DELETE FROM vacp_sessions WHERE token=$1', [hash(token)])
    sessionCookie(res, '', 0)
  }

  @Get('auth/me')
  me(@Req() req: FastifyRequest) { return actor(req) }

  @Get('workspaces')
  async list(@Req() req: FastifyRequest) {
    const user = await actor(req)
    const { rows } = await pool.query<{id:string,name:string,role:Role}>('SELECT w.id,w.name,m.role FROM vacp_workspaces w JOIN vacp_members m ON m.workspace_id=w.id WHERE m.user_id=$1 ORDER BY w.name,w.id', [user.id])
    return rows.map(row => ({ ...row, permissions: permissions[row.role] }))
  }

  @Post('workspaces')
  async create(@Req() req: FastifyRequest, @Body() body: unknown) {
    const user = await actor(req)
    const id = randomUUID()
    const name = field(body, 'name', 1, 80)
    await pool.query(`WITH created AS (INSERT INTO vacp_workspaces VALUES($1,$2) RETURNING id)
      INSERT INTO vacp_members SELECT id,$3,'owner' FROM created`, [id,name,user.id])
    return { id,name,role:'owner',permissions:permissions.owner }
  }

  @Patch('workspaces/:id')
  async rename(@Req() req: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const user = await actor(req)
    if (!uuid.test(id)) throw new NotFoundException()
    const name = field(body, 'name', 1, 80)
    const { rows: [result] } = await pool.query(`WITH scope AS (
      SELECT role FROM vacp_members WHERE workspace_id=$1 AND user_id=$2
    ), updated AS (
      UPDATE vacp_workspaces SET name=$3 WHERE id=$1
      AND EXISTS (SELECT 1 FROM scope WHERE role IN ('owner','admin')) RETURNING id
    )
    SELECT (SELECT role FROM scope) AS role, EXISTS (SELECT 1 FROM updated) AS updated`, [id,user.id,name])
    if (!result.role) throw new NotFoundException()
    if (!result.updated) throw new ForbiddenException()
    return { id, name }
  }

  @Get('workspaces/:id/members')
  async members(@Req() req: FastifyRequest, @Param('id') id: string) {
    const user = await actor(req)
    if (!uuid.test(id)) throw new NotFoundException()
    const {rows} = await pool.query(`SELECT u.email, m.role, actor.role AS actor_role
      FROM vacp_members actor JOIN vacp_members m ON m.workspace_id=actor.workspace_id
      JOIN vacp_users u ON u.id=m.user_id WHERE actor.user_id=$1 AND actor.workspace_id=$2 ORDER BY u.email`, [user.id,id])
    if (!rows.length) throw new NotFoundException()
    if (!permissions[rows[0].actor_role as Role].includes('members:read')) throw new ForbiddenException()
    return rows.map(({email,role}) => ({email,role}))
  }

  @Put('workspaces/:id/members')
  assign(@Req() req: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const role = field(body,'role',1,10)
    if (role !== 'admin' && role !== 'member' && role !== 'viewer') throw new BadRequestException('Invalid role')
    return this.change(req,id,email(body),role)
  }

  @Delete('workspaces/:id/members')
  @HttpCode(204)
  async remove(@Req() req: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    await this.change(req,id,email(body),null)
  }

  @Get('workspaces/:id/ownership-transfers')
  async ownershipHistory(@Req() req: FastifyRequest, @Param('id') id: string) {
    const user = await actor(req)
    if (!uuid.test(id)) throw new NotFoundException()
    const { rows: [result] } = await pool.query(`
      SELECT m.role, COALESCE((
        SELECT json_agg(history ORDER BY history."transferredAt" DESC, history.id DESC)
        FROM (
          SELECT t.id, t.transferred_at AS "transferredAt",
            previous.email AS "fromEmail", successor.email AS "toEmail"
          FROM vacp_ownership_transfers t
          LEFT JOIN vacp_users previous ON previous.id=t.from_user_id
          LEFT JOIN vacp_users successor ON successor.id=t.to_user_id
          WHERE t.workspace_id=m.workspace_id AND m.role IN ('owner','admin')
          ORDER BY t.transferred_at DESC, t.id DESC
          LIMIT 50
        ) history
      ), '[]'::json) AS history
      FROM vacp_members m WHERE m.workspace_id=$1 AND m.user_id=$2
    `, [id, user.id])
    if (!result) throw new NotFoundException()
    if (!permissions[result.role as Role].includes('ownership:history')) throw new ForbiddenException()
    return result.history
  }

  @Post('workspaces/:id/ownership-transfer')
  @HttpCode(204)
  async transfer(@Req() req: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const address = email(body)
    await this.withLockedWorkspace(req, id, async (db, userId, role) => {
      if (!permissions[role].includes('ownership:transfer')) throw new ForbiddenException()
      const { rows: [target] } = await db.query<{ id: string }>(`
        SELECT u.id FROM vacp_members m JOIN vacp_users u ON u.id=m.user_id
        WHERE m.workspace_id=$1 AND u.email=$2
      `, [id, address])
      if (!target) throw new NotFoundException('Target must be a workspace member')
      if (target.id === userId) throw new BadRequestException('Already the workspace owner')

      await db.query("UPDATE vacp_members SET role='admin' WHERE workspace_id=$1 AND user_id=$2", [id, userId])
      await db.query("UPDATE vacp_members SET role='owner' WHERE workspace_id=$1 AND user_id=$2", [id, target.id])
      await db.query(`
        INSERT INTO vacp_ownership_transfers(id,workspace_id,from_user_id,to_user_id) VALUES($1,$2,$3,$4)
      `, [randomUUID(), id, userId, target.id])
    })
  }

  private change(req: FastifyRequest, id: string, address: string, next: Role | null) {
    return this.withLockedWorkspace(req, id, async (db, _userId, role) => {
      if (!permissions[role].includes('members:manage')) throw new ForbiddenException()
      const {rows:[target]} = await db.query('SELECT u.id, m.role FROM vacp_users u LEFT JOIN vacp_members m ON m.user_id=u.id AND m.workspace_id=$1 WHERE u.email=$2', [id,address])
      if (!target) throw new NotFoundException('User not found')
      if (target.role === 'owner' || ((next === 'admin' || target.role === 'admin') && role !== 'owner')) throw new ForbiddenException()
      if (next) await db.query('INSERT INTO vacp_members VALUES($1,$2,$3) ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=excluded.role', [id,target.id,next])
      else await db.query('DELETE FROM vacp_members WHERE workspace_id=$1 AND user_id=$2', [id,target.id])
      return { email: address, role: next }
    })
  }

  private async withLockedWorkspace<T>(
    req: FastifyRequest, id: string,
    action: (db: import('pg').PoolClient, userId: string, role: Role) => Promise<T>,
  ): Promise<T> {
    const user = await actor(req)
    if (!uuid.test(id)) throw new NotFoundException()
    const db = await pool.connect()
    try {
      await db.query('BEGIN')
      await db.query('SELECT id FROM vacp_workspaces WHERE id=$1 FOR UPDATE', [id])
      const {rows:[member]} = await db.query<{role:Role}>('SELECT role FROM vacp_members WHERE user_id=$1 AND workspace_id=$2', [user.id,id])
      if (!member) throw new NotFoundException()
      const result = await action(db, user.id, member.role)
      await db.query('COMMIT')
      return result
    } catch (error) {
      await db.query('ROLLBACK')
      throw error
    } finally {
      db.release()
    }
  }
}
