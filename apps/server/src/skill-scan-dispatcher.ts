import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pool } from './database.js'

const root = process.env.VACP_SCAN_EXCHANGE ?? fileURLToPath(new URL('../../../.skill-scanner-exchange/', import.meta.url))
const inbox = join(root, 'inbox')
const outbox = join(root, 'outbox')
const engine = '2.3.2'
const key = /^[\da-f-]{36}\.[\da-f-]{36}\.(?:json|tmp)$/
type Job = { release_id: string; generation: string; digest: string; content: string }
type Finding = { rule: string; severity: string; line: number | null }
type Result = { status: 'passed' | 'blocked' | 'failed'; engine: string; digest: string; findings: Finding[]; error?: string }

function parseResult(value: unknown, digest: string): Result {
  if (!value || typeof value !== 'object') throw Error('invalid')
  const report = value as Record<string, unknown>
  if (report.digest !== digest || report.engine !== engine) throw Error('identity mismatch')
  if (report.status === 'failed') {
    return { digest, engine, status: 'failed', findings: [],
      error: report.error === 'timeout' || report.error === 'invalid_skill_metadata' ? report.error : 'invalid_input_or_report' }
  }
  if (!Array.isArray(report.findings) || report.findings.length > 200) throw Error('invalid findings')
  const findings: Finding[] = report.findings.map(item => {
    if (!item || typeof item.rule !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(item.rule) ||
        !['CRITICAL','HIGH','MEDIUM','LOW','INFO'].includes(item.severity)) throw Error('invalid finding')
    return { rule: item.rule, severity: item.severity, line: Number.isSafeInteger(item.line) ? item.line : null }
  })
  if (findings.some(item => item.rule === 'SKILL_LOAD_FALLBACK_USED')) throw Error('invalid skill metadata')
  const status = findings.some(item => item.severity === 'CRITICAL') ? 'blocked' : 'passed'
  if (report.status !== status) throw Error('invalid outcome')
  return { digest, engine, status, findings }
}

async function tick() {
  const { rows: expired } = await pool.query<Job>(`
    UPDATE vacp_skill_scan_jobs
    SET status=CASE WHEN attempts < 2 THEN 'queued' ELSE 'failed' END,
        error=CASE WHEN attempts < 2 THEN NULL ELSE 'worker_timeout' END,
        finished_at=CASE WHEN attempts < 2 THEN NULL ELSE now() END
    WHERE status='running' AND lease_until < now()
    RETURNING release_id,generation
  `)
  for (const job of expired) {
    const filename = job.release_id + '.' + job.generation + '.json'
    await rm(join(inbox, filename), { force:true })
    await rm(join(outbox, filename), { force:true })
  }
  const { rows: running } = await pool.query<Job>(
    "SELECT release_id,generation,digest FROM vacp_skill_scan_jobs WHERE status='running'",
  )
  for (const job of running) {
    const filename = job.release_id + '.' + job.generation + '.json'
    const report = join(outbox, filename)
    let result: Result
    try {
      if ((await stat(report)).size > 131072) throw Error('size')
      result = parseResult(JSON.parse(await readFile(report, 'utf8')), job.digest)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue
      result = { status:'failed',digest:job.digest,engine,findings:[],error:'invalid_report' }
    }
    await pool.query(`UPDATE vacp_skill_scan_jobs SET status=$3,report=$4,error=$5,finished_at=now()
      WHERE release_id=$1 AND generation=$2 AND status='running' AND lease_until >= now()`,
      [job.release_id,job.generation,result.status,JSON.stringify(result),result.error ?? null])
    await rm(join(inbox, filename), { force:true })
    await rm(report, { force:true })
  }

  // Remove expired-generation spool files left by a crash or timed-out worker.
  const { rows: active } = await pool.query<{ filename: string }>(
    "SELECT release_id || '.' || generation || '.json' AS filename FROM vacp_skill_scan_jobs WHERE status='running'",
  )
  const live = new Set(active.map(job => job.filename))
  for (const directory of [inbox,outbox]) {
    for (const filename of await readdir(directory)) {
      if (!key.test(filename) || live.has(filename.replace(/\.tmp$/, '.json'))) continue
      const file = join(directory, filename)
      const info = await stat(file).catch(() => null)
      if (info && Date.now() - info.mtimeMs > 90000) await rm(file,{force:true})
    }
  }

  const { rows: [job] } = await pool.query<Job>(`
    WITH next AS (
      SELECT release_id FROM vacp_skill_scan_jobs
      WHERE status='queued' AND NOT EXISTS (SELECT 1 FROM vacp_skill_scan_jobs WHERE status='running')
      ORDER BY created_at,release_id LIMIT 1 FOR UPDATE SKIP LOCKED
    )
    UPDATE vacp_skill_scan_jobs j SET status='running',generation=$1,lease_until=now()+interval '60 seconds',
      attempts=j.attempts+1
    FROM next,vacp_skill_releases r WHERE j.release_id=next.release_id AND r.id=j.release_id
    RETURNING j.release_id,j.generation,j.digest,r.content
  `, [randomUUID()])
  if (!job) return
  const basename = job.release_id + '.' + job.generation
  const staging = join(inbox, basename + '.tmp')
  await writeFile(staging, JSON.stringify({ content:job.content,digest:job.digest }), { flag:'wx',mode:0o644 })
  await rename(staging, join(inbox, basename + '.json'))
}

export async function startSkillScanDispatcher() {
  await mkdir(inbox, {recursive:true})
  await mkdir(outbox, {recursive:true})
  if (process.platform !== 'win32') await chmod(outbox, 0o1777)
  let current: Promise<void> | undefined
  const timer = setInterval(() => {
    if (current) return
    current = tick().catch(() => console.error('Skill scanner dispatcher could not process its queue'))
      .finally(() => { current = undefined })
  }, 1000)
  timer.unref()
  return async () => {
    clearInterval(timer)
    await current
  }
}
