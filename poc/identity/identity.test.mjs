import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from './server.mjs'

test('login, scoped listing and server-side authorization', async t => {
  const app = createServer()
  t.after(() => app.close())
  const call = (method, path, payload, token) => app.inject({
    method, url: '/api/v1/' + path, payload,
    headers: token ? { authorization: 'Bearer ' + token } : {},
  })
  assert.equal((await call('GET', 'workspaces')).statusCode, 401)
  const { uid, password, privateSpace } = (await call('POST', 'demo')).json()
  assert.equal((await call('POST', 'login', { uid, password: 'wrong' })).statusCode, 401)
  const { token } = (await call('POST', 'login', { uid, password })).json()
  const list = (await call('GET', 'workspaces', undefined, token)).json()
  assert.equal(list.length, 2)
  const rename = id => call('PATCH', 'workspaces/' + id, { name: '测试名称' }, token)
  assert.equal((await rename(list.find(space => space.role === 'viewer').id)).statusCode, 403)
  assert.equal((await rename(privateSpace)).statusCode, 404)
  assert.equal((await rename(list.find(space => space.role === 'owner').id)).statusCode, 200)
  assert.ok((await call('GET', 'workspaces', undefined, token)).json().some(space => space.name === '测试名称'))
})
