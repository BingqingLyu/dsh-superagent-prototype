/** Private gh wrapper entry. Never print credential-bearing exceptions or fall back to a personal login. */
import { spawn } from 'node:child_process'
import { installationToken, type AppCommand } from './github-app.ts'

async function main() {
  const config = JSON.parse(process.argv[2]!) as AppCommand
  const args = process.argv.slice(3)
  const { token } = await installationToken(config)
  const child = spawn(config.cli, args, { stdio: 'inherit', env: { ...process.env, GH_TOKEN: token,
    GITHUB_TOKEN: undefined, GH_PROMPT_DISABLED: '1' } })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { child.kill(signal) })
  child.once('error', () => { console.error('Unable to run the configured GitHub CLI'); process.exitCode = 1 })
  child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0) })
}
void main().catch(() => { console.error('GitHub App authentication failed; check installation credentials and permissions.'); process.exitCode = 1 })
