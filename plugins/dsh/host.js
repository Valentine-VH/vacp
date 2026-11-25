import { createVacpClient } from './account-client.js'
import { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { pipeline } from 'node:stream/promises'
import { createWorkspaceModels } from './models.js'
import { mountRemoteConversations } from './remote-conversations.js'
import { createPluginUpdate } from './plugin-update.js'
import manifest from './package.json' with { type: 'json' }

export const name = 'vacp-account'
export const inject = ['webServer', 'credentials', 'llm', 'profileContext', 'pluginPackages']

const credential = 'vacp-account/default'
const path = '/api/vacp-plugin/account'
const instance = { instanceId: randomUUID(), hostName: hostname().trim().slice(0,160) || '未知主机', version: manifest.version }

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(data))
}

async function readJson(req, limit) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw new Error('invalid input')
  const chunks = []
  let size = 0
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > limit) throw new Error('invalid input')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function readLogin(req) {
  const value = await readJson(req, 4096)
  const { address, email, password } = value ?? {}
  if (typeof address !== 'string' || !address.trim() || address.length > 1000 ||
      typeof email !== 'string' || !email.trim() || email.length > 254 ||
      typeof password !== 'string' || !password || password.length > 128) throw new Error('invalid input')
  return { address: address.trim(), email: email.trim(), password }
}

function accountView(account, workspaces, remoteConversations) {
  return {
    account: { email: account.email, address: account.address },
    instanceId: instance.instanceId,
    remoteConversations,
    workspaces: workspaces.map(({ id, name, role, models }) => ({ id, name, role, models: models ?? [] })),
  }
}

export async function apply(ctx) {
  const providers = await createWorkspaceModels(ctx)
  const pluginUpdate = createPluginUpdate(ctx)
  let queue = Promise.resolve()
  let disposed = false
  function run(operation) {
    const result = queue.then(() => { if (!disposed) return operation() })
    queue = result.catch(() => {})
    return result
  }
  let remote
  async function readAccount() {
    const record = await ctx.credentials.readRecord(credential)
    return record?.kind === 'grant' && !record.payload.logoutPending ? record.payload : null
  }
  async function finishLogout(account) {
    try { await createVacpClient(account.address).logout(account.token) }
    catch (error) { if (error?.status !== 401) return false }
    await ctx.credentials.deleteRecord(credential)
    return true
  }
  async function maintainAccount() {
    const record = await ctx.credentials.readRecord(credential)
    if (record?.kind !== 'grant') return
    if (record.payload.logoutPending) await finishLogout(record.payload)
    else report(record.payload)
  }
  async function sync(account, workspaces) {
    if (disposed) return
    providers.sync(account, workspaces)
    report(account)
    await remote?.sync(account, workspaces)
  }

  let reporting = false
  function report(account) {
    if (!account || disposed || reporting) return
    reporting = true
    void createVacpClient(account.address).reportInstance(account.token, instance)
      .catch(() => {}).finally(() => { reporting = false })
  }

  ctx.effect(() => {
    const timer = setInterval(() => { void run(maintainAccount).catch(() => {}) }, 60_000)
    timer.unref()
    return () => { clearInterval(timer); disposed = true; providers.dispose() }
  })
  if (process.env.VACP_DSH_REMOTE_CONVERSATIONS === '1') {
    ctx.inject(['sessionController', 'workspaceRegistry', 'fileUploads'], remoteCtx => {
      const bridge = mountRemoteConversations(remoteCtx, readAccount, run, instance)
      remote = bridge
      void run(async () => {
        const account = await readAccount()
        if (account && remote === bridge) {
          await bridge.sync(account, await createVacpClient(account.address).listWorkspaces(account.token))
        }
      }).catch(() => {})
      remoteCtx.effect(() => () => { bridge.close(); if (remote === bridge) remote = undefined })
    })
  }
  void run(async () => {
    const account = await readAccount()
    if (account) {
      const workspaces = await createVacpClient(account.address).listWorkspaces(account.token)
      await sync(account, workspaces)
    } else await maintainAccount()
  }).catch(() => {})

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/api/vacp-plugin/models', auth: 'required',
    async handler(req, res, peer) {
      if (peer?.principal.kind !== 'owner') return send(res, 403, { message: '仅 DSH 所有者可配置模型。' })
      if (req.method !== 'POST') return send(res, 405, { message: '请求方式无效。' })
      if (req.headers['x-vacp-account-action'] !== '1') return send(res, 403, { message: '请求来源无效。' })
      const id = new URL(req.url, 'http://localhost').searchParams.get('workspace')
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id ?? '')) {
        return send(res, 400, { message: '请选择有效的工作空间。' })
      }
      let body
      try { body = await readJson(req, 16384) }
      catch { return send(res, 400, { message: '模型配置格式无效。' }) }
      return run(async () => {
        try {
          const account = await readAccount()
          if (!account) return send(res, 401, { message: '请先登录 VACP。' })
          const client = createVacpClient(account.address)
          const route = await client.addWorkspaceModel(account.token, id, body)
          try {
            const workspaces = await client.listWorkspaces(account.token)
            await sync(account, workspaces)
            return send(res, 201, { ...route, ...accountView(account, workspaces, Boolean(remote)) })
          } catch {
            return send(res, 201, { ...route, message: '模型已保存到 VACP，请点击「同步模型」刷新。' })
          }
        } catch (error) {
          if ([400, 401, 403, 409].includes(error?.status)) return send(res, error.status, { message: error.message })
          return send(res, 502, { message: '无法确认配置结果，请先同步模型再重试。' })
        }
      })
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/api/vacp-plugin/update', auth: 'required',
    async handler(req, res, peer) {
      if (peer?.principal.kind !== 'owner') return send(res, 403, { message: '仅 DSH 所有者可更新 VACP 插件。' })
      if (!['GET', 'POST'].includes(req.method)) return send(res, 405, { message: '请求方式无效。' })
      const workspace = new URL(req.url, 'http://localhost').searchParams.get('workspace')
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(workspace ?? '')) {
        return send(res, 400, { message: '请选择有效的工作空间。' })
      }
      let selection
      if (req.method === 'POST') {
        if (req.headers['x-vacp-account-action'] !== '1') return send(res, 403, { message: '请求来源无效。' })
        try { selection = await readJson(req, 1024) }
        catch { return send(res, 400, { message: '版本信息无效，请重新检测。' }) }
      }
      return run(async () => {
        try {
          const account = await readAccount()
          if (!account) return send(res, 401, { message: '请先登录 VACP。' })
          const result = req.method === 'GET' ? await pluginUpdate.check(account, workspace)
            : await pluginUpdate.install(account, workspace, selection)
          return send(res, 200, result)
        } catch (error) {
          if (error?.status === 401) return send(res, 401, { message: 'VACP 登录已过期，请重新登录。' })
          if (error?.status === 404) return send(res, 404, { message: '工作空间、插件仓库或所选版本不可用。' })
          if (error?.status === 409) return send(res, 409, { message: error.message })
          ctx.logger.warn('VACP plugin update failed', error)
          return send(res, 502, { message: req.method === 'GET' ? '无法检测版本，请检查 VACP 连接后重试。'
            : '更新失败。请重新检测已安装版本，或在 DSH「插件」中查看安装记录。' })
        }
      })
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/api/vacp-plugin/repository', auth: 'required',
    async handler(req, res, peer) {
      if (peer?.principal.kind !== 'owner') return send(res, 403, { message: '仅 DSH 所有者可访问插件仓库。' })
      if (req.method !== 'GET') return send(res, 405, { message: '请求方式无效。' })
      const query = new URL(req.url, 'http://localhost').searchParams
      const workspace = query.get('workspace')
      const id = query.get('id')
      const version = query.get('version')
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(workspace ?? '') ||
          ((id !== null || version !== null) &&
            (!['dsh', 'opencode'].includes(id) || !/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(version ?? '')))) {
        return send(res, 400, { message: '请选择有效的工作空间和插件版本。' })
      }
      try {
        const account = await readAccount()
        if (!account) return send(res, 401, { message: '请先登录 VACP。' })
        const {address, token} = account
        const client = createVacpClient(address)
        if (!id) return send(res, 200, await client.listPluginSources(token, workspace))
        const upstream = await client.fetchPlugin(token,workspace,id,version)
        if (!upstream.body || upstream.headers.get('content-type') !== 'application/gzip') {
          await upstream.body?.cancel()
          return send(res, 502, { message: 'VACP 未返回有效的插件安装包。' })
        }
        res.writeHead(200, {
          'Content-Type': 'application/gzip',
          'Cache-Control': 'private, no-store',
          'Content-Disposition': `attachment; filename="vacp-plugin-${id}-${version}.tgz"`,
        })
        await pipeline(Readable.fromWeb(upstream.body),res)
      } catch (error) {
        if (res.headersSent || res.destroyed) { res.destroy(); return }
        const status = [401, 404].includes(error?.status) ? error.status : 502
        return send(res, status, { message: status === 401 ? 'VACP 登录已过期，请重新登录。' : '无法读取该插件或仓库。' })
      }
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/api/vacp-plugin/resources', auth: 'required',
    async handler(req, res, peer) {
      if (peer?.principal.kind !== 'owner') return send(res, 403, { message: '仅 DSH 所有者可查看 VACP 资源。' })
      if (req.method !== 'GET') return send(res, 405, { message: '请求方式无效。' })
      const id = new URL(req.url, 'http://localhost').searchParams.get('workspace')
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id ?? '')) {
        return send(res, 400, { message: '请选择工作空间。' })
      }
      try {
        const account = await readAccount()
        if (!account) return send(res, 401, { message: '请先登录 VACP。' })
        const { address, token } = account
        return send(res, 200, await createVacpClient(address).listWorkspaceResources(token, id))
      } catch (error) {
        if (error?.status === 401) return send(res, 401, { message: 'VACP 登录已过期，请重新登录。' })
        if (error?.status === 404) return send(res, 404, { message: '该工作空间不可用或当前 VACP 尚未提供资源目录。' })
        return send(res, 502, { message: '无法读取 VACP 资源目录，请重试。' })
      }
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path, auth: 'required',
    async handler(req, res, peer) {
      if (peer?.principal.kind !== 'owner') return send(res, 403, { message: '仅 DSH 所有者可管理 VACP 账号。' })
      if (!['GET', 'POST', 'DELETE'].includes(req.method)) return send(res, 405, { message: '请求方式无效。' })
      const mutation = req.method !== 'GET'
      if (mutation && req.headers['x-vacp-account-action'] !== '1') return send(res, 403, { message: '请求来源无效。' })
      let loginInput
      if (req.method === 'POST') {
        try {
          loginInput = await readLogin(req)
          createVacpClient(loginInput.address)
        } catch {
          return send(res, 400, { message: '请填写有效的 VACP 服务地址、邮箱和密码。远程地址须使用 HTTPS。' })
        }
      }

      return run(async () => {
      try {
        const saved = await ctx.credentials.readRecord(credential)
        const grant = saved?.kind === 'grant' ? saved.payload : null
        const account = grant?.logoutPending ? null : grant
        if (req.method === 'GET') {
          if (!account) {
            await sync(undefined)
            return send(res, 200, { account: null, workspaces: [],
              ...(grant?.logoutPending ? {message: '已退出本机，恢复连接后会撤销服务端凭据。'} : {}) })
          }
          try {
            const workspaces = await createVacpClient(account.address).listWorkspaces(account.token)
            await sync(account, workspaces)
            return send(res, 200, accountView(account, workspaces, Boolean(remote)))
          } catch (error) {
            if (error?.status !== 401) throw error
            await sync(undefined)
            return send(res, 200, { account: null, workspaces: [], message: '登录已过期，请重新登录。' })
          }
        }

        if (req.method === 'DELETE') {
          if (account) await ctx.credentials.modifyRecord(credential, async () => ({
            kind: 'grant', payload: { ...account, logoutPending: true },
          }))
          await sync(undefined)
          const revoked = !grant || await finishLogout(grant)
          return send(res, 200, { account: null, workspaces: [],
            message: revoked ? '已退出 VACP，工作空间模型已关闭。' : '已退出本机，恢复连接后会撤销服务端凭据。' })
        }

        if (grant?.logoutPending && !await finishLogout(grant)) {
          return send(res, 503, { message: '上一次退出的服务端凭据仍待撤销，请恢复连接后重试。' })
        }
        const input = loginInput
        const client = createVacpClient(input.address)
        if (account) {
          try {
            await createVacpClient(account.address).listWorkspaces(account.token)
            return send(res, 409, { message: '请先退出当前 VACP 账号。' })
          } catch (error) {
            if (error?.status !== 401) throw error
          }
        }
        const login = await client.login({ ...input, device: 'DSH Desktop', version: manifest.version })
        const entry = { address: input.address, email: login.user.email, token: login.accountToken }
        try {
          const workspaces = await client.listWorkspaces(entry.token)
          await ctx.credentials.modifyRecord(credential, async () => ({ kind: 'grant', payload: entry }))
          await sync(entry, workspaces)
          return send(res, 200, accountView(entry, workspaces, Boolean(remote)))
        } catch (error) {
          await sync(undefined)
          await client.logout(entry.token).catch(() => {})
          throw error
        }
      } catch (error) {
        const message = error?.status === 401 ? '邮箱或密码不正确。' : '无法连接 VACP 或保存登录状态，请检查服务地址后重试。'
        return send(res, error?.status === 401 ? 401 : 502, { message })
      }
      })
    },
  }))
}
