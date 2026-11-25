import { BadGatewayException, BadRequestException, Body, ConflictException, Controller, Param, Post, Req } from '@nestjs/common'
import { createHash, randomUUID } from 'node:crypto'
import { fromBuffer, type Entry } from 'yauzl'
import { pool } from './database.js'
import { field } from './identity.js'
import { requireWorkspaceAccess, type WorkspaceRequest } from './workspace-access.js'

const ZIP_LIMIT = 512 * 1024
const DOC_LIMIT = 64000
const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
const safeCoordinate = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/
type Source = { kind: 'skillhub' | 'clawhub' | 'zip'; label: string; url?: string; version?: string; license?: string; digest: string }
type Import = { name: string; description: string; content: string; origin: Source; omitted: number }

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}
function text(value: unknown): string { return typeof value === 'string' ? value : '' }

function document(bytes: Buffer) {
  if (!bytes.length || bytes.length > DOC_LIMIT) throw new BadRequestException('SKILL.md 大小必须在 1–64000 字节之间')
  let content: string
  try { content = new TextDecoder('utf-8', { fatal:true,ignoreBOM:true }).decode(bytes) }
  catch { throw new BadRequestException('SKILL.md 必须为 UTF-8 文本') }
  if (!content.trim() || Array.from(content).some(char => char.charCodeAt(0) < 32 && !'\t\r\n'.includes(char))) {
    throw new BadRequestException('SKILL.md 为空或包含无效控制字符')
  }
  return content
}

async function readResponse(url: URL, limit: number, allowSkillHubStorage = false) {
  const signal = AbortSignal.timeout(10000)
  try {
    let response = await fetch(url,{ redirect:'manual',signal })
    if (response.status === 302 && allowSkillHubStorage) {
      const location = response.headers.get('location')
      await response.body?.cancel()
      if (!location) throw new Error('missing redirect')
      const next = new URL(location)
      if (next.protocol !== 'https:' || next.username || next.password || next.port ||
        !/^skillhub-1388575217\.cos(?:\.[a-z0-9-]+)?\.myqcloud\.com$/.test(next.hostname)) throw new Error('invalid redirect')
      response = await fetch(next,{ redirect:'error',signal })
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      if ([401,403,404].includes(response.status)) throw new BadRequestException('上游未开放该版本，或需要授权或购买')
      throw new Error('upstream response')
    }
    const reader = response.body.getReader()
    try {
      const chunks: Uint8Array[] = []
      let size = 0
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) return Buffer.concat(chunks, size)
        size += chunk.value.length
        if (size > limit) throw new BadRequestException('上游内容大小超限')
        chunks.push(chunk.value)
      }
    } finally {
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  } catch (error) {
    if (error instanceof BadRequestException) throw error
    throw new BadGatewayException('无法读取上游技能，请重试或查看来源详情')
  }
}

async function json(url: URL) {
  try { return object(JSON.parse((await readResponse(url, 256 * 1024)).toString('utf8'))) }
  catch (error) {
    if (error instanceof SyntaxError) throw new BadGatewayException('上游技能信息格式异常')
    throw error
  }
}

async function external(body: unknown): Promise<Import> {
  const kind = field(body,'source',7,8)
  if (kind !== 'skillhub' && kind !== 'clawhub') throw new BadRequestException('未知技能来源')
  const owner = field(body,'owner',1,100)
  const slug = field(body,'slug',1,100)
  const requestedVersion = text(object(body).version)
  if (![owner,slug].every(value => safeCoordinate.test(value)) ||
      (requestedVersion && !safeCoordinate.test(requestedVersion))) throw new BadRequestException('无效的技能来源坐标')
  const skillHub = kind === 'skillhub'
  const host = skillHub ? 'https://api.skillhub.cn' : 'https://clawhub.ai'
  const endpoint = new URL('/api/v1/skills/' + encodeURIComponent(slug), host)
  if (!skillHub) endpoint.searchParams.set('ownerHandle',owner)
  const info = await json(endpoint)
  const metadata = object(info.skill)
  if (text(object(info.owner).handle).toLowerCase() !== owner.toLowerCase() || metadata.slug !== slug) {
    throw new BadRequestException('上游返回的技能作者或标识与所选条目不一致')
  }
  const version = requestedVersion || text(object(info.latestVersion).version)
  if (!safeCoordinate.test(version)) throw new BadRequestException('该技能没有可验证的版本')
  const versionUrl = new URL(endpoint)
  versionUrl.pathname += skillHub ? '/files' : '/versions/' + encodeURIComponent(version)
  if (skillHub) versionUrl.searchParams.set('version',version)
  const exact = await json(versionUrl)
  const selected = skillHub ? exact : object(exact.version)
  if (selected.version !== version || !Array.isArray(selected.files)) throw new BadRequestException('无法确认准确的上游版本')
  const entries = selected.files.map(object)
  const entry = entries.find(item => item.path === 'SKILL.md')
  if (!entry || !/^[a-f0-9]{64}$/i.test(text(entry.sha256))) throw new BadRequestException('该版本没有可验证的根目录 SKILL.md')
  const fileUrl = new URL(endpoint)
  fileUrl.pathname += '/file'
  fileUrl.searchParams.set('path','SKILL.md')
  fileUrl.searchParams.set('version',version)
  const bytes = await readResponse(fileUrl,DOC_LIMIT,skillHub)
  const digest = sha256(bytes)
  if (digest !== text(entry.sha256).toLowerCase()) throw new BadGatewayException('来源文件与版本摘要不一致')
  const link = skillHub ? host + '/' + encodeURIComponent(owner) + '/' + encodeURIComponent(slug)
    : host + '/' + encodeURIComponent(owner) + '/skills/' + encodeURIComponent(slug)
  return {
    name:(text(metadata.displayName) || slug).slice(0,80),
    description:(text(metadata.summary_zh) || text(metadata.summary) || '来自 ' + owner + '/' + slug).slice(0,250),
    content:document(bytes),
    omitted:entries.length - 1,
    origin:{kind,label:owner + '/' + slug,version,url:link,license:text(selected.license).slice(0,100),digest},
  }
}

function unzipDocument(archive: Buffer): Promise<{ bytes: Buffer; omitted: number }> {
  return new Promise((resolve,reject) => {
    fromBuffer(archive,{ lazyEntries:true,strictFileNames:true,validateEntrySizes:true }, (error,zip) => {
      if (error || !zip) return reject(new BadRequestException('无法读取 ZIP 文件'))
      const seen = new Set<string>()
      const candidates: Buffer[] = []
      let count = 0
      let files = 0
      let declaredBytes = 0
      let done = false
      const fail = (message: string) => {
        if (done) return
        done = true
        zip.close()
        reject(new BadRequestException(message))
      }
      zip.on('error',() => fail('ZIP 含损坏或不安全的条目'))
      zip.on('end',() => {
        if (done) return
        if (candidates.length !== 1) return fail('ZIP 必须有且仅有一个根目录或一级子目录中的 SKILL.md')
        done = true
        resolve({bytes:candidates[0],omitted:files-1})
      })
      zip.on('entry', (entry: Entry) => {
        const directory = entry.fileName.endsWith('/')
        const path = directory ? entry.fileName.slice(0,-1) : entry.fileName
        const parts = path.split('/')
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000
        if (++count > 80 || path.length > 240 || /[\\:\x00-\x1f\x7f]/.test(path) ||
            parts.some(part => !part || part === '.' || part === '..') ||
            seen.has(path.toLowerCase()) || (entry.generalPurposeBitFlag & 1) ||
            (mode && mode !== (directory ? 0o040000 : 0o100000))) {
          return fail('ZIP 条目过多、重复、加密或包含不安全文件')
        }
        seen.add(path.toLowerCase())
        if (directory) return zip.readEntry()
        files++
        declaredBytes += entry.uncompressedSize
        if (entry.uncompressedSize > 512*1024 || declaredBytes > 4*1024*1024) return fail('ZIP 展开体积超限')
        if (parts.at(-1) !== 'SKILL.md') return zip.readEntry()
        if (parts.length > 2 || entry.uncompressedSize > DOC_LIMIT || candidates.length) return fail('ZIP 只允许一个有效的 SKILL.md')
        zip.openReadStream(entry,(streamError,stream) => {
          if (streamError || !stream) return fail('无法读取 ZIP 中的 SKILL.md')
          const chunks: Buffer[] = []
          let size = 0
          stream.on('data',(chunk:Buffer) => {
            size += chunk.length
            if (size > DOC_LIMIT) { stream.destroy(); fail('SKILL.md 展开体积超限'); return }
            chunks.push(chunk)
          })
          stream.on('error',() => fail('ZIP 文档读取失败'))
          stream.on('end',() => {
            if (done) return
            candidates.push(Buffer.concat(chunks,size))
            zip.readEntry()
          })
        })
      })
      zip.readEntry()
    })
  })
}

async function uploaded(body: unknown): Promise<Import> {
  const name = field(body,'filename',5,120)
  if (!/\.zip$/i.test(name) || /[\\/\x00-\x1f]/.test(name)) throw new BadRequestException('请选择 ZIP 文件')
  const encoded = field(body,'archive',4,Math.ceil(ZIP_LIMIT/3)*4)
  const archive = Buffer.from(encoded,'base64')
  if (archive.length > ZIP_LIMIT || archive.toString('base64') !== encoded) throw new BadRequestException('ZIP 内容无效或超过 512 KiB')
  const {bytes,omitted} = await unzipDocument(archive)
  return {name:name.slice(0,-4).trim().slice(0,80) || 'ZIP 技能',description:'从 ZIP 上传的文档技能',
    content:document(bytes),origin:{kind:'zip',label:name,digest:sha256(bytes)},omitted}
}

@Controller('api/v1/workspaces/:workspaceId/skills/imports')
export class SkillImportController {
  @Post(':source/preview')
  async preview(@Req() req: WorkspaceRequest, @Param('workspaceId') workspaceId: string,
    @Param('source') source: string, @Body() body: unknown) {
    await requireWorkspaceAccess(req,workspaceId,true)
    return this.read(source,body)
  }

  @Post(':source')
  async confirm(@Req() req: WorkspaceRequest, @Param('workspaceId') workspaceId: string,
    @Param('source') source: string, @Body() body: unknown) {
    await requireWorkspaceAccess(req,workspaceId,true)
    const name = field(body,'name',1,80)
    const description = field(body,'description',1,250)
    const digest = field(body,'digest',64,64)
    const candidate = await this.read(source,body)
    if (candidate.origin.digest !== digest) throw new ConflictException('文件内容已变化，请重新预览')
    const { rows:[draft] } = await pool.query(`
      INSERT INTO vacp_skills(id,workspace_id,name,description,content,origin)
      SELECT $1,$2,$3,$4,$5,$6 WHERE EXISTS (
        SELECT 1 FROM vacp_members WHERE workspace_id=$2 AND user_id=$7 AND role IN ('owner','admin')
      )
      ON CONFLICT DO NOTHING RETURNING id
    `, [randomUUID(),workspaceId,name,description,candidate.content,candidate.origin,
      (await requireWorkspaceAccess(req,workspaceId,true)).id])
    if (draft) return draft
    await requireWorkspaceAccess(req,workspaceId,true)
    const { rows:[existing] } = await pool.query<{id:string; digest:string}>(`
      SELECT id,origin->>'digest' AS digest FROM vacp_skills
      WHERE workspace_id=$1 AND origin->>'kind'=$2 AND origin->>'label'=$3
        AND COALESCE(origin->>'version',origin->>'digest')=$4
    `, [workspaceId,candidate.origin.kind,candidate.origin.label,candidate.origin.version ?? digest])
    if (!existing) throw new ConflictException('已有同名技能，请换一个仓库名称')
    if (existing.digest !== digest) throw new ConflictException('同一上游版本的内容与已导入版本不一致')
    return { id:existing.id }
  }

  private read(source:string,body:unknown) {
    if (source === 'zip') return uploaded(body)
    if (source === 'external') return external(body)
    throw new BadRequestException('未知导入方式')
  }
}
