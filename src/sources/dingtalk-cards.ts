/** DingTalk card transport; original Source KV and Outbox retain ownership of delivery and reply routing. */
import { key, type OutboundMessage, type Trigger } from '../core/index.ts'
import { family } from '../kv.ts'
import type { SourceContext } from './host.ts'

interface Card {
  triggerId: string; conversationId: string; templateId: string; used: boolean; sent: boolean
  ticketId?: string
}
const cards = family<Card, [string]>('dingtalk-card:')
const deliveries = family<string, [string]>('dingtalk-card-delivery:')
const pendingCards = family<string[], [string]>('dingtalk-card-pending:')
export const receiptId = (triggerId: string) => key('dingtalk-received', triggerId)
/** Creates AI receipts/feedback cards whose summary carries the task reference for native quoted replies. */
export class DingTalkCards {
  constructor(private readonly context: SourceContext, private readonly templateId: string,
    private readonly token: () => Promise<string>, private readonly http: typeof fetch = fetch,
    private readonly robotCode?: string, private readonly robotName = 'Super agent') {}

  /** Called in the same transaction as intake; no model call or remote API delays the receive ACK. */
  received(trigger: Trigger): void {
    const pending = pendingCards(key(JSON.stringify(trigger.threads)))
    this.context.state.set(pending, [...new Set([...this.context.state.get(pending) ?? [], trigger.id])])
    this.context.notify({ id: receiptId(trigger.id), kind: 'notice', channel: trigger.channel!,
      text: '已收到，处理中…' })
  }

  async send(message: OutboundMessage): Promise<void> {
    const conversationId = message.channel.address.conversationId!
    const triggerId = message.channel.address.triggerId
      ?? (message.ticketId ? this.context.tickets.get(message.ticketId)?.origin.triggerId : undefined)
    const origin = triggerId ? this.context.triggers.get(triggerId) : undefined
    if (!origin || origin.source !== 'dingtalk' || origin.meta.conversationId !== conversationId) {
      throw new Error('DingTalk card has no matching source message')
    }
    const receipt = receiptId(origin.id)
    const placeholder = message.id === receipt
    const pendingKey = pendingCards(key(JSON.stringify(origin.threads)))
    const pending = this.context.state.get(pendingKey) ?? []
    const mapped = this.context.state.get(deliveries(message.id))
    const waiting = !placeholder && !mapped ? pending[0] : undefined
    const id = mapped ?? (placeholder ? receipt : waiting ? receiptId(waiting) : key('dingtalk-feedback', message.id))
    const saved = this.context.state.get(cards(id))
    // A model may enqueue its acknowledgement before the receipt was delivered. Never overwrite that feedback with a late placeholder.
    if (placeholder && saved?.used) return
    this.context.state.set(deliveries(message.id), id)
    if (waiting) this.context.state.set(pendingKey, pending.filter(item => item !== waiting))
    const card: Card = saved ?? { triggerId: waiting ?? origin.id, conversationId, templateId: this.templateId, used: false, sent: false }
    if (message.ticketId) card.ticketId = message.ticketId
    if (!placeholder) card.used = true
    this.context.state.set(cards(id), card)
    const taskLabel = message.ticketId ? `#${message.ticketId.slice(0, 12)}` : ''
    const data = { title: [taskLabel, this.robotName].filter(Boolean).join(' '), status: placeholder ? '处理中' : '完成',
      markdown: taskLabel ? `${taskLabel}\n\n${message.text}` : message.text, flowStatus: placeholder ? '1' : '3',
      replyHint: placeholder ? '已收到消息，等待处理。' : taskLabel
        ? `引用回复此卡片并 @${this.robotName}。若客户端未带回引用摘要，请在正文附上 ${taskLabel}。`
        : `请在群里 @${this.robotName} 继续沟通。`,
    }
    const body = { outTrackId: id, cardData: { cardParamMap: data } }
    const response = await this.http(`https://api.dingtalk.com/v1.0/card/instances${card.sent ? '' : '/createAndDeliver'}`, {
      method: card.sent ? 'PUT' : 'POST', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': await this.token() },
      body: JSON.stringify(card.sent ? { ...body, cardUpdateOptions: { updateCardDataByKey: true } } : {
        ...body, cardTemplateId: card.templateId, userIdType: 1,
        openSpaceId: `dtv1.card//IM_GROUP.${conversationId}`,
        imGroupOpenSpaceModel: { supportForward: false }, imGroupOpenDeliverModel: { robotCode: origin.meta.robotCode ?? this.robotCode },
      }),
    })
    if (!response.ok) throw new Error(`DingTalk card delivery failed (HTTP ${response.status}); check template and card permissions`)
    const result = await response.json() as { code?: string }
    if (result.code) throw new Error('DingTalk card delivery was rejected; check template and card permissions')
    card.sent = true; this.context.state.set(cards(id), card)
  }

}
