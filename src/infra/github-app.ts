/** Installation credentials shared by the service, worker gh commands and Git's credential helper. */
import { createHash, createSign } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lock } from 'proper-lockfile'
import { z } from 'zod'

export const GithubAppSchema = z.object({
  appId: z.string().regex(/^\d+$/), installationId: z.string().regex(/^\d+$/),
  privateKeyPath: z.string().startsWith('/'),
}).strict()
export type GithubAppConfig = z.infer<typeof GithubAppSchema>
export interface AppCommand { app: GithubAppConfig; repository: string; stateDir: string; cli: string }
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
  createHash('sha256').update(JSON.stringify([config.app, config.repository])).digest('hex'))

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
    const value = TokenSchema.parse(await appRequest(`/app/installations/${config.app.installationId}/access_tokens`,
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
