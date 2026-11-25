import type { ReactNode } from 'react'
import { Flex, Typography } from 'antd'
import { Conversations, Welcome, type ConversationsProps, type WelcomeProps } from '@ant-design/x'
import { ChatComposer, type ChatComposerProps } from './ChatComposer'
import { ChatTranscript, type ChatTranscriptProps } from './ChatTranscript'

export type ChatPanelProps = ChatTranscriptProps & {
  composer?: ChatComposerProps
  conversations?: ConversationsProps
  welcome?: WelcomeProps
  header?: ReactNode
  status?: ReactNode
}

export function ChatPanel({ composer, conversations, welcome, header, status, empty, ...transcript }: ChatPanelProps) {
  return <div className={conversations ? 'vacp-chat-layout' : undefined}>
    {conversations && <aside aria-label="会话列表" className="vacp-chat-conversations">
      <Typography.Text strong className="vacp-chat-list-heading">会话</Typography.Text>
      <Conversations {...conversations} />
    </aside>}
    <Flex vertical gap={12} className="vacp-chat-main">
      {header}
      <ChatTranscript {...transcript} empty={welcome ? <Welcome {...welcome} /> : empty} />
      {status}
      {composer && <ChatComposer {...composer} />}
    </Flex>
  </div>
}
