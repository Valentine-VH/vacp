import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createVacpClient } from './account-client.js'
import manifest from './package.json' with { type: 'json' }

const versionPattern = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/
const maxBytes = 8 * 1024 * 1024

function newer(a, b) {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  return (left[0] - right[0] || left[1] - right[1] || left[2] - right[2]) > 0
}

async function readArchive(client, token, workspace, release) {
  const response = await client.fetchPlugin(token, workspace, 'dsh', release.version)
  if (!response.body || response.headers.get('content-type') !== 'application/gzip') {
    await response.body?.cancel()
    throw new Error('VACP 未返回有效的安装包。')
  }
  const hash = createHash('sha256')
  const chunks = []
  let bytes = 0
  for await (const chunk of response.body) {
    bytes += chunk.byteLength
    if (bytes > release.bytes) throw new Error('安装包大小与发布信息不一致。')
    hash.update(chunk)
    chunks.push(chunk)
  }
  if (bytes !== release.bytes || hash.digest('hex') !== release.sha256) {
    throw new Error('安装包校验失败，请重新检测更新。')
  }
  return Buffer.concat(chunks, bytes)
}

export function createPluginUpdate(ctx) {
  const manager = () => ctx.get('pluginManager')
  async function check(client, token, workspace, pluginManager) {
    const catalog = await client.listPlugins(token, workspace)
    const releases = catalog.find(item => item.id === 'dsh')?.releases ?? []
    let latest
    for (const release of releases) {
      if (versionPattern.test(release.version) && /^[a-f0-9]{64}$/.test(release.sha256) &&
        release.filename === 'vacp-plugin-dsh-' + release.version + '.tgz' &&
        Number.isSafeInteger(release.bytes) && release.bytes > 0 && release.bytes <= maxBytes &&
        (!latest || newer(release.version, latest.version))) latest = release
    }
    const bundle = (await pluginManager?.listBundles())?.find(item => item.name === manifest.name)
    const installed = bundle?.version && versionPattern.test(bundle.version) ? bundle.version : manifest.version
    const restartRequired = newer(installed, manifest.version)
    return {
      current: manifest.version, installed, latest: latest ?? null, restartRequired,
      available: Boolean(latest && newer(latest.version, installed)),
      canInstall: bundle?.installed === true && bundle.enabled,
    }
  }

  return {
    check(account, workspace) {
      return check(createVacpClient(account.address), account.token, workspace, manager())
    },
    async install(account, workspace, selection) {
      const pluginManager = manager()
      const client = createVacpClient(account.address)
      const status = await check(client, account.token, workspace, pluginManager)
      if (!status.canInstall || status.restartRequired || !status.available ||
        status.latest.version !== selection?.version || status.latest.sha256 !== selection?.sha256) {
        throw Object.assign(new Error('更新状态已变化，请重新检测版本。'), { status: 409 })
      }
      const release = status.latest
      const bytes = await readArchive(client, account.token, workspace, release)
      const directory = join(ctx.profileContext.dir, 'vacp-updates')
      await mkdir(directory, { recursive: true })
      const staging = await mkdtemp(join(directory, 'release-'))
      const archive = join(staging, release.filename)
      let installing = false
      try {
        await writeFile(archive, bytes, { flag: 'wx' })
        // The saved file dependency still needs this archive on subsequent profile installs.
        installing = true
        const result = await pluginManager.installBundle(archive, {
          enabled: true, saveExact: true, expected: { name: manifest.name, version: release.version },
        })
        if (result.application !== 'applied' && result.application !== 'restart-required') {
          if (result.stage === 'install' && !result.changed) installing = false
          throw new Error('DSH 安装未完成，请在 DSH「插件」中查看安装记录。')
        }
        return { installed: release.version, restartRequired: result.application === 'restart-required' }
      } finally {
        if (!installing) await rm(staging, { recursive: true, force: true }).catch(() => {})
      }
    },
  }
}
