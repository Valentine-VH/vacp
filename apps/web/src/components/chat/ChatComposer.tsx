import { useRef, type ComponentPropsWithRef, type ComponentRef, type ReactNode } from 'react'
import { Button, Flex, Input, Typography } from 'antd'
import { Attachments, Prompts, Sender, Suggestion, type AttachmentsProps, type PromptsProps,
  type SenderProps, type SuggestionProps } from '@ant-design/x'
import './chat.css'

export type ChatComposerProps = {
  value: string
  onChange: (value: string) => void
  onSubmit: (value: string) => void
  onStop?: () => void
  placeholder?: string
  maxLength?: number
  disabled?: boolean
  submitting?: boolean
  generating?: boolean
  attachments?: AttachmentsProps
  prompts?: PromptsProps
  suggestions?: Pick<SuggestionProps, 'items' | 'onSelect'>
  speech?: SenderProps['allowSpeech']
  tools?: ReactNode
}

function ComposerInput(props: ComponentPropsWithRef<typeof Input.TextArea>) {
  return <Input.TextArea {...props} aria-label="聊天消息" />
}

const composerComponents = { input: ComposerInput }

export function ChatComposer({ value, onChange, onSubmit, onStop, placeholder = '输入消息', maxLength,
  disabled, submitting, generating, attachments, prompts, suggestions, speech, tools }: ChatComposerProps) {
  const attachmentsRef = useRef<ComponentRef<typeof Attachments>>(null)
  const cannotSend = Boolean(disabled || submitting || generating)
  const readyAttachments = attachments?.items?.some(file => file.status === 'done')
  const updateText = (text: string) => onChange(text.slice(0, maxLength))
  return <Flex vertical gap={8}>
    {Boolean(prompts?.items?.length) && <Prompts {...prompts} />}
    {attachments && <Attachments beforeUpload={attachments.customRequest || attachments.action ? undefined : () => false}
      {...attachments} ref={attachmentsRef} disabled={disabled || attachments.disabled} />}
    <Sender components={composerComponents} value={value} onChange={updateText} onSubmit={text => {
      if (!cannotSend && (text.trim() || readyAttachments)) onSubmit(text)
    }} disabled={disabled} loading={submitting} placeholder={placeholder} autoSize={{ minRows: 2, maxRows: 6 }}
      allowSpeech={speech} suffix={false}
      onPasteFile={attachments ? files => {
        if (!disabled && !attachments.disabled) Array.from(files).forEach(file => attachmentsRef.current?.upload(file))
      } : undefined}
      footer={(_, { components: { SendButton, SpeechButton } }) => <Flex justify="space-between" align="center" gap={8} wrap>
        <Flex gap={6} align="center" wrap>
          <Typography.Text type="secondary" className="vacp-chat-hint">Enter 发送 · Shift + Enter 换行</Typography.Text>
          {suggestions && <Suggestion items={suggestions.items} onSelect={suggestions.onSelect ?? updateText}>
            {({ onTrigger, onKeyDown, open }) => <Button size="small" type="text" disabled={disabled}
              aria-expanded={open} onKeyDown={onKeyDown} onClick={() => onTrigger(!open)}>输入建议</Button>}
          </Suggestion>}
          {tools}
        </Flex>
        <Flex gap={6}>
          {speech && <SpeechButton aria-label="语音输入" disabled={disabled} />}
          {generating && onStop && <Button onClick={onStop}>停止生成</Button>}
          <SendButton type="primary" shape="default" icon={null} aria-label="发送消息"
            disabled={cannotSend || (!value.trim() && !readyAttachments)} loading={submitting}>发送消息</SendButton>
        </Flex>
      </Flex>} />
  </Flex>
}
