import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { Store } from '../src/app/store.ts'
import { family } from '../src/kv.ts'
import { CodexSessions } from '../src/harness/codex-rpc.ts'
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
it.each([false, true])('applies explicit host access to new and resumed sessions (resume=%s), keeping admission read-only', async resume => {
  const sessions = new CodexSessions({ get: <T>(kind: string) => (resume && kind === 'codex-thread' ? 'saved-thread' : undefined) as T | undefined,
    set: () => {} }, '/unused', undefined, 'danger-full-access')
  const request = vi.spyOn(sessions, 'request').mockImplementation(async (method, params: any) =>
    method === 'turn/start' ? { turn: { id: 'turn' } } : { thread: { id: params.threadId ?? 'new-thread' } })
  for (const router of [false, true]) {
    const key = router ? 'admission' : 'worker'
    await sessions.ensure(key, '/tmp', 'Instructions', [], router)
    expect(request).toHaveBeenLastCalledWith(resume ? 'thread/resume' : 'thread/start', expect.objectContaining({
      sandbox: router ? 'read-only' : 'danger-full-access', approvalPolicy: router ? 'on-request' : 'never',
    }))
    await sessions.send(key, `request-${key}`, 'Task')
    expect(request).toHaveBeenLastCalledWith('turn/start', expect.objectContaining({
      sandboxPolicy: router ? { type: 'readOnly', networkAccess: true } : { type: 'dangerFullAccess' },
    }))
  }
})
it('creates a no-subagent session, dispatches scoped tool calls, streams input and completion, and deduplicates submission', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-protocol-'))
  const store = new Store(join(dir, 'db.sqlite'))
  const binary = fileURLToPath(new URL('./fixtures/codex-rpc.mjs', import.meta.url))
  chmodSync(binary, 0o755)
  const kv = family<any, [string, string]>('test-rpc:')
  const sessions = new CodexSessions({ get: (kind, id) => store.get(kv(kind, id)),
    set: (kind, id, value) => store.set(kv(kind, id), value) }, binary)
  cleanups.push(async () => { await sessions.close(); store.close(); rmSync(dir, { recursive: true, force: true }) })
  const tool = vi.fn(async () => ({ recorded: true })), input = vi.fn(), turn = vi.fn()
  sessions.onTool = tool; sessions.onInput = input; sessions.onTurn = turn
  await sessions.start()
  const id = await sessions.ensure('worker:one', dir, 'No subagents', [])
  expect(await sessions.ensure('worker:one', dir, 'No subagents', [])).toBe(id)
  await sessions.send('worker:one', 'request-one', 'Task')
  await vi.waitFor(() => expect(turn).toHaveBeenCalledOnce())
  expect(tool).toHaveBeenCalledWith('worker:one', 'orchestrator_report', { state: 'ready', summary: 'Done' })
  expect(input).toHaveBeenCalledWith('worker:one', 'Task')
  expect(sessions.running('worker:one')).toBe(false)
  await sessions.send('worker:one', 'request-one', 'Task')
  expect(tool).toHaveBeenCalledOnce()
  expect(store.get(kv('codex-thread', 'worker:one'))).toBe(id)
  const write = vi.spyOn(sessions as any, 'write')
  for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']) {
    await sessions.message({ id: 'human-approval', method, params: { threadId: id } })
    expect(write).toHaveBeenLastCalledWith({ id: 'human-approval', result: { decision: 'decline' } })
  }
})
it.skipIf(!process.env.CODEX_GH_SMOKE_BINARY)('lets two fresh sandboxed workers use host GitHub auth through native allow rules', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-gh-auth-'))
  const values = new Map<string, unknown>()
  const sessions = new CodexSessions({ get: <T>(kind: string, id: string) => values.get(`${kind}:${id}`) as T | undefined,
    set: (kind, id, value) => { values.set(`${kind}:${id}`, value) } }, process.env.CODEX_GH_SMOKE_BINARY!, process.env.CODEX_MODEL, 'read-only')
  cleanups.push(async () => { await sessions.close(); rmSync(dir, { recursive: true, force: true }) })
  const commands: { key: string; item: any }[] = []
  const completed = new Set<string>()
  sessions.onTool = async () => ({ recorded: true })
  sessions.onEvent = (key, method, params) => {
    if (method === 'item/completed' && params.item?.type === 'commandExecution') commands.push({ key, item: params.item })
  }
  sessions.onTurn = key => { completed.add(key) }
  await sessions.start()
  for (const key of ['worker-first', 'worker-second']) {
    await sessions.ensure(key, dir, 'Run exactly gh pr list --repo alibaba/neug --state open --limit 1 --json number. '
      + 'This is a read-only connectivity test. Native operator allow rules permit this command to use host credentials. '
      + 'Do not log in, extract or print tokens, change configuration, edit files, or run other commands. End after observing the command result.', [], false, true)
    await sessions.send(key, `probe-${key}`, 'Run the specified gh pr list command once and report whether it succeeded.')
    await vi.waitFor(() => expect(completed.has(key)).toBe(true), { timeout: 55000, interval: 250 })
    const command = commands.find(value => value.key === key && value.item.command.includes('gh pr list'))
    expect(command, 'real command event must confirm success, not just assistant text').toBeDefined()
    expect(command!.item.exitCode).toBe(0)
    expect(JSON.parse(command!.item.aggregatedOutput)).toBeInstanceOf(Array)
  }
}, 120000)
