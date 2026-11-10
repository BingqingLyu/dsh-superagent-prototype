# DingTalk AI receipt and native reply cards

This mode uses an **AI card**, with the platform's native pending component. The first received group mention queues a waiting card before any model response. The receipt shows **处理中** (`flowStatus=1`). The first complete feedback updates that card to **完成** (`flowStatus=3`); later feedback remains in separate completed AI cards. The receipt means message received, not task accepted. Completion describes this individual message, not the whole task. The current transport sends complete messages and does not enter the writing state (`flowStatus=2`).

The **回复** button prepares `@机器人 #任务编号 ` in the current group's native chat input. The user adds text and presses Send, so the reply is an ordinary user-authored group message visible to everyone. It then enters the existing Stream mention and task-reference path. Clicking the button neither sends a message nor creates a private card submission. There is no robot-authored echo.

## Publish the AI template

1. Request **互动卡片实例写权限** (`Card.Instance.Write`) for the existing DingTalk app. This version uses complete card updates, so it does not call `Card.Streaming.Write` or claim token-by-token streaming.
2. Open the advanced card platform, choose **消息卡片 → AI 卡片**, and associate it with the bot's application. Do not use the ordinary `card.dingtalk.com/card-builder?cardType=normal` editor or import into a standard-card template.
3. In the advanced editor's top-right four-square tools menu, choose **导入卡片模板** and import [dingtalk-superagent.json](dingtalk-superagent.json). [dingtalk-superagent.editor.json](dingtalk-superagent.editor.json) is the readable source. Save to compile the editable schema, then preview the AI processing and completed states before publishing. The import JSON is not a normal-card API body.
4. The processing state must show the native `AIPending` animation; the completed state must show the response and **回复**. The old card input and **发送回复** controls have been removed.
5. Set `DINGTALK_CARD_TEMPLATE_ID=<published-AI-template-ID>` and `DINGTALK_ROBOT_NAME=<the bot's actual display name>` in the private env file, rebuild, and restart. Start a new group @ message so the callback supplies the real `chatbotUserId`. Without a bot ID, the reply button is disabled rather than fabricating a plain-text @.

## Native input integration and live acceptance

The button uses the DingTalk JSAPI SDK's `biz.chat.sendReplyToInputPanel`, with `cidEnc`, `replyContent`, and `atDingTalkIds`. The bot ID is taken from the received platform message, not inferred from its display name or application ID. A task reference is added only when the actual task ID is known. The initial pending state has no reply button because no task has been accepted yet.

**The SDK declares this API for iOS, Android and PC, but that does not establish that this particular AliDing card container has permission to invoke it.** Verify in the real client after publishing; a browser preview cannot validate the native composer. If the client rejects the API, investigate its documented container permissions before enabling this interaction. Do not silently switch back to private submissions or robot echoes.

Live acceptance: click **回复** on a feedback card and verify (1) the correct group input is focused, (2) the bot is a real mention, (3) the correct task prefix is present, (4) no message is sent until the user presses Send, and (5) everyone sees the user-authored message and the original task receives it. Test both desktop and mobile, including a draft already in the input. No claim of this behavior is established by local transport tests alone.

## Transport

- Creation uses `POST /v1.0/card/instances/createAndDeliver`; updates use `PUT /v1.0/card/instances`. `flowStatus=1` shows processing and `flowStatus=3` shows the complete feedback. This is the per-message display state, not the task lifecycle state.
- Source KV persists pending receipt and delivery mappings; the original Outbox owns delivery/retries. Native replies arrive through the existing group-message callback, not `TOPIC_CARD`. No public HTTP endpoint is required.
- An ambiguous create response after a network failure may require operator reconciliation; this transport does not claim exactly-once external delivery. Misconfigured card delivery stays in normal Outbox retry/error handling. Without a configured template the original text mode remains active.

References: [official AI card examples](https://github.com/open-dingtalk/dingtalk-card-examples), [official AI state implementation](https://github.com/open-dingtalk/dingtalk-stream-sdk-python/blob/main/dingtalk_stream/card_replier.py), [DingTalk JSAPI SDK](https://www.npmjs.com/package/dingtalk-jsapi) (`lib/common/api/biz/chat/sendReplyToInputPanel.d.ts`).
