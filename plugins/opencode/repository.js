import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import manifest from './package.json' with { type: 'json' }

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const authPath = '/api/v1/agent-plugin-auth/account'

export function repositoryClient(address = 'http://127.0.0.1:5176') {
  const server = new URL(address)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(server.hostname)
  if ((server.protocol !== 'https:' && !(server.protocol === 'http:' && loopback)) ||
    server.username || server.password || server.pathname !== '/' || server.search || server.hash) {
    throw new Error('VACP_URL must be an HTTPS origin, or loopback HTTP for development.')
  }

  async function send(path, { token, method = 'GET', body, signal, raw } = {}) {
    const headers = new Headers()
    if (body) headers.set('Content-Type', 'application/json')
    if (token) headers.set('Authorization', 'Bearer ' + token)
    const timeout = AbortSignal.timeout(30000)
    const response = await fetch(new URL(authPath + path, server), {
      method, headers, redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      body: body && JSON.stringify(body),
    })
    if (!response.ok) throw new Error('VACP request failed (HTTP ' + response.status + ').')
    if (raw) return response
    if (response.status !== 204) return response.json()
  }

  function scope(workspace) {
    if (!uuid.test(workspace ?? '')) throw new Error('Set VACP_WORKSPACE_ID to a workspace ID.')
    return '/workspaces/' + workspace + '/plugins'
  }

  return {
    async login(email, password) {
      const version = manifest.version
      const login = await send('/login', { method:'POST', body:{ email,password,plugin:'opencode',device:'OpenCode CLI',version } })
      await send('/instance', { method:'PUT', token:login.accountToken, body:{
        instanceId: randomUUID(), hostName: hostname().trim().slice(0,160) || '未知主机', version,
      } }).catch(() => {})
      return login
    },
    logout: token => send('/session',{ method:'DELETE',token }),
    workspaces: token => send('/workspaces',{ token }),
    list: (workspace,token,signal) => send(scope(workspace),{ token,signal }),
    listSources: (workspace,token,signal) => send(scope(workspace)+'/sources',{ token,signal }),
    download: (workspace,token,id,version) => send(scope(workspace)+'/'+encodeURIComponent(id)+'/versions/'+encodeURIComponent(version)+'/download',{ token,raw:true }),
  }
}
