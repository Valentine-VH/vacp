#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { repositoryClient } from './repository.js'

async function signIn(client) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Use an interactive terminal or set VACP_PLUGIN_ACCOUNT_TOKEN.')
  let secret = false
  const output = new Writable({ write(chunk, encoding, done) {
    if (!secret) process.stdout.write(chunk,encoding)
    done()
  } })
  const rl = createInterface({ input:process.stdin, output, terminal:true })
  try {
    const email = (await rl.question('VACP email: ')).trim()
    process.stdout.write('VACP password: ')
    secret = true
    const password = await rl.question('')
    return await client.login(email,password)
  } finally {
    process.stdout.write('\n')
    rl.close()
  }
}

async function main() {
  const [action,id,version] = process.argv.slice(2)
  if (!['workspaces','list','download'].includes(action) || (action==='download' && (!id || !version))) {
    console.log('Usage: vacp-opencode-plugins workspaces | list | download <dsh|opencode> <version>')
    return
  }
  const client = repositoryClient(process.env.VACP_URL)
  let token = process.env.VACP_PLUGIN_ACCOUNT_TOKEN
  const temporary = !token
  if (!token) token = (await signIn(client)).accountToken
  try {
    if (action==='workspaces') {
      const spaces = await client.workspaces(token)
      console.table(spaces.map(({id,name,role})=>({id,name,role})))
      return
    }
    let workspace = process.env.VACP_WORKSPACE_ID
    if (!workspace) {
      const spaces = await client.workspaces(token)
      if (spaces.length !== 1) throw new Error('Run workspaces and set VACP_WORKSPACE_ID to a workspace ID.')
      workspace = spaces[0].id
    }
    if (action==='list') {
      console.table((await client.listSources(workspace,token)).map(({host,fullName,description})=>({host,repository:fullName,description})))
      return
    }
    const catalog = await client.list(workspace,token)
    const release = catalog.find(plugin=>plugin.id===id)?.releases.find(item=>item.version===version)
    if (!release || !['dsh','opencode'].includes(id) || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(version)) {
      throw new Error('Plugin release not found.')
    }
    const filename = 'vacp-plugin-'+id+'-'+version+'.tgz'
    const response = await client.download(workspace,token,id,version)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length !== release.bytes || createHash('sha256').update(bytes).digest('hex') !== release.sha256) {
      throw new Error('Plugin size or SHA-256 did not match the catalog.')
    }
    await writeFile(filename,bytes,{flag:'wx'})
    console.log(resolve(filename))
  } finally {
    if (temporary) await client.logout(token).catch(()=>console.error('Could not revoke the temporary VACP session.'))
  }
}

main().catch(error=>{console.error(error.message);process.exitCode=1})
