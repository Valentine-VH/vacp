import { setTimeout as wait } from 'node:timers/promises'

const base = process.env.VACP_URL ?? 'http://127.0.0.1:3320'
const token = process.env.VACP_NODE_TOKEN
if (!token) throw new Error('Configure VACP_NODE_TOKEN before starting the Mock Connector')

async function post(path, body) {
  const response = await fetch(new URL('/api/v1/mock-node/' + path, base), {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, ...(body && { 'Content-Type': 'application/json' }) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  })
  if (response.status === 401) throw new Error('Invalid node credential')
  if (response.status === 409 && path.endsWith('/complete')) return null
  if (!response.ok) throw new Error('Server returned HTTP ' + response.status)
  return response.json()
}

console.log('Mock Connector started')
while (true) {
  try {
    const { task } = await post('poll')
    if (task) {
      const result = await post('tasks/' + task.id + '/complete', {
        lease: task.lease, result: 'Mock Connector 已收到：' + task.input,
      })
      if (result) console.log('Completed task ' + task.id)
    }
  } catch (error) {
    if (error.message === 'Invalid node credential') throw error
    console.error(error.message)
  }
  await wait(1500)
}
