import { repositoryClient } from './repository.js'

const description = 'List third-party plugin sources published in the configured VACP workspace.'

async function list(signal) {
  const {VACP_URL,VACP_WORKSPACE_ID,VACP_PLUGIN_ACCOUNT_TOKEN} = process.env
  if (!VACP_PLUGIN_ACCOUNT_TOKEN) throw new Error('Set VACP_PLUGIN_ACCOUNT_TOKEN before using the VACP catalog tool.')
  const rows = await repositoryClient(VACP_URL).listSources(VACP_WORKSPACE_ID,VACP_PLUGIN_ACCOUNT_TOKEN,signal)
  return JSON.stringify(rows.map(({fullName,host,description})=>({fullName,host,description})))
}

export default {
  id:'vacp.plugin-repository',
  async setup(ctx) {
    await ctx.tool.transform(editor=>editor.add({
      name:'vacp_plugin_catalog', description,
      input:{type:'object',properties:{},additionalProperties:false},
      execute:async (_input,{signal})=>({content:await list(signal)}),
    }))
  },
  async server() {
    return {tool:{vacp_plugin_catalog:{description,args:{},execute:(_args,context)=>list(context.abort)}}}
  },
}
