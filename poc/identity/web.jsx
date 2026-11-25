import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import './web.css'

async function api(path, { method = 'GET', body, token } = {}) {
  const headers = {}
  if (body) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = 'Bearer ' + token
  const response = await fetch('/api/v1/' + path, { method, headers, body: JSON.stringify(body) })
  if (!response.ok) throw Error('请求失败 · HTTP ' + response.status)
  return response.json()
}

function App() {
  const [token, setToken] = useState('')
  const [spaces, setSpaces] = useState([])
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  async function run(action) {
    setBusy(true)
    setStatus('')
    try { await action() }
    catch (error) { setStatus(error.message) }
    finally { setBusy(false) }
  }

  return <main>
    <header>VACP</header>
    <h1>工作空间权限</h1>
    <button disabled={busy} onClick={() => run(async () => {
      const { uid, password } = await api('demo', { method: 'POST' })
      const { token: nextToken } = await api('login', { method: 'POST', body: { uid, password } })
      setSpaces(await api('workspaces', { token: nextToken }))
      setToken(nextToken)
    })}>创建并登录演示账户</button>
    <p role="status">{status}</p>
    {spaces.map(space => <section key={space.id}>
      <h2>{space.name}</h2><p>角色 · {space.role}</p>
      {space.permissions.includes('workspace:rename') && <form onSubmit={event => {
        event.preventDefault()
        const name = new FormData(event.currentTarget).get('name')
        run(async () => {
          await api('workspaces/' + space.id, { method: 'PATCH', token, body: { name } })
          setSpaces(await api('workspaces', { token }))
          setStatus('名称已保存')
        })
      }}>
        <label>工作空间名称 <input name="name" defaultValue={space.name} maxLength={80} required /></label>
        <button disabled={busy}>保存</button>
      </form>}
    </section>)}
  </main>
}
createRoot(document.getElementById('root')).render(<App />)
