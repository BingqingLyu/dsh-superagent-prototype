#!/usr/bin/env node
// A protocol fixture, not a model. Exercises bidirectional RPC without network or inference.
import { createInterface } from 'node:readline';
let pending;
let turns = 0;
const specs = new Map();
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ id: message.id, result: {} });
  else if (message.method === 'thread/start') {
    const p = message.params;
    if (p.config['features.multi_agent'] !== false || p.approvalPolicy !== 'on-request' || p.approvalsReviewer !== 'user') {
      send({ id: message.id, error: { code: -1, message: 'Expected native on-request approvals with subagents disabled' } });
    } else {
      const id = `thread-${message.id}`;
      specs.set(id, p.dynamicTools ?? []);
      send({ id: message.id, result: { thread: { id } } });
    }
  } else if (message.method === 'thread/resume') send({ id: message.id, result: { thread: { id: message.params.threadId } } });
  else if (message.method === 'turn/start') {
    const turnId = `turn-${++turns}`, threadId = message.params.threadId;
    send({ id: message.id, result: { turn: { id: turnId } } });
    send({ method: 'turn/started', params: { threadId, turn: { id: turnId } } });
    send({ method: 'item/completed', params: { threadId, item: { type: 'userMessage', content: message.params.input } } });
    const router = specs.get(threadId)?.some(tool => tool.name === 'route_request');
    const candidate = router ? JSON.parse(message.params.input[0].text) : undefined;
    pending = { turnId, threadId };
    send({ id: 'tool-request', method: 'item/tool/call', params: { threadId, turnId, callId: 'call',
      tool: router ? 'route_request' : 'orchestrator_report', arguments: router
        ? { kind: 'accept', triggerId: candidate.triggers[0].id, title: 'Test task', scope: 'Local test', reason: 'Requested' }
        : { state: 'ready', summary: 'Done' } } });
  } else if (message.id === 'tool-request' && pending) {
    send({ method: 'turn/completed', params: { threadId: pending.threadId, turn: { id: pending.turnId, status: 'completed' } } });
    pending = undefined;
  } else if (message.id !== undefined) send({ id: message.id, result: {} });
});
