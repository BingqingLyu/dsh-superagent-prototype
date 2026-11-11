import { generateKeyPairSync, createVerify } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GithubAppSchema, appCacheDirectory, appJwt, commandRepository, installationToken, writeAppCli, type AppCommand } from '../src/infra/github-app.ts'
import { resolveDeployment } from '../src/deployment.ts'
import { testDeployment, testMachine } from './fixtures/deployment.ts'
import { writeEnvironment, workerGitConfig } from '../src/infra/environment.ts'
import { agentPull } from '../src/sources/github-pull.ts'

const exec = promisify(execFile)
const withInput = (file: string, args: string[], input: string, env = process.env) => new Promise<string>((resolve, reject) => {
  const child = execFile(file, args, { env, timeout: 10000 }, (error, stdout) => error ? reject(error) : resolve(stdout))
  child.stdin!.end(input)
})
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
  expect(await withInput(wrapper, ['auth', 'git-credential', 'get'], 'protocol=https\nhost=github.com\npath=acme/widgets.git\n\n', env))
    .toBe('username=x-access-token\npassword=installation-test-token\n\n')
}, 10000)

const multiple = (config: AppCommand): AppCommand => ({ ...config, app: { appId: config.app.appId, privateKeyPath: config.app.privateKeyPath,
  installations: [{ repository: 'acme/widgets', installationId: '34' }, { repository: 'alice/widgets', installationId: '56' }] } })
it('validates unambiguous repository installation mappings while retaining the single-installation format', () => {
  expect(GithubAppSchema.safeParse(config.app).success).toBe(true)
  const app = multiple(config).app
  expect(GithubAppSchema.safeParse(app).success).toBe(true)
  expect(GithubAppSchema.safeParse({ ...app, installationId: '34' }).success).toBe(false)
  expect(GithubAppSchema.safeParse({ ...app, installations: [...app.installations!, { repository: 'ACME/widgets', installationId: '56' }] }).success).toBe(false)
})
it.each([
  [['api', 'repos/acme/widgets/issues/1/comments'], 'acme/widgets'],
  [['api', 'https://api.github.com/repos/alice/widgets/contents/a'], 'alice/widgets'],
  [['pr', 'comment', '1', '--repo', 'acme/widgets'], 'acme/widgets'],
  [['pr', 'create', '-Racme/widgets', '--head', 'alice:fix'], 'acme/widgets'],
  [['pr', 'view', 'https://github.com/alice/widgets/pull/1'], 'alice/widgets'],
  [['repo', 'view', 'alice/widgets'], 'alice/widgets'],
  [['api', 'graphql', '-F', 'owner=alice', '-F', 'name=widgets', '-f', 'query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){id}}'], 'alice/widgets'],
  [['api', 'graphql', '-f', 'query={repository(name:"widgets",owner:"acme"){id}}'], 'acme/widgets'],
] as [string[], string][])('routes explicit command targets: %j', async (args, repository) => {
  expect(await commandRepository(multiple(config), args, { GH_REPO: 'other/unconfigured' })).toBe(repository)
})
it('uses GH_REPO or the checkout remote for implicit commands and refuses unknown or conflicting targets', async () => {
  config = multiple(config)
  expect(await commandRepository(config, ['pr', 'list'], { GH_REPO: 'alice/widgets' })).toBe('alice/widgets')
  await exec('git', ['init', directory])
  await exec('git', ['-C', directory, 'remote', 'add', 'origin', 'git@github.com:alice/widgets.git'])
  expect(await commandRepository(config, ['pr', 'list'], {}, directory)).toBe('alice/widgets')
  await expect(commandRepository(config, ['api', 'repos/other/widgets'], {}, directory)).rejects.toThrow('no configured')
  await expect(commandRepository(config, ['pr', 'view', 'https://github.com/alice/widgets/pull/1', '-R', 'acme/widgets'], {})).rejects.toThrow('one repository')
  await expect(commandRepository(config, ['pr', 'list'], { GH_HOST: 'other.example' })).rejects.toThrow('github.com')
})
it('validates all installations and preserves the upstream as the watched repository', async () => {
  config = multiple(config)
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith('/app')) return response({ id: 12, slug: 'neug-agent' })
    if (url.endsWith('/app/installations/34')) return response({ app_id: 12, account: { login: 'acme' } })
    if (url.endsWith('/app/installations/56')) return response({ app_id: 12, account: { login: 'alice' } })
    if (url.endsWith('/access_tokens')) return response(credential())
    if (url.includes('/repos/')) return response({ full_name: url.split('/repos/')[1] })
    return response({ id: 56, login: 'neug-agent[bot]' })
  })
  vi.stubGlobal('fetch', fetcher)
  const deployment = await resolveDeployment(testMachine({ stateDir: directory }), { repository: config.repository, cli: config.cli, app: config.app }, vi.fn())
  expect(deployment.repository).toBe('acme/widgets')
  expect(deployment.github.repositories).toEqual(['acme/widgets', 'alice/widgets'])
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/access_tokens'))).toHaveLength(2)
  const pr = { user: { login: 'neug-agent[bot]' }, head: { repo: { full_name: 'alice/widgets' } } }
  expect(agentPull(pr, deployment)).toBe(true)
  expect(agentPull({ ...pr, head: { repo: { full_name: 'other/widgets' } } }, deployment)).toBe(false)
  expect(agentPull({ ...pr, user: { login: 'other-user' } }, deployment)).toBe(false)
})
it('switches CLI and real Git credential requests between isolated upstream and fork tokens', async () => {
  config = multiple(config)
  const cli = join(directory, 'real-gh')
  writeFileSync(cli, '#!/bin/sh\nprintf "%s:%s\\n" "$GH_REPO" "$GH_TOKEN"\n', { mode: 0o700 })
  config.cli = cli
  const fetcher = vi.fn(async (url: string) => response(credential(url.includes('/34/') ? 'upstream-fixture' : 'fork-fixture')))
  vi.stubGlobal('fetch', fetcher)
  await Promise.all([installationToken(config), installationToken({ ...config, repository: 'alice/widgets' })])
  const wrapper = await writeAppCli(config)
  expect((await exec(wrapper, ['pr', 'comment', '1', '-R', 'acme/widgets'])).stdout.trim()).toBe('acme/widgets:upstream-fixture')
  expect((await exec(wrapper, ['api', 'repos/alice/widgets/contents/a'])).stdout.trim()).toBe('alice/widgets:fork-fixture')
  const deployment = testDeployment({ stateDir: directory, github: { cli: wrapper, auth: 'app', login: 'neug-agent[bot]', noreply: '' } })
  await writeEnvironment(deployment, [])
  const env = { ...process.env, GIT_CONFIG_GLOBAL: workerGitConfig(directory), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }
  for (const [repository, token] of [['acme/widgets', 'upstream-fixture'], ['alice/widgets', 'fork-fixture']]) {
    const output = await withInput('git', ['credential', 'fill'], `protocol=https\nhost=github.com\npath=${repository}.git\n\n`, env)
    expect(output).toContain(`password=${token}\n`)
  }
  expect(fetcher).toHaveBeenCalledTimes(2) // Both child processes reused the installation-specific caches.
  expect(appCacheDirectory(config)).not.toBe(appCacheDirectory({ ...config, repository: 'alice/widgets' }))
}, 20000)
