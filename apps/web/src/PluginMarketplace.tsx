import { useEffect, useState } from 'react'
import { Alert, Button, Card, List, Modal, Space, Tabs, Tag, Typography } from 'antd'
import { GitHubPluginSources } from './GitHubPluginSources'

type PluginRelease = { version:string; filename:string; bytes:number; sha256:string }
type Plugin = { id:string; name:string; filename:string; available:boolean; releases?:PluginRelease[] }
type Api = <T>(path:string, method?:string, body?:object) => Promise<T>

function installPrompt(origin: string, downloadPath: string, plugin: Plugin) {
  return [
    '请在我指定的 '+plugin.name+' 实例中安装 VACP 插件。',
    '1. 使用我已登录的浏览器从以下地址下载插件包，并记下下载文件的完整本地路径。',
    new URL(downloadPath, origin).href,
    '   如果下载需要登录，请让我先在 VACP 完成登录。',
    ...(plugin.id === 'dsh' ? [
      '2. 在目标 DeepSeek Harness Desktop 打开「插件 → 添加插件」，输入下载的 .tgz 文件完整路径，然后点击「安装」。安装完成后点击「立即启用」。',
      '3. 确认左侧出现「VACP」，打开该页面，把服务地址填为 '+origin+'，停留在登录表单，由我输入邮箱和密码。',
    ] : [
      '2. 将 .tgz 解压到用户指定的插件目录，在目标 OpenCode 项目的 opencode.json(c) 中加入解压后的 package 目录。OpenCode V2 使用 plugins，V1.18.29 及以上使用 plugin。',
      '3. 检查目标实例是否加载了 vacp_plugin_catalog。可使用包里的 cli.js 列出或下载仓库版本，凭据由我在终端输入。',
    ]),
    '如有多个实例，请先确认安装目标。',
  ].join('\n')
}

export function PluginMarketplace({ workspaceId, writable, api }: { workspaceId:string; writable:boolean; api:Api }) {
  const [plugins,setPlugins] = useState<Plugin[]>([])
  const [busy,setBusy] = useState(true)
  const [error,setError] = useState('')
  const [revision,setRevision] = useState(0)
  const [guide,setGuide] = useState<Plugin>()
  const base = 'workspaces/' + workspaceId + '/agent-plugins'
  const origin = window.location.origin
  const downloadPath = (id: string, version?: string) => '/api/v1/' + base + '/' + id
    + (version ? '/versions/' + encodeURIComponent(version) : '') + '/download'
  const guidePath = guide ? downloadPath(guide.id, guide.releases?.[0]?.version) : ''

  useEffect(() => {
    let active = true
    setBusy(true)
    setError('')
    void api<Plugin[]>(base).then(result => { if (active) setPlugins(result) })
      .catch(cause => {
        if (active) {
          setPlugins([])
          setError(cause instanceof Error ? cause.message : '插件列表加载失败')
        }
      })
      .finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [api,base,revision])

  return <Tabs items={[
    { key: 'vacp', label: 'VACP 发布', children: <Card title="支持的客户端" extra={<Button loading={busy} onClick={() => setRevision(value => value + 1)}>刷新</Button>}>
    {error ? <Alert type="error" title={error} showIcon /> : <List<Plugin> loading={busy} dataSource={plugins}
      renderItem={plugin => <List.Item actions={
        plugin.available
          ? [
            <Button key="download" href={downloadPath(plugin.id,plugin.releases?.[0]?.version)}>下载最新版</Button>,
            <Button key="install" type="primary" onClick={() => setGuide(plugin)}>安装指南</Button>,
          ]
          : [<Button key="unpublished" disabled>暂不可下载</Button>]
      }>
        <List.Item.Meta title={<Space wrap>{plugin.name}<Tag color={plugin.available ? 'green' : undefined}>
          {plugin.available ? '可安装' : '待发布'}
        </Tag></Space>} description={plugin.releases?.length ? <Space orientation="vertical">
          {plugin.releases.map(release => <Space key={release.version} wrap>
            <Tag>{release.version}</Tag>
            <a href={downloadPath(plugin.id,release.version)}>{release.filename}</a>
            <Typography.Text type="secondary">{Math.ceil(release.bytes/1024)} KB</Typography.Text>
            <Typography.Text type="secondary" copyable={{text:release.sha256, tooltips:['复制 SHA-256','已复制']}}>SHA-256</Typography.Text>
          </Space>)}
        </Space> : plugin.available ? plugin.filename : '暂无可安装的 VACP 发布包'} />
      </List.Item>} />}
    <Modal title={guide && '安装 '+guide.name+' 插件'} open={!!guide} onCancel={() => setGuide(undefined)}
      footer={guide && <Button type="primary" href={guidePath}>下载插件包</Button>}>
      {guide && <>
        <ol>
          <li>下载 <code>{guide.filename}</code>。</li>
          {guide.id==='dsh' ? <>
            <li>在目标 DSH Desktop 打开「插件 → 添加插件」，输入下载文件的完整本地路径。</li>
            <li>点击「安装」，完成后点击「立即启用」。</li>
            <li>从 DSH 左侧打开「VACP」，填入服务器地址并登录。</li>
          </> : <>
            <li>解压安装包。在目标 OpenCode 项目的 <code>opencode.json(c)</code> 中填入解压后的 <code>package</code> 目录。</li>
            <li>OpenCode V2 使用 <code>plugins</code>，V1.18.29 及以上使用 <code>plugin</code>。</li>
            <li>在解压目录用 <code>node cli.js list</code> 登录并查看仓库。</li>
          </>}
        </ol>
        <Typography.Paragraph copyable={{ text: origin, tooltips: ['复制服务器地址', '已复制'] }}>
          服务器地址 <code>{origin}</code>
        </Typography.Paragraph>
        <Typography.Title level={5}>安装提示词</Typography.Title>
        <Typography.Paragraph type="secondary">
          可将提示词交给能操作本机浏览器和目标客户端的助手。下载使用你在 VACP 的登录权限。
        </Typography.Paragraph>
        <Typography.Paragraph copyable={{ text: installPrompt(origin, guidePath, guide), tooltips: ['复制安装提示词', '已复制'] }}
          style={{ whiteSpace:'pre-wrap', overflowWrap:'anywhere', padding:12, border:'1px solid var(--ant-color-border-secondary)', borderRadius:8 }}>
          {installPrompt(origin, guidePath, guide)}
        </Typography.Paragraph>
      </>}
    </Modal>
    </Card> },
    { key: 'github', label: 'GitHub 来源', children: <GitHubPluginSources workspaceId={workspaceId} writable={writable} api={api} /> },
  ]} />
}
