import { Body, Controller, ForbiddenException, Get, NotFoundException, Param, Post, Req, BadRequestException, ConflictException } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { pool } from './database.js'
import { actor, field, uuid } from './identity.js'
import type { WorkspaceRequest } from './workspace-access.js'

type Request = WorkspaceRequest
type Room = { id:string; kind:'group'|'direct'; name:string|null }
type Participant = { id:string; name:string; kind:'human'|'agent'; online:boolean }
const checkId = (id:string) => { if (!uuid.test(id)) throw new NotFoundException() }

function ids(body:unknown, key:string) {
  const value = body && typeof body === 'object' ? Reflect.get(body,key) : undefined
  if (!Array.isArray(value) || value.length > 30 ||
      value.some(id => typeof id !== 'string' || !uuid.test(id))) throw new BadRequestException('会话成员格式无效')
  return [...new Set<string>(value.map(id => id.toLowerCase()))]
}

async function inTransaction<T>(action:(db:PoolClient)=>Promise<T>) {
  const db = await pool.connect()
  try {
    await db.query('BEGIN')
    const result = await action(db)
    await db.query('COMMIT')
    return result
  } catch (error) {
    await db.query('ROLLBACK')
    throw error
  } finally { db.release() }
}

async function member(db:Pool|PoolClient, workspace:string, user:string, write=false) {
  const { rows:[entry] } = await db.query<{role:string}>(
    'SELECT role FROM vacp_members WHERE workspace_id=$1 AND user_id=$2' + (write ? ' FOR SHARE' : ''),
    [workspace,user],
  )
  if (!entry) throw new NotFoundException()
  if (write && entry.role === 'viewer') throw new ForbiddenException('只读成员无法创建会话或发送消息')
  return entry
}

async function room(db:Pool|PoolClient, workspace:string, roomId:string, userId:string) {
  checkId(roomId)
  const {rows:[entry]} = await db.query<Room>(`
    SELECT r.id,r.kind,r.name FROM vacp_chat_rooms r
    JOIN vacp_chat_people p ON p.room_id=r.id AND p.user_id=$3
    JOIN vacp_members m ON m.workspace_id=r.workspace_id AND m.user_id=p.user_id
    WHERE r.id=$1 AND r.workspace_id=$2
  `, [roomId,workspace,userId])
  if (!entry) throw new NotFoundException()
  return entry
}

const rosterSql = `
  SELECT p.room_id,u.id,u.email AS name,'human' AS kind,true AS online FROM vacp_chat_people p
  JOIN vacp_chat_rooms r ON r.id=p.room_id JOIN vacp_users u ON u.id=p.user_id
  JOIN vacp_members m ON m.workspace_id=r.workspace_id AND m.user_id=u.id WHERE p.room_id=ANY($1::uuid[])
  UNION ALL
  SELECT a.room_id,n.id,n.name,'agent',COALESCE(n.last_seen > now()-interval '20 seconds',false)
  FROM vacp_chat_agents a JOIN vacp_mock_nodes n ON n.id=a.node_id WHERE a.room_id=ANY($1::uuid[])`

@Controller('api/v1/workspaces/:workspaceId/agent-teams')
export class AgentTeamsController {
  @Get('directory')
  async directory(@Req() req:Request,@Param('workspaceId') workspace:string) {
    checkId(workspace)
    const user = await actor(req)
    const access = await member(pool,workspace,user.id)
    if (access.role === 'viewer') throw new ForbiddenException()
    const {rows} = await pool.query<Participant>(`
      SELECT u.id,u.email AS name,'human' AS kind,true AS online
      FROM vacp_members m JOIN vacp_users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND u.id<>$2
      UNION ALL SELECT id,name,'agent',COALESCE(last_seen > now()-interval '20 seconds',false)
      FROM vacp_mock_nodes WHERE workspace_id=$1 ORDER BY kind,name
    `,[workspace,user.id])
    return rows
  }

  @Get('rooms')
  async list(@Req() req:Request,@Param('workspaceId') workspace:string) {
    checkId(workspace)
    const user = await actor(req)
    const {rows} = await pool.query<Room>(`
      SELECT r.id,r.kind,r.name FROM vacp_chat_rooms r
      JOIN vacp_chat_people p ON p.room_id=r.id AND p.user_id=$2
      JOIN vacp_members m ON m.workspace_id=r.workspace_id AND m.user_id=p.user_id
      WHERE r.workspace_id=$1 ORDER BY r.updated_at DESC,r.id
    `,[workspace,user.id])
    const {rows:roster} = await pool.query<Participant & {room_id:string}>(rosterSql,[rows.map(r=>r.id)])
    return rows.map(r=>({...r,participants:roster.filter(row=>row.room_id===r.id)}))
  }

  @Post('rooms')
  async create(@Req() req:Request,@Param('workspaceId') workspace:string,@Body() body:unknown) {
    checkId(workspace)
    const user = await actor(req)
    const kind = field(body,'kind',5,6)
    if (kind !== 'direct' && kind !== 'group') throw new BadRequestException('会话类型无效')
    const humans = ids(body,'userIds').filter(id=>id!==user.id)
    const agents = ids(body,'agentIds')
    const count = humans.length + agents.length
    if (!count || count > 30 || (kind === 'direct' && count !== 1)) throw new BadRequestException('请选择合适的会话成员')
    const name = kind === 'group' ? field(body,'name',1,80) : null
    const directKey = kind==='direct' ? (agents[0] ? 'agent:'+user.id+':'+agents[0] : 'human:'+ [user.id,humans[0]].sort().join(':')) : null
    return inTransaction(async db=>{
      await member(db,workspace,user.id,true)
      const eligible = await db.query('SELECT user_id FROM vacp_members WHERE workspace_id=$1 AND user_id=ANY($2::uuid[]) FOR SHARE',[workspace,humans])
      const nodes = await db.query('SELECT id FROM vacp_mock_nodes WHERE workspace_id=$1 AND id=ANY($2::uuid[]) FOR SHARE',[workspace,agents])
      if (eligible.rowCount!==humans.length || nodes.rowCount!==agents.length) throw new NotFoundException('成员或 Agent 不在当前工作空间')
      const {rows:[created]} = await db.query<{id:string}>(`
        INSERT INTO vacp_chat_rooms(id,workspace_id,kind,name,direct_key) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(workspace_id,direct_key) DO UPDATE SET direct_key=excluded.direct_key RETURNING id
      `,[randomUUID(),workspace,kind,name,directKey])
      await db.query('INSERT INTO vacp_chat_people(room_id,user_id) SELECT $1,unnest($2::uuid[]) ON CONFLICT DO NOTHING',[created.id,[user.id,...humans]])
      await db.query('INSERT INTO vacp_chat_agents(room_id,node_id) SELECT $1,unnest($2::uuid[]) ON CONFLICT DO NOTHING',[created.id,agents])
      return { id:created.id }
    })
  }

  @Get('rooms/:id/messages')
  async messages(@Req() req:Request,@Param('workspaceId') workspace:string,@Param('id') id:string) {
    checkId(workspace)
    const user = await actor(req)
    await room(pool,workspace,id,user.id)
    const {rows} = await pool.query(`
      SELECT message.* FROM (
        SELECT m.id,u.email AS sender,m.body,m.created_at AS "createdAt",
          n.name AS "agentName",t.status AS "agentStatus",t.result AS "agentReply"
        FROM vacp_chat_messages m JOIN vacp_chat_rooms r ON r.id=m.room_id
        JOIN vacp_chat_people p ON p.room_id=r.id AND p.user_id=$3
        JOIN vacp_members access ON access.workspace_id=r.workspace_id AND access.user_id=p.user_id
        JOIN vacp_users u ON u.id=m.sender_id
        LEFT JOIN vacp_mock_tasks t ON t.id=m.task_id LEFT JOIN vacp_mock_nodes n ON n.id=t.node_id
        WHERE r.id=$1 AND r.workspace_id=$2 ORDER BY m.created_at DESC,m.id DESC LIMIT 100
      ) message ORDER BY "createdAt",id
    `,[id,workspace,user.id])
    return rows
  }

  @Post('rooms/:id/messages')
  async send(@Req() req:Request,@Param('workspaceId') workspace:string,@Param('id') id:string,@Body() body:unknown) {
    checkId(workspace)
    const user = await actor(req)
    const content = field(body,'content',1,2000)
    const selected = body && typeof body === 'object' ? Reflect.get(body,'agentId') : undefined
    if (selected !== undefined && (typeof selected !== 'string' || !uuid.test(selected))) throw new BadRequestException('Agent 标识无效')
    return inTransaction(async db=>{
      await member(db,workspace,user.id,true)
      const current = await room(db,workspace,id,user.id)
      const {rows:agents} = await db.query<{node_id:string}>('SELECT node_id FROM vacp_chat_agents WHERE room_id=$1',[id])
      const target = current.kind==='direct' ? agents[0]?.node_id : selected as string|undefined
      let taskId: string|null = null
      if (target) {
        if (!agents.some(agent=>agent.node_id===target)) throw new NotFoundException('Agent 不在会话中')
        const { rows:[task] } = await db.query<{id:string}>(`
          INSERT INTO vacp_mock_tasks(id,node_id,input,is_chat)
          SELECT $1,id,$4,true FROM vacp_mock_nodes WHERE id=$2 AND workspace_id=$3
            AND last_seen>now()-interval '20 seconds' RETURNING id
        `,[randomUUID(),target,workspace,content])
        if (!task) throw new ConflictException('Agent 当前离线，请稍后重试')
        taskId = task.id
      }
      const mid = randomUUID()
      await db.query('INSERT INTO vacp_chat_messages(id,room_id,sender_id,body,task_id) VALUES($1,$2,$3,$4,$5)',
        [mid,id,user.id,content,taskId])
      await db.query('UPDATE vacp_chat_rooms SET updated_at=now() WHERE id=$1',[id])
      return { id:mid }
    })
  }
}
