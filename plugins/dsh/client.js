window.__ModuleLoader__.load({
  id: '@vacp/plugin-dsh',
  factory(require) {
    const { createElement: h, Fragment, useEffect, useState } = require('react')
    const { Button, Input, IconLinkOutlineRegular } = require('@deepseek-ai/dsh-client-ui-primitives')
    const path = '/api/vacp-plugin/account'
    const panelId = 'vacp-account'

    async function request(method, body, signal, url = path) {
      const options = {
        method, signal,
        headers: { 'Content-Type': 'application/json', 'X-VACP-Account-Action': '1' },
        body: body && JSON.stringify(body),
      }
      let response
      const attempts = method === 'GET' ? 3 : 1
      for (let attempt = 0; attempt < attempts; attempt++) {
        signal?.throwIfAborted()
        response = await fetch(url, options).catch(() => null)
        if (response && ![404, 503].includes(response.status)) break
        if (attempt + 1 < attempts) {
          await response?.body?.cancel()
          await new Promise(resolve => setTimeout(resolve, 180))
        }
      }
      if (!response) throw new Error('无法连接 DSH 插件，请重试。')
      const data = await response.json().catch(() => null)
      if (!response.ok || !data) throw new Error(data?.message ?? '无法访问 VACP 插件。')
      return data
    }

    const authLabels = { none: '无需认证', bearer: 'Bearer 认证', header: '自定义 Header 认证' }

    async function savePlugin(url, release) {
      const response = await fetch(url)
      if (!response.ok) throw new Error('下载安装包失败，请刷新仓库后重试。')
      const blob = await response.blob()
      const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
      const hex = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
      if (blob.size !== release.bytes || hex !== release.sha256) throw new Error('安装包校验失败，请刷新仓库后重试。')
      const objectUrl = URL.createObjectURL(blob)
      if (window.dshDesktop?.fileActions) {
        try {
          return await window.dshDesktop.fileActions.save({ url: objectUrl, name: release.filename,
            mediaType: 'application/gzip', mode: 'download' })
        } finally { URL.revokeObjectURL(objectUrl) }
      }
      const anchor = document.createElement('a')
      anchor.href = objectUrl
      anchor.download = release.filename
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(objectUrl), 30000)
      return { status: 'requested' }
    }

    function WorkspaceResources({ workspaces, kind }) {
      const [selection, setSelection] = useState('')
      const [result, setResult] = useState()
      const [revision, setRevision] = useState(0)
      const workspace = workspaces.find(entry => entry.id === selection) ?? workspaces[0]
      const workspaceId = workspace?.id
      const active = result?.workspaceId === workspaceId && result?.revision === revision ? result : null

      useEffect(() => {
        if (!workspaceId) return
        const controller = new AbortController()
        const repository = kind === 'plugins'
        const url = (repository ? '/api/vacp-plugin/repository' : '/api/vacp-plugin/resources')
          + '?workspace=' + encodeURIComponent(workspaceId)
        void request('GET', undefined, controller.signal, url).then(data => {
          if (!controller.signal.aborted) setResult({ workspaceId, revision, repository, data })
        }).catch(error => {
          if (!controller.signal.aborted) setResult({ workspaceId, revision, repository, error: error.message })
        })
        return () => controller.abort()
      }, [workspaceId, revision, kind === 'plugins'])

      if (!workspace) return h('p', { className: 'vacp-card vacp-muted' }, '此账号暂时没有可用的工作空间。')
      const skills = kind === 'skills'
      const repository = kind === 'plugins'
      const visible = active?.repository === repository ? active : null
      const items = visible?.data?.[kind]
      const label = repository ? '插件仓库' : skills ? 'Skill 仓库' : 'MCP 仓库'
      return h('section', { className: 'vacp-resource-list', 'aria-label': label },
        h('div', { className: 'vacp-resource-toolbar' },
          h('label', { className: 'vacp-field' },
            h('span', null, '工作空间'),
            h('select', { value: workspaceId, onChange: event => setSelection(event.target.value) },
              workspaces.map(entry => h('option', { key: entry.id, value: entry.id }, entry.name)))),
          h(Button, { variant: 'outline', disabled: !visible, onClick: () => setRevision(value => value + 1) }, '刷新资源')),
        !visible ? h('p', { role: 'status', className: 'vacp-muted' }, '正在加载资源…')
          : visible.error ? h('p', { role: 'alert', className: 'vacp-notice' }, visible.error)
            : repository ? (visible.data.length ? h('ul', { className: 'vacp-workspaces' }, visible.data.map(plugin =>
              h('li', { key: plugin.host + '/' + plugin.id },
                h('div', { className: 'vacp-workspace-name' },
                  h('a', { href: 'https://github.com/' + plugin.fullName.split('/').map(encodeURIComponent).join('/'),
                    target: '_blank', rel: 'noopener noreferrer' }, plugin.fullName),
                  plugin.description && h('p', { className: 'vacp-muted' }, plugin.description)),
                h('span', { className: 'vacp-role' }, plugin.host === 'dsh' ? 'DSH' : 'OpenCode'))))
              : h('p', { className: 'vacp-card vacp-muted' }, '该工作空间暂无第三方插件。'))
            : items.length ? h('ul', { className: 'vacp-workspaces' }, items.map(item =>
              h('li', { key: item.id },
                h('div', { className: 'vacp-workspace-name' },
                  h('strong', null, item.name),
                  skills && h('span', { className: 'vacp-role' }, ' · ' + item.version),
                  skills && item.description && h('p', { className: 'vacp-muted' }, item.description)),
                h('span', { className: 'vacp-role' }, skills
                  ? item.installed ? '已安装' : '已发布'
                  : authLabels[item.auth] ?? '已启用'))))
              : h('p', { className: 'vacp-card vacp-muted' }, skills ? '该空间暂无已审核的 Skill。' : '该空间暂无已启用的 MCP 服务。'))
    }

    function PluginUpdate({ workspaces, address, onAvailable }) {
      const [selection, setSelection] = useState('')
      const [revision, setRevision] = useState(0)
      const [check, setCheck] = useState()
      const [action, setAction] = useState()
      const workspace = workspaces.find(item => item.id === selection) ?? workspaces[0]
      const id = workspace?.id
      const url = '/api/vacp-plugin/update?workspace=' + encodeURIComponent(id ?? '')
      const current = check?.id === id && check?.revision === revision ? check : null
      const status = current?.data
      const message = action?.id === id ? action : null

      useEffect(() => { onAvailable(Boolean(status?.available && !status.restartRequired)) }, [onAvailable, status])

      useEffect(() => {
        if (!id) return
        const abort = new AbortController()
        void request('GET', undefined, abort.signal, url).then(data => {
          if (!abort.signal.aborted) setCheck({ id, revision, data })
        }).catch(error => {
          if (!abort.signal.aborted) setCheck({ id, revision, error: error.message })
        })
        return () => abort.abort()
      }, [id, url, revision])

      async function update() {
        if (!status?.available || status.restartRequired || message?.busy) return
        setAction({ id, busy: true })
        try {
          if (status.canInstall) {
            const installed = await request('POST', { version: status.latest.version, sha256: status.latest.sha256 }, undefined, url)
            setAction({ id, text: installed.restartRequired ? '已安装 ' + installed.installed + '，重启 DSH 后生效。'
              : '已更新至 ' + installed.installed + '。' })
            setRevision(value => value + 1)
          } else {
            const href = '/api/vacp-plugin/repository?' + new URLSearchParams({
              workspace: id, id: 'dsh', version: status.latest.version,
            })
            const result = await savePlugin(href, status.latest)
            setAction({ id, text: result.status === 'cancelled' ? '已取消下载。'
              : '已提交下载。请在 DSH 的「插件」中选择下载的安装包。' })
          }
        } catch (error) { setAction({ id, text: error.message, error: true }) }
      }

      return h('section', { className: 'vacp-resource-list', 'aria-label': '版本更新' },
        h('h2', null, 'VACP DSH 插件'),
        h('p', { className: 'vacp-muted' }, '更新来源 ' + address),
        id ? h('div', { className: 'vacp-resource-toolbar' },
          h('label', { className: 'vacp-field' }, h('span', null, '工作空间'),
            h('select', { value: id, disabled: message?.busy, onChange: event => {
              setSelection(event.target.value)
              setAction(undefined)
            } }, workspaces.map(item => h('option', { key: item.id, value: item.id }, item.name)))),
          h(Button, { variant: 'outline', disabled: message?.busy || !current, onClick: () => {
            setAction(undefined)
            setRevision(value => value + 1)
          } }, '检测更新'))
          : h('p', { className: 'vacp-muted' }, '此账号暂时没有可用的工作空间。'),
        status && h('div', { className: 'vacp-card vacp-resource-list' },
          h('p', null, '当前版本 ', h('code', null, status.current)),
          h('p', null, '仓库最新版本 ', status.latest ? h('code', null, status.latest.version) : '暂无版本'),
          status.restartRequired ? h('p', { role: 'status' }, '已安装 ' + status.installed + '，重启 DSH 后生效。')
            : status.available ? h('div', { className: 'vacp-resource-toolbar' },
              h(Button, { variant: 'primary', disabled: message?.busy, onClick: () => void update() },
                message?.busy ? '正在处理…' : status.canInstall ? '更新至 ' + status.latest.version : '下载安装包'))
              : status.latest && h('p', { role: 'status', className: 'vacp-muted' }, '当前没有可用更新。')),
        id && !current && h('p', { role: 'status', className: 'vacp-muted' }, '正在检测版本…'),
        current?.error && h('p', { role: 'alert', className: 'vacp-notice' }, current.error),
        message?.text && !(status?.restartRequired && !message.error) &&
          h('p', { role: message.error ? 'alert' : 'status', className: message.error ? 'vacp-notice' : 'vacp-muted' }, message.text))
    }

    function ConversationSharing({ workspaces, navigation, instanceId }) {
      const [selected, setSelected] = useState('')
      const [result, setResult] = useState()
      const [error, setError] = useState('')
      const [pending, setPending] = useState(false)
      const [revision, setRevision] = useState(0)
      const [copyStatus, setCopyStatus] = useState('')
      const workspace = workspaces.find(item => item.id === selected) ?? workspaces[0]
      const id = workspace?.id
      const url = '/api/vacp-plugin/conversations?workspace=' + encodeURIComponent(id ?? '')
      useEffect(() => {
        if (!id) return
        const abort = new AbortController()
        async function load() {
          try {
            const data = await request('GET', undefined, abort.signal, url)
            if (!abort.signal.aborted) { setResult({ id, ...data }); setError('') }
          } catch (cause) {
            if (!abort.signal.aborted) setError(cause.message)
          }
        }
        setError('')
        void load()
        return () => abort.abort()
      }, [id, revision])
      async function change(entry) {
        setPending(true)
        setError('')
        try {
          const data = await request(entry.shared ? 'DELETE' : 'POST', undefined, undefined,
            url + '&session=' + encodeURIComponent(entry.id))
          setResult({ id, ...data })
        } catch (cause) { setError(cause.message) }
        finally { setPending(false) }
      }
      const current = result?.id === id ? result : null
      const instanceView = instanceId && h('div', { className: 'vacp-instance' },
        h('span', { className: 'vacp-muted' }, '实例识别号'),
        h('code', null, instanceId),
        h(Button, { variant: 'ghost', size: 'sm', async onClick() {
          try {
            await navigator.clipboard.writeText(instanceId)
            setCopyStatus('已复制')
          } catch { setCopyStatus('请选择识别号手动复制。') }
        } }, '复制识别号'),
        copyStatus && h('span', { role: 'status', className: 'vacp-muted' }, copyStatus))
      return h('section', { className: 'vacp-resource-list', 'aria-label': 'Chat 授权' },
        instanceView,
        !id ? h('p', { className: 'vacp-muted' }, '此账号暂时没有可用的工作空间。') : h(Fragment, null,
        h('p', { className: 'vacp-muted' }, '授权后，可用同一 VACP 账号在所选工作空间的 Chat 中继续对话。'),
        h('label', { className: 'vacp-field' }, h('span', null, '工作空间'),
          h('select', { value: id, disabled: pending, onChange: event => setSelected(event.target.value) },
            workspaces.map(item => h('option', { key: item.id, value: item.id }, item.name)))),
        h('div', { className: 'vacp-resource-toolbar' },
          h(Button, { variant: 'outline', disabled: pending, onClick: () => setRevision(value => value + 1) }, '刷新会话'),
          h(Button, { variant: 'ghost', onClick: () => navigation.startSession() }, '新建 DSH 会话')),
        error && h('p', { role: 'alert', className: 'vacp-notice' }, error),
        current?.sessions.length ? h('ul', { className: 'vacp-workspaces' }, current.sessions.map(entry =>
          h('li', { key: entry.id }, h('div', { className: 'vacp-workspace-name' },
            h('strong', { title: entry.id }, entry.title),
            entry.shared && h('p', { className: 'vacp-muted' }, '已授权给当前工作空间')),
            h(Button, { variant: 'ghost', disabled: !entry.available, onClick: () => navigation.openSession(entry.id) }, '打开原会话'),
            h(Button, { variant: 'outline', disabled: pending, onClick: () => change(entry) }, entry.shared ? '撤销授权' : '授权给 Chat'))))
          : h('p', { className: 'vacp-muted' }, current ? '此实例暂无可授权的会话。新建 DSH 会话，选择可用模型并发送一条消息，然后回到这里授权。' : error ? '' : '正在加载会话…')))
    }

    function WorkspaceModels({ workspaces, navigation, syncing, refresh, updated }) {
      const [selected, setSelected] = useState('')
      const [editing, setEditing] = useState(false)
      const [saving, setSaving] = useState(false)
      const [notice, setNotice] = useState('')
      const [error, setError] = useState('')
      const workspace = workspaces.find(item => item.id === selected) ?? workspaces[0]
      if (!workspace) return h('p', { className: 'vacp-card vacp-muted' }, '此账号暂时没有可用的工作空间。')
      const canManage = ['owner', 'admin'].includes(workspace.role)
      async function save(event) {
        event.preventDefault()
        const form = event.currentTarget
        const body = Object.fromEntries(new FormData(form))
        form.elements.upstreamKey.value = ''
        setSaving(true)
        setError('')
        setNotice('')
        try {
          const result = await request('POST', body, undefined,
            '/api/vacp-plugin/models?workspace=' + encodeURIComponent(workspace.id))
          if (result.workspaces) updated(result)
          setEditing(false)
          setNotice(result.message ?? ('已添加 ' + result.alias + '。请在 DSH 模型选择器中选择它。'))
        } catch (error) { setError(error.message) }
        finally { setSaving(false) }
      }
      const modelField = (label, props) => h('label', { className: 'vacp-field' },
        h('span', null, label), h(Input, { required: true, ...props }))
      return h('section', { className: 'vacp-resource-list', 'aria-label': '工作空间模型' },
        h('div', { className: 'vacp-section-heading' },
          h('h2', null, '工作空间模型'),
          h(Button, { variant: 'ghost', size: 'sm', disabled: saving || syncing, onClick: refresh }, '同步模型')),
        h('label', { className: 'vacp-field' },
          h('span', null, '工作空间'),
          h('select', { value: workspace.id, disabled: saving, onChange: event => {
            setSelected(event.target.value); setEditing(false); setNotice(''); setError('')
          } }, workspaces.map(item => h('option', { key: item.id, value: item.id }, item.name)))),
        h('p', { className: 'vacp-muted' }, '从 DSH 模型选择器的「VACP · ' + workspace.name + '」分组使用这些模型，请求经 VACP 网关转发。'),
        workspace.models.length ? h('ul', { className: 'vacp-workspaces' }, workspace.models.map(model =>
          h('li', { key: model }, h('strong', { className: 'vacp-workspace-name' }, model))))
          : h('p', { className: 'vacp-muted' }, canManage ? '当前工作空间还没有启用的模型。' : '当前工作空间还没有启用的模型，请联系空间管理员添加。'),
        h('div', { className: 'vacp-resource-toolbar' },
          canManage && !editing && h(Button, { variant: 'primary', disabled: syncing, onClick: () => { setEditing(true); setNotice('') } }, '添加网关模型'),
          workspace.models.length > 0 && h(Button, { variant: 'outline', disabled: saving, onClick: () => navigation.startSession() }, '新建 DSH 会话')),
        notice && h('p', { role: 'status', className: 'vacp-muted' }, notice),
        error && h('p', { role: 'alert', className: 'vacp-notice' }, error),
        canManage && editing && h('form', { key: workspace.id, className: 'vacp-card vacp-form', onSubmit: save },
          h('fieldset', { disabled: saving },
            modelField('网关模型别名', { name: 'alias', placeholder: 'team-chat', maxLength: 80 }),
            modelField('上游 Base URL', { name: 'baseUrl', type: 'url', placeholder: 'https://api.deepseek.com/v1', maxLength: 1000 }),
            modelField('上游模型名', { name: 'upstreamModel', placeholder: '填写上游提供的模型 ID', maxLength: 200 }),
            modelField('上游 API Key（可选）', { name: 'upstreamKey', type: 'password', required: false, autoComplete: 'new-password', maxLength: 4096 }),
            h('p', { className: 'vacp-muted' }, '支持公网 HTTP / HTTPS 和查询参数。使用 URL Basic 认证时，API Key 留空。'),
            h('div', { className: 'vacp-resource-toolbar' },
              h(Button, { variant: 'primary', type: 'submit' }, saving ? '正在保存…' : '保存到 VACP'),
              h(Button, { variant: 'ghost', type: 'button', onClick: () => { setEditing(false); setError('') } }, '取消')))))
    }

    function AccountPage({ panel = false, navigation }) {
      const [state, setState] = useState()
      const [busy, setBusy] = useState(true)
      const [message, setMessage] = useState('')
      const [section, setSection] = useState('models')
      const [updateAvailable, setUpdateAvailable] = useState(false)

      function load(signal) {
        setBusy(true)
        setMessage('')
        void request('GET', undefined, signal).then(data => {
          setState(data)
          setMessage(data.message ?? '')
        }).catch(error => {
          if (!signal?.aborted) setMessage(error.message)
        }).finally(() => { if (!signal?.aborted) setBusy(false) })
      }

      useEffect(() => {
        const controller = new AbortController()
        load(controller.signal)
        return () => controller.abort()
      }, [])

      async function change(method, body) {
        setBusy(true)
        setMessage('')
        try {
          const data = await request(method, body)
          setState(data)
          setMessage(data.message ?? '')
          setUpdateAvailable(false)
          setSection('models')
        }
        catch (error) { setMessage(error.message) }
        finally { setBusy(false) }
      }

      const messageView = message && h('p', { className: 'vacp-notice', role: 'status' }, message)
      const field = (label, props) => h('label', { className: 'vacp-field' },
        h('span', null, label), h(Input, { required: true, ...props }))

      let content
      if (!state) {
        content = h('div', { className: 'vacp-card' }, messageView,
          busy ? h('p', { role: 'status' }, '正在读取登录状态…')
            : h(Button, { variant: 'outline', onClick: () => load() }, '重试'))
      } else if (state.account) {
        content = h('div', { className: 'vacp-account' },
          h('section', { className: 'vacp-card vacp-session', 'aria-label': '当前账号' },
            h('div', null,
              h('span', { className: 'vacp-status' }, '已登录'),
              h('p', { className: 'vacp-email' }, state.account.email),
              h('p', { className: 'vacp-muted' }, state.account.address)),
            h(Button, { variant: 'outline', disabled: busy, onClick: () => change('DELETE') }, '退出 VACP')),
          messageView,
          h('nav', { className: 'vacp-resources-nav', 'aria-label': 'VACP 资源' },
            [['models', '模型'], ['skills', 'Skill 仓库'], ['mcps', 'MCP 仓库'], ['plugins', '插件仓库'],
              ['update', updateAvailable ? '版本更新 · 有新版' : '版本更新'],
              ...(state.remoteConversations ? [['conversations', 'Chat 授权']] : [])].map(([id, label]) =>
              h(Button, { key: id, variant: section === id ? 'outline' : 'ghost',
                'aria-pressed': section === id, onClick: () => setSection(id) }, label))),
          section === 'models' ? h(WorkspaceModels, { workspaces: state.workspaces, navigation,
            syncing: busy, refresh: () => load(), updated: setState })
            : section === 'conversations' ? h(ConversationSharing, { workspaces: state.workspaces, navigation, instanceId: state.instanceId })
              : section !== 'update' && h(WorkspaceResources, { workspaces: state.workspaces, kind: section }),
          h('div', { hidden: section !== 'update' },
            h(PluginUpdate, { workspaces: state.workspaces, address: state.account.address, onAvailable: setUpdateAvailable })))
      } else {
        content = h('form', { className: 'vacp-card vacp-form', onSubmit(event) {
          event.preventDefault()
          const form = event.currentTarget
          const data = new FormData(form)
          form.elements.password.value = ''
          void change('POST', Object.fromEntries(data))
        } },
        h('fieldset', { disabled: busy },
          field('服务地址', { name: 'address', type: 'url', placeholder: 'http://127.0.0.1:5176', autoComplete: 'url' }),
          field('邮箱', { name: 'email', type: 'email', placeholder: 'name@example.com', autoComplete: 'username' }),
          field('密码', { name: 'password', type: 'password', autoComplete: 'current-password' }),
          messageView,
          h(Button, { variant: 'primary', type: 'submit' }, busy ? '正在登录…' : '登录 VACP')))
      }

      return h('section', { className: panel ? 'vacp-page vacp-page-panel' : 'vacp-page' },
        h('div', { className: 'vacp-content' },
          h('header', { className: 'vacp-header' },
            h('span', { className: 'vacp-mark', 'aria-hidden': true }, h(IconLinkOutlineRegular, { size: 24 })),
            h('div', null,
              h('h1', null, 'VACP 账号'),
              h('p', { className: 'vacp-muted' }, '查看工作空间的模型、Skill 和 MCP。'))),
          content))
    }

    return {
      name: 'vacp-account-ui',
      inject: ['slots', 'uiWorkspace'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: panelId,
          order: 40,
          label: () => 'VACP 账号',
        }, () => h(AccountPage, { navigation: ctx.uiWorkspace })))
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: panelId,
        }, () => h(AccountPage, { panel: true, navigation: ctx.uiWorkspace })))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: panelId, order: 20, label: 'VACP',
        }, () => h(IconLinkOutlineRegular, { size: 16, 'aria-hidden': true })))
      },
    }
  },
  meta: () => ({
    stylesheets: {
      'vacp-account.css': { text: () => `
        .vacp-page {
          color: var(--dsw-alias-label-primary);
          font-size: 14px;
          min-width: 0;
        }
        .vacp-page-panel {
          height: 100%;
          box-sizing: border-box;
          overflow: auto;
          padding: clamp(24px, 6vw, 80px) clamp(16px, 5vw, 64px);
        }
        .vacp-content { max-width: 680px; margin-inline: auto; }
        .vacp-header { display: flex; align-items: center; gap: 14px; margin-bottom: 24px; }
        .vacp-mark {
          display: grid; place-items: center; flex: 0 0 44px; height: 44px;
          border-radius: 13px; color: var(--dsw-alias-state-business-primary);
          background: color-mix(in srgb, currentColor 11%, transparent);
        }
        .vacp-header h1 { margin: 0 0 4px; font-size: 25px; line-height: 1.25; font-weight: 650; }
        .vacp-header p, .vacp-card p { margin: 0; }
        .vacp-muted { color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
        .vacp-card {
          padding: 20px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 16px;
          background: var(--dsw-alias-bg-layer-1);
        }
        .vacp-form { max-width: 492px; }
        .vacp-form fieldset { display: grid; gap: 16px; min-width: 0; padding: 0; margin: 0; border: 0; }
        .vacp-field { display: grid; gap: 7px; min-width: 0; font-weight: 550; }
        .vacp-field > span:last-child { height: 38px; font-weight: 400; }
        .vacp-form button { justify-self: start; min-width: 110px; }
        .vacp-notice {
          margin: 0; padding: 10px 12px; border-radius: 8px; color: var(--dsw-alias-state-error-primary);
          background: color-mix(in srgb, currentColor 8%, transparent);
        }
        .vacp-account { display: grid; gap: 20px; }
        .vacp-resources-nav { display: flex; flex-wrap: wrap; gap: 6px; padding-bottom: 10px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
        .vacp-resource-list { display: grid; gap: 12px; }
        .vacp-instance { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
        .vacp-instance code { overflow-wrap: anywhere; user-select: text; }
        .vacp-resource-toolbar { display: flex; align-items: end; gap: 10px; flex-wrap: wrap; }
        .vacp-resource-toolbar label { flex: 1 0 160px; }
        .vacp-resource-toolbar select {
          min-width: 0; height: 36px; padding: 0 9px; border-radius: var(--dsw-radius-md);
          border: 1px solid var(--dsw-alias-border-l4);
          background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit;
        }
        .vacp-session, .vacp-section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
        .vacp-session { flex-wrap: wrap; }
        .vacp-session > div { min-width: 0; }
        .vacp-status { color: var(--dsw-alias-state-success-primary); font-size: 12px; font-weight: 600; }
        .vacp-session .vacp-email { margin-block: 4px; font-size: 16px; font-weight: 620; overflow-wrap: anywhere; }
        .vacp-section-heading { margin-bottom: 8px; }
        .vacp-section-heading h2 { margin: 0; font-size: 16px; font-weight: 600; }
        .vacp-workspaces {
          list-style: none; margin: 0; padding: 0;
          border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; overflow: hidden;
        }
        .vacp-workspaces li { display: flex; align-items: center; gap: 10px; padding: 12px; min-width: 0; }
        .vacp-workspaces li + li { border-top: 1px solid var(--dsw-alias-border-l2); }
        .vacp-workspace-name { flex: 1; min-width: 0; overflow-wrap: anywhere; }
        .vacp-workspace-name p { margin: 4px 0 0; font-size: 12px; }
        .vacp-role { flex: none; color: var(--dsw-alias-label-secondary); font-size: 12px; }
      ` },
    },
  }),
})
