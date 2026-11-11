import { generateKeyPairSync, createVerify } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { appCacheDirectory, appJwt, installationToken, writeAppCli, type AppCommand } from '../src/infra/github-app.ts'
import { resolveDeployment } from '../src/deployment.ts'
import { testMachine } from './fixtures/deployment.ts'

const exec = promisify(execFile)
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
let directory: string, config: AppCommand
const permissions = { contents: 'write', pull_requests: 'write', issues: 'write' }
const credential = (token = 'installation-test-token') => ({ token, expires_at: new Date(Date.now() + 3600000).toISOString(), permissions })
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'github-app-'))
  const privateKeyPath = join(directory, 'app.pem')
  writeFileSync(privateKeyPath, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  config = { app: { appId: '12', installationId: '34', privateKeyPath }, repository: 'acme/widgets', stateDir: directory, cli: '/bin/echo' }
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }) })

it('signs short-lived app JWTs with the private key', async () => {
  const jwt = await appJwt(config.app)
  const [header, payload, signature] = jwt.split('.')
  const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString())
  expect(claims).toMatchObject({ iss: '12' })
  expect(claims.exp - claims.iat).toBe(600)
  const verifier = createVerify('RSA-SHA256'); verifier.update(`${header}.${payload}`)
  expect(verifier.verify(keys.publicKey, signature!, 'base64url')).toBe(true)
})
it('restricts tokens to the repository, shares concurrent refreshes and refreshes expiring cached tokens', async () => {
  const fetcher = vi.fn(async () => response(credential()))
  vi.stubGlobal('fetch', fetcher)
  const tokens = await Promise.all([installationToken(config), installationToken(config), installationToken(config)])
  expect(tokens.every(value => value.token === 'installation-test-token')).toBe(true)
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(fetcher.mock.calls[0]).toEqual(['https://api.github.com/app/installations/34/access_tokens', expect.objectContaining({
    body: JSON.stringify({ repositories: ['widgets'] }), headers: expect.objectContaining({ Authorization: expect.stringMatching(/^Bearer /) }),
  })])
  const file = join(appCacheDirectory(config), 'installation.json')
  expect(statSync(file).mode & 0o777).toBe(0o600)
  writeFileSync(file, JSON.stringify({ ...credential(), expires_at: new Date(Date.now() + 60000).toISOString() }))
  await installationToken(config)
  expect(fetcher).toHaveBeenCalledTimes(2)
})
it('does not cache failed exchanges or include response credentials in errors', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response({ message: 'private diagnostic' }, 403)))
  await expect(installationToken(config)).rejects.toThrow('GitHub App request failed (HTTP 403)')
  vi.stubGlobal('fetch', vi.fn(async () => response(credential())))
  await expect(installationToken(config)).resolves.toMatchObject({ token: 'installation-test-token' })
})
it('uses the installation identity and verifies installation ownership instead of probing /user', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/app')) return response({ id: 12, slug: 'neug-agent' })
    if (url.endsWith('/app/installations/34')) return response({ app_id: 12, account: { login: 'acme' } })
    if (url.endsWith('/access_tokens')) return response(credential())
    if (url.endsWith('/repos/acme/widgets')) return response({ full_name: 'acme/widgets' })
    if (url.endsWith('/users/neug-agent%5Bbot%5D')) return response({ id: 56, login: 'neug-agent[bot]' })
    throw new Error('Unexpected personal endpoint')
  }))
  const probe = vi.fn()
  const deployment = await resolveDeployment(testMachine({ stateDir: directory }), { repository: config.repository, cli: config.cli, app: config.app }, probe)
  expect(probe).not.toHaveBeenCalled()
  expect(deployment.github).toMatchObject({ auth: 'app', login: 'neug-agent[bot]', noreply: '56+neug-agent[bot]@users.noreply.github.com' })
  expect(readFileSync(deployment.github.cli, 'utf8')).not.toContain('installation-test-token')
})
it.each(['wrong-owner', 'missing-permissions'])('refuses invalid App setup: %s', async reason => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/app')) return response({ id: 12, slug: 'neug-agent' })
    if (url.endsWith('/app/installations/34')) return response({ app_id: 12, account: { login: reason === 'wrong-owner' ? 'other' : 'acme' } })
    return response({ ...credential(), permissions: { contents: 'read' } })
  }))
  await expect(resolveDeployment(testMachine({ stateDir: directory }), { repository: config.repository, cli: config.cli, app: config.app }, vi.fn()))
    .rejects.toMatchObject({ code: 'githubAppFailed' })
})
it('uses the same cached App identity for CLI operations and git credentials, overriding personal tokens', async () => {
  const cli = join(directory, 'real-gh')
  writeFileSync(cli, `#!/bin/sh\n[ "$GH_TOKEN" = installation-test-token ] || exit 9\n[ -z "$GITHUB_TOKEN" ] || exit 10\ncase "$*" in\n 'auth git-credential get') printf 'username=x-access-token\\npassword=%s\\n' "$GH_TOKEN" ;;\n *) echo 'neug-agent[bot]' ;;\nesac\n`, { mode: 0o700 })
  config.cli = cli
  vi.stubGlobal('fetch', vi.fn(async () => response(credential())))
  await installationToken(config)
  const wrapper = await writeAppCli(config)
  const env = { ...process.env, GH_TOKEN: 'personal', GITHUB_TOKEN: 'personal' }
  expect((await exec(wrapper, ['api', 'repos/acme/widgets'], { env })).stdout.trim()).toBe('neug-agent[bot]')
  expect((await exec(wrapper, ['auth', 'git-credential', 'get'], { env })).stdout).toBe('username=x-access-token\npassword=installation-test-token\n')
}, 10000)
