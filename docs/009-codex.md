# Codex CLI and DingTalk

This entry boots the existing `src/app/runtime.ts`. It uses the original Store, Engine, Policy, Effects, DshExecutor, MasterAssessor, Sessions, prompts, role tools, report relays and Outbox. The Codex host adapter replaces session transport and host events. DingTalk is a Source kind. There is no second orchestration implementation.

Worker reports still go through `orchestrator_report → reportRelay → main Session`. The main Session decides whether to continue, ask for human action, answer a question or deliver a result through `orchestrator_reply`. Ordinary progress stays internal. A blocked/failed report without a question still reaches the main Session.

The entry also starts the existing GitHub polling loop after DingTalk connects and stops it on shutdown. Polling uses the original cursors, deduplication and policy gates; unchanged polls do not invoke the model. The GitHub Source settings control the interval (60 seconds by default) and repository observation switches; starting polling does not enable those switches or add group broadcasts.

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
DINGTALK_REPORT_CONVERSATION_ID=<report-group-conversationId> \
CODEX_BINARY=/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex \
CODEX_MODEL=gpt-6.1-sol \
CODEX_SANDBOX=read-only \
node lib/codex-cli.js --env-file /absolute/path/to/dingtalk.env
```

`DINGTALK_REPORT_CONVERSATION_ID` is optional: it names the DingTalk group where CI analysis results are sent. The robot must already be in that group with the "send group messages" permission. `DINGTALK_ROBOT_CODE` optionally overrides the robotCode used for the report group (defaults to `DINGTALK_CLIENT_ID`).

The bundled CLI above was available on the test machine; another compatible Codex executable can be used. Stop any older listener for this same DingTalk robot before starting this entry.

Wait for `ready`, then @ the robot with a small read-only request. Acceptance is an acknowledgement; the original main Session delivers a subsequent ready result or necessary human action. Ctrl+C stops the service. `CODEX_SANDBOX=workspace-write` enables Worker file changes in its ticket worktree. Both sandboxes permit network access so the existing GitHub workflow can run; read-only applies to Worker file operations, while the service still persists state, prepares worktrees and sends messages.

To explicitly run main and Worker session commands directly on the host, set `CODEX_SANDBOX=danger-full-access` and restart the service after rebuilding. This disables their filesystem/network sandbox and uses `approvalPolicy=never`; commands run with the service user's host permissions, including access to its existing CLI credentials. The admission router remains read-only. Existing persisted Codex threads receive the selected mode when resumed; no state deletion is required.

## Start on another computer

1. Install the required Node.js/pnpm versions, Git, an authenticated GitHub CLI with push access, and a compatible authenticated Codex CLI. Clone this adapted repository and the target repository onto the new computer.
2. In this adapted repository, run `pnpm install --frozen-lockfile` and `npm run build`. Copy `codex.example.env` to `.env` (ignored by Git), then fill in the DingTalk application credentials and the new computer's absolute repository, state and Codex executable paths. Set `CODEX_SANDBOX=danger-full-access` for the explicitly selected host-execution mode, or choose a sandbox as described above.
3. Stop the old service before connecting the same DingTalk robot on the new computer. Start with `npm run start:codex -- --env-file .env`, wait for `ready`, then mention the robot in its group.

These steps start a fresh installation. Runtime state, credentials, ticket worktrees and Codex conversation history are not included in Git. Continuing old tickets requires a separate coordinated migration of the state database, worktrees and Codex history, with their saved paths accounted for; copying just the database is insufficient. An existing state directory also retains its saved installation settings, including the old prepare command's repository path.

## Settings and state

### GitHub App identity

Install the same GitHub App on the upstream and your fork. The watched upstream needs Contents read and Pull requests/Issues write permissions; a fork used for code pushes needs Contents write. Grant Checks and Actions read permissions for CI inspection. Metadata read access is implicit. Download an App private key onto the service machine; keep the PEM file outside the checkout and restrict its file permissions to the service user.

For a new state directory, set `SUPERAGENT_GITHUB_AUTH=app`, `SUPERAGENT_GITHUB_APP_ID`, `SUPERAGENT_GITHUB_PRIVATE_KEY_PATH` and `SUPERAGENT_GITHUB_INSTALLATIONS` before the first start. The last variable is a JSON array of repository-to-installation mappings as shown below. `SUPERAGENT_GITHUB_CLI` still names the real `gh` executable. Both installations use the same `neug-agent[bot]` identity, with different repository access tokens. The old `SUPERAGENT_GITHUB_INSTALLATION_ID` remains supported for a single watched repository; use either the single ID or mappings.

For an existing installation, environment variables do not replace saved Source settings. Read `GET /orchestrator/api/settings`, keep the current GitHub block's configuration and revision, then save it with `PUT /orchestrator/api/settings/source:github` and the `x-orchestrator-request: 1` header. Add this object to the existing `value.config`:

```json
{
  "app": {
    "appId": "123456",
    "installations": [
      { "repository": "alibaba/neug", "installationId": "12345678" },
      { "repository": "your-login/neug", "installationId": "87654321" }
    ],
    "privateKeyPath": "/absolute/path/to/neug-agent.pem"
  }
}
```

Keep `repository`, `cli` and observation settings in that configuration. The `cli` must remain the real GitHub CLI, not a generated `stateDir/github-app/.../gh-app` wrapper. Saving validates the App installation and requests a service restart. To return to personal authentication, remove `app` and save again.

The service validates every configured repository and installation. Tokens are cached separately per repository and installation and refreshed five minutes before expiry. Each invocation selects credentials using the REST repository path, `--repo`/`-R`, a repository URL, or an explicit GraphQL repository; otherwise it uses `GH_REPO`, the checkout's `origin`, then the watched repository when no origin exists. Use explicit targets for cross-fork work, for example `gh pr create --repo alibaba/neug --head your-login:branch` or `gh pr comment 123 --repo alibaba/neug`. One GraphQL request cannot span multiple repository targets; issue separate requests. Unknown repositories fail rather than falling back to another installation or personal login.

Git's credential helper uses the remote repository path (`credential.useHttpPath=true`) to choose the fork or upstream token. Push to your fork remote and create/comment on PRs against the upstream explicitly. The worker receives the authorized repository list as `DSH_SUPERAGENT_GITHUB_REPOSITORIES`; it still watches only the configured Source repository. An App-authored PR whose head is in an authorized fork can bind to the task when its branch matches the task name. Git commits retain the existing explicit author policy; authenticating pushes as an App does not rewrite commit authors.

App installations have no personal notification inbox. App mode polls repository Issue/PR and comment streams instead to discover mentions, and reads reviews on changed PRs and subscribed threads. Existing observation switches, policy gates, cursors and deduplication still apply; enabling App authentication does not enable proactive work or group broadcasts. Polling uses the original initial-baseline behavior rather than replaying repository history.

For macOS CLI credentials stored in Keychain, keep the sandbox and use Codex's native execution rules for the intended commands. Install [codex-readonly.rules](../codex-readonly.rules) as `~/.codex/rules/superagent-readonly.rules` and restart the service. It permits `gh pr list/view/checks`, `gh run list/view`, `gh workflow run/view/list` and `gh release create/view/list` to run with host permissions; it neither copies tokens nor changes login state. Every subsequent Worker inherits the same native rules. For release operations that need file writes (bump, freeze branch, notes), use `CODEX_SANDBOX=workspace-write` together with the same rule file. Other tools can use the same operator-managed rule mechanism; they do not require separate credential-injection code. The adapter uses `on-request` with user review, and declines unresolved approval prompts in headless mode instead of auto-granting them. Model subagents remain disabled.

An authentication failure inside a sandbox does not prove the host login expired. Test the configured native command rule before asking the user to log in again. `workspace-write` alone does not grant macOS Keychain access.

The first start seeds the original Settings schema: GitHub repository/CLI with CI monitoring enabled (`observeCi`, `observePrCi`, `watchWorkflows` for nightly/release/package), the prepare command creating a ticket worktree, DingTalk admission row `group.unlistedAddressed=explicit`, GitHub admission rows `ci/prCi/runs` set to `inferred`, the `ci-analysis` rule, accept mode `auto`, and the `neug-ci`/`neug-release` team skills. If `DINGTALK_REPORT_CONVERSATION_ID` is set, the DingTalk report group is seeded. This allows every received group mention without a user/group whitelist and admits CI failures as analysis-only tickets. Later starts keep the original settings history; installation settings are managed through the original settings API, rather than overwritten from environment variables.

The original loopback management API is served at `http://127.0.0.1:3082/orchestrator/api/`; `SUPERAGENT_PORT` changes the port. Its original same-origin/header checks remain. This does not provide the DSH desktop/web UI shell.

## Upgrading an existing installation

The first-start seed only applies to a fresh state directory. To enable CI monitoring and release automation on an already-running service, use the one-shot upgrade script:

```sh
node scripts/neug-ops-enable.mjs --report-conversation <conversationId>
```

`--url` defaults to `DSH_SUPERAGENT_URL` or `http://127.0.0.1:3082`; `--report-conversation` defaults to `DINGTALK_REPORT_CONVERSATION_ID`. The script merges each settings block through the loopback management API (GitHub config, DingTalk report group, policy admission rows and `ci-analysis` rule, eval mode `auto`, and the two team skills). Re-running is safe. Restart the service afterwards so the GitHub polling loops pick up the new configuration.

Alternatively, save each block manually through the panel or the API: `PUT settings/source:github` (add `observeCi`, `observePrCi`, `watchWorkflows`), `PUT settings/source:dingtalk` (add `reportConversationId`), `PUT settings/policy` (set `ci/prCi/runs` admission to `inferred`, append the `ci-analysis` rule), `PUT settings/eval` (mode `auto`), and `PUT prompts` (add the `neug-ci` and `neug-release` team skills). Each block carries its own revision; read `GET settings` first.

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
