import { lazy, Suspense, useEffect, useState } from 'react'
import { Alert, Button, Card, Empty, Form, Input, Layout, Menu, Modal, Select, Space, Spin, Table, Tag, Typography } from 'antd'
import { Skills } from './Skills'
import { McpServices } from './McpServices'
import { ModelGateway } from './ModelGateway'
import { AgentPluginLogins } from './AgentPluginLogins'
import { PluginMarketplace } from './PluginMarketplace'
import { AgentTeams } from './AgentTeams'
import { SystemAdmin, platformRoleLabel, systemSections, type PlatformRole } from './SystemAdmin'
import { version } from '../../../package.json'

const DshConversations = lazy(() => import('./DshConversations'))

type User = { id: string; email: string; platformRole: PlatformRole }
type Member = { email: string; role: string }
type Workspace = { id: string; name: string; role: string; permissions: string[] }
type Credentials = { email: string; password: string }
type OwnershipTransfer = { id: string; fromEmail: string | null; toEmail: string | null; transferredAt: string }
const roleLabels: Record<string, string> = {
  owner: '所有者', admin: '管理员', member: '成员', viewer: '只读',
}
const roleLabel = (role: string) => roleLabels[role] ?? role
const sections = [
  { key: 'workspace', label: '工作空间' },
  { key: 'chat', label: 'Chat' },
  { key: 'agent-teams', label: 'Team' },
  { key: 'agent', label: 'Agent' },
  { key: 'plugin-market', label: '插件' },
  { key: 'tools', label: '工具', children: [
    { key: 'mcp', label: 'MCP' },
    { key: 'skills', label: 'Skill' },
  ] },
  { key: 'models', label: '模型' },
]
const pages = sections.flatMap(item => item.children ?? [item])
const sectionDescriptions: Record<string,string> = {
  workspace: '管理空间设置、成员和角色权限。',
  chat: '继续已授权的 DSH 会话，发送消息和附件。',
  agent: '查看已登录的 Agent 客户端和设备。',
  'plugin-market': '查看 DeepSeek Harness 和 OpenCode 的插件版本、安装包和安装指南。',
  'agent-teams': '在当前工作空间组织成员与 Agent，开展群聊和私聊。',
  skills: '发现技能、审核版本，并管理当前空间可用的技能。',
  mcp: '管理工作空间的 MCP 地址、认证与启用状态。',
  models: '统一配置上游模型、网关 Key 与请求频率。',
}
function sectionFromUrl() {
  const key = window.location.hash.slice(1)
  return [...pages,...systemSections].find(section => section.key === key)?.key ?? 'workspace'
}

async function api<T>(path: string, method = 'GET', body?: object): Promise<T> {
  const response = await fetch('/api/v1/' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!response.ok) {
    const detail = await response.json().catch(() => null)
    const message = Array.isArray(detail?.message) ? detail.message.join(' · ') : detail?.message
    throw Object.assign(new Error(message ?? '请求失败 · ' + response.status), { status: response.status })
  }
  return response.status === 204 ? undefined as T : response.json()
}

export default function App() {
  const [user, setUser] = useState<User>()
  const [spaces, setSpaces] = useState<Workspace[]>([])
  const [selected, setSelected] = useState('')
  const [members, setMembers] = useState<Member[]>([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState<OwnershipTransfer[]>([])
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [section, setSection] = useState(sectionFromUrl)
  const [openMenus, setOpenMenus] = useState<string[]>([])
  const [creating, setCreating] = useState(false)
  const [authForm] = Form.useForm<Credentials>()
  const [createForm] = Form.useForm<{ name: string }>()
  const [memberForm] = Form.useForm<Member>()
  const [modal, context] = Modal.useModal()
  const workspace = spaces.find(item => item.id === selected)
  const isSuper = user?.platformRole === 'super_admin'
  const systemPage = isSuper ? systemSections.find(item => item.key === section) : undefined
  const activeSection = section.startsWith('system-') && !systemPage ? 'workspace' : section
  const parentMenu = systemPage ? 'system' : sections.find(item => item.children?.some(child => child.key === activeSection))?.key
  const showNavigation = Boolean(user && (workspace || isSuper))
  const can = (permission: string) => workspace?.permissions.includes(permission) ?? false
  const roles = can('admins:manage') ? ['member', 'viewer', 'admin'] : ['member', 'viewer']

  async function run(action: () => Promise<void>, success?: string, keepDialogOnError = false) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
      if (success) setNotice(success)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '请求失败')
      if (keepDialogOnError) throw cause
    } finally {
      setBusy(false)
    }
  }

  async function selectSpace(next?: Workspace) {
    setMembers([])
    setSelected(next?.id ?? '')
    memberForm.resetFields()
    if (next?.permissions.includes('members:read')) {
      setMembers(await api<Member[]>('workspaces/' + next.id + '/members'))
    }
  }

  async function refreshSpaces(preferred?: string) {
    const result = await api<Workspace[]>('workspaces')
    setSpaces(result)
    await selectSpace(result.find(item => item.id === preferred) ?? result[0])
  }

  useEffect(() => {
    const updateSection = () => setSection(sectionFromUrl())
    window.addEventListener('hashchange', updateSection)
    return () => window.removeEventListener('hashchange', updateSection)
  }, [])

  useEffect(() => {
    if (parentMenu) setOpenMenus(keys => keys.includes(parentMenu) ? keys : [...keys,parentMenu])
  }, [activeSection,parentMenu])

  useEffect(() => {
    void run(async () => {
      const session = await fetch('/api/v1/auth/me')
      if (session.status === 401) return
      if (!session.ok) throw new Error('无法恢复会话')
      setUser(await session.json())
      await refreshSpaces()
    })
  }, [])

  function authenticate(values: Credentials, register = false) {
    if (register && Array.from(values.password).length < 8) {
      authForm.setFields([{ name: 'password', errors: ['新账户密码至少 8 个字符'] }])
      return
    }
    return run(async () => {
      if (register) await api('auth/register', 'POST', values)
      setUser(await api<User>('auth/login', 'POST', values))
      authForm.resetFields()
      await refreshSpaces()
    })
  }

  function transferOwnership(member: Member) {
    const path = 'workspaces/' + selected + '/ownership-transfer'
    modal.confirm({
      title: '转移工作空间所有权',
      content: `交接后，${member.email} 将成为所有者，你将成为管理员。`,
      okText: '确认转移',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: () => run(async () => {
        await api(path, 'POST', { email: member.email })
        await refreshSpaces(selected)
      }, '所有权已转移', true),
    })
  }

  function showOwnershipHistory() {
    return run(async () => {
      const records = await api<OwnershipTransfer[]>('workspaces/' + selected + '/ownership-transfers')
      setHistory(records)
      setHistoryOpen(true)
    })
  }

  return <Layout className={showNavigation ? 'console-shell console-shell--workspace' : 'console-shell'}>
    {context}
    <Modal title="最近 50 条所有权交接记录" open={historyOpen} footer={null}
      onCancel={() => { setHistoryOpen(false); setHistory([]) }}>
      <Table<OwnershipTransfer> rowKey="id" dataSource={history} size="small"
        pagination={{ pageSize: 10 }} locale={{ emptyText: '暂无交接记录' }}
        columns={[
          { title: '原所有者', dataIndex: 'fromEmail', render: (value: string | null) => value ?? '账户已删除' },
          { title: '新所有者', dataIndex: 'toEmail', render: (value: string | null) => value ?? '账户已删除' },
          { title: '交接时间', dataIndex: 'transferredAt', render: (value: string) => new Date(value).toLocaleString('zh-CN') },
        ]} />
    </Modal>
    <Layout.Header className="console-header">
      {!showNavigation && <span className="console-brand"><span className="console-mark" aria-hidden="true" />VACP</span>}
      {user && <Space wrap>
        <Select aria-label="当前工作空间" placeholder="选择工作空间" value={selected || undefined}
          disabled={busy || !spaces.length} style={{ width: 230 }}
          options={spaces.map(item => ({ value: item.id, label: item.name + ' · ' + roleLabel(item.role) }))}
          onChange={id => void run(() => selectSpace(spaces.find(item => item.id === id)))} />
        <Button disabled={busy} onClick={() => { setError(''); setCreating(true) }}>新建工作空间</Button>
      </Space>}
      {user && <Space wrap>{user.email}{isSuper && <Tag color="purple">{platformRoleLabel(user.platformRole)}</Tag>}<Button disabled={busy} onClick={() => void run(async () => {
        await api('auth/logout', 'POST')
        setUser(undefined)
        setSpaces([])
        await selectSpace()
      })}>退出</Button></Space>}
    </Layout.Header>
    {showNavigation && <nav className="console-navigation" aria-label="工作空间导航">
      <span className="console-brand"><span className="console-mark" aria-hidden="true" />VACP</span>
      <Menu mode="inline" theme="dark" inlineIndent={16} selectedKeys={[activeSection]} openKeys={openMenus} onOpenChange={setOpenMenus}
        items={[...sections.filter(item => (item.key !== 'models' || can('members:manage')) &&
          (item.key !== 'chat' || (workspace && workspace.role !== 'viewer'))),
          ...(isSuper ? [{key:'system',label:'系统',children:[...systemSections]}] : [])]}
        onClick={({ key }) => { setSection(key); setNotice(''); setError(''); window.location.hash = key }} />
      <small className="console-version" aria-label={`VACP 版本 ${version}`}>v{version}</small>
    </nav>}
    <Modal title="新建工作空间" open={creating} footer={null} destroyOnHidden
      onCancel={() => { if (!busy) setCreating(false) }}>
      {error && <Alert type="error" title={error} showIcon />}
      <Form name="workspace-create" form={createForm} preserve={false} layout="vertical" disabled={busy}
        onFinish={({ name }) => void run(async () => {
          const created = await api<Workspace>('workspaces', 'POST', { name })
          setCreating(false)
          await refreshSpaces(created.id)
        }, '工作空间已创建')}>
        <Form.Item name="name" label="新工作空间名称" rules={[{ required: true, whitespace: true }]}>
          <Input maxLength={80} />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={busy}>创建工作空间</Button>
      </Form>
    </Modal>
    <Layout.Content className="console-content">
      <Space orientation="vertical" size="large" style={{ width: '100%' }}>
        {error && <Alert type="error" title={error} showIcon />}
        {notice && <Alert type="success" title={notice} showIcon />}
        {!user ? <Card title="登录控制台" className="console-login">
          <Form form={authForm} layout="vertical" disabled={busy} onFinish={values => void authenticate(values)}>
            <Form.Item name="email" label="邮箱" rules={[{ required: true, type: 'email' }]}>
              <Input type="email" autoComplete="username" />
            </Form.Item>
            <Form.Item name="password" label="密码" rules={[{ required: true }]}>
              <Input.Password autoComplete="current-password" />
            </Form.Item>
            <Space>
              <Button type="primary" htmlType="submit">登录</Button>
              <Button onClick={() => void authForm.validateFields().then(values => authenticate(values, true), () => undefined)}>创建账户</Button>
            </Space>
          </Form>
          <Typography.Paragraph style={{ marginTop: 12, marginBottom: 0 }}>新账户密码至少 8 个字符。</Typography.Paragraph>
        </Card> : <>
          {systemPage && <section className="console-hero" aria-labelledby="console-page-title">
            <div className="console-hero-context">系统 <span>超管</span></div>
            <h1 id="console-page-title">{systemPage.label}</h1>
          </section>}
          {workspace && !systemPage && <section className="console-hero" aria-labelledby="console-page-title">
            <div className="console-hero-context">{workspace.name} <span>{roleLabel(workspace.role)}</span></div>
            <h1 id="console-page-title">{pages.find(item => item.key === activeSection)?.label}</h1>
            <p>{sectionDescriptions[activeSection]}</p>
          </section>}
          {!workspace && !systemPage && !busy && <Card><Empty description="你还没有工作空间">
            <Button type="primary" onClick={() => { setError(''); setCreating(true) }}>创建第一个工作空间</Button>
          </Empty></Card>}
          {workspace && activeSection === 'workspace' && <Card title={workspace.name} extra={<Space wrap>
            <Tag>{roleLabel(workspace.role)}</Tag>
            {can('ownership:history') && <Button disabled={busy} onClick={() => void showOwnershipHistory()}>交接记录</Button>}
          </Space>}>
            {can('workspace:rename') && <Form key={workspace.id + workspace.name} layout="vertical" disabled={busy}
              initialValues={{ name: workspace.name }} onFinish={({ name }) => void run(async () => {
                await api('workspaces/' + selected, 'PATCH', { name })
                await refreshSpaces(selected)
              }, '工作空间名称已保存')}>
              <Form.Item label="工作空间名称" name="name" rules={[{ required: true, whitespace: true }]}><Input maxLength={80} /></Form.Item>
              <Button htmlType="submit">保存名称</Button>
            </Form>}
            {can('members:read') && <>
              <Typography.Title level={4}>成员</Typography.Title>
              <Table<Member> rowKey="email" dataSource={members} loading={busy}
                columns={[
                  { title: '邮箱', dataIndex: 'email' },
                  { title: '角色', dataIndex: 'role', render: (value: string) => <Tag>{roleLabel(value)}</Tag> },
                  { title: '操作', render: (_, member) => can('members:manage') && member.role !== 'owner' &&
                    (member.role !== 'admin' || can('admins:manage')) && <Space wrap>
                    <Select aria-label={`更改 ${member.email} 的角色`} value={member.role} disabled={busy}
                      options={roles.map(value => ({ value, label: roleLabel(value) }))}
                      onChange={role => void run(async () => {
                        await api('workspaces/' + selected + '/members', 'PUT', { email: member.email, role })
                        await refreshSpaces(selected)
                      }, '成员角色已更新')} />
                    <Button danger type="link" disabled={busy} onClick={() => modal.confirm({
                      title: '移除成员',
                      content: member.email + ' 将失去对此工作空间的访问权限。',
                      okText: '移除',
                      cancelText: '取消',
                      okButtonProps: { danger: true },
                      onOk: () => run(async () => {
                        await api('workspaces/' + selected + '/members', 'DELETE', { email: member.email })
                        await refreshSpaces(selected)
                      }, '成员已移除', true),
                    })}>移除</Button>
                    {can('ownership:transfer') && <Button type="link" disabled={busy}
                      onClick={() => transferOwnership(member)}>转移所有权</Button>}
                    </Space> },
                ]} />
              {can('members:manage') && <Form form={memberForm} layout="vertical" disabled={busy} initialValues={{ role: 'member' }}
                onFinish={values => void run(async () => {
                  await api('workspaces/' + selected + '/members', 'PUT', values)
                  await refreshSpaces(selected)
                }, '成员角色已保存')}>
                <Form.Item name="email" label="已注册用户邮箱" rules={[{ required: true, type: 'email' }]}><Input type="email" /></Form.Item>
                <Form.Item name="role" label="角色" rules={[{ required: true }]}><Select options={roles.map(value => ({ value, label: roleLabel(value) }))} /></Form.Item>
                <Button type="primary" htmlType="submit">添加或更新角色</Button>
              </Form>}
            </>}
          </Card>}
          {workspace && activeSection === 'skills' && <Skills key={workspace.id} id={workspace.id} writable={can('members:manage')} api={api} />}
          {workspace && activeSection === 'agent' && <Space orientation="vertical" size="middle" style={{ width:'100%' }}>
            <div>
              <Button type="primary" href="#agent-teams">打开 Team</Button>
            </div>
            <Card title="已登录设备">
              <AgentPluginLogins key={workspace.id} workspaceId={workspace.id} api={api} />
            </Card>
          </Space>}
          {workspace && activeSection === 'chat' && (workspace.role !== 'viewer'
            ? <Suspense fallback={<Card><Spin aria-label="加载 Chat" /></Card>}>
              <DshConversations key={workspace.id} workspaceId={workspace.id} api={api} />
            </Suspense>
            : <Alert type="warning" title="当前工作空间角色为只读" showIcon />)}
          {workspace && activeSection === 'plugin-market' && <PluginMarketplace key={workspace.id} workspaceId={workspace.id} writable={can('members:manage')} api={api} />}
          {workspace && activeSection === 'agent-teams' && <AgentTeams key={workspace.id} workspaceId={workspace.id}
            userId={user.id} writable={workspace.role!=='viewer'} api={api} />}
          {workspace && activeSection === 'mcp' && <McpServices key={workspace.id} workspaceId={workspace.id} writable={can('members:manage')} api={api} />}
          {workspace && activeSection === 'models' && (can('members:manage')
            ? <ModelGateway key={workspace.id} workspaceId={workspace.id} api={api} />
            : <Alert type="warning" title="需要工作空间管理员权限" showIcon />)}
          {systemPage && <SystemAdmin key={systemPage.key} section={systemPage.key} api={api} userId={user.id}
            onSelfChanged={async () => setUser(await api<User>('auth/me'))} />}
        </>}
      </Space>
    </Layout.Content>
  </Layout>
}
