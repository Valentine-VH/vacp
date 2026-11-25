import { useEffect, useState } from 'react'
import { Alert, Card, Col, Row, Segmented, Select, Space, Statistic, Table, Typography } from 'antd'
import type { TableColumnsType } from 'antd'

type Totals = {requests:number;failed:number;cancelled:number;reported:number;inputTokens:number;outputTokens:number;totalTokens:number}
type UsageRow = Totals & {userId?:string|null;email?:string|null;useCase?:string}
type Usage = {total:Totals;users:UsageRow[];useCases:UsageRow[]}
type Api = <T>(path:string,method?:string,body?:object)=>Promise<T>
const format = new Intl.NumberFormat('zh-CN')
const number = (value:number) => format.format(value)
const tokens = (value:number,row:UsageRow) => row.reported ? number(value) : '—'

export function ModelGatewayUsage({path,models,api,revision}:{
  path:string;models:string[];api:Api;revision:number
}) {
  const [days,setDays] = useState('7')
  const [model,setModel] = useState<string>()
  const [dimension,setDimension] = useState<'user'|'case'>('user')
  const [usage,setUsage] = useState<Usage>()
  const [loading,setLoading] = useState(true)
  const [error,setError] = useState('')

  useEffect(()=>{
    let active = true
    const params = new URLSearchParams({days,...(model ? {model} : {})})
    setLoading(true)
    setUsage(undefined)
    setError('')
    void api<Usage>(path+'/usage?'+params).then(value=>{
      if (active) setUsage(value)
    }).catch(cause=>{
      if (active) setError(cause instanceof Error ? cause.message : '读取统计失败')
    }).finally(()=>{
      if (active) setLoading(false)
    })
    return ()=>{active=false}
  },[path,api,days,model,revision])

  const total = usage?.total
  const byUser = dimension==='user'
  const columns:TableColumnsType<UsageRow> = [
    {title:byUser?'用户':'用例',render:(_,row)=>byUser
      ? row.email ?? (row.userId ? '已删除用户 · '+row.userId.slice(0,8) : '共享 Key')
      : row.useCase},
    {title:'请求数',dataIndex:'requests',align:'right',render:number},
    {title:'失败',dataIndex:'failed',align:'right',render:number},
    {title:'取消',dataIndex:'cancelled',align:'right',render:number},
    {title:'输入 Token',dataIndex:'inputTokens',align:'right',render:tokens},
    {title:'输出 Token',dataIndex:'outputTokens',align:'right',render:tokens},
    {title:'总 Token',dataIndex:'totalTokens',align:'right',render:tokens},
    {title:'用量覆盖',align:'right',render:(_,row)=>number(row.reported)+' / '+number(row.requests)},
  ]

  return <Space orientation="vertical" size={16} style={{display:'flex'}}>
    <Space wrap>
      <Segmented aria-label="统计时间范围" value={days} onChange={setDays} options={[
        {label:'近 24 小时',value:'1'},{label:'近 7 天',value:'7'},{label:'近 30 天',value:'30'},
      ]}/>
      <Select allowClear aria-label="筛选网关模型" placeholder="全部模型" value={model} onChange={setModel}
        style={{minWidth:160}} options={models.map(value=>({value,label:value}))}/>
    </Space>
    {error && <Alert type="error" title={error} showIcon/>}
    {total && <Row gutter={[12,12]}>
      <Col xs={12} lg={6}><Card size="small"><Statistic title="请求数" value={total.requests}/></Card></Col>
      <Col xs={12} lg={6}><Card size="small"><Statistic title="失败请求" value={total.failed}/></Card></Col>
      <Col xs={12} lg={6}><Card size="small"><Statistic title="总 Token" value={total.reported ? total.totalTokens : '—'}/></Card></Col>
      <Col xs={12} lg={6}><Card size="small"><Statistic title="返回用量的请求" value={number(total.reported)+' / '+number(total.requests)}/></Card></Col>
    </Row>}
    <Segmented aria-label="统计维度" value={dimension} onChange={setDimension} options={[
      {label:'按用户',value:'user'},{label:'按用例',value:'case'},
    ]}/>
    <Table<UsageRow> key={dimension} loading={loading} columns={columns} size="small" scroll={{x:840}}
      rowKey={row=>byUser ? row.userId ?? 'shared-keys' : row.useCase!}
      dataSource={byUser ? usage?.users : usage?.useCases} locale={{emptyText:'所选范围暂无调用记录'}}/>
    <Typography.Text type="secondary">
      统计通过网关校验的对话请求。Token 以模型上游返回的数据为准。插件请求按登录用户和客户端类型归类，共享 Key 按签发或编辑时设置的用例归类。
    </Typography.Text>
  </Space>
}
