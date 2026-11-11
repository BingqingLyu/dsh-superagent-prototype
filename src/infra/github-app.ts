/** Installation credentials shared by the service, worker gh commands and Git's credential helper. */
import { createHash, createSign } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { lock } from 'proper-lockfile'
import { z } from 'zod'

const RepositorySchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
export const GithubAppSchema = z.object({
  appId: z.string().regex(/^\d+$/), installationId: z.string().regex(/^\d+$/).optional(),
  installations: z.array(z.object({ repository: RepositorySchema, installationId: z.string().regex(/^\d+$/) }).strict()).min(1).optional(),
  privateKeyPath: z.string().startsWith('/'),
}).strict().refine(value => !!value.installationId !== !!value.installations, 'Set either installationId or installations')
  .refine(value => !value.installations || new Set(value.installations.map(item => item.repository.toLowerCase())).size === value.installations.length,
    'Each repository must have exactly one installation')
export type GithubAppConfig = z.infer<typeof GithubAppSchema>
export interface AppCommand { app: GithubAppConfig; repository: string; stateDir: string; cli: string }
export const appInstallations = (config: Pick<AppCommand, 'app' | 'repository'>) => config.app.installations
  ?? [{ repository: config.repository, installationId: config.app.installationId! }]
export function repositoryInstallation(config: Pick<AppCommand, 'app' | 'repository'>, repository = config.repository) {
  const route = appInstallations(config).find(item => item.repository.toLowerCase() === repository.toLowerCase())
  if (!route) throw new Error('Repository has no configured GitHub App installation')
  return route
}

const normalizedRepository = (value: string): string => RepositorySchema.parse(value.replace(/^github\.com\//i, '').replace(/\.git$/, ''))
const fromUrl = (value: string): string | undefined => {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/#?]+)/i.exec(value)
  return match ? normalizedRepository(match[1]!) : undefined
}
/** Select credentials from explicit command targets first, then GH_REPO, then the checkout's origin. */
export async function commandRepository(config: AppCommand, args: string[], env = process.env, cwd = process.cwd()): Promise<string> {
  if (env.GH_HOST && env.GH_HOST !== 'github.com') throw new Error('Only github.com is supported')
  const targets: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--hostname' && args[index + 1] !== 'github.com' || arg.startsWith('--hostname=') && arg !== '--hostname=github.com') {
      throw new Error('Only github.com is supported')
    }
    if (arg === '-R' || arg === '--repo') targets.push(normalizedRepository(args[++index] ?? ''))
    else if (arg.startsWith('--repo=')) targets.push(normalizedRepository(arg.slice(7)))
    else if (arg.startsWith('-R') && arg.length > 2) targets.push(normalizedRepository(arg.slice(2)))
  }
  if (args[0] === 'api') {
    const endpoint = args.find(arg => /^\/?repos\//.test(arg) || /^https:\/\/api\.github\.com\/repos\//.test(arg))
    if (endpoint) {
      const match = /^(?:https:\/\/api\.github\.com\/|\/)?repos\/([^/]+\/[^/?#]+)/.exec(endpoint)!
      targets.push(normalizedRepository(match[1]!))
    }
    if (args.includes('graphql')) {
      const fields = args.filter((_, index) => ['-f', '-F', '--field', '--raw-field'].includes(args[index - 1] ?? ''))
      const field = (name: string) => fields.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1)
      if (field('owner') && (field('name') || field('repo'))) targets.push(normalizedRepository(`${field('owner')}/${field('name') ?? field('repo')}`))
      for (const match of (field('query') ?? '').matchAll(/repository\s*\(([^)]+)\)/g)) {
        const owner = /owner\s*:\s*"([^"]+)"/.exec(match[1]!)?.[1], name = /name\s*:\s*"([^"]+)"/.exec(match[1]!)?.[1]
        if (owner && name) targets.push(normalizedRepository(`${owner}/${name}`))
      }
    }
  } else if (args[2] && !args[2].startsWith('-')) {
    const url = fromUrl(args[2])
    if (url) targets.push(url)
    else if (args[0] === 'repo' && args[2].includes('/')) targets.push(normalizedRepository(args[2]))
  }
  if (new Set(targets.map(value => value.toLowerCase())).size > 1) throw new Error('A command must target one repository')
  let repository = targets[0] ?? (env.GH_REPO ? normalizedRepository(env.GH_REPO) : undefined)
  if (!repository) {
    const remote = await promisify(execFile)('git', ['remote', 'get-url', 'origin'], { cwd, timeout: 5000 }).catch(() => undefined)
    if (remote?.stdout.trim()) {
      repository = fromUrl(remote.stdout.trim())
      if (!repository) throw new Error('Unsupported repository remote')
    }
  }
  return repositoryInstallation(config, repository ?? config.repository).repository
}
/** Git must include the repository path (credential.useHttpPath) so fork and upstream do not share a host-wide token. */
export function credentialRepository(config: AppCommand, input: string): string {
  const fields = Object.fromEntries(input.trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1).trim()] }))
  if (fields.protocol !== 'https' || fields.host !== 'github.com' || !fields.path) throw new Error('Missing GitHub credential repository')
  return repositoryInstallation(config, normalizedRepository(fields.path)).repository
}
const TokenSchema = z.object({ token: z.string().min(1), expires_at: z.string().datetime(),
  permissions: z.record(z.string(), z.string()) })
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

export async function appRequest(path: string, token: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`https://api.github.com${path}`, {
    method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(20000),
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json', 'User-Agent': 'dsh-superagent' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok) throw new Error(`GitHub App request failed (HTTP ${response.status})`)
  return response.json()
}
export async function appJwt(app: GithubAppConfig): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const input = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + 540, iss: app.appId })}`
  const signer = createSign('RSA-SHA256'); signer.update(input)
  return `${input}.${signer.sign(await readFile(app.privateKeyPath), 'base64url')}`
}
export const appCacheDirectory = (config: AppCommand): string => join(config.stateDir, 'github-app',
  createHash('sha256').update(JSON.stringify([config.app.appId, config.app.privateKeyPath,
    repositoryInstallation(config).installationId, config.repository.toLowerCase()])).digest('hex'))

/** Cross-process cache and refresh lock: gh invocations and Git must not each mint a fresh token. */
export async function installationToken(config: AppCommand) {
  const directory = appCacheDirectory(config)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const file = join(directory, 'installation.json')
  const cached = async () => {
    try {
      const value = TokenSchema.parse(JSON.parse(await readFile(file, 'utf8')))
      if (Date.parse(value.expires_at) > Date.now() + 300000) return value
    } catch { /* Missing, invalid or expired cache is refreshed under the lock. */ }
    return undefined
  }
  const existing = await cached()
  if (existing) return existing
  const release = await lock(directory, { stale: 30000, retries: { retries: 100, minTimeout: 100, maxTimeout: 300 } })
  try {
    const current = await cached()
    if (current) return current
    const value = TokenSchema.parse(await appRequest(`/app/installations/${repositoryInstallation(config).installationId}/access_tokens`,
      await appJwt(config.app), { repositories: [config.repository.split('/')[1]] }))
    if (Date.parse(value.expires_at) <= Date.now() + 300000) throw new Error('GitHub App returned an expiring token')
    const temporary = `${file}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 })
    await rename(temporary, file)
    return value
  } finally { await release() }
}

/** The wrapper resolves credentials on every invocation; no installation token is embedded in it. */
export async function writeAppCli(config: AppCommand): Promise<string> {
  const directory = appCacheDirectory(config)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const file = join(directory, 'gh-app')
  const entry = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './github-app-cli.ts' : './github-app-cli.js', import.meta.url))
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(entry)} ${quote(JSON.stringify(config))} "$@"\n`, { mode: 0o700 })
  await rename(temporary, file)
  return file
}
