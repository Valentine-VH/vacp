import { useEffect, useState } from 'react'
import { Alert, Button, Card, Empty, Flex, Input, List, Popconfirm, Select, Space, Tag, Typography } from 'antd'

type Host = 'dsh' | 'opencode'
type Source = {
  id: string; fullName: string; description: string | null; stars: number
  updatedAt: string | null; archived: boolean; host: Host
}
type SearchResults = { items: Source[]; incomplete: boolean }
type Api = <T>(path: string, method?: string, body?: object) => Promise<T>
const sourceKey = (source: Source) => source.id + '/' + source.host
const hostOptions = [{ value: 'dsh', label: 'DeepSeek Harness' }, { value: 'opencode', label: 'OpenCode' }]
const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback

export function GitHubPluginSources({ workspaceId, writable, api }: { workspaceId: string; writable: boolean; api: Api }) {
  const base = 'workspaces/' + workspaceId + '/agent-plugin-github'
  const [sources, setSources] = useState<Source[]>([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState('')
  const [revision, setRevision] = useState(0)
  const [host, setHost] = useState<Host>('dsh')
  const [query, setQuery] = useState('')
  const [repository, setRepository] = useState('')
  const [results, setResults] = useState<SearchResults>()
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [pending, setPending] = useState('')
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string }>()

  useEffect(() => {
    let active = true
    setLoading(true)
    setListError('')
    void api<Source[]>(base).then(data => { if (active) setSources(data) })
      .catch(error => { if (active) setListError(errorMessage(error, 'GitHub 来源加载失败')) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [api, base, revision])

  async function search(value: string) {
    setSearching(true)
    setResults(undefined)
    setSearchError('')
    try {
      setResults(await api<SearchResults>(base + '/search?' + new URLSearchParams({ host, q: value.trim() })))
    } catch (error) {
      setSearchError(errorMessage(error, 'GitHub 搜索失败'))
    } finally {
      setSearching(false)
    }
  }

  async function add(name: string, target: Host, key: string) {
    setPending(key)
    setFeedback(undefined)
    try {
      const source = await api<Source>(base, 'POST', { repository: name, host: target })
      setSources(previous => [source, ...previous.filter(item => sourceKey(item) !== sourceKey(source))])
      if (key === 'manual') setRepository('')
      setFeedback({ type: 'success', text: '已添加 ' + source.fullName })
    } catch (error) {
      setFeedback({ type: 'error', text: errorMessage(error, '添加失败') })
    } finally {
      setPending('')
    }
  }

  async function remove(source: Source) {
    const key = sourceKey(source)
    setPending(key)
    setFeedback(undefined)
    try {
      await api<void>(base + '/' + key, 'DELETE')
      setSources(previous => previous.filter(item => sourceKey(item) !== key))
    } catch (error) {
      setFeedback({ type: 'error', text: errorMessage(error, '移除失败') })
    } finally {
      setPending('')
    }
  }

  const writesBlocked = loading || !!listError || !!pending
  function row(source: Source, saved: boolean) {
    const key = sourceKey(source)
    const url = 'https://github.com/' + source.fullName
    const alreadySaved = sources.some(item => sourceKey(item) === key)
    return <List.Item key={key} actions={[
      <Button key="releases" href={url + '/releases'} target="_blank" rel="noreferrer">查看 Releases</Button>,
      ...(writable ? [saved
        ? <Popconfirm key="remove" title="从当前工作空间移除该条目？" okText="确认移除" cancelText="取消"
          onConfirm={() => remove(source)} disabled={writesBlocked}>
          <Button danger type="text" autoInsertSpace={false} loading={pending === key} disabled={writesBlocked}>移除</Button>
        </Popconfirm>
        : <Button key="add" type="primary" autoInsertSpace={false} loading={pending === key}
          disabled={alreadySaved || writesBlocked} onClick={() => void add(source.fullName, source.host, key)}>
          {alreadySaved ? '已添加' : '添加'}
        </Button>] : []),
    ]}>
      <List.Item.Meta title={<Space wrap>
        <a href={url} target="_blank" rel="noreferrer">{source.fullName}</a>
        <Tag>{source.host === 'dsh' ? 'DSH' : 'OpenCode'}</Tag>
        {source.archived && <Tag color="orange">已归档</Tag>}
      </Space>} description={<Space orientation="vertical" size={4}>
        {source.description && <Typography.Text>{source.description}</Typography.Text>}
        <Typography.Text type="secondary">
          ★ {source.stars.toLocaleString()} {source.updatedAt && ' · 推送于 ' + new Date(source.updatedAt).toLocaleDateString('zh-CN')}
        </Typography.Text>
      </Space>} />
    </List.Item>
  }

  return <Flex vertical gap={16}>
    <Card title="发现 GitHub 插件">
      <Flex vertical gap={12}>
        <Typography.Text type="secondary">搜索公开仓库，安装前请查阅作者的 README 和发布说明。客户端标签用于归类。</Typography.Text>
        <Flex gap={8} wrap="wrap">
          <Select aria-label="目标客户端" options={hostOptions} value={host} disabled={searching || !!pending}
            style={{ minWidth: 175 }} onChange={value => { setHost(value); setResults(undefined); setSearchError('') }} />
          <Input.Search aria-label="GitHub 仓库搜索" placeholder={host === 'dsh' ? '如 dsh-find-plugin 或 DSH-*' : '如 opencode 插件仓库名称'}
            value={query} maxLength={80} style={{ flex: '1 1 260px' }} allowClear
            onChange={event => setQuery(event.target.value)} onSearch={value => void search(value)}
            enterButton={query.trim() ? '搜索 GitHub' : '发现热门插件'} loading={searching} />
        </Flex>
        {searchError && <Alert type="error" showIcon title={searchError} />}
        {results && <>
          {results.incomplete && <Alert type="info" showIcon title="GitHub 返回了部分结果，可以缩小搜索范围后重试" />}
          <List dataSource={results.items} renderItem={source => row(source, false)}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="未找到符合条件的仓库" /> }} />
        </>}
      </Flex>
    </Card>
    <Card title="工作空间的 GitHub 来源" extra={listError &&
      <Button onClick={() => setRevision(value => value + 1)}>重试</Button>}>
      <Flex vertical gap={12}>
        {writable && <form onSubmit={event => {
          event.preventDefault()
          if (repository.trim() && !writesBlocked) void add(repository.trim(), host, 'manual')
        }}>
          <Flex gap={8} wrap="wrap">
            <Input aria-label="GitHub 仓库地址" placeholder="https://github.com/owner/repo 或 owner/repo"
              value={repository} maxLength={200} style={{flex:'1 1 260px'}} onChange={event => setRepository(event.target.value)} />
            <Button htmlType="submit" loading={pending === 'manual'} disabled={writesBlocked || !repository.trim()}>
              添加到 {host === 'dsh' ? 'DSH' : 'OpenCode'} 列表
            </Button>
          </Flex>
        </form>}
        {listError && <Alert type="error" showIcon title={listError} />}
        {feedback && <Alert type={feedback.type} showIcon title={feedback.text} />}
        {!listError && <List loading={loading} dataSource={sources} renderItem={source => row(source, true)}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前工作空间还没有 GitHub 来源" /> }} />}
      </Flex>
    </Card>
  </Flex>
}
