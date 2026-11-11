/** DingTalk application bot: explicitly mentioned group messages of every type enter the original Engine. */
import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream'
import { z } from 'zod'
import { key, type Trigger, type OutboundMessage } from '../core/index.ts'
import { family } from '../kv.ts'
import type { SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'
import { DingTalkCards } from './dingtalk-cards.ts'

const routes = family<Route, [string]>('dingtalk-route:')
const tickets = family<string, [string, string]>('dingtalk-ticket:')
const bodies = family<{ messageType: string; content: unknown }, [string]>('dingtalk-body:')

const Message = z.object({ msgId: z.string().min(1), conversationId: z.string().min(1),
  conversationType: z.string(), isInAtList: z.boolean().optional(), senderStaffId: z.string().min(1),
  senderCorpId: z.string().min(1), chatbotUserId: z.string().optional(), senderId: z.string().optional(),
  robotCode: z.string().min(1), msgtype: z.string(), text: z.object({ content: z.string().optional() }).nullish(),
  content: z.unknown().optional(),
  createAt: z.number().optional(), sessionWebhook: z.string().url(), sessionWebhookExpiredTime: z.number() })
export interface Route { webhook: string; expires: number; robotCode: string; conversationId: string }
export const ticketReference = (text: string): string | undefined => /(?:^|\s)#([a-f0-9]{12,32})(?=\s|$|[，。,:：])/i.exec(text)?.[1]?.toLowerCase()
export const label = (id: string): string => `#${id.slice(0, 12)}`

/** Projects the platform's body into text without treating a wire-format type as an admission rule. */
function contentText(value: unknown): string {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      return parsed && typeof parsed === 'object' ? contentText(parsed) : value
    } catch { return value }
  }
  if (Array.isArray(value)) return value.map(contentText).join('')
  if (!value || typeof value !== 'object') return ''
  const body = value as Record<string, unknown>
  if (Array.isArray(body.richText)) return contentText(body.richText)
  if (typeof body.text === 'string') return body.text
  if (body.text && typeof body.text === 'object') return contentText(body.text)
  if (typeof body.content === 'string') return body.content
  if (typeof body.recognition === 'string') return body.recognition
  if (typeof body.unknownMsgType === 'string') return body.unknownMsgType
  if (body.type === 'br') return '\n'
  if (body.type === 'picture' || body.pictureDownloadCode) return '\n[图片附件，内容尚未下载或解析]\n'
  if (typeof body.fileName === 'string') return `[文件附件：${body.fileName}，内容尚未下载或解析]`
  return ''
}

const QuotedMessage = z.object({ msgId: z.string().optional(), senderId: z.string().optional(),
  msgType: z.string().optional(), content: z.unknown().optional() })
function quotedMessage(head: Record<string, unknown>) {
  for (let container of [head.text, head.content]) {
    if (typeof container === 'string') {
      try { container = JSON.parse(container) } catch { continue }
    }
    if (!container || typeof container !== 'object') continue
    const body = container as Record<string, unknown>
    if (body.isReplyMsg !== true) continue
    const quote = QuotedMessage.safeParse(body.repliedMsg)
    if (quote.success) return quote.data
  }
}
/** Only card TEXT nodes are readable quote content; opaque/encrypted content is never guessed. */
function quotedText(value: unknown, depth = 0): string {
  if (depth > 8) return ''
  if (typeof value === 'string') {
    try { return quotedText(JSON.parse(value), depth + 1) } catch { return value }
  }
  if (Array.isArray(value)) return value.map(item => quotedText(item, depth + 1)).join('\n')
  if (!value || typeof value !== 'object') return ''
  const body = value as Record<string, unknown>
  if (body.elementType === 'TEXT' && typeof body.value === 'string') return body.value
  if (Array.isArray(body.cardContent)) return quotedText(body.cardContent, depth + 1)
  if (Array.isArray(body.children)) return quotedText(body.children, depth + 1)
  return contentText(value)
}

export function dingTalkTrigger(raw: unknown, context: SourceContext): { trigger: Trigger; route: Route; body?: { messageType: string; content: unknown } } | undefined {
  // The agreed receiving scope is group mentions; content type is not an additional filter.
  if (!raw || typeof raw !== 'object') return
  const head = raw as Record<string, unknown>
  if (head.conversationType !== '2' || head.isInAtList !== true) return
  const message = Message.parse(raw)
  if (message.senderId && message.senderId === message.chatbotUserId) return
  const text = [message.text?.content, contentText(message.content)].filter(value => value?.trim()).join('\n').trim()
    || `[钉钉 ${message.msgtype} 消息，未提供可解析文本；附件内容尚未下载或解析]`
  const id = key('dingtalk', message.robotCode, message.conversationId, message.msgId)
  const quote = quotedMessage(head)
  const replyToBot = !!quote?.senderId && !!message.chatbotUserId && quote.senderId === message.chatbotUserId
  const directReference = ticketReference(text)
  const reference = directReference ?? (replyToBot ? ticketReference(quotedText(quote?.content)) : undefined)
  const saved = reference ? context.state.get(tickets(message.conversationId, reference)) : undefined
  const matches = reference ? (saved ? [context.tickets.get(saved)].filter(ticket => !!ticket)
    : context.tickets.open().filter(ticket => ticket.id.startsWith(reference)))
    .filter(ticket => context.triggers.get(ticket!.origin.triggerId)?.meta.conversationId === message.conversationId) : []
  // Unknown/ambiguous references get their own evaluation, never fan out to another group's ticket.
  const origin = matches.length === 1 ? context.triggers.get(matches[0]!.origin.triggerId) : undefined
  const threads = origin?.threads ?? [{ source: 'dingtalk', id }]
  const conversation = message.conversationId
  return {
    trigger: { id, source: 'dingtalk', threads, actor: { source: 'dingtalk', id: message.senderStaffId }, human: true,
      addressed: 'mention', at: new Date(message.createAt ?? Date.now()).toISOString(), text,
      channel: { source: 'dingtalk', thread: `dingtalk:${conversation}`, address: { conversationId: conversation, triggerId: id } },
      meta: { conversationId: conversation, conversationType: '2', senderCorpId: message.senderCorpId, robotCode: message.robotCode,
        messageId: message.msgId, messageType: message.msgtype, chatbotUserId: message.chatbotUserId,
        ...(quote ? { replyToMessageId: quote.msgId, replyToMessageType: quote.msgType, replyToBot } : {}),
        ...(reference ? { referenceSource: directReference ? 'text' : 'quote' } : {}),
        ...(reference ? { ticketReference: reference, referenceResolved: matches.length === 1 } : {}) } },
    route: { webhook: message.sessionWebhook, expires: message.sessionWebhookExpiredTime, robotCode: message.robotCode, conversationId: conversation },
    ...(message.content !== undefined || quote ? { body: { messageType: message.msgtype,
      content: quote ? { content: message.content, quote } : message.content } } : {}),
  }
}

/** Translates DingTalk Stream callbacks and group sends through the original SourceContext boundary. */
export class DingTalk {
  private readonly client: DWClient
  private readonly cards?: DingTalkCards
  private token?: { value: string; until: number }
  constructor(private readonly context: SourceContext, private readonly credentials: { clientId: string; clientSecret: string },
    private readonly log: (event: string) => void,
    private readonly http: typeof fetch = fetch, cardTemplateId?: string, robotName = 'Super agent') {
    this.client = new DWClient({ ...credentials, debug: false, keepAlive: true })
    if (cardTemplateId) {
      this.cards = new DingTalkCards(context, cardTemplateId, () => this.accessToken(), http, credentials.clientId, robotName)
    }
    this.client.registerCallbackListener(TOPIC_ROBOT, async frame => {
      try {
        const parsed = dingTalkTrigger(JSON.parse(frame.data), context)
        if (parsed) await context.atomic(() => {
          context.state.set(routes(parsed.route.conversationId), parsed.route)
          // Preserve native content/attachment references in the original Source KV, separate from model text.
          if (parsed.body) context.state.set(bodies(parsed.trigger.id), parsed.body)
          const result = context.receive(parsed.trigger)
          if (result instanceof Promise) throw new Error('DingTalk intake must commit synchronously')
          if (result === 'stored') this.cards?.received(parsed.trigger)
          return result
        })
        // Acknowledge only after the event and pending work have committed.
        this.client.socketCallBackResponse(frame.headers.messageId, null)
      } catch { this.log('dingtalk_receive_failed') /* No ACK: DingTalk can redeliver. Never log credentials or payloads. */ }
    })
    const getEndpoint = this.client.getEndpoint.bind(this.client)
    this.client.getEndpoint = async () => {
      try { return await getEndpoint() }
      catch { this.log('dingtalk_connection_failed'); throw new Error('DingTalk Stream authentication or connection failed') }
    }
  }
  async start(): Promise<void> {
    await this.client.connect()
    if (!this.client.connected) { this.client.disconnect(); throw new Error('DingTalk Stream did not connect') }
    this.seedReportRoute()
    this.context.report('dingtalk', { state: 'ready', detail: 'Stream connected' })
    this.log('dingtalk_connected')
  }
  /** Seeds a permanent group-send route for the configured CI report group, so analysis tickets can report there before anyone messages the bot; an existing incoming route is kept. */
  private seedReportRoute(): void {
    const conversation = this.context.config<{ reportConversationId?: string }>('dingtalk')?.reportConversationId
    if (!conversation || this.context.state.get(routes(conversation))) return
    const robotCode = process.env.DINGTALK_ROBOT_CODE || this.credentials.clientId
    // expires 0 makes send() always use the application group-send API; a proactive report has no session webhook.
    this.context.state.set(routes(conversation), { webhook: '', expires: 0, robotCode, conversationId: conversation })
  }
  stop(): void { this.client.disconnect() }
  private async accessToken(): Promise<string> {
    if (this.token && this.token.until > Date.now()) return this.token.value
    const result = await this.http('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ appKey: this.credentials.clientId, appSecret: this.credentials.clientSecret }),
    })
    const data = await result.json() as { accessToken?: string; expireIn?: number }
    if (!result.ok || !data.accessToken) throw new Error('DingTalk token request failed')
    this.token = { value: data.accessToken, until: Date.now() + Math.max(0, (data.expireIn ?? 7200) - 60) * 1000 }
    return this.token.value
  }
  async send(message: OutboundMessage): Promise<void> {
    const conversation = message.channel.address.conversationId!
    const route = this.context.state.get(routes(conversation))
    if (!route) throw new Error('DingTalk reply route is unavailable')
    if (message.ticketId) this.context.state.set(tickets(conversation, message.ticketId.slice(0, 12)), message.ticketId)
    const text = message.ticketId ? `${label(message.ticketId)} ${message.text}` : message.text
    if (text.length > 4000) throw new Error('DingTalk result exceeds 4000 characters; provide a brief result and a link')
    if (this.cards) { await this.cards.send(message); return }
    const token = await this.accessToken()
    // A long coding task can outlive the session webhook, and a seeded report route has none; both use the application group-send API.
    const active = route.expires > Date.now() + 5000
    const url = active ? new URL(route.webhook) : undefined
    if (url && (url.protocol !== 'https:' || url.hostname !== 'oapi.dingtalk.com')) throw new Error('Invalid DingTalk session webhook')
    const response = await this.http(url ?? 'https://api.dingtalk.com/v1.0/robot/groupMessages/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
      signal: AbortSignal.timeout(15000), body: JSON.stringify(active
        ? { msgtype: 'text', text: { content: text } }
        : { robotCode: route.robotCode, openConversationId: conversation, msgKey: 'sampleText', msgParam: JSON.stringify({ content: text }) }),
    })
    const data = await response.json() as { errcode?: number; code?: string; processQueryKey?: string }
    if (!response.ok || (active ? data.errcode !== 0 : !!data.code || !data.processQueryKey)) {
      throw new Error(`DingTalk message send failed (HTTP ${response.status}); check robot permissions and group membership`)
    }
  }
}

/** The original SourceRegistry and Outbox own admission and delivery; this kind only translates DingTalk messages. */
export function dingTalkKind(send: (message: OutboundMessage) => Promise<void>): SourceKind {
  return {
    kind: 'dingtalk', title: { zh: '钉钉', en: 'DingTalk' },
    description: { zh: 'Stream 群内 @ 消息（所有消息类型）', en: 'Stream group mentions (all message types)' },
    schema: z.object({ reportConversationId: z.string().min(1).optional() }).strict(),
    fields: [{ key: 'reportConversationId', type: 'text', label: { zh: 'CI 报告群', en: 'CI report group' },
      hint: { zh: '钉钉群的 conversationId。CI 分析工单的结果与确认会发进这个群；机器人必须在群里且有发送群消息的权限。留空则不单独报告。', en: 'The conversationId of a DingTalk group. CI analysis tickets report their results and confirmations here; the bot must be in the group with permission to send group messages. Leave empty to disable.' } }],
    health: ['dingtalk'],
    scope: ({ meta }) => meta.conversationType === '2' ? { listened: true, observed: false, row: 'group' }
      : { listened: false, reason: 'Only group messages are supported' },
    channel: {
      send: async (_host, message) => { await send(message); return 'sent' },
      link: () => ({ url: '', label: { zh: '钉钉群', en: 'DingTalk group' } }),
    },
  }
}
