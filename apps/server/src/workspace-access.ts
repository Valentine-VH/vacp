import { ForbiddenException, NotFoundException } from '@nestjs/common'
import { actor, uuid } from './identity.js'
import { pool } from './database.js'

export type WorkspaceRequest = { headers: { cookie?: string } }

export async function requireWorkspaceAccess(req: WorkspaceRequest, id: string, write = false) {
  const user = await actor(req)
  if (!uuid.test(id)) throw new NotFoundException()
  const { rows: [member] } = await pool.query<{ role: string }>(
    'SELECT role FROM vacp_members WHERE workspace_id=$1 AND user_id=$2', [id,user.id],
  )
  if (!member) throw new NotFoundException()
  if (write && !['owner','admin'].includes(member.role)) throw new ForbiddenException()
  return user
}
