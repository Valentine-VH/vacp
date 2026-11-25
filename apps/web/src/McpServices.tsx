import { useEffect, useState } from 'react'
import { Alert, Button, Card, Drawer, Form, Input, Popconfirm, Select, Space, Switch, Table, Tag } from 'antd'

type Auth = 'none' | 'bearer' | 'header'
type Server = { id:string;name:string;endpoint:string;auth:Auth;header:string|null;enabled:boolean;hasSecret:boolean }
type Fields = Pick<Server,'name'|'endpoint'|'auth'|'enabled'> & { header?:string; secret?:string }
type Api = <T>(path:string,method?:string,body?:object)=>Promise<T>
const labels: Record<Auth,string> = {none:'无认证',bearer:'Bearer Token',header:'API Key Header'}

export function McpServices({workspaceId,writable,api}:{workspaceId:string;writable:boolean;api:Api}) {
  const path = 'workspaces/' + workspaceId + '/mcp'
  const [rows,setRows] = useState<Server[]>([])
  const [edit,setEdit] = useState<Server | 'new'>()
  const [loading,setLoading] = useState(true)
  const [saving,setSaving] = useState(false)
  const [error,setError] = useState('')
  const [notice,setNotice] = useState('')
  const [revision,setRevision] = useState(0)
  const [form] = Form.useForm<Fields>()
  const auth = Form.useWatch('auth',form) ?? 'none'

  useEffect(() => {
    if (!edit) return
    form.resetFields()
    form.setFieldsValue(edit === 'new'
      ? { name:'',endpoint:'',auth:'none',enabled:true,header:undefined,secret:undefined }
      : { name:edit.name,endpoint:edit.endpoint,auth:edit.auth,enabled:edit.enabled,header:edit.header??undefined,secret:undefined })
  },[edit,form])

  useEffect(() => {
    let current = true
    setLoading(true)
    void api<Server[]>(path).then(result => { if (current) setRows(result) })
      .catch(cause => { if (current) setError(cause instanceof Error ? cause.message : '读取失败') })
      .finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  },[api,path,revision])

  function open(item: Server | 'new') {
    setError('')
    setNotice('')
    setEdit(item)
  }
  function close() {
    if (saving) return
    form.resetFields()
    setEdit(undefined)
    setError('')
  }

  async function save(values: Fields) {
    if (!edit) return
    setSaving(true)
    setError('')
    try {
      const target = edit === 'new' ? path : path + '/' + edit.id
      const payload = {
        name:values.name,endpoint:values.endpoint,auth:values.auth,enabled:values.enabled,
        ...(values.auth==='header' && {header:values.header}),
        ...(values.auth!=='none' && values.secret && {secret:values.secret}),
      }
      await api(target,edit === 'new' ? 'POST' : 'PUT',payload)
      form.resetFields()
      setEdit(undefined)
      setNotice('MCP 配置已保存')
      setRevision(value=>value+1)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败') }
    finally { setSaving(false) }
  }

  async function remove(id:string) {
    setSaving(true)
    setError('')
    setNotice('')
    try {
      await api(path+'/'+id,'DELETE')
      setNotice('MCP 服务已移除')
      setRevision(value=>value+1)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '移除失败') }
    finally { setSaving(false) }
  }

  return <Card title="MCP 服务目录" extra={<Space wrap>
    <Button disabled={loading||saving} onClick={()=>{setError('');setRevision(value=>value+1)}}>刷新</Button>
    {writable && <Button type="primary" onClick={()=>open('new')}>添加 MCP 服务</Button>}
  </Space>}>
    {error && !edit && <Alert type="error" title={error} showIcon style={{marginBottom:12}} />}
    {notice && <Alert type="success" title={notice} showIcon style={{marginBottom:12}} />}
    <Table<Server> rowKey="id" size="small" loading={loading} scroll={{x:720}} dataSource={rows}
      locale={{emptyText:'当前工作空间暂无 MCP 服务'}} columns={[
        {title:'名称',dataIndex:'name'},
        {title:'服务地址',dataIndex:'endpoint',ellipsis:true},
        {title:'认证',render:(_,item)=><Space wrap><span>{labels[item.auth]}</span>
          {item.auth!=='none' && <Tag color={item.hasSecret?'blue':'default'}>{item.hasSecret?'已配置':'未配置'}</Tag>}
        </Space>},
        {title:'配置状态',dataIndex:'enabled',render:(enabled:boolean)=><Tag color={enabled?'green':undefined}>{enabled?'已启用':'已停用'}</Tag>},
        ...(writable ? [{title:'操作',render:(_:unknown,item:Server)=><Space>
          <Button type="link" onClick={()=>open(item)}>编辑</Button>
          <Popconfirm title="移除此 MCP 服务？" description="保存的密钥也会一并删除。" onConfirm={()=>remove(item.id)}>
            <Button danger type="link" disabled={saving}>移除</Button>
          </Popconfirm>
        </Space>}] : []),
      ]} />
    <Drawer title={edit==='new'?'添加 MCP 服务':'编辑 MCP 服务'} open={Boolean(edit)} onClose={close}
      destroyOnHidden size="min(580px, 100vw)">
      {error && <Alert type="error" title={error} showIcon style={{marginBottom:12}} />}
      {edit && <Form key={edit==='new'?'new':edit.id} form={form} layout="vertical" preserve={false} onFinish={save} disabled={saving}
        initialValues={edit==='new'?{auth:'none',enabled:true}:{...edit,header:edit.header??undefined}}>
        <Form.Item name="name" label="服务名称" rules={[{required:true,whitespace:true}]}><Input maxLength={80}/></Form.Item>
        <Form.Item name="endpoint" label="Streamable HTTP 地址" rules={[{required:true,whitespace:true}]}>
          <Input maxLength={1500} placeholder="https://example.com/mcp" autoComplete="off"/>
        </Form.Item>
        <Form.Item name="auth" label="认证方式">
          <Select options={Object.entries(labels).map(([value,label])=>({value,label}))}
            onChange={()=>form.setFieldValue('secret',undefined)}/>
        </Form.Item>
        {auth==='header' && <Form.Item name="header" label="API Key Header 名称" rules={[{required:true,whitespace:true}]}>
          <Input placeholder="X-API-Key" maxLength={64}/>
        </Form.Item>}
        {auth!=='none' && <Form.Item name="secret" label={auth==='bearer'?'Bearer Token':'API Key'}
          extra={edit!=='new'&&edit.hasSecret?'留空保留原密钥。更换地址或认证方式时需重新填写。':'保存后不会显示密钥原文。'}
          rules={edit==='new'||!edit.hasSecret?[{required:true,whitespace:true}]:[]}>
          <Input.Password autoComplete="new-password" visibilityToggle={false} maxLength={4096}/>
        </Form.Item>}
        {auth==='none' && edit!=='new' && edit.hasSecret && <Alert type="warning" title="保存为无认证后，将清除现有密钥。" />}
        <Form.Item name="enabled" label="启用配置" valuePropName="checked"><Switch/></Form.Item>
        <Space>
          <Button type="primary" htmlType="submit" loading={saving}>保存配置</Button>
          <Button onClick={close}>取消</Button>
        </Space>
      </Form>}
    </Drawer>
  </Card>
}
