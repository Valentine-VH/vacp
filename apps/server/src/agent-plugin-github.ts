import { BadGatewayException, BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post, Query, Req, ServiceUnavailableException } from '@nestjs/common'
import { pool } from './database.js'
import { requireWorkspaceAccess, type WorkspaceRequest } from './workspace-access.js'

const repositoryPattern = /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/i

function repositoryName(value: unknown) {
  if (typeof value !== 'string') return null
  const name = value.trim().replace(/^https:\/\/github\.com\//i, '').replace(/\/$/, '').replace(/\.git$/i, '')
  return repositoryPattern.test(name) && !['.','..'].includes(name.split('/')[1]) ? name : null
}

function pluginHost(value: unknown) {
  if (value === 'dsh' || value === 'opencode') return value
  throw new BadRequestException('请选择 DSH 或 OpenCode')
}

type GitHubRepo = {
  id: number; full_name: string; description: string | null; stargazers_count: number
  pushed_at: string | null; private: boolean; archived: boolean
}

function publicRepository(repo: GitHubRepo) {
  if (repo.private !== false || !Number.isSafeInteger(repo.id) || repo.id < 1 ||
    !repositoryPattern.test(repo.full_name)) return null
  return {
    id: String(repo.id), fullName: repo.full_name, description: repo.description,
    stars: repo.stargazers_count, updatedAt: repo.pushed_at, archived: repo.archived,
  }
}

async function github<T>(path: string): Promise<T> {
  const token = process.env.VACP_GITHUB_TOKEN?.trim()
  try {
    const response = await fetch('https://api.github.com' + path, {
      headers: {
        Accept: 'application/vnd.github+json', 'User-Agent': 'VACP-plugin-market',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      redirect: 'error',
      signal: AbortSignal.timeout(8_000),
    })
    if (response.status === 404) throw new NotFoundException('找不到该 GitHub 公开仓库')
    if (response.status === 429 || (response.status === 403 &&
      (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')))) {
      throw new ServiceUnavailableException('GitHub 请求达到频率限制，请稍后再试')
    }
    if (!response.ok) throw new BadGatewayException('GitHub 未能完成请求，请稍后再试')
    return await response.json() as T
  } catch (error) {
    if (error instanceof NotFoundException || error instanceof ServiceUnavailableException || error instanceof BadGatewayException) throw error
    throw new BadGatewayException('服务端无法连接 GitHub，请稍后再试')
  }
}

type SavedSource = NonNullable<ReturnType<typeof publicRepository>> & { host: 'dsh' | 'opencode' }

export async function listPluginSources(workspaceId: string) {
  const { rows } = await pool.query<{ source: SavedSource }>(
    'SELECT source FROM vacp_plugin_github_sources WHERE workspace_id=$1 ORDER BY added_at DESC, repo_id DESC',
    [workspaceId],
  )
  return rows.map(row => row.source)
}

@Controller('api/v1/workspaces/:workspaceId/agent-plugin-github')
export class AgentPluginGitHubController {
  @Get()
  async list(@Req() req: WorkspaceRequest, @Param('workspaceId') workspaceId: string) {
    await requireWorkspaceAccess(req, workspaceId)
    return listPluginSources(workspaceId)
  }

  @Get('search')
  async search(@Req() req: WorkspaceRequest, @Param('workspaceId') workspaceId: string,
    @Query('host') target: unknown, @Query('q') value: unknown) {
    await requireWorkspaceAccess(req, workspaceId)
    const host = pluginHost(target)
    if (value !== undefined && typeof value !== 'string') throw new BadRequestException('搜索词无效')
    const input = (value ?? '').trim()
    const prefix = input.endsWith('*')
    const query = prefix ? input.slice(0, -1) : input
    if (query.length > 80 || !/^[\p{L}\p{N}_. -]*$/u.test(query)) {
      throw new BadRequestException('请输入不超过 80 个字符的仓库名称或关键词')
    }
    const topic = host === 'dsh' ? 'dsh-plugin' : 'opencode-plugin'
    if (prefix && !/^[a-z0-9_.-]+$/i.test(query)) throw new BadRequestException('前缀搜索示例 DSH-*')
    const search = query ? `${query} in:${prefix ? 'name' : 'name,description'}` : `${host} in:name topic:${topic}`
    const params = new URLSearchParams({ q: search + ' is:public archived:false', sort: 'stars', order: 'desc', per_page: '15' })
    const result = await github<{ items: GitHubRepo[]; incomplete_results: boolean }>('/search/repositories?' + params)
    return {
      items: result.items.map(publicRepository)
        .filter(repo => repo !== null && (!prefix || repo.fullName.split('/')[1].toLowerCase().startsWith(query.toLowerCase())))
        .map(repo => ({ ...repo, host })),
      incomplete: result.incomplete_results,
    }
  }

  @Post()
  async add(@Req() req: WorkspaceRequest, @Param('workspaceId') workspaceId: string,
    @Body() body?: { repository?: unknown; host?: unknown }) {
    const actor = await requireWorkspaceAccess(req, workspaceId, true)
    const host = pluginHost(body?.host)
    const name = repositoryName(body?.repository)
    if (!name) throw new BadRequestException('请输入 GitHub 仓库地址或 owner/repo')
    const repo = publicRepository(await github<GitHubRepo>('/repos/' + name))
    if (!repo) throw new NotFoundException('找不到该 GitHub 公开仓库')

    const { rows: [row] } = await pool.query<{ source: SavedSource }>(`
      INSERT INTO vacp_plugin_github_sources(workspace_id,repo_id,host,source)
      SELECT $1,$2,$3,$4 FROM vacp_members
        WHERE workspace_id=$1 AND user_id=$5 AND role IN ('owner','admin')
      ON CONFLICT (workspace_id,repo_id,host) DO UPDATE SET source=EXCLUDED.source
      RETURNING source
    `, [workspaceId, repo.id, host, { ...repo, host }, actor.id])
    if (!row) throw new NotFoundException('工作空间访问权限已变更')
    return row.source
  }

  @Delete(':id/:host')
  @HttpCode(204)
  async remove(@Req() req: WorkspaceRequest, @Param('workspaceId') workspaceId: string,
    @Param('id') id: string, @Param('host') target: unknown) {
    await requireWorkspaceAccess(req, workspaceId, true)
    if (!/^[1-9]\d{0,15}$/.test(id)) throw new NotFoundException()
    await pool.query('DELETE FROM vacp_plugin_github_sources WHERE workspace_id=$1 AND repo_id=$2 AND host=$3',
      [workspaceId, id, pluginHost(target)])
  }
}
