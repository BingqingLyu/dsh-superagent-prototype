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

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`
const reference = <T>(value: T) => ({ get: () => value })
const log = (event: string) => console.log(JSON.stringify({ at: new Date().toISOString(), event }))
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
        store.saveSettings(SettingsSchema.parse({
          sources: { github: { enabled: true, config: { repository: remote, cli: process.env.SUPERAGENT_GITHUB_CLI ?? 'gh' } },
            dingtalk: { enabled: true, config: {} } },
          // Use the original admission table to allow every mentioned sender; no new gate or whitelist implementation.
          policy: { sources: { dingtalk: { allowed: [], admission: { group: { unlistedAddressed: 'explicit' } } } } },
          executor: { maxWorkers: Number(process.env.SUPERAGENT_MAX_WORKERS ?? 3),
            prepare: `git -C ${quote(repository)} worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" HEAD` },
        }))
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
