import { useEffect, useState } from 'react'
import { Alert, Button, Card, Checkbox, Drawer, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Tabs, Tag, Typography } from 'antd'
import { ModelGatewayUsage } from './ModelGatewayUsage'

type ModelLimits = { contextWindow:number;maxOutputTokens:number;compactionHeadroomTokens:number;reasoningEfforts:string[] }
type Route = ModelLimits & { id:string;alias:string;baseUrl:string;upstreamModel:string;enabled:boolean }
type Key = { id:string;routeId:string;label:string;useCase:string|null;shared:boolean;prefix:string;rpm:number;createdAt:string;revokedAt:string|null }
type Api = <T>(path:string,method?:string,body?:object)=>Promise<T>
type Dialog = { kind:'route' } | { kind:'issue' } | { kind:'rotate' | 'edit'; route:Route } | { kind:'useCase'; key:Key }
type RouteFields = ModelLimits & {alias:string;baseUrl:string;upstreamModel:string;upstreamKey?:string}
type KeyFields = {routeId:string;label:string;rpm:number;useCase?:string}

const defaultLimits: ModelLimits = { contextWindow:32768,maxOutputTokens:4096,compactionHeadroomTokens:4096,reasoningEfforts:[] }
const thinkingOptions = [
  {value:'off',label:'关闭'}, {value:'minimal',label:'极低'}, {value:'low',label:'低'},
  {value:'medium',label:'中'}, {value:'high',label:'高'}, {value:'xhigh',label:'极高'}, {value:'max',label:'最大'},
]

function LimitFields() {
  return <>
    <Form.Item name="contextWindow" label="上下文窗口（Token）" rules={[{required:true,type:'integer',min:2,max:2147483647}]}>
      <InputNumber min={2} precision={0} style={{width:'100%'}} />
    </Form.Item>
    <Form.Item name="maxOutputTokens" label="最大输出（Token）" rules={[{required:true,type:'integer',min:1,max:2147483647}]}>
      <InputNumber min={1} precision={0} style={{width:'100%'}} />
    </Form.Item>
    <Form.Item name="compactionHeadroomTokens" label="DSH 压缩预留（Token）" dependencies={['contextWindow','maxOutputTokens']}
      rules={[{required:true,type:'integer',min:0,max:2147483647},({getFieldValue})=>({
        validator:(_,value:number)=> value+getFieldValue('maxOutputTokens')>=getFieldValue('contextWindow')
          ? Promise.reject(new Error('最大输出与压缩预留之和必须小于上下文窗口'))
          : Promise.resolve(),
      })]}>
      <InputNumber min={0} precision={0} style={{width:'100%'}} />
    </Form.Item>
    <Form.Item name="reasoningEfforts" label="支持的思考强度"
      extra="仅勾选上游支持的 reasoning_effort 档位。关闭对应 none。留空时 DSH 不显示强度选项。">
      <Checkbox.Group options={thinkingOptions} aria-label="支持的思考强度" />
    </Form.Item>
  </>
}

function dshPolicy(workspaceId: string, route: Route) {
  return ['modelPolicies:', '  - provider: vacp-'+workspaceId, '    model: '+JSON.stringify(route.alias),
    '    headroomTokens: '+route.compactionHeadroomTokens, '    maxTokens: '+route.maxOutputTokens].join('\n')
}

export function ModelGateway({workspaceId,api}:{workspaceId:string;api:Api}) {
  const path = 'workspaces/' + workspaceId + '/model-gateway'
  const [routes,setRoutes] = useState<Route[]>([])
  const [keys,setKeys] = useState<Key[]>([])
  const [tab,setTab] = useState('routes')
  const [dialog,setDialog] = useState<Dialog>()
  const [issued,setIssued] = useState('')
  const [revision,setRevision] = useState(0)
  const [busy,setBusy] = useState(true)
  const [saving,setSaving] = useState(false)
  const [error,setError] = useState('')
  const [notice,setNotice] = useState('')
  const baseUrl = window.location.origin + '/v1'

  useEffect(()=>{
    let active=true
    setBusy(true)
    void api<{routes:Route[];keys:Key[]}>(path)
      .then(data=>{ if(active){setRoutes(data.routes);setKeys(data.keys)} })
      .catch(cause=>{ if(active) setError(cause instanceof Error ? cause.message : '读取失败') })
      .finally(()=>{ if(active) setBusy(false) })
    return ()=>{active=false}
  },[api,path,revision])

  function open(next:Dialog) {
    setError('')
    setNotice('')
    setDialog(next)
  }

  async function action(work:()=>Promise<void>,message:string) {
    setError('')
    setNotice('')
    setSaving(true)
    try {
      await work()
      setDialog(undefined)
      setNotice(message)
      setRevision(value=>value+1)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败') }
    finally { setSaving(false) }
  }

  return <Card title="模型网关" extra={<Space wrap>
    <Button disabled={busy||saving} onClick={()=>{setError('');setRevision(value=>value+1)}}>刷新</Button>
    {tab==='routes'
      ? <Button type="primary" onClick={()=>open({kind:'route'})}>添加模型</Button>
      : tab==='keys' && <Button type="primary" disabled={!routes.some(route=>route.enabled)} onClick={()=>open({kind:'issue'})}>签发网关 Key</Button>}
  </Space>}>
    <Typography.Paragraph copyable={{text:baseUrl}}>OpenAI 兼容 API 地址 · <code>{baseUrl}</code></Typography.Paragraph>
    {error && !dialog && <Alert type="error" title={error} showIcon />}
    {notice && <Alert type="success" title={notice} showIcon />}
    <Tabs activeKey={tab} onChange={setTab} items={[
      {key:'routes',label:'上游模型',children:<Table<Route> rowKey="id" dataSource={routes} loading={busy} scroll={{x:690}} columns={[
        {title:'网关模型',dataIndex:'alias'},
        {title:'上游模型',dataIndex:'upstreamModel'},
        {title:'上游地址',dataIndex:'baseUrl',ellipsis:true},
        {title:'状态',dataIndex:'enabled',render:(enabled:boolean)=><Tag color={enabled?'green':undefined}>{enabled?'启用':'停用'}</Tag>},
        {title:'操作',render:(_,row)=><Space wrap>
          <Button type="link" onClick={()=>open({kind:'edit',route:row})}>编辑模型</Button>
          <Button type="link" onClick={()=>open({kind:'rotate',route:row})}>更换上游 Key</Button>
          <Button type="link" disabled={saving} onClick={()=>void action(async()=>{
            await api(path+'/routes/'+row.id,'PUT',{enabled:!row.enabled})
          },row.enabled?'模型已停用':'模型已启用')}>{row.enabled?'停用':'启用'}</Button>
        </Space>},
      ]}/>},
      {key:'keys',label:'网关 Key',children:<Table<Key> rowKey="id" dataSource={keys} loading={busy} scroll={{x:780}} columns={[
        {title:'名称',dataIndex:'label'},
        {title:'用例',render:(_,row)=>row.shared ? row.useCase ?? row.label : '按插件类型'},
        {title:'绑定模型',dataIndex:'routeId',render:(id:string)=>routes.find(route=>route.id===id)?.alias??'—'},
        {title:'Key 前缀',dataIndex:'prefix',render:(prefix:string)=><code>{prefix}…</code>},
        {title:'请求/分钟',dataIndex:'rpm'},
        {title:'状态',dataIndex:'revokedAt',render:(revokedAt:string|null)=><Tag color={revokedAt?undefined:'green'}>{revokedAt?'已撤销':'有效'}</Tag>},
        {title:'操作',render:(_,row)=>!row.revokedAt&&<Space wrap>
          {row.shared && <Button type="link" onClick={()=>open({kind:'useCase',key:row})}>编辑用例</Button>}
          <Popconfirm title="撤销这个网关 Key？" onConfirm={()=>action(async()=>{
          await api(path+'/keys/'+row.id+'/revoke','POST')
        },'网关 Key 已撤销')}>
          <Button type="link" danger disabled={saving}>撤销</Button>
        </Popconfirm></Space>},
      ]}/>},
      {key:'usage',label:'用量统计',destroyOnHidden:true,
        children:<ModelGatewayUsage path={path} api={api} revision={revision} models={routes.map(route=>route.alias)}/>},
    ]}/>
    <Drawer title={dialog?.kind==='route'?'添加模型':dialog?.kind==='edit'?'编辑模型 · '+dialog.route.alias:dialog?.kind==='issue'?'签发网关 Key':
      dialog?.kind==='useCase'?'编辑用例 · '+dialog.key.label:'更换上游 Key'}
      size="min(560px, 100vw)" open={Boolean(dialog)} destroyOnHidden onClose={()=>{if(!saving){setDialog(undefined);setError('')}}}>
      {error && <Alert type="error" title={error} showIcon />}
      {dialog?.kind==='route' && <Form<RouteFields> layout="vertical" disabled={saving} initialValues={{baseUrl:'https://api.openai.com/v1',...defaultLimits}}
        onFinish={values=>action(async()=>{await api(path+'/routes','POST',values)},'模型已添加')}>
        <Form.Item name="alias" label="网关模型别名" rules={[{required:true,whitespace:true}]}><Input placeholder="team-chat" maxLength={80}/></Form.Item>
        <Form.Item name="baseUrl" label="上游 Base URL" rules={[{required:true,whitespace:true}]}
          extra="支持公网 HTTP / HTTPS 和查询参数。内网地址由部署者授权。"><Input autoComplete="off" maxLength={1000}/></Form.Item>
        <Form.Item name="upstreamModel" label="上游模型名" rules={[{required:true,whitespace:true}]}><Input maxLength={200}/></Form.Item>
        <Form.Item name="upstreamKey" label="上游 API Key" extra="没有 Bearer Key 或使用 URL Basic 认证时可留空。">
          <Input.Password autoComplete="new-password" visibilityToggle={false} maxLength={4096}/>
        </Form.Item>
        <LimitFields />
        <Button type="primary" htmlType="submit" loading={saving}>保存模型</Button>
      </Form>}
      {dialog?.kind==='edit' && <Form<ModelLimits> key={dialog.route.id} layout="vertical"
        disabled={saving} initialValues={dialog.route} onFinish={values=>action(async()=>{
          await api(path+'/routes/'+dialog.route.id+'/limits','PATCH',values)
        },'模型参数已保存')}>
        <LimitFields />
        <Card size="small" title="已保存的 DSH 压缩策略" style={{marginBottom:16}}>
          <Typography.Paragraph copyable={{text:dshPolicy(workspaceId,dialog.route),tooltips:['复制已保存的 DSH 压缩策略','已复制']}}
            style={{marginBottom:6}}>
            <code style={{display:'block',padding:10,whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>
              {dshPolicy(workspaceId,dialog.route)}
            </code>
          </Typography.Paragraph>
          <Typography.Text type="secondary">压缩策略应用到 DSH 预设后生效。上下文、输出上限和思考强度通过插件的「同步模型」更新。</Typography.Text>
        </Card>
        <Button type="primary" htmlType="submit" loading={saving}>保存模型参数</Button>
      </Form>}
      {dialog?.kind==='issue' && <Form<KeyFields> layout="vertical" initialValues={{rpm:30}} disabled={saving}
        onFinish={values=>action(async()=>{const item=await api<{token:string}>(path+'/keys','POST',values);setIssued(item.token)},'网关 Key 已签发')}>
        <Form.Item name="label" label="Key 名称" rules={[{required:true,whitespace:true}]}><Input maxLength={80}/></Form.Item>
        <Form.Item name="useCase" label="统计用例" extra="可填写业务用途。留空时按 Key 名称归类。"><Input maxLength={80}/></Form.Item>
        <Form.Item name="routeId" label="绑定模型" rules={[{required:true}]}>
          <Select options={routes.filter(route=>route.enabled).map(route=>({value:route.id,label:route.alias}))}/>
        </Form.Item>
        <Form.Item name="rpm" label="每分钟请求数" rules={[{required:true,type:'integer',min:1,max:600}]}><InputNumber min={1} max={600} precision={0}/></Form.Item>
        <Button type="primary" htmlType="submit" loading={saving}>生成 Key</Button>
      </Form>}
      {dialog?.kind==='useCase' && <Form<{useCase?:string}> layout="vertical" disabled={saving}
        initialValues={{useCase:dialog.key.useCase??''}} onFinish={values=>action(async()=>{
          await api(path+'/keys/'+dialog.key.id+'/use-case','PATCH',{useCase:values.useCase??''})
        },'用例已保存')}>
        <Form.Item name="useCase" label="统计用例" extra="修改后从下一次调用起生效。留空时按 Key 名称归类。"><Input maxLength={80}/></Form.Item>
        <Button type="primary" htmlType="submit" loading={saving}>保存用例</Button>
      </Form>}
      {dialog?.kind==='rotate' && <Form<{upstreamKey:string}> layout="vertical" disabled={saving} onFinish={values=>action(async()=>{
        await api(path+'/routes/'+dialog.route.id,'PUT',{...values,enabled:dialog.route.enabled})
      },'上游 Key 已更换')}>
        <Form.Item name="upstreamKey" label="新的上游 API Key" rules={[{required:true,whitespace:true}]}><Input.Password autoComplete="new-password" visibilityToggle={false}/></Form.Item>
        <Button type="primary" htmlType="submit" loading={saving}>确认更换</Button>
      </Form>}
    </Drawer>
    <Modal title="复制网关 Key" open={Boolean(issued)} onCancel={()=>setIssued('')} onOk={()=>setIssued('')} cancelButtonProps={{style:{display:'none'}}}
      okText="完成" destroyOnHidden>
      <Typography.Paragraph>此 Key 只显示一次。客户端使用它作为 Bearer Token。</Typography.Paragraph>
      <Typography.Paragraph copyable code style={{overflowWrap:'anywhere'}}>{issued}</Typography.Paragraph>
    </Modal>
  </Card>
}
