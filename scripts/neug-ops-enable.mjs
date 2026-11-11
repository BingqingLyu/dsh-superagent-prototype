#!/usr/bin/env node
// One-shot upgrade: enable neug CI monitoring + release automation on an EXISTING installation through the loopback
// management API. The codex-cli first-start seed only applies to a fresh state directory; this mirrors it for a running
// service. Same-origin/header checks are the panel's own (x-orchestrator-request: 1). See docs/009-codex.md.
//
//   node scripts/neug-ops-enable.mjs [--url http://127.0.0.1:3082] [--report-conversation <conversationId>]
//
// --url defaults to DSH_SUPERAGENT_URL or http://127.0.0.1:3082; --report-conversation defaults to
// DINGTALK_REPORT_CONVERSATION_ID. Re-running is safe: every block is merged, not replaced. Restart the service afterwards
// so the GitHub polling loops pick up the new config.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback }
const base = option('--url', process.env.DSH_SUPERAGENT_URL || 'http://127.0.0.1:3082').replace(/\/+$/, '')
const reportConversationId = option('--report-conversation', process.env.DINGTALK_REPORT_CONVERSATION_ID || '')
const origin = new URL(base).origin

async function call(method, path, body) {
  const response = await fetch(`${base}/orchestrator/api/${path}`, {
    method, headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json', origin },
    ...body === undefined ? {} : { body: JSON.stringify(body) },
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`${method} ${path} failed (HTTP ${response.status}): ${data.error ?? response.statusText}`)
  return data
}

// Mirrors the ci-analysis rule seeded by src/codex-cli.ts; keep the two in step.
const CI_ANALYSIS_RULE = { id: 'ci-analysis', name: 'CI failure analysis', enabled: true,
  instruction: "Accept a GitHub CI failure event — a failed PR check, or a completed nightly.yml, release.yml or package.yml run whose conclusion is failure or cancelled — as an analysis-only ticket (work_kind analysis). Scope: read the failed run's logs with gh, locate the root cause (code or test defect, flake, environment/infra, or credentials/secrets), and report a concise conclusion with evidence, a suggested next step and links to the DingTalk report group. Do not modify code, open a PR, re-run or cancel any workflow, or publish anything. Ignore success or recovery events, and ignore a failure already covered by a live ticket on the same thread, such as a release ticket waiting on that run." }
const WATCH_WORKFLOWS = ['nightly.yml', 'release.yml', 'package.yml']

/** The body of a packaged team skill, parsed exactly as src/app/skill-files.ts does. */
function skillBody(dir) {
  const text = readFileSync(join(root, 'skills', dir, 'SKILL.md'), 'utf8').replaceAll('\r\n', '\n')
  const match = /^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---\n\n([\s\S]*)$/.exec(text)
  if (!match) throw new Error(`Invalid skill file: skills/${dir}/SKILL.md`)
  return match[3]
}

async function main() {
  const settings = await call('GET', 'settings')
  const github = settings.sources.find(source => source.id === 'github')
  const dingtalk = settings.sources.find(source => source.id === 'dingtalk')
  if (!github) throw new Error('The github Source is not installed; start the service once before upgrading.')

  await call('PUT', 'settings/source:github', { revision: github.revision,
    value: { enabled: github.value.enabled, config: { ...github.value.config, observeCi: true, observePrCi: true, watchWorkflows: WATCH_WORKFLOWS } } })
  console.log('github: observeCi, observePrCi and watchWorkflows (nightly/release/package) enabled')

  if (dingtalk && reportConversationId) {
    await call('PUT', 'settings/source:dingtalk', { revision: dingtalk.revision,
      value: { enabled: dingtalk.value.enabled, config: { ...dingtalk.value.config, reportConversationId } } })
    console.log('dingtalk: reportConversationId set (the bot must be in that group with group-send permission)')
  } else {
    console.warn('dingtalk: no --report-conversation / DINGTALK_REPORT_CONVERSATION_ID given; skipped the report group, so CI analysis results will not reach a group.')
  }

  const policy = settings.blocks.policy.value
  const githubPolicy = policy.sources?.github ?? {}
  const admission = { ...githubPolicy.admission, ci: { unlistedUnaddressed: 'inferred' }, prCi: { unlistedUnaddressed: 'inferred' }, runs: { unlistedUnaddressed: 'inferred' } }
  const rules = policy.rules.some(rule => rule.id === 'ci-analysis') ? policy.rules : [...policy.rules, CI_ANALYSIS_RULE]
  await call('PUT', 'settings/policy', { revision: settings.blocks.policy.revision,
    value: { ...policy, rules, sources: { ...policy.sources, github: { ...githubPolicy, admission } } } })
  console.log('policy: ci/prCi/runs admission rows admit CI failures as inferred; ci-analysis rule enabled')

  await call('PUT', 'settings/eval', { revision: settings.blocks.eval.revision, value: { ...settings.blocks.eval.value, mode: 'auto' } })
  console.log('eval: accept mode auto (inferred CI candidates may open tickets)')

  const prompts = await call('GET', 'prompts')
  const config = prompts.current.config
  const skills = { ...config.skills, 'neug-ci': skillBody('neug-ci'), 'neug-release': skillBody('neug-release') }
  await call('PUT', 'prompts', { baseRevision: prompts.current.revision, config: { ...config, skills } })
  console.log('prompts: neug-ci and neug-release team skills seeded')

  console.log('Done. Restart the service so the GitHub polling loops pick up the new configuration.')
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
