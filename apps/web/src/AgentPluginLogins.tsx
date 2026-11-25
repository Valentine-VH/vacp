import { useEffect, useState } from 'react'
import { Alert, Button, Popconfirm, Select, Space, Table, Tag, Typography } from 'antd'

type Plugin = 'dsh' | 'opencode'
const names:Record<Plugin,string> = {dsh:'DeepSeek Harness',opencode:'OpenCode'}
const statuses:Record<string,string> = {active:'已登录',expired:'已过期',revoked:'已撤销'}
type Session = {
  id:string; userId:string; email:string; plugin:Plugin; device:string; pluginVersion:string
  createdAt:string; lastSeen:string; expiresAt:string; status:string
  instances?: {id:string;hostName:string;pluginVersion:string;lastSeen:string}[]
}
type DeviceRow = Session & { instanceId:string; hostName?:string }
type Api = <T>(path:string,method?:string,body?:object)=>Promise<T>

const date = (value:string) => new Date(value).toLocaleString('zh-CN')

export function AgentPluginLogins({workspaceId,api}:{
  workspaceId:string;api:Api
}) {
  const base='workspaces/'+workspaceId+'/agent-plugin-sessions'
  const [sessions,setSessions]=useState<Session[]>([])
  const [error,setError]=useState('')
  const [busy,setBusy]=useState(false)
  const [filter,setFilter]=useState<Plugin>()

  async function refresh() { setSessions(await api<Session[]>(base)) }
  async function run(action:()=>Promise<void>) {
    setError('')
    setBusy(true)
    try { await action() }
    catch(cause){setError(cause instanceof Error?cause.message:'操作失败')}
    finally{setBusy(false)}
  }

  useEffect(()=>{void run(refresh)},[base,api])
  const rows: DeviceRow[] = sessions.filter(row=>!filter || row.plugin===filter).flatMap(row =>
    row.instances?.length
      ? row.instances.map(instance => ({ ...row, instanceId:instance.id, hostName:instance.hostName,
        pluginVersion:instance.pluginVersion, lastSeen:instance.lastSeen }))
      : [{ ...row, instanceId:row.id }],
  )

  return <>
    <Space wrap style={{marginBottom:12}}>
      <Select<Plugin> allowClear value={filter} onChange={setFilter} placeholder="所有插件" aria-label="筛选插件"
        style={{minWidth:170}} options={[{value:'dsh',label:names.dsh},{value:'opencode',label:names.opencode}]} />
      <Button loading={busy} onClick={()=>void run(refresh)}>刷新</Button>
    </Space>
    {error && <Alert type="error" title={error} showIcon />}
    <Table<DeviceRow> rowKey={row=>row.id+'/'+row.instanceId} size="small" loading={busy} dataSource={rows} scroll={{x:1160}}
      locale={{emptyText:'当前工作空间暂无可见的插件登录设备。'}}
      columns={[
        {title:'用户',dataIndex:'email'},
        {title:'插件',dataIndex:'plugin',render:(value:Plugin)=><Tag color={value==='dsh'?'blue':'purple'}>{names[value]}</Tag>},
        {title:'客户端 / 版本',render:(_,row)=>row.device+' · '+row.pluginVersion},
        {title:'设备名',dataIndex:'hostName',render:(value?:string)=>value || '未上报'},
        {title:'实例识别号',render:(_,row)=><Typography.Text code title={row.instanceId}
          copyable={{text:row.instanceId,tooltips:['复制完整识别号','已复制']}}>{row.instanceId.slice(0,8)}</Typography.Text>},
        {title:'状态',dataIndex:'status',render:(value:string)=><Tag color={value==='active'?'green':undefined}>{statuses[value]}</Tag>},
        {title:'登录时间',dataIndex:'createdAt',render:date},
        {title:'最近活跃',dataIndex:'lastSeen',render:date},
        {title:'操作',render:(_,row)=>row.status==='active' &&
          <Popconfirm title="撤销此登录对当前工作空间的访问？"
            description="同一登录下的客户端实例会一起失去访问权限。" onConfirm={()=>run(async()=>{
            await api(base+'/'+row.id,'DELETE')
            await refresh()
          })}><Button type="link" danger disabled={busy}>撤销访问</Button></Popconfirm>},
      ]} />
  </>
}
