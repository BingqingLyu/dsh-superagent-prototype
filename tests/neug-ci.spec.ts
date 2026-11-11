import { describe, expect, it, vi, beforeEach } from 'vitest'
import { DWClient } from 'dingtalk-stream'
import { DingTalk } from '../src/sources/dingtalk.ts'
import { workflowRunTrigger, type WorkflowRun } from '../src/sources/github-trigger.ts'
import { loadSkillDir } from '../src/app/skill-files.ts'
import type { SourceContext } from '../src/sources/host.ts'
import type { OutboundMessage } from '../src/core/index.ts'

describe('workflowRunTrigger', () => {
  const run: WorkflowRun = { workflow: 'nightly.yml', runId: 42, conclusion: 'failure', event: 'schedule',
    branch: 'main', sha: 'abc1234567890', url: 'https://github.com/alibaba/neug/actions/runs/42', failedJobs: ['build', 'test'] }
  it('builds a self-contained trigger with no channel, human false, and a deterministic id', () => {
    const trigger = workflowRunTrigger(run)
    expect(trigger.id).toBe('github-run:nightly.yml:42')
    expect(trigger.human).toBe(false)
    expect(trigger.actor).toEqual({ source: 'github', id: '' })
    expect(trigger.channel).toBeUndefined()
    expect(trigger.threads).toEqual([{ source: 'github', id: 'run:nightly.yml' }])
    expect(trigger.meta).toMatchObject({ ci: true, run: true, workflow: 'nightly.yml', runId: 42, conclusion: 'failure', event: 'schedule', branch: 'main', sha: 'abc1234567890', failed: true })
  })
  it('includes the workflow, conclusion, failed jobs and URL in the text', () => {
    const trigger = workflowRunTrigger(run)
    expect(trigger.text).toContain('nightly.yml')
    expect(trigger.text).toContain('failure')
    expect(trigger.text).toContain('schedule')
    expect(trigger.text).toContain('main')
    expect(trigger.text).toContain('abc1234')
    expect(trigger.text).toContain('Failed jobs: build, test.')
    expect(trigger.text).toContain(run.url)
  })
  it('marks a success conclusion as not failed and omits the failed-jobs line', () => {
    const trigger = workflowRunTrigger({ ...run, conclusion: 'success', failedJobs: [] })
    expect(trigger.meta.failed).toBe(false)
    expect(trigger.text).not.toContain('Failed jobs')
  })
  it('produces the same id for the same run, so polling twice is a no-op', () => {
    expect(workflowRunTrigger(run).id).toBe(workflowRunTrigger(run).id)
  })
})

describe('DingTalk report route', () => {
  let state: Map<string, unknown>, context: SourceContext, http: ReturnType<typeof vi.fn>
  beforeEach(() => {
    state = new Map()
    http = vi.fn(async (url: string) => {
      if (String(url).includes('accessToken')) return { ok: true, json: async () => ({ accessToken: 'tok', expireIn: 7200 }) }
      return { ok: true, json: async () => ({ processQueryKey: 'pqk' }) }
    })
    context = {
      state: { get: (key: string) => state.get(key), set: (key: string, value: unknown) => { state.set(key, value) } },
      config: (kind: string) => kind === 'dingtalk' ? { reportConversationId: 'cidReport' } : undefined,
      report: vi.fn(), triggers: { get: () => undefined }, tickets: { get: () => undefined, open: () => [] },
      receive: vi.fn(), notify: vi.fn(), atomic: (work: () => unknown) => work(),
    } as unknown as SourceContext
    vi.spyOn(DWClient.prototype, 'connect').mockImplementation(async function (this: { connected: boolean }) { this.connected = true })
    vi.spyOn(DWClient.prototype, 'disconnect').mockImplementation(() => {})
  })
  it('seeds a permanent route with expires 0 on start when reportConversationId is configured', async () => {
    const dingtalk = new DingTalk(context, { clientId: 'appKey', clientSecret: 'secret' }, () => {}, http as typeof fetch)
    await dingtalk.start()
    const route = state.get('dingtalk-route:cidReport') as { webhook: string; expires: number; robotCode: string; conversationId: string }
    expect(route).toMatchObject({ webhook: '', expires: 0, robotCode: 'appKey', conversationId: 'cidReport' })
  })
  it('does not overwrite an existing incoming route', async () => {
    state.set('dingtalk-route:cidReport', { webhook: 'https://oapi.dingtalk.com/robot/send?existing', expires: Date.now() + 60000, robotCode: 'r', conversationId: 'cidReport' })
    const dingtalk = new DingTalk(context, { clientId: 'appKey', clientSecret: 'secret' }, () => {}, http as typeof fetch)
    await dingtalk.start()
    expect((state.get('dingtalk-route:cidReport') as { webhook: string }).webhook).toContain('existing')
  })
  it('sends via the application group-send API when expires is 0, without parsing the empty webhook', async () => {
    state.set('dingtalk-route:cidReport', { webhook: '', expires: 0, robotCode: 'appKey', conversationId: 'cidReport' })
    const dingtalk = new DingTalk(context, { clientId: 'appKey', clientSecret: 'secret' }, () => {}, http as typeof fetch)
    const message: OutboundMessage = { id: 'result-1', channel: { source: 'dingtalk', thread: 'dingtalk:cidReport', address: { conversationId: 'cidReport' } }, text: 'CI analysis done', kind: 'reply', ticketId: 'abcdef123456' }
    await dingtalk.send(message)
    const sendCall = http.mock.calls.find(call => String(call[0]).includes('groupMessages/send'))
    expect(sendCall).toBeDefined()
    const body = JSON.parse(sendCall![1].body)
    expect(body).toMatchObject({ robotCode: 'appKey', openConversationId: 'cidReport', msgKey: 'sampleText' })
    expect(JSON.parse(body.msgParam).content).toContain('CI analysis done')
  })
})

describe('loadSkillDir', () => {
  it('loads the neug-ci skill body with its frontmatter parsed', () => {
    const skill = loadSkillDir('neug-ci')
    expect(skill.name).toBe('neug-ci')
    expect(skill.description.length).toBeGreaterThan(0)
    expect(skill.content).toContain('gh run view')
    expect(skill.content).not.toContain('---')
  })
  it('loads the neug-release skill body with its frontmatter parsed', () => {
    const skill = loadSkillDir('neug-release')
    expect(skill.name).toBe('neug-release')
    expect(skill.content).toContain('gh release create')
    expect(skill.content).toContain('orchestrator_thread_follow')
    expect(skill.content).not.toContain('---')
  })
})

describe('prepareReportChannel logic', () => {
  // Mirrors Runtime.prepareReportChannel: a CI ticket with a configured report group gets its replyChannel overridden.
  const prepare = (ticket: { origin: { triggerId: string }; channels: unknown[]; replyChannel?: unknown },
    triggerMeta: Record<string, unknown> | undefined, conversation: string | undefined) => {
    if (triggerMeta?.ci !== true) return ticket
    if (!conversation) return ticket
    const channel = { source: 'dingtalk', thread: `dingtalk:${conversation}`, address: { conversationId: conversation } }
    return { ...ticket, replyChannel: channel, channels: [channel] }
  }
  it('injects the report channel for a CI ticket when the group is configured', () => {
    const ticket = { origin: { triggerId: 't1' }, channels: [{ source: 'github', thread: 'github:7', address: { number: 7 } }] }
    const result = prepare(ticket, { ci: true }, 'cidReport')
    expect(result.replyChannel).toEqual({ source: 'dingtalk', thread: 'dingtalk:cidReport', address: { conversationId: 'cidReport' } })
    expect(result.channels).toHaveLength(1)
  })
  it('leaves a non-CI ticket unchanged', () => {
    const ticket = { origin: { triggerId: 't1' }, channels: [{ source: 'github' }] }
    expect(prepare(ticket, { ci: false }, 'cidReport')).toBe(ticket)
    expect(prepare(ticket, undefined, 'cidReport')).toBe(ticket)
  })
  it('leaves a CI ticket unchanged when no report group is configured', () => {
    const ticket = { origin: { triggerId: 't1' }, channels: [] }
    expect(prepare(ticket, { ci: true }, undefined)).toBe(ticket)
  })
})