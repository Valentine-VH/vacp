import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Empty, Form, Input, List, Modal, Select, Space, Tag, Typography } from 'antd'
import './agent-teams.css'

type Participant = { id:string; name:string; kind:'human'|'agent'; online:boolean }
type Room = { id:string; kind:'group'|'direct'; name:string|null; participants:Participant[] }
type Message = { id:string; sender:string; body:string; createdAt:string; agentName:string|null; agentStatus:string|null; agentReply:string|null }
type Api = <T>(path:string,method?:string,body?:object)=>Promise<T>
type Group = { name:string; userIds?:string[]; agentIds?:string[] }

export function AgentTeams({ workspaceId,userId,writable,api }: {
  workspaceId:string; userId:string; writable:boolean; api:Api
}) {
  const base = 'workspaces/' + workspaceId + '/agent-teams'
  const [rooms,setRooms] = useState<Room[]>([])
  const [selected,setSelected] = useState('')
  const [messages,setMessages] = useState<Message[]>([])
  const [directory,setDirectory] = useState<Participant[]>([])
  const [creating,setCreating] = useState<'group'|'direct'>()
  const [text,setText] = useState('')
  const [target,setTarget] = useState<string>()
  const [busy,setBusy] = useState(false)
  const [error,setError] = useState('')
  const [refreshError,setRefreshError] = useState('')
  const [messageError,setMessageError] = useState('')
  const timeline = useRef<HTMLDivElement>(null)
  const followLatest = useRef(true)
  const current = rooms.find(room=>room.id===selected)

  function title(room:Room) {
    return room.name ?? room.participants.find(part=>part.id!==userId)?.name ?? '私聊'
  }

  useEffect(()=>{
    let active=true
    let timer:ReturnType<typeof setTimeout>
    async function poll() {
      try {
        const next=await api<Room[]>(base+'/rooms')
        if (!active) return
        setRooms(next)
        setRefreshError('')
      } catch {
        if (active) setRefreshError('无法刷新会话列表，正在重试')
      }
      if (active) timer=setTimeout(poll,3000)
    }
    void poll()
    return ()=>{active=false;clearTimeout(timer)}
  },[base,api])

  useEffect(()=>{
    setMessages([])
    setMessageError('')
    followLatest.current=true
    setTarget(undefined)
    setText('')
    if (!selected) return
    let active=true
    let timer:ReturnType<typeof setTimeout>
    async function poll() {
      try {
        const next=await api<Message[]>(base+'/rooms/'+selected+'/messages')
        if (active) { setMessages(next); setMessageError('') }
      } catch (cause) {
        if (active) {
          setMessages([])
          setMessageError(cause instanceof Error ? cause.message : '无法读取消息，正在重试')
        }
      }
      if (active) timer=setTimeout(poll,1600)
    }
    void poll()
    return ()=>{active=false;clearTimeout(timer)}
  },[base,api,selected])

  useEffect(()=>{
    const panel=timeline.current
    if (panel && followLatest.current) panel.scrollTop=panel.scrollHeight
  },[messages])

  async function run(action:()=>Promise<void>) {
    setBusy(true)
    setError('')
    try { await action() }
    catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败') }
    finally { setBusy(false) }
  }

  function open(kind:'group'|'direct') {
    return run(async ()=>{
      setDirectory(await api(base+'/directory'))
      setCreating(kind)
    })
  }

  function create(values:Group|{participant:string}) {
    return run(async ()=>{
      const data = 'participant' in values
        ? {kind:'direct',userIds:values.participant.startsWith('human:')?[values.participant.slice(6)]:[],
          agentIds:values.participant.startsWith('agent:')?[values.participant.slice(6)]:[]}
        : {kind:'group',name:values.name,userIds:values.userIds??[],agentIds:values.agentIds??[]}
      const created = await api<{id:string}>(base+'/rooms','POST',data)
      setRooms(await api(base+'/rooms'))
      setSelected(created.id)
      setCreating(undefined)
    })
  }

  function send() {
    if (!current || !text.trim()) return
    return run(async ()=>{
      await api(base+'/rooms/'+current.id+'/messages','POST',{content:text,...(target ? {agentId:target} : {})})
      followLatest.current=true
      setText('')
    })
  }

  const options = (kind:'human'|'agent') => directory.filter(item=>item.kind===kind)
    .map(item=>({value:item.id,label:item.name + (kind==='agent' ? ' · Mock Agent' : '')}))
  const agents=current?.participants.filter(item=>item.kind==='agent')??[]
  return <div className="agent-teams">
    <Card size="small" title="会话" className="agent-teams-sidebar">
      {writable && <Space wrap>
        <Button type="primary" disabled={busy} onClick={()=>void open('group')}>新建群聊</Button>
        <Button disabled={busy} onClick={()=>void open('direct')}>发起私聊</Button>
      </Space>}
      {refreshError && <Alert type="warning" title={refreshError} />}
      <List<Room> dataSource={rooms} locale={{emptyText:'暂无会话'}} renderItem={room=>
        <List.Item>
          <Button block type={selected===room.id?'primary':'text'} disabled={busy}
            aria-pressed={selected===room.id} onClick={()=>{setError('');setSelected(room.id)}}>
            <span className="agent-teams-room-name">{title(room)}</span><span>{room.kind==='group'?'群聊':'私聊'}</span>
          </Button>
        </List.Item>
      } />
    </Card>
    <Card title={current ? title(current) : 'Team'} className="agent-teams-thread">
      {error && <Alert type="error" title={error} showIcon />}
      {!current ? <Empty description="选择一个会话，或创建群聊与私聊" /> : <>
        <Space wrap className="agent-teams-roster">{current.participants.map(part=>
          <Tag key={part.kind+part.id} color={part.kind==='agent'?'blue':undefined}>
            {part.name}{part.kind==='agent' ? ' · Mock Agent' + (part.online?' 在线':' 离线') : ''}
          </Tag>
        )}</Space>
        <div className="agent-teams-messages" ref={timeline} aria-label="最近 100 条消息" onScroll={event=>{
          const panel=event.currentTarget
          followLatest.current=panel.scrollHeight-panel.scrollTop-panel.clientHeight<40
        }}>
          {messageError && <Alert type="warning" title={messageError} showIcon />}
          {!messages.length && !messageError && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无消息" />}
          {messages.map(msg=><div key={msg.id} className="agent-teams-message">
            <Typography.Text strong>{msg.sender}</Typography.Text>
            <time dateTime={msg.createdAt}>{new Date(msg.createdAt).toLocaleString('zh-CN')}</time>
            <p>{msg.body}</p>
            {msg.agentName && <div className="agent-teams-reply">
              <Typography.Text strong>{msg.agentName} · Mock Agent</Typography.Text>
              <p>{msg.agentReply ?? (msg.agentStatus==='running'?'正在处理':'等待回复')}</p>
            </div>}
          </div>)}
        </div>
        {writable && <form onSubmit={event=>{event.preventDefault();void send()}}>
          {current.kind==='group' && agents.length>0 && <Select placeholder="发给全群，或选择回复的 Agent"
            aria-label="回复的 Agent" allowClear value={target} onChange={setTarget} disabled={busy}
            style={{width:'100%',marginBottom:8}} options={agents.map(agent=>({
              value:agent.id,label:agent.name + (agent.online?' · 在线':' · 离线'),disabled:!agent.online,
            }))} />}
          <Input.TextArea aria-label="消息内容" value={text} onChange={event=>setText(event.target.value)}
            maxLength={2000} rows={2} disabled={busy} placeholder="输入消息" />
          <Button type="primary" htmlType="submit" loading={busy} disabled={!text.trim()} style={{marginTop:8}}>发送</Button>
        </form>}
      </>}
    </Card>
    <Modal title={creating==='group'?'新建群聊':'发起私聊'} open={Boolean(creating)} footer={null} destroyOnHidden
      onCancel={()=>{if(!busy)setCreating(undefined)}}>
      {error && <Alert type="error" title={error} showIcon />}
      {creating==='group' ? <Form<Group> key="group" name="team-group" layout="vertical" disabled={busy} onFinish={create}>
        <Form.Item name="name" label="群聊名称" rules={[{required:true,whitespace:true}]}><Input maxLength={80} /></Form.Item>
        <Form.Item name="userIds" label="工作空间成员"><Select mode="multiple" options={options('human')} /></Form.Item>
        <Form.Item name="agentIds" label="Agent"><Select mode="multiple" options={options('agent')} /></Form.Item>
        <Button type="primary" loading={busy} htmlType="submit">创建群聊</Button>
      </Form> : <Form<{participant:string}> key="direct" name="team-direct" layout="vertical" disabled={busy} onFinish={create}>
        <Form.Item name="participant" label="私聊对象" rules={[{required:true}]}>
          <Select options={directory.map(item=>({value:item.kind+':'+item.id,label:item.name+(item.kind==='agent'?' · Mock Agent':'')}))} />
        </Form.Item>
        <Button type="primary" loading={busy} htmlType="submit">打开会话</Button>
      </Form>}
    </Modal>
  </div>
}
