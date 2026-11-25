import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createVacpClient } from './account-client.js'

const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

const noAmbientAuth = {
  credentials: {
    read: async () => undefined,
    list: async () => [],
    modify: async () => undefined,
    delete: async () => {},
  },
  authContext: { env: async () => undefined, fileExists: async () => false },
}

export async function createWorkspaceModels(ctx) {
  const resolve = createRequire(ctx.profileContext.installAnchor)
  const piEntry = resolve.resolve('@deepseek-ai/dsh-llm-pi-ai')
  const sdk = ctx.pluginPackages.packageOf('@earendil-works/pi-ai', pathToFileURL(piEntry).href)
  const apiExport = sdk?.manifest.exports?.['./api/*']?.import
  if (typeof apiExport !== 'string') throw new Error('此 DSH 宿主缺少兼容的 OpenAI Completions 适配器。')
  const protocolEntry = join(sdk.dir, apiExport.replace('*', 'openai-completions.lazy'))
  const [{ PiAiAdapter }, { openAICompletionsApi }, { LlmError }] = await Promise.all([
    import(pathToFileURL(piEntry).href),
    import(pathToFileURL(protocolEntry).href),
    import(pathToFileURL(resolve.resolve('@deepseek-ai/dsh-llm')).href),
  ])
  const protocol = openAICompletionsApi()
  let registration, account, signature, accountLifetime
  let profiles = new Map()
  const sessions = new Map()

  async function sessionFor(provider, profile) {
    const selected = account
    if (!selected || profiles.get(provider) !== profile) throw new LlmError('请重新同步 VACP 工作空间模型。', 'MISSING_CREDENTIAL')
    if (!sessions.has(provider)) {
      sessions.set(provider, createVacpClient(selected.address).connectWorkspace(selected.token, profile.workspaceId))
    }
    const pending = sessions.get(provider)
    try {
      const session = await pending
      if (account !== selected || profiles.get(provider) !== profile || Date.parse(session.expiresAt) <= Date.now()) {
        throw new Error('workspace session is no longer active')
      }
      return session.accessToken
    } catch {
      if (sessions.get(provider) === pending) sessions.delete(provider)
      throw new LlmError('无法连接该 VACP 工作空间，请刷新模型或重新登录。', 'MISSING_CREDENTIAL')
    }
  }

  class WorkspaceAdapter extends PiAiAdapter {
    async listModels(provider) {
      const profile = profiles.get(provider)
      return profile?.piProvider.getModels().map(model => ({
        provider, id: model.id, name: model.name, inputModalities: ['text'],
      })) ?? []
    }
  }
  const adapter = new WorkspaceAdapter({
    profiles: () => profiles,
    auth: noAmbientAuth,
    resolveApiKey: sessionFor,
  })

  function sync(nextAccount, workspaces = []) {
    const modelSpaces = workspaces.filter(workspace => workspace.models?.length)
    const nextSignature = JSON.stringify(modelSpaces.map(({ id, name, models, modelLimits }) => [id, name, models, modelLimits]))
    const sameAccount = account?.token === nextAccount?.token && account?.address === nextAccount?.address
    if (sameAccount && signature === nextSignature) return
    const previous = profiles
    const lifetime = sameAccount ? accountLifetime : new AbortController()
    const nextProfiles = new Map(modelSpaces.map(workspace => {
      const provider = 'vacp-' + workspace.id
      const displayName = 'VACP · ' + workspace.name
      const baseUrl = new URL('/v1', nextAccount.address).href
      const scopedOptions = options => ({ ...options,
        signal: options?.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal })
      const models = workspace.models.map(alias => {
        const limits = workspace.modelLimits?.[alias]
        const efforts = thinkingLevels.filter(level => limits?.reasoningEfforts?.includes(level))
        const reasoning = efforts.length > 0
        const thinkingLevelMap = Object.fromEntries(thinkingLevels.map(level =>
          [level, efforts.includes(level) ? (level === 'off' ? 'none' : level) : null]))
        return {
          id: alias, name: alias, provider, baseUrl, api: 'openai-completions',
          input: ['text'], reasoning,
          ...(reasoning ? { thinkingLevelMap } : {}),
          contextWindow: limits?.contextWindow ?? 32768,
          maxTokens: limits?.maxOutputTokens ?? 4096,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: 'max_tokens', supportsReasoningEffort: reasoning },
        }
      })
      return [provider, {
        provider, displayName, workspaceId: workspace.id, streamIdleTimeoutMs: 120000,
        configuredMaxTokens: new Map(models.map(model => [model.id, model.maxTokens])), modelErrors: new Map(),
        piProvider: {
          id: provider, name: displayName, baseUrl,
          getModels: () => models,
          auth: { apiKey: { name: 'VACP', resolve: async ({ credential }) => ({ auth: { apiKey: credential?.key }, source: 'VACP' }) } },
          stream: (model, context, options) => protocol.stream(model, context, scopedOptions(options)),
          streamSimple: (model, context, options) => protocol.streamSimple(model, context, scopedOptions(options)),
        },
      }]
    }))
    profiles = nextProfiles
    try {
      if (registration) registration.replace([...profiles.keys()])
      else if (profiles.size) registration = ctx.llm.registerAdapter([...profiles.keys()], adapter)
    } catch (error) {
      profiles = previous
      throw error
    }
    if (!sameAccount) {
      accountLifetime?.abort()
      accountLifetime = lifetime
      sessions.clear()
    }
    else for (const provider of sessions.keys()) if (!profiles.has(provider)) sessions.delete(provider)
    account = sameAccount ? account : nextAccount
    signature = nextSignature
  }

  return { sync, dispose: () => {
    sync(undefined)
    registration?.()
    registration = undefined
  } }
}
