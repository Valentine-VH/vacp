import Fastify from 'fastify'
import { DatabaseSync } from 'node:sqlite'
import { randomBytes, randomUUID, createHash, scryptSync, timingSafeEqual } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'

const roles = {
  owner: ['workspace:read', 'workspace:rename'],
  admin: ['workspace:read', 'workspace:rename'],
  member: ['workspace:read'],
  viewer: ['workspace:read'],
}
const digest = value => createHash('sha256').update(value).digest('hex')

export function createServer(filename = ':memory:') {
  const app = Fastify()
  const db = new DatabaseSync(filename)
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, salt TEXT NOT NULL, password BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS spaces (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS members (
      uid TEXT REFERENCES users(id), wid TEXT REFERENCES spaces(id),
      role TEXT NOT NULL CHECK(role IN ('owner','admin','member','viewer')), PRIMARY KEY(uid,wid)
    );
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, uid TEXT REFERENCES users(id), expires INTEGER NOT NULL);
  `)
  app.addHook('onClose', () => db.close())

  app.post('/api/v1/demo', (_, reply) => {
    const password = randomBytes(24).toString('base64url')
    const uid = randomUUID()
    const wid = randomUUID()
    const readonly = randomUUID()
    const privateSpace = randomUUID()
    const salt = randomBytes(16).toString('hex')
    db.exec('BEGIN')
    try {
      db.prepare('INSERT INTO users VALUES (?,?,?)').run(uid, salt, scryptSync(password, salt, 64))
      const insertSpace = db.prepare('INSERT INTO spaces VALUES (?,?)')
      insertSpace.run(wid, '我的工作空间')
      insertSpace.run(readonly, '只读工作空间')
      insertSpace.run(privateSpace, '其他工作空间')
      const insertMember = db.prepare('INSERT INTO members VALUES (?,?,?)')
      insertMember.run(uid, wid, 'owner')
      insertMember.run(uid, readonly, 'viewer')
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return reply.code(201).send({ uid, password, privateSpace })
  })

  app.post('/api/v1/login', (request, reply) => {
    const input = z.object({ uid: z.uuid(), password: z.string().max(128) }).safeParse(request.body)
    if (!input.success) return reply.code(400).send({ error: 'Invalid input' })
    const { uid, password } = input.data
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(uid)
    const actual = scryptSync(password, row?.salt ?? 'invalid-account', 64)
    if (!row || !timingSafeEqual(row.password, actual)) return reply.code(401).send({ error: 'Invalid credentials' })
    const token = randomBytes(32).toString('base64url')
    db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(digest(token), uid, Date.now() + 3600000)
    return { token }
  })

  app.register(async api => {
    api.decorateRequest('uid', '')
    api.addHook('preHandler', (request, reply, done) => {
      const token = /^Bearer ([\w-]{43})$/.exec(request.headers.authorization ?? '')?.[1]
      const session = token && db.prepare('SELECT uid FROM sessions WHERE token = ? AND expires > ?').get(digest(token), Date.now())
      if (!session) { reply.code(401).send({ error: 'Unauthorized' }); return }
      request.uid = session.uid
      done()
    })

    api.get('/workspaces', request =>
      db.prepare('SELECT spaces.id, name, role FROM spaces JOIN members ON wid = spaces.id WHERE uid = ? ORDER BY name')
        .all(request.uid).map(row => ({ ...row, permissions: roles[row.role] }))
    )

    api.patch('/workspaces/:id', (request, reply) => {
      const input = z.object({ name: z.string().trim().min(1).max(80) }).safeParse(request.body)
      if (!input.success) return reply.code(400).send({ error: 'Invalid name' })
      const member = db.prepare('SELECT role FROM members WHERE uid = ? AND wid = ?').get(request.uid, request.params.id)
      if (!member) return reply.code(404).send({ error: 'Workspace not found' })
      if (!roles[member.role].includes('workspace:rename')) return reply.code(403).send({ error: 'Forbidden' })
      db.prepare('UPDATE spaces SET name = ? WHERE id = ?').run(input.data.name, request.params.id)
      return { id: request.params.id, name: input.data.name }
    })
  }, { prefix: '/api/v1' })

  return app
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await createServer('vacp-poc.sqlite').listen({ host: '127.0.0.1', port: 3310 })
}
