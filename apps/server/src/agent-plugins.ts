import { Controller, Get, Header, NotFoundException, Param, Req, StreamableFile, UnauthorizedException } from '@nestjs/common'
import { createHash } from 'node:crypto'
import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { accountHash, type PluginRequest } from './agent-plugin-sessions.js'
import { pool } from './database.js'
import { uuid } from './identity.js'
import { requireWorkspaceAccess, type WorkspaceRequest } from './workspace-access.js'
import { listPluginSources } from './agent-plugin-github.js'

const plugins = [
  { id:'dsh', name:'DeepSeek Harness', packageName:'@vacp/plugin-dsh' },
  { id:'opencode', name:'OpenCode', packageName:'@vacp/plugin-opencode' },
] as const
const directory = process.env.VACP_AGENT_PLUGIN_DIR ||
  fileURLToPath(new URL('../../../plugins/releases/', import.meta.url))
const versionPattern = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/

function missing(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

async function releaseInfo(filename: string, version: string) {
  const file = await open(join(directory,filename),'r').catch(error => {
    if (!missing(error)) throw error
    return null
  })
  if (!file) return null
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size === 0) return null
    const hash = createHash('sha256')
    for await (const chunk of file.createReadStream({autoClose:false})) hash.update(chunk)
    return {version,filename,bytes:info.size,sha256:hash.digest('hex')}
  } finally {
    await file.close()
  }
}

function byVersion(a: string,b: string) {
  return b.localeCompare(a,'en',{numeric:true})
}

async function catalog() {
  const entries = await readdir(directory,{withFileTypes:true}).catch(error => {
    if (!missing(error)) throw error
    return []
  })
  return Promise.all(plugins.map(async plugin => {
    const prefix = 'vacp-plugin-'+plugin.id+'-'
    const filename = 'vacp-plugin-'+plugin.id+'.tgz'
    const versions = entries.filter(entry=>entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith('.tgz'))
      .map(entry=>entry.name.slice(prefix.length,-4))
      .filter(version=>versionPattern.test(version))
      .sort(byVersion)
    const releases = (await Promise.all(versions.map(version=>releaseInfo(prefix+version+'.tgz',version))))
      .filter(release=>release!==null)
    const previous = releases.length ? null : await stat(join(directory,filename)).catch(error => {
      if (!missing(error)) throw error
      return null
    })
    return {...plugin,filename:releases[0]?.filename ?? filename,
      available:releases.length>0 || Boolean(previous?.isFile() && previous.size>0),releases}
  }))
}

async function download(id: string, version?: string) {
  if (!plugins.some(plugin=>plugin.id===id) || (version!==undefined && !versionPattern.test(version))) {
    throw new NotFoundException('插件版本不存在')
  }
  const filename = version ? 'vacp-plugin-'+id+'-'+version+'.tgz' : (await catalog()).find(plugin=>plugin.id===id)!.filename
  const file = await open(join(directory,filename),'r').catch(error => {
    if (missing(error)) throw new NotFoundException('插件尚未发布')
    throw error
  })
  try {
    const info = await file.stat()
    if (!info.isFile() || !info.size) throw new NotFoundException('插件尚未发布')
    return new StreamableFile(file.createReadStream(),{
      type:'application/gzip',disposition:`attachment; filename="${filename}"`,length:info.size,
    })
  } catch (error) {
    await file.close()
    throw error
  }
}

async function requireCatalogAccess(req: PluginRequest,workspace: string) {
  const hash=accountHash(req)
  if (!uuid.test(workspace)) throw new NotFoundException()
  const {rows:[entry]}=await pool.query(`
    SELECT EXISTS (
      SELECT 1 FROM vacp_members m WHERE m.workspace_id=$2 AND m.user_id=a.user_id AND m.role<>'viewer'
        AND NOT EXISTS (SELECT 1 FROM vacp_plugin_workspace_revocations r WHERE r.account_id=a.id AND r.workspace_id=$2)
    ) AS allowed
    FROM vacp_plugin_accounts a WHERE a.token_hash=$1 AND a.expires_at>now()
  `,[hash,workspace])
  if (!entry) throw new UnauthorizedException()
  if (!entry.allowed) throw new NotFoundException('工作空间不可用')
}

@Controller('api/v1/workspaces/:workspaceId/agent-plugins')
export class AgentPluginsController {
  @Get()
  @Header('Cache-Control','no-store')
  async list(@Req() req: WorkspaceRequest, @Param('workspaceId') workspace: string) {
    await requireWorkspaceAccess(req,workspace)
    return catalog()
  }

  @Get(':id/download')
  @Header('Cache-Control','private, no-store')
  async latest(@Req() req: WorkspaceRequest, @Param('workspaceId') workspace: string, @Param('id') id: string) {
    await requireWorkspaceAccess(req,workspace)
    return download(id)
  }

  @Get(':id/versions/:version/download')
  @Header('Cache-Control','private, no-store')
  async version(@Req() req: WorkspaceRequest, @Param('workspaceId') workspace: string, @Param('id') id: string,@Param('version') version:string) {
    await requireWorkspaceAccess(req,workspace)
    return download(id,version)
  }
}

@Controller('api/v1/agent-plugin-auth/account/workspaces/:workspaceId/plugins')
export class AgentPluginRepositoryController {
  @Get('sources')
  @Header('Cache-Control','private, no-store')
  async sources(@Req() req: PluginRequest, @Param('workspaceId') workspace: string) {
    await requireCatalogAccess(req,workspace)
    return listPluginSources(workspace)
  }

  @Get()
  @Header('Cache-Control','no-store')
  async list(@Req() req: PluginRequest, @Param('workspaceId') workspace: string) {
    await requireCatalogAccess(req,workspace)
    return catalog()
  }

  @Get(':id/versions/:version/download')
  @Header('Cache-Control','private, no-store')
  async version(@Req() req: PluginRequest, @Param('workspaceId') workspace: string, @Param('id') id: string,@Param('version') version:string) {
    await requireCatalogAccess(req,workspace)
    return download(id,version)
  }
}
