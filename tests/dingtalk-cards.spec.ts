import { beforeEach, expect, it, vi } from 'vitest'
import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream'
import { DingTalk, dingTalkTrigger } from '../src/sources/dingtalk.ts'
import { DingTalkCards, receiptId } from '../src/sources/dingtalk-cards.ts'
import type { SourceContext } from '../src/sources/host.ts'
import type { OutboundMessage, Trigger } from '../src/core/index.ts'

let context: SourceContext, origin: Trigger, cards: DingTalkCards
let http: ReturnType<typeof vi.fn>, notify: ReturnType<typeof vi.fn>
const raw = { msgId: 'incoming', conversationId: 'group', conversationType: '2', isInAtList: true,
  senderStaffId: 'author', senderCorpId: 'corp', robotCode: 'robot', chatbotUserId: 'bot-dingtalk-id', msgtype: 'text', text: { content: '检查 PR' },
  sessionWebhook: 'https://oapi.dingtalk.com/robot/send?example', sessionWebhookExpiredTime: Date.now() + 60000 }
beforeEach(() => {
  const state = new Map(), triggers = new Map<string, Trigger>()
  notify = vi.fn()
  context = { state: { get: (key: string) => state.get(key), set: (key: string, value: unknown) => { state.set(key, value) } },
    triggers: { get: (id: string) => triggers.get(id) }, tickets: { get: (id: string) => id === 'ticket' ? { id, origin: { triggerId: origin.id } } : undefined, open: () => [] },
    receive: vi.fn((trigger: Trigger) => {
      if (triggers.has(trigger.id)) return 'duplicate'
      triggers.set(trigger.id, trigger); return 'stored'
    }), notify, atomic: (work: () => unknown) => work(),
  } as unknown as SourceContext
  origin = dingTalkTrigger(raw, context)!.trigger
  context.receive(origin)
  http = vi.fn(async () => ({ ok: true, json: async () => ({ outTrackId: 'card' }) }))
  cards = new DingTalkCards(context, 'template.schema', async () => 'access-token', http as typeof fetch)
})
const message = (overrides: Partial<OutboundMessage> = {}): OutboundMessage => ({
  id: 'ack', channel: origin.channel!, text: '正在检查', kind: 'acknowledgement', ticketId: 'ticket', ...overrides,
})
async function receipt() {
  cards.received(origin)
  const pending = notify.mock.calls.at(-1)![0] as OutboundMessage
  await cards.send(pending)
  return pending
}
const requestBody = (call: number) => JSON.parse(http.mock.calls[call]![1].body)
it('queues a durable AI waiting card immediately on intake without registering a private reply callback', async () => {
  const listeners = new Map<string, (frame: any) => Promise<void>>()
  const register = vi.spyOn(DWClient.prototype, 'registerCallbackListener').mockImplementation(function (this: DWClient, topic, listener) {
    listeners.set(topic, listener as any); return this
  })
  const ack = vi.spyOn(DWClient.prototype, 'socketCallBackResponse').mockImplementation(() => {})
  try {
    new DingTalk(context, { clientId: 'client', clientSecret: 'secret' }, () => {}, http as typeof fetch, 'template.schema')
    expect(listeners.size).toBe(1)
    const frame = { data: JSON.stringify({ ...raw, msgId: 'second' }), headers: { messageId: 'delivery' } }
    await listeners.get(TOPIC_ROBOT)!(frame)
    expect(notify).toHaveBeenCalledOnce()
    const pending = notify.mock.calls[0]![0] as OutboundMessage
    expect(pending.text).toContain('处理中')
    expect(context.triggers.get(pending.channel.address.triggerId!)).toBeDefined()
    expect(ack).toHaveBeenCalledWith('delivery', null)
    expect(http).not.toHaveBeenCalled() // No remote API or model call blocks the Stream receive ACK.
    await listeners.get(TOPIC_ROBOT)!(frame)
    expect(notify).toHaveBeenCalledOnce()
  } finally { register.mockRestore(); ack.mockRestore() }
})
it('replaces the placeholder with first feedback and gives subsequent feedback independent reply cards', async () => {
  await receipt()
  expect(requestBody(0)).toMatchObject({ cardTemplateId: 'template.schema',
    openSpaceId: 'dtv1.card//IM_GROUP.group', cardData: { cardParamMap: { flowStatus: '1', status: '处理中' } } })
  await cards.send(message())
  expect(http.mock.calls[1]![1].method).toBe('PUT')
  expect(requestBody(1)).toMatchObject({ outTrackId: receiptId(origin.id), cardData: { cardParamMap: { flowStatus: '3', status: '完成', markdown: '正在检查' } } })
  await cards.send(message({ id: 'result', kind: 'reply', text: '检查完成' }))
  expect(http.mock.calls[2]![1].method).toBe('POST')
  expect(requestBody(2).outTrackId).not.toBe(receiptId(origin.id))
  expect(requestBody(2).cardData.cardParamMap).toMatchObject({ flowStatus: '3', status: '完成', markdown: '检查完成' })
})
it('prepares a real robot mention and task reference for the group input, with no auto-send or private submission', async () => {
  await receipt()
  expect(requestBody(0).cardData.cardParamMap.replyEnabled).toBe('false')
  await cards.send(message())
  const data = requestBody(1).cardData.cardParamMap
  expect(data.replyContent).toBe('@Super agent #ticket ')
  expect(data.replyConversationId).toBe('group')
  expect(JSON.parse(data.sys_full_json_obj)).toEqual({ replyAtUsers: { 'bot-dingtalk-id': 'Super agent' } })
  expect(data.replyEnabled).toBe('true')
  expect(requestBody(0).callbackType).toBeUndefined()
  expect(http.mock.calls.every(call => call[0].startsWith('https://api.dingtalk.com/v1.0/card/instances'))).toBe(true)
})
it('disables native reply when the real bot identity is unavailable, rather than using a fake text mention', async () => {
  origin.meta.chatbotUserId = undefined
  await cards.send(message())
  const data = requestBody(0).cardData.cardParamMap
  expect(data.replyEnabled).toBe('false')
  expect(JSON.parse(data.sys_full_json_obj)).toEqual({ replyAtUsers: {} })
  expect(data.replyHint).toContain('重新 @')
})
it('uses a stable card ID on retry and never lets a delayed placeholder overwrite feedback', async () => {
  const pending = await receipt()
  http.mockResolvedValueOnce({ ok: false, status: 503 })
  await expect(cards.send(message())).rejects.toThrow('HTTP 503')
  await cards.send(message())
  expect(requestBody(1).outTrackId).toBe(requestBody(2).outTrackId)
  const before = http.mock.calls.length
  await cards.send(pending)
  expect(http).toHaveBeenCalledTimes(before)
})
