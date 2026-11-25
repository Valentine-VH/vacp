import { Body, Controller, Get, Param, Post, Req, UnauthorizedException, ForbiddenException, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { actor, field, uuid } from './identity.js'
import { pool } from './database.js'

type Request = { headers: { cookie?: string; authorization?: string } }
const digest = (token: string) => createHash('sha256').update(token).digest('hex')

async function workspace(req: Request, id: string, write = false) {
  const user = await actor(req)
  if (!uuid.test(id)) throw new NotFoundException()
  const { rows: [member] } = await pool.query<{ role: string }>(
    'SELECT role FROM vacp_members WHERE workspace_id=$1 AND user_id=$2', [id,user.id],
  )
  if (!member) throw new NotFoundException()
  if (write && !['owner','admin'].includes(member.role)) throw new ForbiddenException()
}

async function nodeIdentity(req: Request) {
  const token = /^Bearer ([\w-]{43})$/.exec(req.headers.authorization ?? '')?.[1]
  if (!token) throw new UnauthorizedException()
  const { rows: [node] } = await pool.query<{ id: string }>(
    'UPDATE vacp_mock_nodes SET last_seen=now() WHERE credential=$1 RETURNING id', [digest(token)],
  )
  if (!node) throw new UnauthorizedException()
  return node.id
}

@Controller('api/v1')
export class MockTaskController {
  @Get('workspaces/:id/mock-nodes')
  async nodes(@Req() req: Request, @Param('id') id: string) {
    await workspace(req,id)
    const { rows } = await pool.query(
      "SELECT id,name, COALESCE(last_seen > now() - interval '20 seconds', false) AS online FROM vacp_mock_nodes WHERE workspace_id=$1 ORDER BY name", [id],
    )
    return rows
  }

  @Post('workspaces/:id/mock-nodes')
  async createNode(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    await workspace(req,id,true)
    const name = field(body,'name',1,80)
    const nodeId = randomUUID()
    const token = randomBytes(32).toString('base64url')
    await pool.query('INSERT INTO vacp_mock_nodes(id,workspace_id,name,credential) VALUES($1,$2,$3,$4)', [nodeId,id,name,digest(token)])
    return { id:nodeId,name,token }
  }

  @Get('workspaces/:id/mock-tasks')
  async tasks(@Req() req: Request, @Param('id') id: string) {
    await workspace(req,id)
    const { rows } = await pool.query(`
      SELECT t.id,t.input,t.status,t.result,n.name AS node FROM vacp_mock_tasks t
      JOIN vacp_mock_nodes n ON n.id=t.node_id WHERE n.workspace_id=$1
      AND NOT t.is_chat
      ORDER BY t.created_at DESC,t.id DESC LIMIT 50
    `, [id])
    return rows
  }

  @Post('workspaces/:id/mock-tasks')
  async submit(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    await workspace(req,id,true)
    const nodeId = field(body,'nodeId',36,36)
    const input = field(body,'input',1,2000)
    if (!uuid.test(nodeId)) throw new BadRequestException('Invalid node')
    const { rows: [task] } = await pool.query(`
      INSERT INTO vacp_mock_tasks(id,node_id,input)
      SELECT $1,id,$4 FROM vacp_mock_nodes
      WHERE id=$2 AND workspace_id=$3 AND last_seen > now() - interval '20 seconds'
      RETURNING id,status
    `, [randomUUID(),nodeId,id,input])
    if (!task) throw new ConflictException('节点不在线或不可用')
    return task
  }

  @Post('mock-node/poll')
  async poll(@Req() req: Request) {
    const nodeId = await nodeIdentity(req)
    const lease = randomUUID()
    const { rows: [task] } = await pool.query(`
      WITH next AS (
        SELECT id FROM vacp_mock_tasks t WHERE node_id=$1
        AND (status='queued' OR (status='running' AND lease_until < now()))
        AND (NOT t.is_chat OR EXISTS (
          SELECT 1 FROM vacp_chat_messages cm JOIN vacp_chat_rooms r ON r.id=cm.room_id
          JOIN vacp_members m ON m.workspace_id=r.workspace_id AND m.user_id=cm.sender_id
          WHERE cm.task_id=t.id AND m.role<>'viewer'
        ))
        ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
      )
      UPDATE vacp_mock_tasks SET status='running',lease=$2,lease_until=now()+interval '15 seconds'
      WHERE id=(SELECT id FROM next) RETURNING id,input,lease
    `, [nodeId,lease])
    return { task:task ?? null }
  }

  @Post('mock-node/tasks/:id/complete')
  async complete(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const nodeId = await nodeIdentity(req)
    const lease = field(body,'lease',36,36)
    const result = field(body,'result',1,4000)
    if (!uuid.test(id) || !uuid.test(lease)) throw new BadRequestException('Invalid task or lease')
    const update = await pool.query(`
      UPDATE vacp_mock_tasks SET status='succeeded',result=$4
      WHERE id=$1 AND node_id=$2 AND lease=$3 AND status='running' AND lease_until >= now()
    `, [id,nodeId,lease,result])
    if (!update.rowCount) throw new ConflictException('任务租约已失效')
    return { status:'succeeded' }
  }
}
