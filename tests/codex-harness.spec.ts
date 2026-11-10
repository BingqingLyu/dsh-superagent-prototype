import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Runtime } from '../src/app/runtime.ts'
import { Setup } from '../src/app/setup.ts'
import { Store } from '../src/app/store.ts'
import { SettingsSchema } from '../src/policy.ts'
import { CodexHarness } from '../src/harness/codex.ts'
import { DingTalk, dingTalkKind, dingTalkTrigger } from '../src/sources/dingtalk.ts'
import { testMachine, testDeployment } from './fixtures/deployment.ts'
import type { OutboundMessage } from '../src/core/index.ts'

let directory: string, runtime: Runtime, harness: CodexHarness
let source: ReturnType<Runtime['context']>
let sent: ReturnType<typeof vi.fn<(message: OutboundMessage) => Promise<void>>>, submitted: { id: string; text: string }[]
const event = (overrides: Record<string, unknown> = {}) => ({
  msgId: 'message-1', conversationId: 'group-1', conversationType: '2', isInAtList: true,
  senderStaffId: 'any-user', senderCorpId: 'corp', robotCode: 'robot', msgtype: 'text',
  text: { content: '查看未合并 PR' }, sessionWebhook: 'https://oapi.dingtalk.com/robot/send?session=secret',
  sessionWebhookExpiredTime: Date.now() + 60000, ...overrides,
})
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'original-codex-'))
  const machine = testMachine({ stateDir: directory })
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  store.saveSettings(SettingsSchema.parse({
    sources: { dingtalk: { enabled: true, config: {} } },
    policy: { sources: { dingtalk: { allowed: [], admission: { group: { unlistedAddressed: 'explicit' } } } } },
  }))
  store.close()
  vi.spyOn(Setup.prototype, 'run').mockImplementation(async function (this: Setup) {
    Object.assign(this, { resolved: testDeployment({ ...machine, feishu: undefined }) }); return true
  })
  const ctx = new Context()
  harness = new CodexHarness(ctx, { binary: process.env.CODEX_SMOKE_BINARY ?? '/unused', model: process.env.CODEX_MODEL, sandbox: 'read-only' })
  // Model boundary only: all Runtime, Store, Engine, Executor, Assessor, tools, relays and Outbox are the original code.
  submitted = []; sent = vi.fn(async () => {})
  vi.spyOn(harness.rpc, 'start').mockResolvedValue()
  vi.spyOn(harness.rpc, 'ensure').mockResolvedValue('thread')
  vi.spyOn(harness.rpc, 'send').mockImplementation(async (id, _requestId, text) => { submitted.push({ id, text }) })
  vi.spyOn(harness.rpc, 'interrupt').mockResolvedValue()
  vi.spyOn(harness.rpc, 'close').mockResolvedValue()
  vi.spyOn(harness.rpc, 'running').mockReturnValue(false)
  // Workspace credential verification sees no local overrides; startup account checks are outside this test.
  vi.spyOn(ctx.subprocess, 'spawn').mockReturnValue({ done: Promise.resolve({ exitCode: 1 }),
    collected: { stdout: { readFrom: () => ({ text: '' }) }, stderr: { readFrom: () => ({ text: '' }) } } } as never)
  runtime = new Runtime(ctx, machine, () => {})
  const kind = dingTalkKind(sent)
  runtime.sources.register(kind)
  await runtime.ready
  source = runtime.context(kind)
})
afterEach(async () => {
  await harness?.close(); await runtime?.stop()
  vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true })
})
async function accept() {
  const parsed = dingTalkTrigger(event(), source)!
  runtime.receive(parsed.trigger); await runtime.idle()
  await vi.waitFor(() => expect(submitted.some(item => item.id === runtime.masterId)).toBe(true))
  const result = await harness.rpc.onTool(runtime.masterId, 'orchestrator_route', { decisions: [{
    kind: 'accept', trigger_id: parsed.trigger.id, title: '查看未合并 PR', worktree_name: 'list-open-prs', acknowledgement: '收到，查看未合并 PR。',
  }] }) as any
  expect(result.results[0].refused).toBeUndefined()
  const id = result.results[0].ticket.ticket_id as string
  await runtime.idle()
  await vi.waitFor(() => expect(submitted.some(item => item.id === `worker-${id}`)).toBe(true))
  return { id, trigger: parsed.trigger, worker: `worker-${id}` }
}
it('uses original worker reports to relay blockers without a question to the main session, without inventing a direct reply', async () => {
  const { id, worker } = await accept()
  expect(sent).toHaveBeenCalledTimes(1)
  const result = await harness.rpc.onTool(worker, 'orchestrator_report', { state: 'blocked', summary: 'GitHub API unavailable' })
  expect(result).toMatchObject({ notification: 'orchestrator' })
  await runtime.idle()
  await vi.waitFor(() => expect(submitted.some(item => item.id === runtime.masterId && item.text.includes('GitHub API unavailable'))).toBe(true))
  const relay = submitted.filter(item => item.id === runtime.masterId).map(item => item.text).find(text => text.includes('GitHub API unavailable'))!
  expect(relay).toContain('worker_report')
  expect(runtime.store.tickets.get(id)?.assignments.at(-1)?.report?.state).toBe('blocked')
  expect(sent).toHaveBeenCalledTimes(1) // Original communication policy: main decides, not the transport.
})
it('sends a ready result only through the original main-session reply tool and outbox', async () => {
  const { id, worker } = await accept()
  await harness.rpc.onTool(worker, 'orchestrator_report', { state: 'ready', summary: 'Found three PRs' })
  await runtime.idle()
  expect(sent).toHaveBeenCalledTimes(1)
  await harness.rpc.onTool(runtime.masterId, 'orchestrator_reply', { ticket_id: id, purpose: 'result', text: 'Found three PRs' })
  await runtime.idle()
  expect(sent).toHaveBeenLastCalledWith(expect.objectContaining({ ticketId: id, text: 'Found three PRs' }))
  expect(runtime.store.tickets.get(id)?.ended?.outcome).toBe('completed')
  expect(harness.rpc.ensure).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.stringContaining('Human attention'),
    expect.arrayContaining([expect.objectContaining({ name: 'orchestrator_report' })]), expect.any(Boolean))
})
it('keeps progress internal and rejects tools outside each original role', async () => {
  const { worker } = await accept()
  const before = submitted.length
  expect(await harness.rpc.onTool(worker, 'orchestrator_report', { state: 'progress', summary: 'working' })).toMatchObject({ notification: 'internal_only' })
  await runtime.idle()
  expect(submitted).toHaveLength(before)
  await expect(harness.rpc.onTool(worker, 'orchestrator_route', { decisions: [] })).rejects.toThrow('not available')
  await expect(harness.rpc.onTool(runtime.masterId, 'orchestrator_report', {})).rejects.toThrow('not available')
})
it('accepts any group member mention, ignores other messages, and keeps task followups within the originating group', async () => {
  for (const overrides of [{ conversationType: '1' }, { isInAtList: false }]) {
    expect(dingTalkTrigger(event(overrides), source)).toBeUndefined()
  }
  expect(dingTalkTrigger(event({ senderStaffId: 'guest', conversationId: 'other-group' }), source)).toBeDefined()
  const { id, trigger } = await accept()
  const text = { content: `#${id.slice(0, 12)} 继续` }
  expect(dingTalkTrigger(event({ msgId: 'follow', text }), source)?.trigger.threads).toEqual(trigger.threads)
  expect(dingTalkTrigger(event({ msgId: 'other', conversationId: 'other-group', text }), source)?.trigger.threads).not.toEqual(trigger.threads)
  expect(JSON.stringify(trigger)).not.toContain('session=secret')
})
it('normalizes pasted rich text with formatting and routes its task reference through the original thread', async () => {
  const { id, trigger } = await accept()
  const text = `#${id.slice(0, 12)}\ngh auth status --hostname github.com\n  ✓ Logged in (keyring)`
  const parsed = dingTalkTrigger(event({ msgId: 'rich-followup', msgtype: 'richText', text: undefined,
    content: { richText: [{ text: `#${id.slice(0, 12)}` }, { text: '\ngh auth status --hostname github.com\n' },
      { text: '  ✓ Logged in (keyring)' }] } }), source)!
  expect(parsed.trigger.text).toBe(text)
  expect(parsed.trigger.threads).toEqual(trigger.threads)
  expect(parsed.trigger.meta).toMatchObject({ messageType: 'richText', referenceResolved: true })
  runtime.receive(parsed.trigger); await runtime.idle()
  await vi.waitFor(() => expect(submitted.some(value => value.id === `worker-${id}` && value.text.includes('Logged in (keyring)'))).toBe(true))
})
it('preserves rich-text order around images and accepts string-encoded content', () => {
  const content = { richText: [{ text: '前文\n' }, { type: 'picture', downloadCode: 'media-reference' }, { text: '\n后文' }] }
  const parsed = dingTalkTrigger(event({ msgtype: 'richText', text: undefined, content: JSON.stringify(content) }), source)!
  expect(parsed.trigger.text).toContain('前文\n')
  expect(parsed.trigger.text).toContain('[图片附件，内容尚未下载或解析]')
  expect(parsed.trigger.text).toMatch(/前文[\s\S]*图片附件[\s\S]*后文/)
  expect(parsed.body?.content).toBe(JSON.stringify(content))
  expect(parsed.trigger.text).not.toContain('media-reference')
})
it.each(['picture', 'audio', 'video', 'file', 'unknownMsgType', 'futureMessageType'])('accepts %s group mentions instead of silently dropping them', msgtype => {
  const parsed = dingTalkTrigger(event({ msgtype, text: undefined, content: { downloadCode: 'media-reference' } }), source)!
  expect(parsed.trigger.meta.messageType).toBe(msgtype)
  expect(parsed.trigger.text).toContain('尚未下载或解析')
  expect(parsed.body).toEqual({ messageType: msgtype, content: { downloadCode: 'media-reference' } })
})
it('retains audio transcription and file names when supplied by the platform', () => {
  expect(dingTalkTrigger(event({ msgtype: 'audio', text: undefined, content: { recognition: '查询开放的 PR' } }), source)?.trigger.text).toBe('查询开放的 PR')
  expect(dingTalkTrigger(event({ msgtype: 'file', text: undefined, content: { fileName: '日志.txt' } }), source)?.trigger.text).toContain('日志.txt')
})
it('uses the original source context KV for DingTalk routes and the expired-webhook fallback', async () => {
  const parsed = dingTalkTrigger(event(), source)!
  source.state.set('dingtalk-route:group-1', { ...parsed.route, expires: 0 })
  const http = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ accessToken: 'token', expireIn: 7200 }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ processQueryKey: 'sent' }) })
  const robot = new DingTalk(source, { clientId: 'client', clientSecret: 'secret' }, () => {}, http)
  await robot.send({ id: 'reply', kind: 'reply', text: 'done', channel: parsed.trigger.channel! })
  expect(http.mock.calls[1]![0]).toBe('https://api.dingtalk.com/v1.0/robot/groupMessages/send')
})
it('keeps original worker slots occupied while a native Codex command is still running', async () => {
  const { worker } = await accept()
  harness.rpc.onEvent(worker, 'item/started', { item: { type: 'commandExecution', id: 'command', command: 'test', status: 'inProgress' } })
  harness.rpc.onTurn(worker, { status: 'completed' })
  await runtime.idle()
  expect(runtime.executor.activeCount()).toBe(1)
  harness.rpc.onEvent(worker, 'item/completed', { item: { type: 'commandExecution', id: 'command', status: 'completed' } })
  await vi.waitFor(() => expect(runtime.executor.activeCount()).toBe(0))
})
it('maps the original role model selection and model resource to Codex', async () => {
  const settings = runtime.store.settings()
  runtime.store.saveSettings({ ...settings, executor: { ...settings.executor,
    model: { provider: 'codex', model: 'test-model', reasoningEffort: 'high' } } })
  const { worker } = await accept()
  expect(harness.rpc.send).toHaveBeenCalledWith(worker, expect.any(String), expect.any(String), expect.any(String),
    expect.objectContaining({ model: 'test-model', reasoningEffort: 'high' }))
  vi.spyOn(harness.rpc, 'request').mockResolvedValue({ data: [{ model: 'test-model', displayName: 'Test', isDefault: true }] })
  const result = await harness.rpc.onTool(runtime.masterId, 'orchestrator_read', { resource: 'models' })
  expect(result).toMatchObject({ providers: [{ id: 'codex', count: 1 }] })
})
it.skipIf(!process.env.CODEX_SMOKE_BINARY)('runs a real read-only Codex worker report through the original orchestrator and reply tool', async () => {
  for (const name of ['start', 'ensure', 'send', 'interrupt', 'close', 'running'] as const) vi.mocked(harness.rpc[name]).mockRestore()
  const parsed = dingTalkTrigger(event({ text: { content: '纯连通性任务：不要读写文件或运行命令。请交付结果 CODEX_ADAPTER_OK；通过 orchestrator_report 上报 ready。' } }), source)!
  runtime.receive(parsed.trigger)
  runtime.engine.evaluateDue()
  const decision = runtime.engine.decide(parsed.trigger.id, { kind: 'accept', title: 'Codex connectivity', scope: 'Return CODEX_ADAPTER_OK without file or command operations',
    name: 'codex-connectivity', acknowledgement: '开始连通性检查。', reason: 'Explicit connectivity test' })
  expect(decision.ticketId).toBeDefined()
  await runtime.idle()
  await vi.waitFor(() => expect(sent.mock.calls.some(([message]) => message.kind === 'reply' && message.text.includes('CODEX_ADAPTER_OK'))).toBe(true), { timeout: 110000, interval: 500 })
  expect(runtime.store.tickets.get(decision.ticketId!)?.assignments.at(-1)?.report?.state).toBe('ready')
  await harness.rpc.cleanBackground(`worker-${decision.ticketId}`)
}, 120000)
