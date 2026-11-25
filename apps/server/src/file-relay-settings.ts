import { BadRequestException, ForbiddenException } from '@nestjs/common'
import { pool } from './database.js'

export type FileRelaySettings = { enabled: boolean; maxFiles: number; maxTotalKiB: number; maxConcurrent: number }
const columns = 'enabled,max_files AS "maxFiles",max_total_kib AS "maxTotalKiB",max_concurrent AS "maxConcurrent"'

export async function readFileRelaySettings() {
  const { rows: [settings] } = await pool.query<FileRelaySettings>(
    `SELECT ${columns} FROM vacp_file_relay_settings WHERE singleton`,
  )
  return settings
}

export async function updateFileRelaySettings(input: unknown, userId: string) {
  const body = input as Partial<FileRelaySettings> | null
  const { enabled, maxFiles, maxTotalKiB, maxConcurrent } = body ?? {}
  const integer = (value: unknown, max: number): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max
  if (typeof enabled !== 'boolean' || !integer(maxFiles, 3) || !integer(maxTotalKiB, 256) || !integer(maxConcurrent, 16)) {
    throw new BadRequestException('请输入有效设置，文件数 1–3，单条大小 1–256 KiB，并发数 1–16')
  }
  const { rows: [settings] } = await pool.query<FileRelaySettings>(`
    UPDATE vacp_file_relay_settings
    SET enabled=$1,max_files=$2,max_total_kib=$3,max_concurrent=$4
    WHERE singleton AND EXISTS (
      SELECT 1 FROM vacp_users WHERE id=$5 AND platform_role='super_admin' FOR SHARE
    )
    RETURNING ${columns}
  `, [enabled,maxFiles,maxTotalKiB,maxConcurrent,userId])
  if (!settings) throw new ForbiddenException('超管权限已撤销')
  return settings
}
