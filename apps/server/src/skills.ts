import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Req, BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { createHash, randomUUID } from 'node:crypto'
import { pool } from './database.js'
import { field, uuid } from './identity.js'
import { requireWorkspaceAccess, type WorkspaceRequest } from './workspace-access.js'

type Request = WorkspaceRequest
function checkId(id: string) {
  if (!uuid.test(id)) throw new NotFoundException()
}

function checkSnapshot(content: string) {
  if (!content.trim() || Buffer.byteLength(content) > 64000 ||
      Array.from(content).some(char => char.charCodeAt(0) < 32 && !'\t\r\n'.includes(char))) {
    throw new BadRequestException('SKILL.md 为空、超出 64 KB 或包含无效控制字符')
  }
  return createHash('sha256').update(content).digest('hex')
}

@Controller('api/v1/workspaces/:workspaceId/skills')
export class SkillsController {
  @Get('repository')
  async repository(@Req() req: Request, @Param('workspaceId') workspaceId: string) {
    await requireWorkspaceAccess(req, workspaceId)
    const [drafts, installed] = await Promise.all([
      pool.query(`SELECT s.id,s.name,s.description,s.content,s.origin,
        COALESCE((SELECT json_agg(r.version ORDER BY r.published_at DESC)
        FROM vacp_skill_releases r WHERE r.skill_id=s.id AND r.review_status='approved'), '[]') AS versions
        FROM vacp_skills s WHERE s.workspace_id=$1 ORDER BY s.name`, [workspaceId]),
      pool.query(`SELECT r.id,r.name,r.description,r.version,r.review_status AS "reviewStatus",
        CASE WHEN r.review_status='approved' THEN r.content END AS content,w.name AS publisher
        FROM vacp_skill_installs i JOIN vacp_skill_releases r ON r.id=i.release_id
        JOIN vacp_skills s ON s.id=r.skill_id JOIN vacp_workspaces w ON w.id=s.workspace_id
        WHERE i.workspace_id=$1 ORDER BY r.name,r.version`, [workspaceId]),
    ])
    return { drafts:drafts.rows, installed:installed.rows }
  }

  @Post('repository')
  async create(@Req() req: Request, @Param('workspaceId') workspaceId: string, @Body() body: unknown) {
    await requireWorkspaceAccess(req, workspaceId, true)
    const values = this.fields(body)
    const { rows:[skill] } = await pool.query(`
      INSERT INTO vacp_skills(id,workspace_id,name,description,content) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(workspace_id,name) DO NOTHING RETURNING id
    `, [randomUUID(),workspaceId,...values])
    if (!skill) throw new ConflictException('技能名称已存在')
    return skill
  }

  @Put('repository/:id')
  async edit(@Req() req: Request, @Param('workspaceId') workspaceId: string, @Param('id') id: string, @Body() body: unknown) {
    await requireWorkspaceAccess(req, workspaceId, true)
    checkId(id)
    const values = this.fields(body)
    const result = await pool.query(`
      UPDATE vacp_skills SET name=$3,description=$4,content=$5 WHERE workspace_id=$1 AND id=$2
    `, [workspaceId,id,...values]).catch(error => {
      if (error.code === '23505') throw new ConflictException('技能名称已存在')
      throw error
    })
    if (!result.rowCount) throw new NotFoundException()
    return { id }
  }

  @Post('repository/:id/releases')
  async publish(@Req() req: Request, @Param('workspaceId') workspaceId: string, @Param('id') id: string, @Body() body: unknown) {
    const user = await requireWorkspaceAccess(req, workspaceId, true)
    checkId(id)
    const version = field(body,'version',5,32)
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new BadRequestException('版本格式为 1.0.0')
    const { rows:[draft] } = await pool.query<{name:string;description:string;content:string;origin:object|null}>(
      'SELECT name,description,content,origin FROM vacp_skills WHERE id=$1 AND workspace_id=$2', [id,workspaceId],
    )
    if (!draft) throw new NotFoundException()
    const digest = checkSnapshot(draft.content)
    const { rows:[release] } = await pool.query(`
      WITH submitted AS (
        INSERT INTO vacp_skill_releases(id,skill_id,version,name,description,content,submitted_by,digest,checked_at,origin)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),$9) RETURNING id,version
      ), scheduled AS (
        INSERT INTO vacp_skill_scan_jobs(release_id,digest) SELECT id,$8 FROM submitted
      )
      SELECT id,version FROM submitted
    `, [randomUUID(),id,version,draft.name,draft.description,draft.content,user.id,digest,draft.origin]).catch(error => {
      if (error.code === '23505') throw new ConflictException('该版本号已使用')
      throw error
    })
    if (!release) throw new NotFoundException()
    return release
  }

  @Get('reviews')
  async reviews(@Req() req: Request, @Param('workspaceId') workspaceId: string) {
    const user = await requireWorkspaceAccess(req, workspaceId, true)
    const { rows } = await pool.query(`
      SELECT r.id,r.name,r.version,r.content,r.digest,r.origin,r.review_status AS status,
        (r.submitted_by IS DISTINCT FROM $2 OR $3::boolean) AS "canApprove", event.reason AS reason,
        j.status AS "scanStatus",j.report AS "scanReport",j.error AS "scanError"
      FROM vacp_skill_releases r JOIN vacp_skills s ON s.id=r.skill_id
      LEFT JOIN vacp_skill_scan_jobs j ON j.release_id=r.id
      LEFT JOIN LATERAL (
        SELECT reason FROM vacp_skill_review_events WHERE release_id=r.id
        ORDER BY created_at DESC,id DESC LIMIT 1
      ) event ON true
      WHERE s.workspace_id=$1 ORDER BY r.published_at DESC,r.id DESC
    `, [workspaceId,user.id,process.env.NODE_ENV !== 'production' && process.env.VACP_ALLOW_SKILL_SELF_REVIEW === '1'])
    return rows
  }

  @Post('reviews/:id/rescan')
  @HttpCode(204)
  async rescan(@Req() req: Request, @Param('workspaceId') workspaceId: string, @Param('id') id: string) {
    await requireWorkspaceAccess(req, workspaceId, true)
    checkId(id)
    const reset = await pool.query(`
      UPDATE vacp_skill_scan_jobs j SET status='queued',generation=NULL,lease_until=NULL,report=NULL,error=NULL,
        finished_at=NULL,created_at=now(),attempts=0
      FROM vacp_skill_releases r JOIN vacp_skills s ON s.id=r.skill_id
      WHERE j.release_id=r.id AND r.id=$1 AND s.workspace_id=$2 AND r.review_status='pending'
        AND j.status='failed' AND j.error IS DISTINCT FROM 'invalid_skill_metadata'
    `, [id,workspaceId])
    if (!reset.rowCount) throw new ConflictException('该版本当前无法重新扫描')
  }

  @Post('reviews/:id')
  @HttpCode(200)
  async decide(@Req() req: Request, @Param('workspaceId') workspaceId: string, @Param('id') id: string, @Body() body: unknown) {
    const user = await requireWorkspaceAccess(req, workspaceId, true)
    checkId(id)
    const action = field(body,'action',7,8)
    if (!['approved','rejected','revoked'].includes(action)) throw new BadRequestException('无效审核操作')
    const reason = field(body,'reason',1,500)
    const db = await pool.connect()
    try {
      await db.query('BEGIN')
      const { rows:[version] } = await db.query<{status:string;content:string;submitted_by:string|null}>(`
        SELECT r.review_status AS status,r.content,r.submitted_by
        FROM vacp_skill_releases r JOIN vacp_skills s ON s.id=r.skill_id
        WHERE r.id=$1 AND s.workspace_id=$2 FOR UPDATE OF r
      `, [id,workspaceId])
      if (!version) throw new NotFoundException()
      if (version.status !== (action === 'revoked' ? 'approved' : 'pending')) throw new ConflictException('审核状态已变化')
      if (action === 'approved' && version.submitted_by === user.id &&
        (process.env.NODE_ENV === 'production' || process.env.VACP_ALLOW_SKILL_SELF_REVIEW !== '1')) {
        throw new ForbiddenException('请由另一位管理员审核')
      }
      if (action === 'approved') {
        const digest = checkSnapshot(version.content)
        const { rows:[scan] } = await db.query(
          "SELECT digest FROM vacp_skill_scan_jobs WHERE release_id=$1 AND status='passed'", [id],
        )
        if (scan?.digest !== digest) throw new ConflictException('该版本尚未通过扫描')
        await db.query('UPDATE vacp_skill_releases SET digest=$2,checked_at=now() WHERE id=$1', [id,digest])
      }
      await db.query('UPDATE vacp_skill_releases SET review_status=$2 WHERE id=$1', [id,action])
      await db.query('INSERT INTO vacp_skill_review_events(id,release_id,actor_id,action,reason) VALUES($1,$2,$3,$4,$5)',
        [randomUUID(),id,user.id,action,reason])
      await db.query('COMMIT')
      return { id,status:action }
    } catch (error) {
      await db.query('ROLLBACK')
      throw error
    } finally {
      db.release()
    }
  }

  @Get('market')
  async market(@Req() req: Request, @Param('workspaceId') workspaceId: string) {
    await requireWorkspaceAccess(req, workspaceId)
    const { rows } = await pool.query(`
      SELECT r.id,r.name,r.description,r.version,r.origin,w.name AS publisher, (i.release_id IS NOT NULL) AS installed
      FROM vacp_skill_releases r JOIN vacp_skills s ON s.id=r.skill_id
      JOIN vacp_workspaces w ON w.id=s.workspace_id
      LEFT JOIN vacp_skill_installs i ON i.release_id=r.id AND i.workspace_id=$1
      WHERE r.review_status='approved' AND (r.origin IS NULL OR s.workspace_id=$1)
      ORDER BY r.published_at DESC,r.id DESC
    `, [workspaceId])
    return rows
  }

  @Get('market/:id')
  async preview(@Req() req: Request, @Param('workspaceId') workspaceId: string, @Param('id') id: string) {
    await requireWorkspaceAccess(req, workspaceId)
    checkId(id)
    const { rows:[release] } = await pool.query(`
      SELECT r.id,r.name,r.version,r.content FROM vacp_skill_releases r JOIN vacp_skills s ON s.id=r.skill_id
      WHERE r.id=$1 AND r.review_status='approved' AND (r.origin IS NULL OR s.workspace_id=$2)
    `, [id,workspaceId])
    if (!release) throw new NotFoundException()
    return release
  }

  @Put('installations/:id')
  async install(@Req() req: Request, @Param('workspaceId') workspaceId: string, @Param('id') id: string) {
    await requireWorkspaceAccess(req, workspaceId, true)
    checkId(id)
    const result = await pool.query(`
      INSERT INTO vacp_skill_installs(workspace_id,release_id)
      SELECT $1,r.id FROM vacp_skill_releases r JOIN vacp_skills s ON s.id=r.skill_id
      WHERE r.id=$2 AND r.review_status='approved' AND (r.origin IS NULL OR s.workspace_id=$1) FOR SHARE OF r
      ON CONFLICT(workspace_id,release_id) DO UPDATE SET release_id=excluded.release_id
      RETURNING release_id
    `, [workspaceId,id])
    if (!result.rowCount) throw new NotFoundException()
    return { id }
  }

  @Delete('installations/:id')
  @HttpCode(204)
  async uninstall(@Req() req: Request, @Param('workspaceId') workspaceId: string, @Param('id') id: string) {
    await requireWorkspaceAccess(req, workspaceId, true)
    checkId(id)
    await pool.query('DELETE FROM vacp_skill_installs WHERE workspace_id=$1 AND release_id=$2', [workspaceId,id])
  }

  private fields(body: unknown) {
    return [field(body,'name',1,80),field(body,'description',1,250),field(body,'content',1,32000)]
  }
}
