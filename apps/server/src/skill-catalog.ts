import { BadGatewayException, BadRequestException, Controller, Get, Param, Query, Req } from '@nestjs/common'
import { requireWorkspaceAccess, type WorkspaceRequest } from './workspace-access.js'

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}
function string(value: unknown) {
  return typeof value === 'string' ? value : ''
}

@Controller('api/v1/workspaces/:workspaceId/skills/external')
export class SkillCatalogController {
  @Get(':source')
  async list(
    @Req() req: WorkspaceRequest, @Param('workspaceId') workspaceId: string,
    @Param('source') source: string, @Query('q') query?: string,
  ) {
    await requireWorkspaceAccess(req, workspaceId)
    if (source !== 'skillhub' && source !== 'clawhub') throw new BadRequestException('未知技能市场')
    if (query !== undefined && typeof query !== 'string') throw new BadRequestException('搜索词格式错误')
    const keyword = query?.trim() ?? ''
    if (keyword.length > 100) throw new BadRequestException('搜索词最多 100 字')
    const skillHub = source === 'skillhub'
    const url = skillHub
      ? new URL('/api/skills?page=1&pageSize=30', 'https://api.skillhub.cn')
      : new URL(keyword ? '/api/v1/search?limit=30' : '/api/v1/skills?limit=30&sort=downloads', 'https://clawhub.ai')
    if (keyword) url.searchParams.set(skillHub ? 'keyword' : 'q', keyword)

    let payload: Record<string, unknown>
    try {
      const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000), redirect: 'error' })
      if (!response.ok) throw new Error(String(response.status))
      payload = object(await response.json())
    } catch {
      throw new BadGatewayException((skillHub ? 'SkillHub' : 'ClawHub') + ' 暂时无法访问，请重试')
    }
    const entries = skillHub ? object(payload.data).skills : keyword ? payload.results : payload.items
    if (!Array.isArray(entries)) throw new BadGatewayException('上游市场返回了无法识别的目录')
    return entries.slice(0,30).flatMap(entry => {
      const row = object(entry)
      const native = object(row.native)
      const skill = keyword && !skillHub ? object(native.skill) : row
      const slug = string(skill.slug)
      const owner = string(skillHub ? object(row.namespace).handle || row.ownerName : native.ownerHandle || row.ownerHandle)
      const name = string(skillHub ? row.name : row.displayName || skill.displayName)
      if (!slug || !owner || !name) return []
      const encode = encodeURIComponent
      const link = skillHub
        ? 'https://api.skillhub.cn/' + encode(owner) + '/' + encode(slug)
        : 'https://clawhub.ai/' + encode(owner) + '/skills/' + encode(slug)
      const price = object(row.channelPricing)
      return [{
        id: owner + '/' + slug,
        slug,
        name,
        owner,
        description: string(skillHub ? row.description_zh || row.description : row.summary || skill.summary),
        version: string(skillHub ? row.version : object(row.latestVersion).version || object(native.version).version || row.version),
        price: skillHub && string(price.price) ? [string(price.price), string(price.currency)].filter(Boolean).join(' ') : '',
        link,
      }]
    })
  }
}
