import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Card, Flex, Select, Tag, Typography, Upload } from 'antd'
import type { AttachmentsProps, ConversationsProps } from '@ant-design/x'
import { ChatPanel, type ChatMessage } from './components/chat'
import './dsh-conversations.css'

type Session = { id: string; title: string }
type Device = { id: string; name: string; hostName?: string; instanceId?: string; files?: boolean; sessions: Session[] }
type Message = { seq: number; role: 'assistant' | 'user'; text: string; files?: { name: string; bytes: number }[] }
type Frame = { type: 'snapshot'; messages: Message[]; draft: string; running?: boolean }
  | { type: 'message'; message: Message } | { type: 'draft'; text?: string; reset?: boolean }
  | { type: 'activity' }
  | { type: 'state'; result: string }
type Api = <T>(path: string, method?: string, body?: object) => Promise<T>
type Attachments = NonNullable<AttachmentsProps['items']>
type FileRelay = { enabled: boolean; maxFiles: number; maxTotalKiB: number }

function encodeFile(file: File) {
  return new Promise<{name: string;data: string}>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('无法读取附件 ' + file.name))
    reader.onload = () => resolve({ name: file.name, data: String(reader.result).split(',')[1] })
    reader.readAsDataURL(file)
  })
}

export default function DshConversations({ workspaceId, api }: { workspaceId: string; api: Api }) {
  const base = 'workspaces/' + workspaceId + '/dsh-conversations'
  const [devices, setDevices] = useState<Device[]>([])
  const [fileRelay, setFileRelay] = useState<FileRelay>()
  const [error, setError] = useState('')
  const [selection, setSelection] = useState({ device: '', session: '' })

  useEffect(() => {
    let active = true
    let refresh: ReturnType<typeof setTimeout>
    async function load() {
      try {
        const [data, settings] = await Promise.all([api<Device[]>(base),api<FileRelay>(base + '/file-relay-settings')])
        if (active) {
          setDevices(data)
          setFileRelay(settings)
          setError('')
          setSelection(previous => {
            const device = data.find(item => item.id === previous.device)
            // Keep the selection while the same device reconnects.
            return device && previous.session && !device.sessions.some(item => item.id === previous.session)
              ? { ...previous, session: '' }
              : previous
          })
        }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : '设备列表加载失败')
      } finally {
        if (active) refresh = setTimeout(load, 2500)
      }
    }
    void load()
    return () => { active = false; clearTimeout(refresh) }
  }, [api, base])

  const device = devices.find(item => item.id === selection.device)
  const session = device?.sessions.find(item => item.id === selection.session)
  const channel = selection.session
    ? base + '/' + encodeURIComponent(selection.device) + '/' + encodeURIComponent(selection.session)
    : ''
  const conversations: ConversationsProps = {
    items: device?.sessions.map(session => ({ key: session.id, label: session.title })) ?? [],
    activeKey: selection.session || undefined,
    onActiveChange(key) {
      if (device?.sessions.some(session => session.id === key)) setSelection({ device: device.id, session: key })
    },
  }
  const welcome = device
    ? device.sessions.length
      ? { title: '选择会话', description: '在左侧选择该 Agent 客户端上已授权的会话。' }
      : { title: '此客户端暂无已授权会话', description: '请在该客户端打开「VACP → Chat 授权」。' }
    : selection.device
      ? { title: '客户端离线', description: '客户端重新上线后会恢复会话列表。' }
      : { title: '先选 Agent 客户端', description: devices.length
        ? '选定客户端后，左侧将显示它的已授权会话。'
        : '请启动 DSH 客户端并在「VACP → Chat 授权」中授权会话。' }
  return <Card title="DSH 会话">
    <Flex vertical gap={16} className="dsh-conversations">
      <Flex align="center" wrap="wrap" gap={8}>
        <Typography.Text strong>Agent 客户端</Typography.Text>
        <Select aria-label="Agent 客户端" className="dsh-client-select" value={device?.id}
          placeholder={selection.device && !device ? '所选客户端离线' : '选择在线客户端'}
          notFoundContent="暂无在线客户端" loading={!fileRelay && !error}
          options={devices.map(item => ({ value: item.id,
            label: [item.name, item.hostName, (item.instanceId ?? item.id).slice(0, 8)].filter(Boolean).join(' · '),
          }))}
          onChange={id => setSelection({ device: id, session: '' })} />
      </Flex>
      {error && <Alert type="error" title={error} showIcon />}
      {channel ? <Conversation key={channel} channel={channel} online={Boolean(session)}
        fileRelay={device?.files === true ? fileRelay : undefined} title={session?.title} conversations={conversations} api={api} />
        : <ChatPanel messages={[]} conversations={conversations} welcome={welcome} />}
    </Flex>
  </Card>
}

function Conversation({ channel, online, api, fileRelay, title, conversations }: {
  channel: string; online: boolean; api: Api; fileRelay?: FileRelay; title?: string; conversations: ConversationsProps
}) {
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const [running, setRunning] = useState(false)
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachments>([])
  const [connected, setConnected] = useState(false)
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState('')
  const [turnError, setTurnError] = useState('')
  const [snapshot, setSnapshot] = useState(false)
  const busy = useRef(false)
  const attachmentsEnabled = fileRelay?.enabled === true
  const fileLimit = (fileRelay?.maxTotalKiB ?? 0) * 1024
  const maxFiles = fileRelay?.maxFiles ?? 0
  const fileLimitHint = '最多 ' + maxFiles + ' 个文件，合计 ' + fileRelay?.maxTotalKiB + ' KiB'
  const exceedsLimit = (files: Attachments) => files.length > maxFiles ||
    files.reduce((total, file) => total + (file.size ?? 0), 0) > fileLimit

  useEffect(() => {
    if (fileRelay?.enabled === false) setAttachments([])
  }, [fileRelay?.enabled])

  useEffect(() => {
    setConnected(false)
    if (!online) {
      setMessages([])
      setDraft('')
      setRunning(false)
      setSnapshot(false)
      return
    }
    const source = new EventSource('/api/v1/' + channel + '/stream')
    let retry: ReturnType<typeof setTimeout>
    let active = source
    let stopped = false

    function listen(stream: EventSource) {
      stream.onerror = () => {
        if (stopped) return
        setConnected(false)
        stream.close()
        retry = setTimeout(() => {
          active = new EventSource('/api/v1/' + channel + '/stream')
          listen(active)
        }, 1800)
      }
      stream.onmessage = event => {
        if (stopped) return
        const frame = JSON.parse(event.data) as Frame
        switch (frame.type) {
          case 'snapshot':
            setMessages(frame.messages)
            setDraft(frame.draft)
            setRunning(frame.running === true)
            setConnected(true)
            setSnapshot(true)
            break
          case 'message':
            setMessages(previous => [...previous.filter(item => item.seq !== frame.message.seq), frame.message].slice(-40))
            if (frame.message.role === 'assistant') setDraft('')
            break
          case 'draft':
            setDraft(previous => frame.reset ? '' : (previous + (frame.text ?? '')).slice(0, 8000))
            break
          case 'activity':
            setRunning(true)
            setTurnError('')
            break
          case 'state':
            setDraft('')
            setRunning(false)
            setTurnError(frame.result === 'completed' ? '' : 'DSH 本轮未正常完成，请在原客户端查看详情。')
            break
        }
      }
    }

    listen(source)
    return () => { stopped = true; active.close(); clearTimeout(retry) }
  }, [channel, online])

  async function send(value: string) {
    if (busy.current || !connected || !online || (!value.trim() && !attachments.length)) return
    if (attachments.length && (!attachmentsEnabled || exceedsLimit(attachments))) {
      setNotice(attachmentsEnabled ? '附件超过当前限制，请移除部分文件后再发送。' : '附件中转已停用或当前设备不支持。')
      return
    }
    busy.current = true
    setPending(true)
    setNotice('')
    setTurnError('')
    const body = { id: crypto.randomUUID(), text: value.trim() }
    try {
      let files
      try {
        if (attachments.length) files = await Promise.all(attachments.map(item => {
          if (!item.originFileObj) throw new Error('请重新选择附件 ' + item.name)
          return encodeFile(item.originFileObj)
        }))
      } catch (error) {
        setNotice(error instanceof Error ? error.message : '附件读取失败')
        return
      }
      setText('')
      const result = await api<{ status: string }>(channel + '/messages', 'POST', { ...body, files })
      if (result.status === 'rejected') {
        setNotice('DSH 拒绝接收，请检查原会话状态。')
        setText(current => current || body.text)
      } else {
        setAttachments([])
        if (result.status !== 'accepted') setNotice('投递结果未知。重连后请先核对原会话记录。')
      }
    } catch (error) {
      if (error instanceof Error && 'status' in error && [400,403,404,409,413,429].includes(Number(error.status))) {
        setText(current => current || body.text)
        setNotice(error.message)
      } else {
        setAttachments([])
        setNotice('无法确认投递结果。请先核对原会话记录。')
      }
    } finally {
      busy.current = false
      setPending(false)
    }
  }

  const history = useMemo<ChatMessage[]>(() =>
    messages.map(({ seq, role, text, files }) => ({ id: seq, role, text,
      files: files?.map((file, i) => ({ key: seq + '-' + i, name: file.name, byte: file.bytes })),
    })), [messages])
  const items: ChatMessage[] = draft
    ? [...history, { id: 'live-reply', role: 'assistant', text: draft, status: 'streaming' }]
    : running && connected
      ? [...history, { id: 'live-reply', role: 'assistant', text: '', status: 'loading' }]
      : history
  return <ChatPanel messages={items} assistantName="DSH" conversations={conversations}
    header={<Flex justify="space-between" align="center" className="dsh-conversation-status">
      <Typography.Text ellipsis strong>{title ?? '原 DSH 会话'}</Typography.Text>
      <Tag color={connected && online ? 'green' : 'orange'}>{connected && online ? '已连接' : online ? '正在连接' : '设备离线'}</Tag>
    </Flex>}
    empty={<Typography.Text type="secondary">
      {snapshot ? '暂无可显示的文本消息' : online ? '正在等待会话记录…' : '设备重新在线后会恢复会话'}
    </Typography.Text>}
    status={(notice || turnError) && <Flex vertical gap={8}>
      {notice && <Alert type="warning" title={notice} showIcon />}
      {turnError && <Alert type="warning" title={turnError} showIcon />}
    </Flex>}
    composer={{ value: text, onChange: setText, onSubmit: value => void send(value),
      disabled: !connected || !online, submitting: pending, placeholder: '给原会话发消息', maxLength: 8000,
      tools: fileRelay?.enabled === false ? <Tag>附件中转已停用</Tag> : undefined,
      attachments: attachmentsEnabled ? {
        items: attachments, disabled: pending, multiple: true, overflow: 'wrap',
        placeholder: { title: '添加附件', description: fileLimitHint + '，随消息一起发送。' },
        beforeUpload(file) {
          if (!file.size || file.size > fileLimit || file.name.length > 160) {
            setNotice('请选择非空且符合大小限制的文件。文件名最多 160 字符。')
            return Upload.LIST_IGNORE
          }
          return false
        },
        onChange({ fileList }) {
          const files = fileList.filter(file => file.status !== 'removed')
          if (exceedsLimit(files)) {
            setNotice(fileLimitHint + '。')
            return
          }
          setAttachments(files.map(file => ({ ...file, status: 'done' })))
        },
      } : undefined,
    }} />
}
