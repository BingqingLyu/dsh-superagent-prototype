/** JSON-RPC adapter to an independent Codex CLI app-server, never the desktop application's host. */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
export interface RpcStore {
  get<T>(kind: string, id: string): T | undefined
  set(kind: string, id: string, value: unknown): void
}

export interface Tool { name: string; description: string; inputSchema: unknown }
export type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access'
export interface Session { threadId: string; activeTurn?: string; instructions?: string; cwd?: string; sandbox?: string }
export interface CodexPort {
  ensure(key: string, cwd: string, instructions: string, tools: Tool[], router?: boolean, ephemeral?: boolean): Promise<string>
  send(key: string, requestId: string, text: string): Promise<void>
  interrupt(key: string): Promise<void>
  running(key: string): boolean
}
export type RpcMessage = { id?: string | number; method?: string; params?: any; result?: any; error?: { code: number; message: string } }
/** Owns the Codex subprocess, durable thread/message IDs, JSON-RPC requests and streamed session events. */
export class CodexSessions implements CodexPort {
  private process?: ChildProcessWithoutNullStreams
  private sequence = 0
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>()
  private sessions = new Map<string, Session>()
  private creating = new Map<string, Promise<string>>()
  private closing = false
  private agentConfig = false
  private writes = new Map<string, Promise<void>>()
  onTool: (key: string, tool: string, args: unknown) => Promise<unknown> = async () => { throw new Error('Tools not initialized') }
  onTurn: (key: string, turn: any) => void = () => {}
  onInput: (key: string, text: string) => void = () => {}
  onEvent: (key: string, method: string, params: any) => void = () => {}
  onFailure: (error: Error) => void = () => {}
  constructor(private readonly store: RpcStore, private readonly binary: string, private readonly model?: string,
    private readonly sandbox: CodexSandbox = 'workspace-write') {}
  async start(): Promise<void> {
    // Bot credentials must never be inherited by worker subprocesses or printed in CLI errors.
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('DINGTALK_')))
    // Newer CLIs moved the switch into agents.enabled; older ones reject that key as an agent-role table.
    const probe = spawnSync(this.binary, ['-c', 'agents.enabled=false', 'features', 'list'], { env, timeout: 15000, encoding: 'utf8' })
    this.agentConfig = probe.status === 0
    const flags = ['-c', 'features.multi_agent=false', '-c', 'features.multi_agent_v2=false',
      ...(this.agentConfig ? ['-c', 'agents.enabled=false'] : [])]
    this.process = spawn(this.binary, [...flags, 'app-server', '--listen', 'stdio://'],
      { env, stdio: 'pipe' })
    createInterface({ input: this.process.stdout }).on('line', line => {
      try { void this.message(JSON.parse(line)).catch(() => this.fail(new Error('Codex protocol handler failed'))) }
      catch { this.fail(new Error('Invalid Codex JSON-RPC output')) }
    })
    // stderr may contain prompts, paths, or provider credentials. Do not relay it to chat or logs.
    this.process.stderr.resume()
    this.process.on('error', () => this.fail(new Error('Unable to start Codex CLI')))
    this.process.on('exit', () => { if (!this.closing) this.fail(new Error('Codex app-server exited; restart the service to recover')) })
    await this.request('initialize', { clientInfo: { name: 'superagent_dingtalk', version: '0.1.0' }, capabilities: { experimentalApi: true } })
    this.write({ method: 'initialized' })
  }
  private write(message: RpcMessage): void {
    if (!this.process || this.process.stdin.destroyed) throw new Error('Codex is disconnected')
    this.process.stdin.write(JSON.stringify(message) + '\n')
  }
  request(method: string, params: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out`)) }, 30000)
      this.pending.set(id, { resolve, reject, timer })
      try { this.write({ id, method, params }) }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error) }
    })
  }
  /** Also exercised by protocol tests; server requests are handled without blocking notification reads. */
  async message(message: RpcMessage): Promise<void> {
    if (!message.method && typeof message.id === 'number') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id); clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(`Codex RPC rejected request (${message.error.code}): ${message.error.message}`))
      else pending.resolve(message.result)
      return
    }
    const params = message.params ?? {}
    const entry = [...this.sessions].find(([, value]) => value.threadId === params.threadId)
    if (message.id !== undefined) {
      if (message.method === 'item/tool/call') {
        try {
          if (!entry) throw new Error('Tool call belongs to an unmanaged session')
          const value = await this.onTool(entry[0], params.tool, params.arguments)
          this.write({ id: message.id, result: { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value ?? {}) }] } })
        } catch (error) {
          this.write({ id: message.id, result: { success: false, contentItems: [{ type: 'inputText', text: error instanceof Error ? error.message : 'Tool failed' }] } })
        }
      } else if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') {
        // Native allow rules execute without a client prompt. Requests still requiring a human are declined headlessly.
        this.write({ id: message.id, result: { decision: 'decline' } })
      } else {
        // Headless operation never silently grants approval. Workers report blocked instead.
        this.write({ id: message.id, error: { code: -32601, message: 'Interactive requests are unavailable in the headless runtime' } })
      }
      return
    }
    if (!entry) return
    const [key, session] = entry
    this.onEvent(key, message.method!, params)
    if (message.method === 'turn/started') session.activeTurn = params.turn.id
    if (message.method === 'item/completed' && params.item?.type === 'userMessage') {
      const text = (params.item.content ?? []).filter((item: any) => item.type === 'text').map((item: any) => item.text).join('\n')
      this.onInput(key, text)
    }
    if (message.method === 'turn/completed') {
      if (session.activeTurn === params.turn.id) delete session.activeTurn
      this.onTurn(key, params.turn)
    }
  }
  ensure(key: string, cwd: string, instructions: string, tools: Tool[], router = false, ephemeral = false): Promise<string> {
    const existing = this.sessions.get(key)
    if (existing) return Promise.resolve(existing.threadId)
    const running = this.creating.get(key)
    if (running) return running
    const created = this.create(key, cwd, instructions, tools, router, ephemeral).finally(() => this.creating.delete(key))
    this.creating.set(key, created)
    return created
  }
  private async create(key: string, cwd: string, instructions: string, tools: Tool[], router: boolean, ephemeral: boolean): Promise<string> {
    const saved = this.store.get<string>('codex-thread', key)
    const config = { 'features.multi_agent': false, 'features.multi_agent_v2': false,
      ...(this.agentConfig ? { 'agents.enabled': false } : {}),
      'features.shell_tool': true, 'features.apps': false, 'features.plugins': false }
    const sandbox = router ? 'read-only' : this.sandbox
    const common = { cwd, model: this.model, approvalPolicy: sandbox === 'danger-full-access' ? 'never' : 'on-request', approvalsReviewer: 'user', sandbox,
      developerInstructions: instructions, config }
    // A failed resume must not silently lose the old conversation or repeat external actions.
    const result = saved ? await this.request('thread/resume', { ...common, threadId: saved, excludeTurns: true })
      : await this.request('thread/start', { ...common, dynamicTools: tools, ephemeral })
    const threadId = result.thread.id as string
    this.store.set('codex-thread', key, threadId)
    this.sessions.set(key, { threadId, instructions, cwd, sandbox: common.sandbox })
    return threadId
  }
  /** Serialize submissions, while allowing follow-ups to steer an active model turn. */
  send(key: string, requestId: string, text: string, instructions?: string, selection?: { model: string; reasoningEffort?: string }): Promise<void> {
    const next = (this.writes.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (this.store.get('codex-delivered', requestId)) return
      const session = this.sessions.get(key)
      if (!session) throw new Error('Session is not initialized')
      if (!session.activeTurn && instructions !== undefined && instructions !== session.instructions) {
        await this.request('thread/resume', { threadId: session.threadId, developerInstructions: instructions, excludeTurns: true })
        session.instructions = instructions
      }
      let messageId = this.store.get<string>('codex-message', requestId)
      if (!messageId) { messageId = randomUUID(); this.store.set('codex-message', requestId, messageId) }
      const params = { threadId: session.threadId, clientUserMessageId: messageId, input: [{ type: 'text', text }] }
      if (session.activeTurn) await this.request('turn/steer', { ...params, expectedTurnId: session.activeTurn })
      else {
        const sandboxPolicy = session.sandbox === 'danger-full-access' ? { type: 'dangerFullAccess' }
          : session.sandbox === 'read-only' ? { type: 'readOnly', networkAccess: true }
          : { type: 'workspaceWrite', networkAccess: true, writableRoots: [session.cwd] }
        const result = await this.request('turn/start', { ...params, sandboxPolicy,
          ...(selection ? { model: selection.model, effort: selection.reasoningEffort } : {}) })
        session.activeTurn = result.turn.id
      }
      this.store.set('codex-delivered', requestId, true)
    })
    this.writes.set(key, next)
    return next
  }
  running(key: string): boolean { return !!this.sessions.get(key)?.activeTurn }
  async inputSeen(key: string, requestId: string): Promise<boolean> {
    const session = this.sessions.get(key), id = this.store.get<string>('codex-message', requestId)
    if (!session || !id) return false
    const result = await this.request('thread/read', { threadId: session.threadId, includeTurns: true })
    return (result.thread?.turns ?? []).some((turn: any) => (turn.items ?? []).some((item: any) => item.type === 'userMessage' && item.id === id))
  }
  async interrupt(key: string): Promise<void> {
    const session = this.sessions.get(key)
    if (session?.activeTurn) await this.request('turn/interrupt', { threadId: session.threadId, turnId: session.activeTurn })
    await this.cleanBackground(key)
  }
  async cleanBackground(key: string): Promise<void> {
    const session = this.sessions.get(key)
    if (session) await this.request('thread/backgroundTerminals/clean', { threadId: session.threadId })
  }
  private fail(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear(); if (!this.closing) this.onFailure(error)
  }
  async close(): Promise<void> {
    this.closing = true
    await Promise.allSettled([...this.sessions.keys()].map(key => this.interrupt(key)))
    this.fail(new Error('Codex shutdown'))
    const child = this.process
    if (!child || child.exitCode !== null) return
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL') }, 5000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
      child.kill('SIGTERM')
    })
  }
}
