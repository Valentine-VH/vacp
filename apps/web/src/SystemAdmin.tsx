import { useEffect, useState } from 'react'
import { Alert, Button, Card, Divider, Form, InputNumber, Popconfirm, Space, Spin, Statistic, Switch, Table, Tag } from 'antd'

export type PlatformRole = 'super_admin' | 'user'
export const platformRoleLabel = (role: PlatformRole) => role === 'super_admin' ? '超管' : '默认用户'

export const systemSections = [
  { key:'system-workspaces', label:'工作空间' },
  { key:'system-users', label:'用户' },
  { key:'system-roles', label:'角色' },
  { key:'system-menus', label:'菜单' },
  { key:'system-status', label:'系统' },
] as const

type Section = typeof systemSections[number]['key']
type Api = <T>(path:string,method?:string,body?:object) => Promise<T>
type User = {id:string;email:string;platformRole:PlatformRole;workspaceCount:number}
type Workspace = {id:string;name:string;ownerEmail:string|null;memberCount:number}
type Role = {id:PlatformRole;name:string;description:string;count:number}
type Menu = {id:string;name:string;group:string;access:string}
type Status = {database:string;users:number;workspaces:number;superAdmins:number}
type FileRelay = {enabled:boolean;maxFiles:number;maxTotalKiB:number;maxConcurrent:number}

export function SystemAdmin({ section, api, userId, onSelfChanged }: {
  section: Section; api:Api; userId:string; onSelfChanged:() => Promise<void>
}) {
  const [users,setUsers] = useState<User[]>([])
  const [spaces,setSpaces] = useState<Workspace[]>([])
  const [roles,setRoles] = useState<Role[]>([])
  const [menus,setMenus] = useState<Menu[]>([])
  const [status,setStatus] = useState<Status>()
  const [fileRelay,setFileRelay] = useState<FileRelay>()
  const [saving,setSaving] = useState(false)
  const [saved,setSaved] = useState(false)
  const [fileForm] = Form.useForm<FileRelay>()
  const [busy,setBusy] = useState(true)
  const [error,setError] = useState('')
  const [revision,setRevision] = useState(0)

  useEffect(() => {
    let active = true
    setBusy(true)
    setError('')
    setSaved(false)
    async function load() {
      switch (section) {
        case 'system-users': { const rows = await api<User[]>('system/users'); if (active) setUsers(rows); break }
        case 'system-workspaces': { const rows = await api<Workspace[]>('system/workspaces'); if (active) setSpaces(rows); break }
        case 'system-roles': { const rows = await api<Role[]>('system/roles'); if (active) setRoles(rows); break }
        case 'system-menus': { const rows = await api<Menu[]>('system/menus'); if (active) setMenus(rows); break }
        case 'system-status': {
          const [row, settings] = await Promise.all([
            api<Status>('system/status'), api<FileRelay>('system/settings/file-relay'),
          ])
          if (active) {
            setStatus(row)
            setFileRelay(settings)
            fileForm.setFieldsValue(settings)
          }
          break
        }
      }
    }
    void load().catch(cause => { if (active) setError(cause instanceof Error ? cause.message : '读取失败') })
      .finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [api,section,revision,fileForm])

  async function saveFileRelay(values: FileRelay) {
    setSaving(true)
    setError('')
    setSaved(false)
    try {
      const settings = await api<FileRelay>('system/settings/file-relay','PUT',values)
      setFileRelay(settings)
      fileForm.setFieldsValue(settings)
      setSaved(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '附件中转设置保存失败')
    } finally { setSaving(false) }
  }

  async function changeRole(user: User, role: PlatformRole) {
    setBusy(true)
    setError('')
    try {
      await api('system/users/' + user.id + '/role', 'PUT', {role})
      if (user.id === userId) await onSelfChanged()
      else setRevision(value => value+1)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '修改失败')
      setBusy(false)
    }
  }

  return <Card title={systemSections.find(item => item.key===section)?.label}
    extra={<Button disabled={busy || saving} onClick={() => setRevision(value => value+1)}>刷新</Button>}>
    {error && <Alert type="error" title={error} showIcon style={{marginBottom:12}} />}
    {section==='system-workspaces' && <Table<Workspace> rowKey="id" size="small" scroll={{x:500}} loading={busy} dataSource={spaces} columns={[
      {title:'工作空间',dataIndex:'name'},
      {title:'所有者',dataIndex:'ownerEmail',render:(value:string|null)=>value ?? '—'},
      {title:'成员数',dataIndex:'memberCount'},
    ]} />}
    {section==='system-users' && <Table<User> rowKey="id" size="small" scroll={{x:550}} loading={busy} dataSource={users} columns={[
      {title:'邮箱',dataIndex:'email'},
      {title:'平台角色',dataIndex:'platformRole',render:(role:PlatformRole)=><Tag color={role==='super_admin'?'purple':undefined}>{platformRoleLabel(role)}</Tag>},
      {title:'工作空间数',dataIndex:'workspaceCount'},
      {title:'操作',render:(_,row)=>{
        const next = row.platformRole==='super_admin'?'user':'super_admin'
        return <Popconfirm title={'将平台角色改为' + platformRoleLabel(next) + '？'} description={row.email}
          onConfirm={()=>changeRole(row,next)}>
          <Button type="link" disabled={busy}>{next==='super_admin'?'设为超管':'设为默认用户'}</Button>
        </Popconfirm>
      }},
    ]} />}
    {section==='system-roles' && <Table<Role> rowKey="id" size="small" loading={busy} dataSource={roles} columns={[
      {title:'角色',dataIndex:'name'}, {title:'权限范围',dataIndex:'description'}, {title:'用户数',dataIndex:'count'},
    ]} />}
    {section==='system-menus' && <Table<Menu> rowKey="id" size="small" loading={busy} dataSource={menus} columns={[
      {title:'菜单',dataIndex:'name'}, {title:'分组',dataIndex:'group'}, {title:'可见范围',dataIndex:'access'},
    ]} />}
    {section==='system-status' && <>
      {busy && <Spin />}
      {status && <Space wrap size="large">
        <Statistic title="数据库" value={status.database==='ready'?'就绪':'不可用'} />
        <Statistic title="用户" value={status.users} />
        <Statistic title="超管" value={status.superAdmins} />
        <Statistic title="工作空间" value={status.workspaces} />
      </Space>}
      <Divider />
      <Card size="small" title="全局设置 · DSH 附件中转">
        {saved && <Alert type="success" title="设置已保存" showIcon style={{marginBottom:12}} />}
        <Form form={fileForm} layout="vertical" disabled={busy || saving || !fileRelay}
          onFinish={values => void saveFileRelay(values)} onValuesChange={() => setSaved(false)} style={{maxWidth:460}}>
          <Form.Item label="启用附件中转" name="enabled" valuePropName="checked" extra="应用于所有工作空间的 DSH 续聊。">
            <Switch />
          </Form.Item>
          <Form.Item label="单条消息文件数" name="maxFiles" rules={[{required:true,type:'integer',min:1,max:3}]}>
            <InputNumber min={1} max={3} precision={0} />
          </Form.Item>
          <Form.Item label="单条消息附件总大小（KiB）" name="maxTotalKiB"
            rules={[{required:true,type:'integer',min:1,max:256}]}>
            <InputNumber min={1} max={256} precision={0} />
          </Form.Item>
          <Form.Item label="全局并发中转数" name="maxConcurrent" rules={[{required:true,type:'integer',min:1,max:16}]}
            extra="按带附件的消息计数。达到上限时，后续中转返回繁忙提示。">
            <InputNumber min={1} max={16} precision={0} />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={saving}>保存全局设置</Button>
        </Form>
      </Card>
    </>}
  </Card>
}
