/** Headless bootstrap for the original Runtime: Codex host adapter + DingTalk Source. */
import { Context } from '@deepseek-ai/cordis'
import { execFileSync } from 'node:child_process'
import { loadEnvFile } from 'node:process'
import { resolve, join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { lockSync } from 'proper-lockfile'
import { z } from 'zod'
import { Runtime } from './app/runtime.ts'
import { Store } from './app/store.ts'
import { KV } from './kv.ts'
import { SettingsSchema } from './policy.ts'
import type { Machine } from './deployment.ts'
import { CodexHarness } from './harness/codex.ts'
import { DingTalk, dingTalkKind } from './sources/dingtalk.ts'
import { githubKind, watchGithub } from './sources/github.ts'
import { GithubAppSchema } from './infra/github-app.ts'
import { Prompts, defaultPrompts } from './app/prompts.ts'
import { loadSkillDir } from './app/skill-files.ts'

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`
const reference = <T>(value: T) => ({ get: () => value })
const log = (event: string) => console.log(JSON.stringify({ at: new Date().toISOString(), event }))
/** The proactive rule that turns a GitHub CI failure into a read-only analysis ticket reported to the DingTalk group. */
const CI_ANALYSIS_RULE = 'Accept a GitHub CI failure event — a failed PR check, or a completed nightly.yml, release.yml or package.yml run whose conclusion is failure or cancelled — as an analysis-only ticket (work_kind analysis). Scope: read the failed run\'s logs with gh, locate the root cause (code or test defect, flake, environment/infra, or credentials/secrets), and report a concise conclusion with evidence, a suggested next step and links to the DingTalk report group. Do not modify code, open a PR, re-run or cancel any workflow, or publish anything. Ignore success or recovery events, and ignore a failure already covered by a live ticket on the same thread, such as a release ticket waiting on that run.'
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const usage = 'Usage: node lib/codex-cli.js [--env-file /absolute/path/to/env]'
  if (args.length === 1 && args[0] === '--help') { console.log(usage); return }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--env-file' && args[i + 1]) loadEnvFile(args[++i]!)
    else throw new Error(usage)
  }
  const clientId = process.env.DINGTALK_CLIENT_ID, clientSecret = process.env.DINGTALK_CLIENT_SECRET
  if (!clientId || !clientSecret) throw new Error('Set DINGTALK_CLIENT_ID and DINGTALK_CLIENT_SECRET')
  const repository = resolve(process.env.SUPERAGENT_REPOSITORY ?? '.')
  const stateDir = resolve(process.env.SUPERAGENT_STATE_DIR ?? './state-codex')
  const sandbox = z.enum(['read-only', 'workspace-write', 'danger-full-access']).parse(process.env.CODEX_SANDBOX ?? 'workspace-write')
  const port = z.coerce.number().int().min(1).max(65535).parse(process.env.SUPERAGENT_PORT ?? 3082)
  const githubAuth = z.enum(['user', 'app']).parse(process.env.SUPERAGENT_GITHUB_AUTH ?? 'user')
  const githubApp = githubAuth === 'app' ? GithubAppSchema.parse({
    appId: process.env.SUPERAGENT_GITHUB_APP_ID,
    ...(process.env.SUPERAGENT_GITHUB_INSTALLATIONS
      ? { installations: JSON.parse(process.env.SUPERAGENT_GITHUB_INSTALLATIONS) }
      : { installationId: process.env.SUPERAGENT_GITHUB_INSTALLATION_ID }),
    privateKeyPath: process.env.SUPERAGENT_GITHUB_PRIVATE_KEY_PATH,
  }) : undefined
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  // Seed installation settings once using the original schema/store; subsequent settings retain their original history.
  const release = lockSync(stateDir)
  try {
    const store = new Store(join(stateDir, 'orchestrator.sqlite'))
    try {
      if (!store.get(KV.settings.revision)) {
        const remote = process.env.SUPERAGENT_GITHUB_REPOSITORY ?? (() => {
          const url = execFileSync('git', ['-C', repository, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim()
          const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url)
          if (!match) throw new Error('Set SUPERAGENT_GITHUB_REPOSITORY=owner/name')
          return match[1]!
        })()
        const reportConversationId = process.env.DINGTALK_REPORT_CONVERSATION_ID
        const settings = SettingsSchema.parse({
          sources: { github: { enabled: true, config: { repository: remote, cli: process.env.SUPERAGENT_GITHUB_CLI ?? 'gh',
              observeCi: true, observePrCi: true, watchWorkflows: ['nightly.yml', 'release.yml', 'package.yml'],
              ...(githubApp ? { app: githubApp } : {}) } },
            dingtalk: { enabled: true, config: reportConversationId ? { reportConversationId } : {} } },
          // Use the original admission table to allow every mentioned sender; no new gate or whitelist implementation.
          // CI events have no sender, so the ci/prCi/runs rows admit them as inferred candidates for the ci-analysis rule.
          policy: { sources: { dingtalk: { allowed: [], admission: { group: { unlistedAddressed: 'explicit' } } },
            github: { allowed: [], admission: { ci: { unlistedUnaddressed: 'inferred' }, prCi: { unlistedUnaddressed: 'inferred' }, runs: { unlistedUnaddressed: 'inferred' } } } } },
          eval: { mode: 'auto' },
          executor: { maxWorkers: Number(process.env.SUPERAGENT_MAX_WORKERS ?? 3),
            prepare: `git -C ${quote(repository)} worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" HEAD` },
        })
        settings.policy.rules.push({ id: 'ci-analysis', name: 'CI failure analysis', enabled: true, instruction: CI_ANALYSIS_RULE })
        store.saveSettings(settings)
        // Seed the neug team skills into the prompts configuration on first start, so both roles' Sessions register them.
        const prompts = new Prompts(store, () => 100000, () => undefined, () => false)
        if (prompts.current().revision === 0) {
          prompts.save({ ...defaultPrompts(), skills: { 'neug-ci': loadSkillDir('neug-ci').content, 'neug-release': loadSkillDir('neug-release').content } }, 0, 'sync')
        }
      }
    } finally { store.close() }
  } finally { release() }
  const machine: Machine = { stateDir, promptMaxChars: reference(100000), admissionContextMaxPages: reference(10),
    admissionContextTimeoutMs: reference(15000) }
  const ctx = new Context()
  const harness = new CodexHarness(ctx, { binary: process.env.CODEX_BINARY ?? 'codex', model: process.env.CODEX_MODEL,
    sandbox, port })
  let runtime: Runtime | undefined, robot: DingTalk | undefined
  const githubController = new AbortController()
  let githubPolling: Promise<void> | undefined
  let stopping: Promise<void> | undefined
  const stop = () => stopping ??= (async () => {
    robot?.stop()
    githubController.abort()
    await githubPolling
    const stopped = runtime?.stop()
    await harness.close()
    await stopped
  })()
  try {
    runtime = new Runtime(ctx, machine, () => { log('restart_required'); void stop() })
    runtime.lifetime.addEventListener('abort', () => { githubController.abort(); robot?.stop(); void harness.close() }, { once: true })
    runtime.sources.register(githubKind)
    const kind = dingTalkKind(message => robot!.send(message))
    runtime.sources.register(kind)
    await runtime.ready
    if (!runtime.configured()) throw new Error(`Setup: ${runtime.setupProblem?.detail ?? 'not configured'}`)
    robot = new DingTalk(runtime.context(kind), { clientId, clientSecret }, log, fetch,
      process.env.DINGTALK_CARD_TEMPLATE_ID, process.env.DINGTALK_ROBOT_NAME)
    await harness.listen()
    await robot.start()
    githubPolling = watchGithub(runtime.context(githubKind), githubController.signal)
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void stop().catch(() => { process.exitCode = 1 }) })
    log('ready')
  } catch (error) { await stop(); throw error }
}
void main().catch(error => {
  // SDK errors may retain credentials; never print raw HTTP/Stream errors.
  console.error(error instanceof Error && /^(Set |Usage:|Setup:)/.test(error.message) ? error.message
    : 'Startup failed; check Codex, GitHub setup and DingTalk credentials.')
  process.exitCode = 1
})
