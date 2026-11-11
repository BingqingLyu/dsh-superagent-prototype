---
name: neug-ci
description: Diagnose alibaba/neug CI failures read-only and report root cause, evidence and a suggested next step to the DingTalk group.
---

Diagnose alibaba/neug CI failures read-only and report the root cause, evidence and a suggested next step to the DingTalk group. This skill is for analysis-only tickets opened by the `ci-analysis` rule on a CI failure event (a PR's checks, or a completed `nightly.yml` / `package.yml` / `release.yml` run). The deliverable is a group report, not a code change.

## Authority (read-only)

This ticket authorizes diagnosis and a group report only. Do not edit code, do not commit, push or open a PR, do not re-run or cancel any workflow or job, do not create or edit a Release, and do not change repository settings or secrets. Report `pr_number: null`. If the evidence shows a fix is needed, describe it as a suggestion for a human; never apply it here. Read repository `AGENTS.md` and `RELEASE.md` for context when useful.

## CI map

The repository is `$DSH_SUPERAGENT_GITHUB_REPOSITORY` (alibaba/neug). Pass `--repo "$DSH_SUPERAGENT_GITHUB_REPOSITORY"` to every gh command.

- **PR CI** — workflows triggered by `pull_request` to `main`: NeuG Test (Linux / OSX / Windows), Lite, format-check, and PR Completeness Check. They run on path-filtered changes; a PR's checks are the set of these that fired. `ci-plan.yml` is a reusable `workflow_call` that selects platforms/Python versions for the scheduled and release pipelines, not a PR check itself.
- **nightly.yml** (`nightly-test`) — cron `0 14 * * 0,2-6` (22:00 CST Tuesday–Sunday; Monday is covered by package.yml), plus `workflow_dispatch`. Calls ci-plan, then builds and tests Linux/OSX/Windows. Not a release.
- **package.yml** (`package`) — cron `0 14 * * 1` (Monday 22:00 CST), `workflow_dispatch` (the release dry-run), and `workflow_call` (invoked by release.yml). Builds all platforms (wheel / npm / extension / java), uploads Actions artifacts (7-day retention), calls verify-artifacts.yml for pre-publish smoke, and a `complete` job hard-asserts everything is green.
- **release.yml** (`Release`) — `release: published` only. Jobs: ci-plan → resolve-reuse → package → publish_wheel (PyPI) / publish_npm (npm) / publish_extension (OSS) / publish_java (Maven) → verify_published → report. A failure in `package` (including java) skips the publish jobs.

## Reading the failure

A workflow-run trigger is self-contained: its text names the workflow, run id, conclusion, trigger event, branch, sha, the failed job names and the run URL. A run thread has no Issue/PR conversation, so rely on the trigger text plus gh; do not expect orchestrator_read thread context for it. A PR-check trigger names the PR number; read that PR's checks.

```
gh run view <run-id> --repo "$DSH_SUPERAGENT_GITHUB_REPOSITORY" --log-failed
gh api repos/$DSH_SUPERAGENT_GITHUB_REPOSITORY/actions/runs/<run-id>/jobs --paginate
gh run list --repo "$DSH_SUPERAGENT_GITHUB_REPOSITORY" --workflow <file> --limit 5
gh pr checks <number> --repo "$DSH_SUPERAGENT_GITHUB_REPOSITORY"
```

`--log-failed` prints only the failed steps, which is usually enough; fetch a full job log only when the failed step is ambiguous. The jobs API gives each job's name and conclusion, so you can name exactly which leg failed. For a PR check, find its run id from the check details, then read that run's failed logs. Logs can be huge: never paste a whole log into the report; quote the few decisive lines. Use bounded retries for transient gh/network errors and report a concrete limitation if a log cannot be accessed.

## Failure classification

Decide the most likely category from the evidence, and say how confident you are:

- **Code / test defect** — a compile error or assertion failure tied to the change. Name the file, test and the probable cause; check whether the same leg fails on recent main/nightly runs (pre-existing) or only on this PR (introduced).
- **Flake** — intermittent, timing/network/order-dependent, or passes on a prior run of the same commit. Cite the evidence of instability rather than asserting a code bug.
- **Environment / infra** — runner offline or disk full, image pull failure, dependency download timeout, OOM, self-hosted `daily` runner unavailable. Name the infra signal.
- **Credentials / secrets** — 403/401, expired token, OSS AccessKey disabled, `gpg: no secret key`, npm auth/provenance. Name the secret or permission at fault (for example OSS_ACCESS_KEY_ID, GPG_PRIVATE_KEY, NPM_TOKEN).

Distinguish a failure introduced by the change from one already present on main by comparing recent runs of the same workflow.

## Group report

Put the whole group-facing report in `orchestrator_report` with `state: ready` and `pr_number: null`; the orchestrator delivers it to the DingTalk report group. Keep it concise and self-contained:

1. One-line conclusion: which workflow/PR, which job failed, and the root-cause category.
2. Two to four evidence bullets: the decisive log lines, file/test names, or the comparison with main.
3. A suggested next step for a human (for example "re-run the failed macOS leg", "rotate the OSS AccessKey", "fix the assertion in tests/x"), explicitly not done by this ticket.
4. Links: the run URL and, for a PR, the PR URL.

The DingTalk transport rejects messages over 4000 characters; stay well under it and prefer a short report with links over a long dump. Do not send a second IM message yourself and do not re-run anything. If the failure is already covered by another live ticket on the same thread, admission ignores the candidate, so you normally will not see it.