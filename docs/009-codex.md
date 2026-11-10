# Codex CLI and DingTalk

This entry boots the existing `src/app/runtime.ts`. It uses the original Store, Engine, Policy, Effects, DshExecutor, MasterAssessor, Sessions, prompts, role tools, report relays and Outbox. The Codex host adapter replaces session transport and host events. DingTalk is a Source kind. There is no second orchestration implementation.

Worker reports still go through `orchestrator_report → reportRelay → main Session`. The main Session decides whether to continue, ask for human action, answer a question or deliver a result through `orchestrator_reply`. Ordinary progress stays internal. A blocked/failed report without a question still reaches the main Session.

Optional DingTalk AI receipt and native reply cards display a waiting receipt before model processing and provide a reply button/input on every feedback card. See `cards/README.md`, publish the supplied [template](../cards/dingtalk-superagent.json), and set `DINGTALK_CARD_TEMPLATE_ID` to enable this mode; text mode remains the default.

## Install and start

Requires Node 22.19+, a Codex CLI with app-server dynamic tools, and the original GitHub setup: an authenticated `gh` executable with push access to the configured repository. The desktop application does not need to run. This preserves the original repository/account checks.

```sh
pnpm install --frozen-lockfile
npm run typecheck
npm test
npm run build
```

Set the installation variables **before the first start**; see [codex.example.env](../codex.example.env). Credentials may remain in the existing env file:

```sh
SUPERAGENT_REPOSITORY=/absolute/path/to/local/neug \
SUPERAGENT_GITHUB_REPOSITORY=alibaba/neug \
SUPERAGENT_STATE_DIR="$PWD/state-codex" \
CODEX_BINARY=/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex \
CODEX_MODEL=gpt-6.1-sol \
CODEX_SANDBOX=read-only \
node lib/codex-cli.js --env-file /absolute/path/to/dingtalk.env
```

The bundled CLI above was available on the test machine; another compatible Codex executable can be used. Stop any older listener for this same DingTalk robot before starting this entry.

Wait for `ready`, then @ the robot with a small read-only request. Acceptance is an acknowledgement; the original main Session delivers a subsequent ready result or necessary human action. Ctrl+C stops the service. `CODEX_SANDBOX=workspace-write` enables Worker file changes in its ticket worktree. Both sandboxes permit network access so the existing GitHub workflow can run; read-only applies to Worker file operations, while the service still persists state, prepares worktrees and sends messages.

To explicitly run main and Worker session commands directly on the host, set `CODEX_SANDBOX=danger-full-access` and restart the service after rebuilding. This disables their filesystem/network sandbox and uses `approvalPolicy=never`; commands run with the service user's host permissions, including access to its existing CLI credentials. The admission router remains read-only. Existing persisted Codex threads receive the selected mode when resumed; no state deletion is required.

## Start on another computer

1. Install the required Node.js/pnpm versions, Git, an authenticated GitHub CLI with push access, and a compatible authenticated Codex CLI. Clone this adapted repository and the target repository onto the new computer.
2. In this adapted repository, run `pnpm install --frozen-lockfile` and `npm run build`. Copy `codex.example.env` to `.env` (ignored by Git), then fill in the DingTalk application credentials and the new computer's absolute repository, state and Codex executable paths. Set `CODEX_SANDBOX=danger-full-access` for the explicitly selected host-execution mode, or choose a sandbox as described above.
3. Stop the old service before connecting the same DingTalk robot on the new computer. Start with `npm run start:codex -- --env-file .env`, wait for `ready`, then mention the robot in its group.

These steps start a fresh installation. Runtime state, credentials, ticket worktrees and Codex conversation history are not included in Git. Continuing old tickets requires a separate coordinated migration of the state database, worktrees and Codex history, with their saved paths accounted for; copying just the database is insufficient. An existing state directory also retains its saved installation settings, including the old prepare command's repository path.

## Settings and state

For macOS CLI credentials stored in Keychain, keep the sandbox and use Codex's native execution rules for the intended commands. Install [codex-readonly.rules](../codex-readonly.rules) as `~/.codex/rules/superagent-readonly.rules` and restart the service. It permits only `gh pr list/view/checks` to run with host permissions; it neither copies tokens nor changes login state. Every subsequent Worker inherits the same native rules. Other tools can use the same operator-managed rule mechanism; they do not require separate credential-injection code. The adapter uses `on-request` with user review, and declines unresolved approval prompts in headless mode instead of auto-granting them. Model subagents remain disabled.

An authentication failure inside a sandbox does not prove the host login expired. Test the configured native command rule before asking the user to log in again. `workspace-write` alone does not grant macOS Keychain access.

The first start seeds the original Settings schema: GitHub repository/CLI, the prepare command creating a ticket worktree, and DingTalk admission row `group.unlistedAddressed=explicit`. This allows every received group mention without a user/group whitelist. Later starts keep the original settings history; installation settings are managed through the original settings API, rather than overwritten from environment variables.

The original loopback management API is served at `http://127.0.0.1:3082/orchestrator/api/`; `SUPERAGENT_PORT` changes the port. Its original same-origin/header checks remain. This does not provide the DSH desktop/web UI shell.

The database is `state-codex/orchestrator.sqlite`. Codex thread IDs, durable inboxes and session events use that Store's KV, while ticket/assignment/outbox data use the original tables. Earlier experimental `standalone/state` data and worktrees are retained on disk but are not imported or executed by this entry. Reissue an old experimental request as a new request after switching.

## First-version boundaries

- Only group @ messages enter the Source; private messages and ordinary group messages remain outside scope. All message types are admitted: plain text, rich text, image, audio, video, file and unknown types. Rich text is projected in its original order, and supplied audio transcription/file names are retained. Binary attachments currently produce explicit unparsed-content markers; their native body/references are retained in Source KV, but are not automatically downloaded or interpreted.
- In text mode, follow up with `@robot #<12-character-ticket-id> ...`. In AI card mode, **回复** prepares a real robot mention and task reference in the group input; add text and send normally. Native input support must be verified in the real client as described in `cards/README.md`. References associate only within their originating group. Native quoted-message association is not implemented.
- No subagents: Codex multi-agent features are disabled, and no subagent service/tools are exposed.
- Built-in Codex coding tools use the configured sandbox. Original orchestrator tools keep their original schemas and handlers.
- Native command events feed the original worker-slot/background-work tracking. Codex's terminal cleanup API operates on a whole thread, so stopping one native background job cleans that thread's background terminals together.
- The DingTalk session webhook is used while valid; after expiry, replies use the application group-send API, which requires the robot's group-message send permission.
- DingTalk has no guaranteed exactly-once send transaction with SQLite: a crash after the platform accepts a reply but before its receipt commits can duplicate that reply.

For a real-model smoke test without sending a DingTalk message or touching a repository:

```sh
CODEX_SMOKE_BINARY=/path/to/codex CODEX_MODEL=gpt-6.1-sol \
  node_modules/.bin/vitest run tests/codex-harness.spec.ts -t 'real read-only'
```

This uses an isolated temporary Runtime, mocks only account setup and the outgoing DingTalk channel, and exercises the real Worker report, main Session and reply tools.

To verify host GitHub authentication through native rules in two fresh read-only Worker sessions (no robot messages or repository changes), set `CODEX_GH_SMOKE_BINARY=/path/to/codex` and run `node_modules/.bin/vitest run tests/codex-rpc.spec.ts -t 'two fresh'`. This test verifies actual command events and exit codes, not an assistant's claim of success.
