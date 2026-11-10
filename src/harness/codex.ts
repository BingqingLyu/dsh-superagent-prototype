/** Codex transport behind the host services used by the unchanged Runtime, Sessions and DshExecutor. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Store } from '../app/store.ts'
import type { Runtime } from '../app/runtime.ts'
import type { Tool } from '../app/tools/tool.ts'
import { family } from '../kv.ts'
import { CodexSessions, type CodexSandbox } from './codex-rpc.ts'

declare module '@deepseek-ai/cordis' { interface Context { codexHarness: CodexHarness } }

const stateKey = family<any, [string, string]>('codex:')
interface SavedSession {
  cwd: string; preset: string; title: string
  events: any[]; nextTurn: UserMessage[]; nextStep: UserMessage[]; notices: UserMessage[]; submitted?: UserMessage[]
}
interface Binding { instructions(): string; tools: Tool[]; guard(): string | undefined }
interface HostAgent {
  id: string; ctx: Context; status: 'idle' | 'running'
  session: { id: string; header: { agentPreset: string }; snapshotEvents(): any[]; requestHeader(): unknown; append(type: string, data: unknown): void }
  inbox: { nextTurn: UserMessage[]; nextStep: UserMessage[]; remove(id: string): boolean }
  inject(message: UserMessage): void; followup(message: UserMessage): void; steer(message: UserMessage): void
  cancel(reason: unknown, options: { keepInbox?: boolean }): void; whenIdle(): Promise<void>
}
export interface CodexOptions {
  binary: string; model?: string; sandbox: CodexSandbox; port?: number
}
const textOf = (message: UserMessage) => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')

/** No ticket, admission, report or reply decisions live here: this translates host sessions/events into Codex RPC. */
export class CodexHarness {
  readonly agents = new Map<string, HostAgent>()
  readonly rpc: CodexSessions
  private readonly bindings = new Map<string, Binding>()
  private readonly saved = new Map<string, SavedSession>()
  private readonly pending = new Map<string, Promise<void>>()
  private readonly idle = new Map<string, Set<() => void>>()
  private connected?: Promise<void>
  private closed = false
  private closing?: Promise<void>
  private readonly jobs = new Map<string, { id: string; owner: string; status: string; label: string }>()
  private readonly jobListeners = new Set<{ owner: string; listener(event: { type: string }): void }>()
  private readonly routes = new Set<{ path: string; handler(req: IncomingMessage, res: ServerResponse): Promise<void> }>()
  private readonly server = createServer((req, res) => {
    const route = [...this.routes].find(route => req.url?.startsWith(route.path))
    if (!route) { res.writeHead(404); res.end(); return }
    void route.handler(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end() })
  })
  constructor(readonly ctx: Context, readonly options: CodexOptions) {
    // Reuse the Runtime's SQLite KV, including durable inboxes; do not introduce another Store or database.
    this.rpc = new CodexSessions({
      get: <T>(kind: string, id: string) => this.store.get(stateKey(kind, id)) as T | undefined,
      set: (kind, id, value) => { this.store.set(stateKey(kind, id), value) },
    }, options.binary, options.model, options.sandbox)
    this.rpc.onTool = async (id, name, args) => {
      const binding = this.bindings.get(id)
      const problem = binding?.guard()
      if (problem) throw new Error(problem)
      const tool = binding?.tools.find(tool => tool.name === name)
      if (!tool) throw new Error('Tool is not available in this session')
      return tool.execute(tool.schema.parse(args), this.runtime.lifetime)
    }
    this.rpc.onEvent = (id, method, params) => {
      const agent = this.agents.get(id)
      if (!agent) return
      if (method === 'turn/started') this.status(agent, 'running')
      if (method === 'item/completed' && params.item?.type === 'agentMessage') {
        agent.session.append('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: params.item.text ?? '' }] } })
      }
      if ((method === 'item/started' || method === 'item/completed') && params.item?.type === 'commandExecution') {
        const item = params.item, jobId = `${id}:${item.id}`
        const job = this.jobs.get(jobId) ?? { id: jobId, owner: id, label: item.command ?? item.id, status: 'running' }
        job.status = item.status === 'inProgress' || method === 'item/started' ? 'running' : item.status ?? 'completed'
        this.jobs.set(jobId, job)
        this.jobEvent(id)
      }
    }
    this.rpc.onTurn = (id, turn) => {
      const agent = this.agents.get(id)
      if (!agent) return
      if (turn.status === 'failed') this.ctx.emit('agent/error', { agent: agent as unknown as Agent,
        error: new Error(turn.error?.message ?? 'Codex turn failed') } as never)
      this.status(agent, 'idle')
      this.pump(agent)
    }
    this.rpc.onInput = (id, text) => {
      const state = this.saved.get(id), agent = this.agents.get(id)
      const message = state?.submitted?.find(message => text.endsWith(textOf(message)))
      if (message && agent) this.inputRead(agent, message)
    }
    this.rpc.onFailure = error => {
      if (this.closed) return
      ctx.logger.error('Codex app-server disconnected: %s', error.message)
      // Preserve queued effects/inboxes and let the original Runtime shut down its workers and state lock.
      void this.runtime.stop().finally(() => { process.exitCode = 1 })
    }
    const provide = (name: string, value: unknown) => { ctx.reflect.provide(name, value) }
    provide('codexHarness', this)
    provide('agents', this.agents)
    provide('workspaceRegistry', { create: async (cwd: string) => ({ id: cwd }) })
    provide('permissionPresets', { set: () => {} }) // Codex sandbox is explicit; never upgrade to DSH's full-access preset.
    provide('llm', { resolveCallConfig: async (value: { provider: string }) => {
      if (value.provider !== 'codex') throw new Error('This host uses the codex model provider')
      return value
    } })
    provide('jobs', {
      list: (owner: string) => [...this.jobs.values()].filter(job => job.owner === owner),
      events: { subscribe: ({ owner }: { owner: string }, listener: (event: { type: string }) => void) => {
        const entry = { owner, listener }; this.jobListeners.add(entry); return () => this.jobListeners.delete(entry)
      } },
      wait: (id: string, timeoutMs: number, owner: string, signal?: AbortSignal) => this.waitJob(id, timeoutMs, owner, signal),
      kill: (id: string, owner: string) => {
        if (this.jobs.get(id)?.owner !== owner) throw new Error('Job is not owned by this session')
        // Codex exposes terminal cleanup per thread; assignment shutdown uses this same boundary.
        void this.rpc.cleanBackground(owner).then(() => {
          for (const job of this.jobs.values()) if (job.owner === owner && job.status === 'running') job.status = 'cancelled'
          this.jobEvent(owner)
        }).catch(() => { ctx.logger.warn('Codex terminal cleanup failed for %s', owner) })
      },
    })
    provide('sessionController', {
      resolveAgent: async (id: string) => {
        if (!this.agents.has(id)) {
          const saved = this.store.get<SavedSession>(stateKey('session', id))
          if (saved) this.create(id, saved.cwd, saved.preset)
        }
        const agent = this.agents.get(id)
        return agent ? { agent } : { error: { code: 'session/not-found' } }
      },
      create: async ({ sessionId, workspaceId, agentPreset }: { sessionId: string; workspaceId: string; agentPreset: string }) => {
        this.create(sessionId, workspaceId, agentPreset)
      },
      rename: async ({ sessionId, title }: { sessionId: string; title: string }) => {
        this.saved.get(sessionId)!.title = title; this.persist(sessionId)
      },
      inspect: async (sessionId: string) => ({
        events: this.saved.get(sessionId)?.events ?? this.store.get<SavedSession>(stateKey('session', sessionId))?.events ?? [],
      }),
      modelCatalog: () => this.catalog(),
    })
    provide('sessionPersistence', {
      flush: async () => {}, // Inbox/event writes are synchronous transactions on the original Store.
      open: async (id: string) => ({
        read: async (offset: number, limit: number) => ({ events: (this.saved.get(id)?.events ?? []).slice(offset, offset + limit) }),
        [Symbol.asyncDispose]: async () => {},
      }),
    })
    provide('subprocess', { spawn: localSpawn })
    provide('webServer', { host: '127.0.0.1', port: options.port ?? 3082,
      register: (route: { path: string; handler(req: IncomingMessage, res: ServerResponse): Promise<void> }) => {
        this.routes.add(route); return () => this.routes.delete(route)
      } })
  }
  private get runtime(): Runtime { return this.ctx.orchestrator as Runtime }
  private get store(): Store { return this.runtime.store }
  bind(agent: Agent, instructions: () => string, tools: Tool[], guard: () => string | undefined): () => void {
    this.bindings.set(agent.id, { instructions, tools, guard })
    return () => { this.bindings.delete(agent.id) }
  }
  private persist(id: string): void { this.store.set(stateKey('session', id), this.saved.get(id)!) }
  private create(id: string, cwd: string, preset: string): void {
    if (this.agents.has(id)) return
    const state: SavedSession = this.store.get(stateKey('session', id)) ?? {
      cwd, preset, title: id, events: [], nextTurn: [], nextStep: [], notices: [],
    }
    this.saved.set(id, state)
    // A crash between submit and consumption leaves an inbox message to reconcile against Codex history.
    state.nextStep.unshift(...state.submitted ?? []); state.submitted = []
    const append = (type: string, data: unknown) => {
      const event = { type, data }
      state.events.push(event); this.persist(id)
      this.ctx.emit('session/event', agent.session as never, event as never)
    }
    const agent: HostAgent = {
      id, ctx: new Context(), status: 'idle',
      session: { id, header: { agentPreset: state.preset }, snapshotEvents: () => state.events,
        requestHeader: () => state.events.find(event => event.type === 'request/header'), append },
      inbox: { nextTurn: state.nextTurn, get nextStep() { return [...state.nextStep, ...state.submitted ?? []] }, remove: messageId => {
        for (const list of [state.nextTurn, state.nextStep, state.submitted!]) {
          const at = list.findIndex(message => message.id === messageId)
          if (at >= 0) { list.splice(at, 1); this.persist(id); return true }
        }
        return false
      } },
      inject: message => { state.notices.push(message); append('user/message', message) },
      followup: message => { state.nextTurn.push(message); this.persist(id); this.pump(agent) },
      steer: message => { state.nextStep.push(message); this.persist(id); this.pump(agent) },
      cancel: (_reason, { keepInbox } = {}) => {
        if (!keepInbox) { state.nextTurn.length = 0; state.nextStep.length = 0; state.submitted!.length = 0; this.persist(id) }
        void this.rpc.interrupt(id).catch(() => {}).finally(() => { if (!this.closed) this.status(agent, 'idle') })
      },
      whenIdle: async () => {
        if (agent.status !== 'idle') await new Promise<void>(resolve => {
          const waiters = this.idle.get(id) ?? new Set(); waiters.add(resolve); this.idle.set(id, waiters)
        })
        await this.pending.get(id)
      },
    }
    this.agents.set(id, agent); this.persist(id)
  }
  private status(agent: HostAgent, status: HostAgent['status']): void {
    if (agent.status === status) return
    agent.status = status
    if (status === 'idle') { for (const resolve of this.idle.get(agent.id) ?? []) resolve(); this.idle.delete(agent.id) }
    this.ctx.emit('agent/status', { agent: agent as unknown as Agent, status } as never)
  }
  private pump(agent: HostAgent): void {
    if (this.closed || this.pending.has(agent.id)) return
    const state = this.saved.get(agent.id)!
    const message = state.nextStep[0] ?? (!this.rpc.running(agent.id) ? state.nextTurn[0] : undefined)
    if (!message) return
    this.status(agent, 'running')
    let accepted = false
    const work = Promise.resolve().then(async () => {
      const binding = this.bindings.get(agent.id)
      if (!binding) throw new Error('Session has not been decorated')
      const problem = binding.guard(); if (problem) throw new Error(problem)
      await (this.connected ??= this.rpc.start())
      const instructions = binding.instructions()
      const skills = this.runtime.prompts.skills(this.runtime.prompts.current().config)
        .map(([name, content]) => `\n## Skill: ${name}\n${content}`).join('\n')
      // Role instructions and original operational skills are composed by Sessions/Prompts, not replaced here.
      const fullAccess = this.options.sandbox === 'danger-full-access' && state.preset !== 'dsh-superagent-router'
      const prompt = `${instructions}\n${skills}\nThis host is Codex. Subagents are unavailable. Use the registered orchestrator tools unchanged. `
        + (fullAccess ? 'The operator configured danger-full-access. Commands execute directly on the host without sandbox restrictions or interactive approval. '
          : 'Commands use the native Codex sandbox and operator-configured execpolicy rules. An authentication error inside the sandbox can mean OS credential-store access was denied; it does not establish that the host login expired. '
            + 'Use configured native command rules before asking a person to log in again. Logging in or reinstalling a CLI inside the sandbox does not change its permissions.')
      await this.rpc.ensure(agent.id, state.cwd, prompt,
        binding.tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.schema.toJSONSchema() })),
        state.preset === 'dsh-superagent-router')
      if (!state.nextStep.includes(message) && !state.nextTurn.includes(message)) return
      const notices = [...state.notices]
      const text = [...notices.map(textOf), textOf(message)].join('\n\n')
      agent.inbox.remove(message.id); state.submitted!.push(message); this.persist(agent.id)
      const selection = state.events.filter(event => event.type === 'model/selection').at(-1)?.data
      await this.rpc.send(agent.id, message.id, text, prompt, selection)
      accepted = true
      this.ctx.emit('agent/inbox/claimed', { agent: agent as unknown as Agent, message } as never)
      // A deduplicated resend after a crash emits no new notification: reconcile actual consumption with the rollout.
      if (state.submitted!.includes(message) && await this.rpc.inputSeen(agent.id, message.id).catch(() => false)) this.inputRead(agent, message)
      state.notices.splice(0, notices.length); this.persist(agent.id)
    }).catch(error => {
      if (!accepted && state.submitted!.includes(message)) {
        agent.inbox.remove(message.id); state.nextStep.unshift(message); this.persist(agent.id)
      }
      this.ctx.emit('agent/error', { agent: agent as unknown as Agent, error } as never)
      this.status(agent, 'idle')
    }).finally(() => { this.pending.delete(agent.id); if (accepted) this.pump(agent) })
    this.pending.set(agent.id, work)
  }
  private inputRead(agent: HostAgent, message: UserMessage): void {
    agent.inbox.remove(message.id)
    // Preserve the original producer's ID/source; DshExecutor marks inputs read only after real Codex consumption.
    agent.session.append('user/message', message)
  }
  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.options.port ?? 3082, '127.0.0.1', () => { this.server.off('error', reject); resolve() })
    })
  }
  private async catalog(): Promise<ModelCatalog> {
    await (this.connected ??= this.rpc.start())
    const result = await this.rpc.request('model/list', {})
    const models = result.data ?? []
    return { default: { provider: 'codex', model: this.options.model ?? models.find((model: any) => model.isDefault)?.model ?? '' },
      routableProviders: ['codex'], failures: [], groups: [{ id: 'codex', name: 'Codex', models: models.map((model: any) => ({
        id: model.model, name: model.displayName ?? model.model, description: model.description,
        reasoning: { defaultEffort: model.defaultReasoningEffort, efforts: (model.supportedReasoningEfforts ?? []).map((effort: any) => ({
          id: effort.reasoningEffort, name: effort.reasoningEffort, description: effort.description,
        })) },
      })) }] }
  }
  private jobEvent(owner: string): void {
    for (const entry of this.jobListeners) if (entry.owner === owner) entry.listener({ type: 'settled' })
  }
  private waitJob(id: string, timeoutMs: number, owner: string, signal?: AbortSignal): Promise<{ status: string }> {
    const job = this.jobs.get(id)
    if (!job || job.owner !== owner) return Promise.reject(new Error('Job is not owned by this session'))
    if (job.status !== 'running' || signal?.aborted) return Promise.resolve({ status: job.status })
    return new Promise(resolve => {
      const finish = () => {
        clearTimeout(timer); this.jobListeners.delete(entry); signal?.removeEventListener('abort', finish)
        resolve({ status: job.status })
      }
      const entry = { owner, listener: () => { if (job.status !== 'running') finish() } }
      const timer = setTimeout(finish, timeoutMs)
      this.jobListeners.add(entry); signal?.addEventListener('abort', finish, { once: true })
    })
  }
  close(): Promise<void> { return this.closing ??= this.shutdown() }
  private async shutdown(): Promise<void> {
    this.closed = true
    await this.rpc.close()
    await Promise.allSettled([...this.pending.values()])
    for (const job of this.jobs.values()) if (job.status === 'running') { job.status = 'cancelled'; this.jobEvent(job.owner) }
    for (const agent of this.agents.values()) this.status(agent, 'idle')
    if (this.server.listening) await new Promise<void>(resolve => { this.server.close(() => resolve()) })
  }
}

/** Host-side prepare/setup commands use the same argv/cwd/env/abort seam as the original DSH subprocess service. */
function localSpawn(spec: { argv: readonly string[]; cwd: string; env?: Record<string, string>; signal?: AbortSignal }) {
  const output = { stdout: '', stderr: '' }
  const env = Object.fromEntries(Object.entries({ ...scrubbedParentEnv(), ...spec.env })
    .filter(([name, value]) => value !== undefined && !name.startsWith('DINGTALK_')))
  const child = spawn(spec.argv[0]!, spec.argv.slice(1), { cwd: spec.cwd, env, signal: spec.signal, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', chunk => { output.stdout = (output.stdout + String(chunk)).slice(-1048576) })
  child.stderr.on('data', chunk => { output.stderr = (output.stderr + String(chunk)).slice(-65536) })
  const done = new Promise<{ exitCode: number | null; signal: string | null }>((resolve, reject) => {
    child.once('error', reject); child.once('close', (exitCode, signal) => resolve({ exitCode, signal }))
  })
  const reader = (name: keyof typeof output) => ({ readFrom: (offset: number) => ({ text: output[name].slice(offset), nextOffset: output[name].length, lossy: false }) })
  return { done, collected: { stdout: reader('stdout'), stderr: reader('stderr') } }
}
