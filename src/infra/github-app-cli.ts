/** Private gh wrapper entry. Never print credential-bearing exceptions or fall back to a personal login. */
import { spawn } from 'node:child_process'
import { commandRepository, credentialRepository, installationToken, type AppCommand } from './github-app.ts'

async function main() {
  const config = JSON.parse(process.argv[2]!) as AppCommand
  const args = process.argv.slice(3)
  if (args[0] === 'auth' && args[1] === 'git-credential') {
    if (args[2] === 'store' || args[2] === 'erase') return
    if (args[2] !== 'get') throw new Error('Unsupported Git credential operation')
    let input = ''
    for await (const chunk of process.stdin) { input += chunk; if (input.length > 65536) throw new Error('Invalid Git credential request') }
    const repository = credentialRepository(config, input)
    const { token } = await installationToken({ ...config, repository })
    process.stdout.write(`username=x-access-token\npassword=${token}\n\n`)
    return
  }
  const repository = await commandRepository(config, args)
  const { token } = await installationToken({ ...config, repository })
  const child = spawn(config.cli, args, { stdio: 'inherit', env: { ...process.env, GH_TOKEN: token,
    GITHUB_TOKEN: undefined, GH_REPO: repository, GH_PROMPT_DISABLED: '1' } })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { child.kill(signal) })
  child.once('error', () => { console.error('Unable to run the configured GitHub CLI'); process.exitCode = 1 })
  child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0) })
}
void main().catch(() => { console.error('GitHub App authentication failed; check installation credentials and permissions.'); process.exitCode = 1 })
