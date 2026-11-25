import { lazy, memo, Suspense, type ReactNode } from 'react'
import { Avatar, Button, Flex, Typography } from 'antd'
import {
  Actions, Bubble, FileCard, Sources, Think, ThoughtChain,
  type ActionsFeedbackProps, type ActionsProps, type BubbleItemType, type FileCardListProps,
  type SourcesProps, type ThoughtChainProps,
} from '@ant-design/x'
import { XMarkdown, type ComponentProps } from '@ant-design/x-markdown'
import '@ant-design/x-markdown/themes/light.css'
import './chat.css'

export type ChatFeedback = NonNullable<ActionsFeedbackProps['value']>

export type ChatMessage = {
  id: string | number
  role: 'user' | 'assistant'
  text: string
  status?: 'loading' | 'streaming' | 'success' | 'error' | 'aborted'
  author?: string
  avatar?: ReactNode
  summary?: ReactNode
  steps?: ThoughtChainProps['items']
  sources?: SourcesProps['items']
  files?: FileCardListProps['items']
  feedback?: ChatFeedback
  actions?: ActionsProps['items']
}

export type ChatTranscriptProps = {
  messages: readonly ChatMessage[]
  assistantName?: string
  empty?: ReactNode
  onFeedback?: (message: ChatMessage, value: ChatFeedback) => void
  onRetry?: (message: ChatMessage) => void
}

const sanitizer = { FORBID_TAGS: ['img'] }
const streaming = { hasNextChunk: true, incompleteMarkdown: 'complete', incremental: true } as const
const bubbleListStyles = { root: { height: '100%' } }
const CodeHighlighter = lazy(() => import('@ant-design/x/es/code-highlighter'))

function MarkdownCode({ children, lang, block, streamStatus }: ComponentProps) {
  if (!block) return <code>{children}</code>
  const plain = <pre><code>{children}</code></pre>
  if (streamStatus === 'loading' || typeof children !== 'string') return plain
  return <Suspense fallback={plain}>
    <CodeHighlighter lang={lang?.split(/\s+/)[0]}>{children}</CodeHighlighter>
  </Suspense>
}

const markdownComponents = {
  pre: ({ children }: ComponentProps) => <div className="vacp-chat-pre">{children}</div>,
  code: MarkdownCode,
}

function safeSources(items: NonNullable<ChatMessage['sources']>) {
  return items.map(item => ({
    ...item,
    url: item.url && /^https?:\/\//i.test(item.url) ? item.url : undefined,
  }))
}

function accessibleAction(action: NonNullable<ActionsProps['items']>[number]) {
  if (action.actionRender) return action
  if (action.subItems) return { ...action, icon: action.icon ?? action.label }
  return { ...action, actionRender: () => <Button type="text" size="small" danger={action.danger} icon={action.icon}
    onClick={() => action.onItemClick?.(action)}>{action.label}</Button> }
}

const MessageContent = memo(function MessageContent({ message }: { message: ChatMessage }) {
  const assistant = message.role === 'assistant'
  return <Flex vertical gap={8}>
    {assistant && message.summary && <Think title="运行摘要">{message.summary}</Think>}
    {assistant && Boolean(message.steps?.length) && <ThoughtChain items={message.steps} />}
    {message.text && (assistant
      ? <XMarkdown content={message.text} className="x-markdown-light" components={markdownComponents}
        escapeRawHtml openLinksInNewTab dompurifyConfig={sanitizer}
        streaming={message.status === 'streaming' ? streaming : false} />
      : <div className="vacp-chat-plain">{message.text}</div>)}
    {message.files?.length ? <FileCard.List items={message.files} size="small" overflow="wrap" /> : null}
    {message.sources?.length ? <Sources title="参考来源" defaultExpanded={false} items={safeSources(message.sources)} /> : null}
  </Flex>
})

export function ChatTranscript({ messages, assistantName = '助手', empty, onFeedback, onRetry }: ChatTranscriptProps) {
  const items: BubbleItemType[] = messages.map(message => {
    const assistant = message.role === 'assistant'
    const author = message.author ?? (assistant ? assistantName : '你')
    const live = message.status === 'streaming'
    const settled = !live && message.status !== 'loading'
    const feedback = assistant && onFeedback && settled && message.status !== 'error'
    const retry = assistant && onRetry && settled
    const actions: NonNullable<ActionsProps['items']> = [
      ...(retry ? [{ key: 'retry', label: '重新生成', onItemClick: () => onRetry(message) }] : []),
      ...(settled ? message.actions ?? [] : []),
    ]
    const footer = settled && (message.text || feedback || actions.length) ? <Flex align="center" gap={6} wrap>
      {message.text && <Actions.Copy text={message.text} aria-label="复制消息" />}
      {feedback && <Actions.Feedback value={message.feedback ?? 'default'}
        onChange={value => onFeedback(message, value)} />}
      {Boolean(actions.length) && <Actions items={actions.map(accessibleAction)} />}
    </Flex> : undefined
    return {
      key: message.id,
      role: message.role,
      content: <MessageContent message={message} />,
      status: message.status === 'streaming' ? 'updating' : message.status === 'aborted' ? 'abort' : message.status ?? 'success',
      streaming: live,
      loading: message.status === 'loading',
      loadingRender: () => <Typography.Text type="secondary" role="status">{author} · 生成中</Typography.Text>,
      placement: assistant ? 'start' : 'end',
      shape: assistant ? 'default' : 'corner',
      variant: assistant ? 'borderless' : 'filled',
      avatar: message.avatar ?? (assistant ? <Avatar size={34} className="vacp-chat-avatar">{author.slice(0, 1)}</Avatar> : undefined),
      header: live ? author + ' · 生成中' : author,
      classNames: { content: assistant ? 'vacp-chat-assistant' : 'vacp-chat-user' },
      footer,
    }
  })
  return <div role="region" aria-label="会话消息" className="vacp-chat-transcript">
    {items.length ? <Bubble.List items={items} autoScroll styles={bubbleListStyles} />
      : <div className="vacp-chat-empty">{empty ?? <Typography.Text type="secondary">暂无消息</Typography.Text>}</div>}
  </div>
}
