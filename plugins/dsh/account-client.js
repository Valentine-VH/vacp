const authPath = '/api/v1/agent-plugin-auth'

export function createVacpClient(serverAddress) {
  const server = new URL(serverAddress)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(server.hostname)
  if ((server.protocol !== 'https:' && !(server.protocol === 'http:' && loopback)) ||
      server.username || server.password || server.search || server.hash || server.pathname !== '/') {
    throw new Error('请输入 VACP 的 HTTPS 服务地址，本机开发可使用回环 HTTP')
  }

  async function send(path, { method = 'GET', token, body, raw = false } = {}) {
    const headers = new Headers()
    if (token) headers.set('Authorization', 'Bearer ' + token)
    if (body !== undefined) headers.set('Content-Type', 'application/json')
    const response = await fetch(new URL(authPath + path, server), {
      method, headers, redirect: 'error', signal: AbortSignal.timeout(15000),
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok) {
      const details = await response.json().catch(() => null)
      throw Object.assign(new Error(details?.message ?? 'VACP 请求失败'), { status: response.status })
    }
    if (raw) return response
    if (response.status !== 204) return response.json()
  }

  return {
    login: ({ email, password, device, version }) =>
      send('/account/login', { method: 'POST', body: { email, password, device, version, plugin: 'dsh' } }),
    listWorkspaces: accountToken => send('/account/workspaces', { token: accountToken }),
    reportInstance: (accountToken, body) => send('/account/instance', { method: 'PUT', token: accountToken, body }),
    addWorkspaceModel: (accountToken, workspaceId, body) => send(
      '/account/workspaces/' + encodeURIComponent(workspaceId) + '/model-gateway/routes',
      { method: 'POST', token: accountToken, body }),
    listWorkspaceResources: (accountToken, workspaceId) =>
      send('/account/workspaces/' + encodeURIComponent(workspaceId) + '/resources', { token: accountToken }),
    listPlugins: (accountToken, workspaceId) =>
      send('/account/workspaces/' + encodeURIComponent(workspaceId) + '/plugins', { token: accountToken }),
    listPluginSources: (accountToken, workspaceId) =>
      send('/account/workspaces/' + encodeURIComponent(workspaceId) + '/plugins/sources', { token: accountToken }),
    fetchPlugin: (accountToken, workspaceId, id, version) => send(
      '/account/workspaces/' + encodeURIComponent(workspaceId) + '/plugins/' + encodeURIComponent(id)
      + '/versions/' + encodeURIComponent(version) + '/download', { token: accountToken, raw: true }),
    connectWorkspace: (accountToken, workspaceId) => send('/account/workspaces/' + encodeURIComponent(workspaceId) + '/session',
      { method: 'POST', token: accountToken }),
    listResources: accessToken => send('/config', { token: accessToken }),
    issueModelKey: (accessToken, model) => send('/model-key', { method: 'POST', token: accessToken, body: { model } }),
    getSkill: (accessToken, id) => send('/skills/' + encodeURIComponent(id), { token: accessToken }),
    logout: accountToken => send('/account/session', { method: 'DELETE', token: accountToken }),
  }
}
