---
name: neug-release
description: Execute the alibaba/neug release runbook end-to-end from a DingTalk group request, with a mandatory human confirmation before creating the public Release.
---

Execute the alibaba/neug release runbook end-to-end when a person asks in the DingTalk group to release a version. This is an explicit ticket: carry the request through bump, freeze branch, dry-run, a human confirmation gate, the public Release, watching the release run, and post-publish verification, reporting to the group throughout. The repository's `RELEASE.md` is the authoritative runbook; read it (and `AGENTS.md`) before acting and follow its commands and platform strings. This skill is the agent execution version of it.

## Authority and safety

You may bump the version, push a freeze branch, dispatch the dry-run, create the public Release **only after the group confirms**, and analyze runs. Hard rules:

- Never create or publish a GitHub Release before the human confirmation gate below is answered with an explicit confirm.
- Create the Release in one step (`gh release create`), never draft-then-publish.
- Never re-run a workflow/job, re-publish, or re-upload artifacts without a human's explicit confirmation; propose it as an option and wait.
- The repository is `$DSH_SUPERAGENT_GITHUB_REPOSITORY` (alibaba/neug); pass `--repo "$DSH_SUPERAGENT_GITHUB_REPOSITORY"` to every gh command. gh is signed in as `$DSH_SUPERAGENT_GITHUB_ACCOUNT`, which must have push and release permission. Use `make` targets for version operations; do not hand-edit version strings.

## Waiting for a long run (subscription, not polling)

A full build takes about 2h40m plus queueing, far beyond a background job's limit. Do **not** run `gh run watch` as a background job and do **not** poll. Instead:

1. Record the run id you dispatched (find it with `gh run list --repo "$DSH_SUPERAGENT_GITHUB_REPOSITORY" --workflow <file> --limit 5` right after dispatch, matching your ref/event).
2. Call `orchestrator_thread_follow` with `thread: github:run:<file>` (for example `github:run:package.yml`) and a one-sentence reason.
3. Call `orchestrator_report` with `state: progress` saying which run you are waiting for, then **end your turn**.

The run-completion trigger wakes you. Its text is self-contained: workflow, run id, conclusion, trigger event, branch, sha, failed job names and run URL. Match it by the run id you recorded; the same thread also carries cron runs and other people's dispatches, so ignore runs that are not yours. A dry-run you dispatch has event `workflow_dispatch`; the package run embedded in a release has a different event, so you can tell them apart. If a wake concerns another run, end the turn again without acting.

## Step 1 — Pre-check

Confirm the target version `X.Y.Z` and the commit to release (default: latest `origin/main`). Run `make version-check` to see whether the version is already bumped and consistent. Confirm the remote has no tag of the same name: `git ls-remote --tags origin | grep vX.Y.Z` (expect empty). Fetch and inspect `origin/main` so the freeze branch starts from the intended commit. If the request is ambiguous about the version or commit, ask via the confirmation gate rather than guessing.

## Step 2 — Bump and freeze branch

If `make version-check` shows the version is not yet bumped, run `make bump-version VER=X.Y.Z` (it syncs the managed files and scans for leftover version strings; never blind-replace). Cut the freeze branch from the target commit on `origin/main` and push it:

```
git fetch origin
git checkout -b release-vX.Y.Z origin/main
make bump-version VER=X.Y.Z
git commit -am "release: bump version to X.Y.Z"
git push origin release-vX.Y.Z
```

If the version was already bumped on the target commit, just cut and push `release-vX.Y.Z` from it. Record the freeze branch's commit sha; the dry-run and the Release both target this exact sha. Build-image tags are decoupled from the release version — do not bump them.

## Step 3 — Dry-run (package.yml) and wait

Dispatch the full-platform dry-run from the freeze branch, then subscribe and end the turn as described above:

```
gh workflow run package.yml --repo "$DSH_SUPERAGENT_GITHUB_REPOSITORY" --ref release-vX.Y.Z -f platforms=all -f python_versions=all
```

Record the run id, follow `github:run:package.yml`, report progress, end the turn. package.yml builds all platforms, runs verify-artifacts smoke, and a `complete` gate asserts everything green. When woken: if the run failed, go to "Failure handling" (do not proceed to release). If it succeeded, continue to step 4 on the same commit.

## Step 4 — Release notes and the confirmation gate

Draft bilingual (Chinese + English) release notes from `git log` since the previous tag, covering features, fixes and CI changes, with the release date. Save them to the gitignored `build/release-notes-vX.Y.Z-draft.md`.

Then stop and ask the group to confirm. Call `orchestrator_report` with `state: progress` and a `human_action` question (at most 1000 characters) that states: the version `vX.Y.Z`, the target commit sha, a short summary of the notes, and an explicit request to reply **confirm** or **cancel**. The orchestrator delivers this as an attention message to the DingTalk group, labelled with the ticket number. End your turn and wait.

The human confirms by replying in the group, @mentioning the bot and including the ticket number (`#<id>`) shown in the question, with confirm or cancel. That reply reaches you as an input on this ticket. Only an explicit confirm from the group authorizes step 5. On cancel, report `dropped` (or `blocked` if something must be undone) and do not create the Release. If the reply is ambiguous, ask again; never treat silence or ordinary discussion as confirmation.

## Step 5 — Create the public Release and wait

After an explicit confirm, create the Release in one step against the frozen commit, using the notes file:

```
gh release create vX.Y.Z --repo "$DSH_SUPERAGENT_GITHUB_REPOSITORY" --target <frozen-commit-sha> --notes-file build/release-notes-vX.Y.Z-draft.md
```

This fires `release: published`, which runs release.yml (ci-plan → resolve-reuse → package → publish_wheel/npm/extension/java → verify_published → report). Record the release run id (`gh run list --repo "$DSH_SUPERAGENT_GITHUB_REPOSITORY" --workflow release.yml --limit 3`), follow `github:run:release.yml`, report progress, and end the turn. Do not create a draft first.

## Step 6 — Release run outcome

When woken by the release run completion:

- **Failed** — go to "Failure handling". Identify the failed job (package / publish_wheel / publish_npm / publish_extension / publish_java / verify_published), read its logs, and report the root cause and recovery options to the group. Any re-run or re-publish needs a fresh human confirmation; never do it unprompted.
- **Succeeded** — spot-check the registries per RELEASE.md §6: PyPI wheel platform tags and version, npm main package plus the five platform sub-packages, and OSS extension HEAD probes per platform/extension (platform strings must match `getPlatform()`: `osx_arm64`, `win_x86_64`, `win_arm64`). `verify_published` already ran as a release.yml job; confirm its result. Then call `orchestrator_report` with `state: ready` and a concise group result: the released version, the registries verified, any caveat, and the Release/run links.

## Failure handling (any run)

Use the neug-ci skill's log commands: `gh run view <run-id> --repo "$DSH_SUPERAGENT_GITHUB_REPOSITORY" --log-failed` and `gh api repos/$DSH_SUPERAGENT_GITHUB_REPOSITORY/actions/runs/<run-id>/jobs --paginate`. Classify the failure (code/test, flake, environment/infra, credentials/secrets) and report to the group via `orchestrator_report`: the failed job, the root cause with decisive evidence, and concrete recovery options (for example re-run failed jobs within the 7-day artifact retention, rotate a disabled OSS AccessKey, fix a GPG signing step). Propose options; wait for a human to choose before any re-run, re-publish or re-upload. Keep every group message under the DingTalk 4000-character limit and prefer a short report with links. The orchestrator owns IM delivery; do not send a second message yourself.