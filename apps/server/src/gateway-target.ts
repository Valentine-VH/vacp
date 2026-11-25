import { BadRequestException } from '@nestjs/common'
import { lookup } from 'node:dns'
import { isIP } from 'node:net'
import ipaddr from 'ipaddr.js'
import { Agent } from 'undici'

type UpstreamSecret = { key?: string; basic?: string; search?: string }
const publicV6 = ipaddr.IPv6.parse('2000::')

function publicAddress(address: string) {
  const ip = ipaddr.process(address)
  if (ip instanceof ipaddr.IPv6) return ip.range() === 'unicast' && ip.match(publicV6, 3)
  return ip.range() === 'unicast'
}

const publicAgent = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      lookup(hostname, { all: true, family: options.family }, (error, addresses) => {
        if (error) return callback(error, '', 0)
        if (!addresses.length || addresses.some(entry => !publicAddress(entry.address))) {
          return callback(new Error('上游域名解析到非公网地址，请配置网关内网上游'), '', 0)
        }
        if (options.all) return callback(null, addresses)
        const first = addresses[0]
        callback(null, first.address, first.family)
      })
    },
  },
})

function trustedOrigin(url: URL) {
  return ['https://api.openai.com','https://api.deepseek.com'].includes(url.origin) ||
    (process.env.VACP_GATEWAY_ALLOWED_ORIGINS ?? '').split(',').some(origin => origin.trim() === url.origin)
}

function upstreamUrl(value: string) {
  let url: URL
  try { url = new URL(value) } catch { throw new BadRequestException('上游地址格式无效') }
  if (!['http:', 'https:'].includes(url.protocol)) throw new BadRequestException('上游地址须使用 HTTP 或 HTTPS')
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '')
  const literal = isIP(host)
  if (!trustedOrigin(url) &&
    (literal ? !publicAddress(host) : !host.includes('.') || host.endsWith('.localhost'))) {
    throw new BadRequestException('内网上游须由部署者配置 VACP_GATEWAY_ALLOWED_ORIGINS')
  }
  return url
}

export function configureUpstream(value: string, key: string | undefined) {
  const url = upstreamUrl(value)
  const secret: UpstreamSecret = { ...(key ? { key } : {}), search: url.search }
  if (url.username || url.password) {
    if (key) throw new BadRequestException('URL 用户密码与 Bearer API Key 请选择一种')
    try {
      const username = decodeURIComponent(url.username)
      const password = decodeURIComponent(url.password)
      if (username.includes(':')) throw new Error('Invalid username')
      secret.basic = Buffer.from(username + ':' + password).toString('base64')
    } catch { throw new BadRequestException('URL 中的 Basic 认证用户密码格式无效') }
  }
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  return { baseUrl: url.href.replace(/\/+$/, ''), secret }
}

export type { UpstreamSecret }

export function upstreamRequest(baseUrl: string, secret: UpstreamSecret) {
  const url = upstreamUrl(baseUrl)
  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = path.endsWith('/chat/completions') ? path : path + '/chat/completions'
  url.search = secret.search ?? ''
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (secret.key) headers.Authorization = 'Bearer ' + secret.key
  else if (secret.basic) headers.Authorization = 'Basic ' + secret.basic
  return { url, headers, dispatcher: trustedOrigin(url) ? undefined : publicAgent }
}
