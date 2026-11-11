# DingTalk AI receipts and native quoted replies

The transport sends complete messages using ordinary card updates: pending is `flowStatus=1`; acceptance of a worker task changes the same card to **输出中** (`flowStatus=2`). Subsequent replies append below the acceptance in that card, separated by a divider, and change it to **完成** (`flowStatus=3`). A direct answer without a worker goes straight from pending to completed. Both writing and finished Markdown blocks explicitly use `isStreaming=false`: this is full-message updating, not token streaming.

The active card is scoped to the ticket and conversation. A new user followup receives a new pending card, which becomes the active card when feedback for that turn is sent. Message IDs and appended text are persisted in Source KV, so retries and transport restarts do not duplicate feedback. Worker reports still go through the original main-agent reply tools and Outbox; the transport does not publish worker reports on its own. The writing state describes a request waiting for its result, not a continuously running main agent.

While writing, a divider below the existing response is followed by the native `AIPending` spinner labeled **输出中…**. Completed feedback replaces this waiting area with the appended result and has no spinner. Both states end with a divided footer: **引用此卡片以回复消息。** This layout requires importing and publishing the updated template as well as restarting the rebuilt service.

## Import the complete AI template

1. Grant the existing app `Card.Instance.Write`.
2. Create a **消息卡片 → AI 卡片** associated with the bot.
3. Use the editor's top-right tools menu **导入卡片模板** with [dingtalk-superagent.json](dingtalk-superagent.json). The readable source is [dingtalk-superagent.editor.json](dingtalk-superagent.editor.json). The import declares `extension.extendType=AI` and `aiStatusList=[1,2,3]`; it must replace the complete AI template, not insert a normal card inside the existing AI content area.
4. Open **变量 → Mock** and save the imported mock data so the editor compiles the preview rich text. Before saving/publishing, inspect the outline: one AI root, with three sibling status containers (1, 2, 3), and no nested status containers. Preview pending and completed states. Completed feedback must display the task ID and response. On 2026-11-11, the AliDing web editor displayed both states and the `title` summary binding after this step; this does not validate live quote callbacks.
5. Set `DINGTALK_CARD_TEMPLATE_ID` to the published template ID and `DINGTALK_ROBOT_NAME` to the actual bot name.

## Reply and retain the task

Use the client's native **回复 / 引用回复** on a feedback card, mention the bot, and send the followup as an ordinary group message. The transport puts `#<12-character task ID>` first in both the card summary (`summaryContent → title`) and Markdown body.

The receiver reads `isReplyMsg/repliedMsg` in either `text` or `content` (including JSON-encoded content). If the quoted sender matches the bot's actual `chatbotUserId`, it extracts a task reference from the quoted summary/text or `cardContent` TEXT nodes and reuses the existing task-reference resolver. A reference typed in the new message takes precedence. Cross-group, unknown and ambiguous references never route to another task. The new user text remains separate from the quoted text. Source KV retains the quote metadata/body for diagnosis.

**Live acceptance is still required for this AliDing client.** Public callback examples establish quoted-message fields, but do not guarantee this client's AI-card quote includes our summary or task ID, or automatically mentions the bot. If the client sends only an opaque message ID or omits the task-bearing summary, automatic task recovery remains unavailable; add the displayed task ID to the new message. Do not infer the most recent task in a group.

The earlier custom **回复** button was invalid: the current AliDing editor has no JSAPI action in either its button actions or event chain. It normalized the unsupported `callAPI` action to an empty URL. The corrected template removes that control instead of claiming `biz.chat.sendReplyToInputPanel` works in this container. There is no private card submission or robot-authored echo.

Verify on the real client: quote a card with two tasks in the same group, send a followup mentioning the bot without typing an ID, and inspect the received trigger for `referenceSource=quote`, `referenceResolved=true`, and the correct task thread/worker. Test desktop and mobile. If unresolved, inspect the persisted quote (not credentials or session webhooks) before extending the mapping.

## Delivery

Creation uses `POST /v1.0/card/instances/createAndDeliver`; updates use `PUT /v1.0/card/instances`. Source KV and the original Outbox retain pending receipt, retry and delivery ownership. No card-interaction callback or public HTTP endpoint is added. Without a configured template, the existing text transport remains active.

References: [official card examples](https://github.com/open-dingtalk/dingtalk-card-examples), [official AI status implementation](https://github.com/open-dingtalk/dingtalk-stream-sdk-python/blob/main/dingtalk_stream/card_replier.py), [quoted callback report in the official Stream SDK repository](https://github.com/open-dingtalk/dingtalk-stream-sdk-go/issues/22), [captured interactiveCard quote body](https://github.com/soimy/openclaw-channel-dingtalk/issues/598).
