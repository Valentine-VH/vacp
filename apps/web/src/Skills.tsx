import { useEffect, useState } from 'react'
import { Alert, Button, Card, Drawer, Empty, Form, Input, Modal, Popconfirm, Space, Table, Tabs, Tag, Typography, Upload } from 'antd'
import type { TabsProps } from 'antd'

type Content = { name: string; description: string; content: string }
type Origin = { kind: 'skillhub' | 'clawhub' | 'zip'; label: string; version?: string; license?: string; url?: string; digest: string }
type Draft = Content & { id: string; versions: string[]; origin: Origin | null }
type ImportPreview = Content & { origin: Origin; omitted: number }
type ImportRequest = { source: 'skillhub' | 'clawhub'; owner: string; slug: string; version: string } |
  { filename: string; archive: string }
type Release = Omit<Content, 'content'> & { id: string; version: string; publisher: string; installed: boolean; origin?: Origin | null }
type Repository = { drafts: Draft[]; installed: (Release & { content: string | null; reviewStatus: string })[] }
type ScanReport = { engine: string; findings: { severity: string; rule: string; line: number | null }[] }
type Review = { id: string; name: string; version: string; status: string; content: string; digest: string | null; canApprove: boolean; reason: string | null; scanStatus: string | null; scanReport: ScanReport | null; scanError: string | null }
type Decision = 'approved' | 'rejected' | 'revoked'
const reviewLabels: Record<string,string> = { pending: '待审核', approved: '已发布', rejected: '已驳回', revoked: '已撤销' }
const scanLabels: Record<string,string> = { queued:'待扫描', running:'扫描中', passed:'扫描完成', blocked:'已阻断', failed:'扫描失败' }
const scanErrors: Record<string,string> = { timeout:'扫描超时', worker_timeout:'扫描服务未在时限内返回', invalid_report:'扫描结果校验失败', invalid_input_or_report:'扫描器无法处理此文档或报告', invalid_skill_metadata:'SKILL.md 的元数据格式无效，请修正草稿并提交新版本' }
type Api = <T>(path: string, method?: string, body?: object) => Promise<T>
type Source = 'skillhub' | 'clawhub' | 'internal'
type CatalogEntry = { id: string; slug: string; name: string; owner: string; description: string; version: string; price: string; link: string }

export function Skills({ id, writable, api }: { id: string; writable: boolean; api: Api }) {
  const base = 'workspaces/' + id + '/skills'
  const [repository, setRepository] = useState<Repository>({ drafts: [], installed: [] })
  const [reviews, setReviews] = useState<Review[]>([])
  const [reviewId, setReviewId] = useState<string>()
  const review = reviews.find(item => item.id === reviewId)
  const [decision, setDecision] = useState<Decision>()
  const [market, setMarket] = useState<Release[]>([])
  const [query, setQuery] = useState('')
  const [editor, setEditor] = useState<Draft | 'new'>()
  const [pendingImport, setPendingImport] = useState<{ mode:'external'|'zip'; request:ImportRequest; preview:ImportPreview }>()
  const [publication, setPublication] = useState<Draft>()
  const [preview, setPreview] = useState<{ name: string; content: string; release?: Release }>()
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [tab, setTab] = useState('repository')
  const [source, setSource] = useState<Source>('skillhub')
  const [catalogQuery, setCatalogQuery] = useState('')
  const [submittedQuery, setSubmittedQuery] = useState('')
  const [catalog, setCatalog] = useState<CatalogEntry[]>([])
  const [catalogBusy, setCatalogBusy] = useState(false)
  const [catalogError, setCatalogError] = useState('')
  const [catalogRevision, setCatalogRevision] = useState(0)
  const [busy, setBusy] = useState(true)

  async function refresh() {
    const [nextRepository, nextMarket, nextReviews] = await Promise.all([
      api<Repository>(base + '/repository'), api<Release[]>(base + '/market'),
      writable ? api<Review[]>(base + '/reviews') : Promise.resolve([]),
    ])
    setRepository(nextRepository)
    setMarket(nextMarket)
    setReviews(nextReviews)
  }

  async function run(action: () => Promise<void>, success?: string) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
      if (success) setNotice(success)
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败') }
    finally { setBusy(false) }
  }

  useEffect(() => { void run(refresh) }, [base, writable])

  useEffect(() => {
    if (!writable || tab !== 'reviews') return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      try {
        const next = await api<Review[]>(base + '/reviews')
        if (active) setReviews(next)
      } catch {
        // Explicit refresh shows request failures without interrupting a decision form.
      }
      if (active) timer = setTimeout(poll, 2000)
    }
    timer = setTimeout(poll, 2000)
    return () => { active = false; clearTimeout(timer) }
  }, [api, base, tab, writable])

  useEffect(() => {
    if (tab !== 'market' || source === 'internal') return
    let active = true
    setCatalog([])
    setCatalogError('')
    setCatalogBusy(true)
    void api<CatalogEntry[]>(base + '/external/' + source + '?q=' + encodeURIComponent(submittedQuery))
      .then(entries => { if (active) setCatalog(entries) })
      .catch(error => { if (active) setCatalogError(error instanceof Error ? error.message : '无法读取市场') })
      .finally(() => { if (active) setCatalogBusy(false) })
    return () => { active = false }
  }, [api, base, source, submittedQuery, tab, catalogRevision])

  function saveDraft(values: Content) {
    return run(async () => {
      if (!editor) return
      const editing = editor !== 'new'
      await api(base + '/repository' + (editing ? '/' + editor.id : ''), editing ? 'PUT' : 'POST', values)
      setEditor(undefined)
      await refresh()
    }, '技能已保存')
  }

  async function openImport(mode: 'external' | 'zip', request: ImportRequest) {
    const preview = await api<ImportPreview>(base + '/imports/' + mode + '/preview', 'POST', request)
    const pinned = 'version' in request ? { ...request, version: preview.origin.version ?? request.version } : request
    setPendingImport({ mode, request:pinned, preview })
  }

  function uploadZip(file: File) {
    return run(async () => {
      if (file.size > 512 * 1024) throw new Error('ZIP 文件不能超过 512 KiB')
      const url = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(new Error('无法读取 ZIP 文件'))
        reader.readAsDataURL(file)
      })
      await openImport('zip',{ filename:file.name,archive:url.slice(url.indexOf(',')+1) })
    })
  }

  function confirmImport(values: Pick<Content,'name'|'description'>) {
    return run(async () => {
      if (!pendingImport) return
      const { mode,request,preview } = pendingImport
      await api(base + '/imports/' + mode, 'POST', { ...request,...values,digest:preview.origin.digest })
      setPendingImport(undefined)
      setTab('repository')
      await refresh()
    }, '已导入到当前工作空间的私有仓库')
  }

  function publish({ version }: { version: string }) {
    return run(async () => {
      if (!publication) return
      await api(base + '/repository/' + publication.id + '/releases', 'POST', { version })
      setPublication(undefined)
      setTab('reviews')
      await refresh()
    }, '版本已提交扫描')
  }

  function submitDecision({ reason }: { reason: string }) {
    return run(async () => {
      if (!review || !decision) return
      await api(base + '/reviews/' + review.id, 'POST', { action: decision, reason })
      setReviewId(undefined)
      setDecision(undefined)
      await refresh()
    }, '审核状态已更新')
  }

  function installation(release: Release, install: boolean) {
    return run(async () => {
      await api(base + '/installations/' + release.id, install ? 'PUT' : 'DELETE')
      if (install) {
        setPreview(undefined)
        setTab('installed')
      }
      await refresh()
    }, install ? '已安装到当前工作空间' : '已从当前工作空间卸载')
  }

  function openRelease(release: Release) {
    return run(async () => {
      const detail = await api<{ name: string; content: string }>(base + '/market/' + release.id)
      setPreview({ ...detail, release })
    })
  }

  const visible = market.filter(release => [release.name, release.description, release.publisher, release.version]
    .some(value => value.toLowerCase().includes(query.trim().toLowerCase())))

  const counters = [
    { key:'repository', label:'仓库技能', value:repository.drafts.length },
    ...(writable ? [{ key:'reviews', label:'待处理版本', value:reviews.filter(item => item.status === 'pending').length }] : []),
    { key:'installed', label:'已安装版本', value:repository.installed.filter(item => item.reviewStatus === 'approved').length },
  ]
  const items: NonNullable<TabsProps['items']> = [
      { key: 'repository', label: '自有技能', children: <>
        {writable && <Space wrap>
          <Button type="primary" disabled={busy} onClick={() => { setError(''); setEditor('new') }}>新建技能</Button>
          <Upload accept=".zip,application/zip" showUploadList={false} disabled={busy}
            beforeUpload={file => { void uploadZip(file); return false }}>
            <Button disabled={busy}>上传 ZIP</Button>
          </Upload>
        </Space>}
        <Table<Draft> style={{ marginTop: 12 }} scroll={{ x: 620 }} size="small" rowKey="id" loading={busy}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前工作空间暂无自有技能" /> }}
          dataSource={repository.drafts} columns={[
          { title: '自有技能', dataIndex: 'name' },
          { title: '描述', dataIndex: 'description' },
          { title: '来源', render: (_, row) => row.origin
            ? <Tag>{row.origin.kind === 'zip' ? 'ZIP' : row.origin.kind === 'skillhub' ? 'SkillHub' : 'ClawHub'} · 私有</Tag>
            : '自有' },
          { title: '已发布版本', render: (_, row) => row.versions.length ? row.versions.map(version => <Tag key={version}>{version}</Tag>) : '未发布' },
          { title: '操作', render: (_, row) => <Space wrap>
            <Button type="link" onClick={() => setPreview(row)}>预览</Button>
            {writable && <>
              <Button type="link" disabled={busy} onClick={() => { setError(''); setEditor(row) }}>编辑</Button>
              <Button type="link" disabled={busy} onClick={() => { setError(''); setPublication(row) }}>提交审核</Button>
              {row.versions.length > 0 && <Button type="link" onClick={() => {
                setSource('internal'); setQuery(row.name); setTab('market')
              }}>查看可安装版本</Button>}
            </>}
          </Space> },
        ]} />
      </> },
      ...(writable ? [{ key: 'reviews', label: '版本审核', children:
        <Table<Review> size="small" rowKey="id" loading={busy} dataSource={reviews}
          locale={{ emptyText: '暂无版本提交' }} columns={[
            { title: '技能', dataIndex: 'name' },
            { title: '版本', dataIndex: 'version' },
            { title: '状态', dataIndex: 'status', render: (value: string) => <Tag>{reviewLabels[value] ?? value}</Tag> },
            { title: 'Cisco 扫描', dataIndex: 'scanStatus', render: (value: string | null) => <Tag>{value ? scanLabels[value] : '未扫描'}</Tag> },
            { title: '操作', render: (_, row) => <Button type="link" onClick={() => {
              setError(''); setDecision(undefined); setReviewId(row.id)
            }}>查看审核</Button> },
          ]} />
      }] : []),
      { key: 'market', label: '市场', children: <>
        <Tabs activeKey={source} items={[
          { key: 'skillhub', label: 'SkillHub' }, { key: 'clawhub', label: 'ClawHub' }, { key: 'internal', label: '平台发布' },
        ]} onChange={value => {
          setCatalogQuery('')
          setSubmittedQuery('')
          setSource(value as Source)
        }} />
        {source !== 'internal' ? <>
          <Input.Search aria-label="搜索外部市场" placeholder="按技能关键词搜索" enterButton="搜索"
            maxLength={100} allowClear value={catalogQuery} onChange={event => setCatalogQuery(event.target.value)}
            onSearch={value => { setSubmittedQuery(value.trim()); setCatalogRevision(revision => revision + 1) }} />
          {catalogError && <Alert type="error" title={catalogError} showIcon
            action={<Button size="small" onClick={() => setCatalogRevision(revision => revision + 1)}>重试</Button>} />}
          <Table<CatalogEntry> style={{ marginTop: 12 }} scroll={{ x: 700 }} size="small" rowKey="id" loading={catalogBusy}
            dataSource={catalog} locale={{ emptyText: catalogError ? '目录加载失败' : '没有匹配的技能' }}
            columns={[
              { title: '技能', dataIndex: 'name' },
              { title: '作者', dataIndex: 'owner' },
              { title: '描述', dataIndex: 'description', ellipsis: true },
              { title: '版本', dataIndex: 'version', render: (value: string) => value || '—' },
              { title: '价格', dataIndex: 'price', render: (value: string) => value || '—' },
              { title: '操作', render: (_, row) => <Space wrap>
                {writable && <Button disabled={busy} onClick={() => void run(() =>
                  openImport('external',{source,owner:row.owner,slug:row.slug,version:row.version}))}>导入到仓库</Button>}
                <Button type="link" href={row.link} target="_blank" rel="noopener noreferrer">来源详情</Button>
              </Space> },
            ]} />
        </> : <>
        <Input aria-label="搜索技能" placeholder="按名称、描述、发布空间或版本搜索" value={query} onChange={event => setQuery(event.target.value)} allowClear />
        <Table<Release> style={{ marginTop: 12 }} scroll={{ x: 680 }} size="small" rowKey="id" loading={busy}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={query.trim() ? '没有匹配的技能' : '市场暂无已发布技能'} /> }}
          dataSource={visible} columns={[
          { title: '技能', dataIndex: 'name' },
          { title: '描述', dataIndex: 'description' },
          { title: '发布空间', dataIndex: 'publisher' },
          { title: '版本', dataIndex: 'version' },
          { title: '可见范围', render: (_, row) => row.origin ? <Tag>当前工作空间</Tag> : '平台内' },
          { title: '操作', render: (_, row) => <Space wrap>
            <Button type="link" disabled={busy} onClick={() => void openRelease(row)}>查看详情</Button>
            {row.installed && <Tag color="green">已安装</Tag>}
          </Space> },
        ]} />
        </>}
      </> },
      { key: 'installed', label: '已安装', children:
        <Table<Repository['installed'][number]> scroll={{ x: 560 }} size="small" rowKey="id" loading={busy}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前工作空间暂无已安装技能">
            <Button onClick={() => { setQuery(''); setTab('market') }}>浏览技能市场</Button>
          </Empty> }} dataSource={repository.installed} columns={[
          { title: '技能', dataIndex: 'name' },
          { title: '来源', dataIndex: 'publisher' },
          { title: '版本', dataIndex: 'version' },
          { title: '状态', dataIndex: 'reviewStatus', render: (value: string) => <Tag>{reviewLabels[value] ?? value}</Tag> },
          { title: '操作', render: (_, row) => <Space wrap>
            {row.content !== null && <Button type="link" onClick={() => setPreview({ name:row.name, content:row.content ?? '' })}>预览</Button>}
            {writable && <Popconfirm title="从当前工作空间卸载此版本？" onConfirm={() => installation(row, false)}>
              <Button type="link" danger disabled={busy}>卸载</Button>
            </Popconfirm>}
          </Space> },
        ]} /> },
  ]
  return <div className="skill-workbench">
    <div className="skill-metrics" aria-label="技能概览">
      {counters.map(item => <button key={item.key} className="skill-metric" onClick={() => setTab(item.key)}>
        <span>{item.label}</span><strong>{busy && item.value === 0 ? '—' : item.value}</strong>
        <span aria-hidden="true" className="skill-metric-arrow">↗</span>
      </button>)}
    </div>
    <Card className="skill-panel">
    {error && <Alert type="error" title={error} showIcon />}
    {notice && <Alert type="success" title={notice} showIcon />}
    <Tabs activeKey={tab === 'market' ? 'market' : 'repository'} onChange={setTab}
      tabBarExtraContent={<Button disabled={busy} onClick={() => {
        if (tab === 'market' && source !== 'internal') setCatalogRevision(value => value + 1)
        else void run(refresh)
      }}>刷新</Button>} items={[
        { key: 'repository', label: '仓库', children: <Tabs size="small" onChange={setTab}
          activeKey={tab === 'market' ? 'repository' : tab} items={items.filter(item => item.key !== 'market')} /> },
        ...items.filter(item => item.key === 'market'),
      ]} />
    <Modal title="确认导入到仓库" open={Boolean(pendingImport)} width={720} footer={null} destroyOnHidden
      onCancel={() => { if (!busy) setPendingImport(undefined) }}>
      {pendingImport && <>
        <Typography.Paragraph>
          {pendingImport.preview.origin.label}{pendingImport.preview.origin.version && ' · ' + pendingImport.preview.origin.version}
          {pendingImport.preview.origin.license && ' · ' + pendingImport.preview.origin.license}
        </Typography.Paragraph>
        <Alert type="info" title="只导入 SKILL.md，并保存为当前工作空间的私有草稿"
          description={pendingImport.preview.omitted > 0 ? '其余 ' + pendingImport.preview.omitted + ' 个文件不会导入。依赖这些文件的技能可能无法独立使用。' : undefined} />
        {error && <Alert type="error" title={error} />}
        <pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:260,overflow:'auto'}}>{pendingImport.preview.content}</pre>
        <Form name="skill-import" layout="vertical" disabled={busy} onFinish={confirmImport}
          initialValues={{name:pendingImport.preview.name,description:pendingImport.preview.description}}>
          <Form.Item name="name" label="技能名称" rules={[{required:true,whitespace:true}]}><Input maxLength={80} /></Form.Item>
          <Form.Item name="description" label="描述" rules={[{required:true,whitespace:true}]}><Input maxLength={250} /></Form.Item>
          <Button type="primary" htmlType="submit" loading={busy}>确认导入</Button>
        </Form>
      </>}
    </Modal>
    <Modal title={editor === 'new' ? '新建技能' : '编辑技能'} open={Boolean(editor)} footer={null} destroyOnHidden
      onCancel={() => setEditor(undefined)}>
      {error && <Alert type="error" title={error} />}
      <Form name="skill-editor" layout="vertical" disabled={busy} initialValues={editor === 'new' ? {} : editor} onFinish={saveDraft}>
        <Form.Item name="name" label="技能名称" rules={[{ required: true, whitespace: true }]}><Input maxLength={80} /></Form.Item>
        <Form.Item name="description" label="描述" rules={[{ required: true, whitespace: true }]}><Input maxLength={250} /></Form.Item>
        <Form.Item name="content" label="SKILL.md 内容" rules={[{ required: true, whitespace: true }]}><Input.TextArea rows={10} maxLength={32000} /></Form.Item>
        <Button type="primary" htmlType="submit">保存技能</Button>
      </Form>
    </Modal>
    <Modal title="提交技能版本审核" open={Boolean(publication)} footer={null} destroyOnHidden onCancel={() => setPublication(undefined)}>
      <p>版本先进行 Cisco 扫描，再由管理员审核。{publication?.origin ? '导入版本仅供当前工作空间安装。' : '批准后其他工作空间可以安装此固定版本。'}</p>
      {error && <Alert type="error" title={error} />}
      <Form name="skill-release" layout="vertical" disabled={busy} onFinish={publish}>
        <Form.Item name="version" label="版本号" rules={[{ required: true, pattern: /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/ }]}>
          <Input placeholder="1.0.0" maxLength={32} />
        </Form.Item>
        <Button type="primary" htmlType="submit">提交审核</Button>
      </Form>
    </Modal>
    <Drawer title={review && review.name + ' · ' + review.version} open={Boolean(review)}
      size="min(640px, 100vw)" destroyOnHidden onClose={() => { if (!busy) { setReviewId(undefined); setDecision(undefined) } }}>
      {review && <>
        <Space wrap>
          <Tag>{reviewLabels[review.status]}</Tag>
          <Tag>Cisco {review.scanReport?.engine ?? 'Skill Scanner'}</Tag>
          <Tag>{review.scanStatus ? scanLabels[review.scanStatus] : '未扫描'}</Tag>
        </Space>
        {review.scanReport && ['passed','blocked'].includes(review.scanStatus ?? '') && <ul>
          {review.scanReport.findings.length === 0 ? <li>无扫描发现，等待人工确认。</li> :
            review.scanReport.findings.map((finding,index) => <li key={index}>
              {finding.severity} · {finding.rule}{finding.line === null ? '' : ' · 扫描文档第 ' + finding.line + ' 行'}
            </li>)}
        </ul>}
        {review.scanError && <Alert type="error" title={scanErrors[review.scanError] ?? '扫描失败'}
          action={review.status === 'pending' && review.scanStatus === 'failed' && review.scanError !== 'invalid_skill_metadata' && <Button disabled={busy} onClick={() => void run(async () => {
            await api(base + '/reviews/' + review.id + '/rescan', 'POST')
            await refresh()
          }, '已重新排队扫描')}>重试扫描</Button>} />}
        <Typography.Paragraph copyable={Boolean(review.digest)} code style={{ overflowWrap:'anywhere' }}>{review.digest ?? '待生成摘要'}</Typography.Paragraph>
        {review.reason && <Typography.Paragraph>{review.reason}</Typography.Paragraph>}
        <pre className="skill-document">{review.content}</pre>
        {error && <Alert type="error" title={error} showIcon />}
        <Space wrap>
          {review.status === 'pending' && review.scanStatus === 'passed' && (review.canApprove
            ? <Button type="primary" onClick={() => setDecision('approved')}>批准并发布</Button>
            : <Typography.Text type="secondary">请由另一位管理员审核</Typography.Text>)}
          {review.status === 'pending' && <Button danger onClick={() => setDecision('rejected')}>驳回</Button>}
          {review.status === 'approved' && <Button danger onClick={() => setDecision('revoked')}>撤销版本</Button>}
        </Space>
        {decision && <Form key={decision} name="skill-decision" layout="vertical" disabled={busy} onFinish={submitDecision}>
          <Form.Item name="reason" label={decision === 'revoked' ? '撤销原因' : '审核理由'} rules={[{ required:true, whitespace:true }]}>
            <Input.TextArea maxLength={500} rows={3} />
          </Form.Item>
          <Button type="primary" danger={decision !== 'approved'} htmlType="submit" loading={busy}>确认{decision === 'approved' ? '发布' : decision === 'revoked' ? '撤销' : '驳回'}</Button>
        </Form>}
      </>}
    </Drawer>
    <Drawer title={preview?.name} open={Boolean(preview)} size="min(640px, 100vw)"
      footer={preview?.release && writable && !preview.release.installed
        ? <Button type="primary" loading={busy} onClick={() => {
          if (preview.release) void installation(preview.release, true)
        }}>安装到当前工作空间</Button> : null}
      onClose={() => { if (!busy) setPreview(undefined) }}>
      {error && <Alert type="error" title={error} showIcon />}
      {preview?.release && <>
        <Space wrap><Tag>{preview.release.version}</Tag><Typography.Text type="secondary">{preview.release.publisher}</Typography.Text></Space>
        <Typography.Paragraph>{preview.release.description}</Typography.Paragraph>
      </>}
      <pre className="skill-document">{preview?.content}</pre>
    </Drawer>
    </Card>
  </div>
}
