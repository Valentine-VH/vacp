import 'reflect-metadata'
import { Controller, Get, Module, ServiceUnavailableException } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { FastifyAdapter } from '@nestjs/platform-fastify'
import { migrateIdentity, pool } from './database.js'
import { IdentityController } from './identity.js'
import { MockTaskController } from './mock-tasks.js'
import { SkillsController } from './skills.js'
import { SkillCatalogController } from './skill-catalog.js'
import { SkillImportController } from './skill-imports.js'
import { SystemController } from './system.js'
import { McpController } from './mcp.js'
import { AgentPluginRepositoryController, AgentPluginsController } from './agent-plugins.js'
import { AgentPluginGitHubController } from './agent-plugin-github.js'
import { AgentPluginAccountController, AgentPluginAuthController, AgentPluginSessionsController } from './agent-plugin-sessions.js'
import { AgentPluginConfigController, AgentPluginProfilesController } from './agent-plugin-config.js'
import { AgentTeamsController } from './agent-teams.js'
import { AgentPluginModelsController, ModelGatewayAdminController, ModelGatewayController } from './model-gateway.js'
import { startSkillScanDispatcher } from './skill-scan-dispatcher.js'
import { DshConversationsController, installDshConnector } from './dsh-conversations.js'

let stopSkillScan: (() => Promise<void>) | undefined
let stopDshConnector: (() => void) | undefined

@Controller()
class HealthController {
  @Get('health/live')
  live() {
    return { status: 'ok' }
  }

  @Get('health/ready')
  async ready() {
    try {
      await pool.query('SELECT 1')
      return { status: 'ok' }
    } catch {
      throw new ServiceUnavailableException('Database unavailable')
    }
  }

  async beforeApplicationShutdown() {
    stopDshConnector?.()
  }

  async onApplicationShutdown() {
    await stopSkillScan?.()
    await pool.end()
  }
}

@Module({ controllers: [HealthController, IdentityController, MockTaskController, SkillsController, SkillCatalogController, SkillImportController, SystemController, McpController, AgentPluginsController, AgentPluginRepositoryController, AgentPluginGitHubController, AgentTeamsController, AgentPluginModelsController, ModelGatewayAdminController, ModelGatewayController, AgentPluginAccountController, AgentPluginAuthController, AgentPluginSessionsController, AgentPluginConfigController, AgentPluginProfilesController, DshConversationsController] })
class AppModule {}

const adapter = new FastifyAdapter()
const app = await NestFactory.create(AppModule, adapter)
await migrateIdentity()
stopDshConnector = installDshConnector(adapter.getInstance().server)
stopSkillScan = await startSkillScanDispatcher()
adapter.getInstance().addHook('onRequest', async (request, reply) => {
  if (!request.url.startsWith('/api/v1/') || request.url.startsWith('/api/v1/mock-node/') ||
      request.url === '/api/v1/agent-plugin-auth/redeem' ||
      request.url === '/api/v1/agent-plugin-auth/model-key' ||
      request.url === '/api/v1/agent-plugin-auth/account/login' ||
      request.url === '/api/v1/agent-plugin-auth/account/session' ||
      request.url === '/api/v1/agent-plugin-auth/account/instance' ||
      /^\/api\/v1\/agent-plugin-auth\/account\/workspaces\/[\da-f-]+\/session$/i.test(request.url) ||
      /^\/api\/v1\/agent-plugin-auth\/account\/workspaces\/[\da-f-]+\/model-gateway\/routes$/i.test(request.url) ||
      /^\/api\/v1\/agent-plugin-auth\/mcps\/[\da-f-]+$/i.test(request.url) ||
      ['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return
  const allowed = process.env.WEB_ORIGIN ?? 'http://127.0.0.1:5176'
  if (request.headers.origin !== allowed) await reply.code(403).send({ message: 'Origin not allowed' })
})
app.enableShutdownHooks()
const port = Number(process.env.VACP_SERVER_PORT ?? '3320')
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid VACP_SERVER_PORT')
await app.listen(port, '127.0.0.1')
