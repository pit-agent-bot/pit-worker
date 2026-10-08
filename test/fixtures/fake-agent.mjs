#!/usr/bin/env node
// Fake codex / claude / kimi / generic jsonl CLI ("cmd") for tests: emits recorded-style JSON event streams. The scenario comes from
// $HOME/pit-fake-scenario.json (HOME is on the child env allowlist); the fake records what it was given
// (args, env, stdin, cwd) under $HOME so tests can assert on it.
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const home = process.env.HOME
// Invoked through a tiny sh wrapper named codex / claude: `exec node fake-agent.mjs <kind> "$@"`.
const kind = ['claude', 'kimi', 'cmd'].includes(process.argv[2]) ? process.argv[2] : 'codex'
const args = process.argv.slice(3)
const sc = JSON.parse(readFileSync(join(home, 'pit-fake-scenario.json'), 'utf8'))
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')

if (args[0] === '--version') {
  console.log(kind === 'codex' ? 'codex-cli 9.9.9' : kind === 'claude' ? '9.9.9 (Claude Code)' : kind === 'kimi' ? '2.1.1' : 'cmd 1.0')
  process.exit(0)
}
if (args.includes('--help')) {
  console.log(sc.help ?? (kind === 'codex' ? '--json --sandbox --skip-git-repo-check --ignore-user-config --ignore-rules --ephemeral' : kind === 'kimi' ? '-p, --prompt <prompt> --output-format <format> -m, --model <model> -y, --yolo' : '--output-format --permission-mode --strict-mcp-config --setting-sources --tools --allowedTools --disallowedTools --append-system-prompt --no-session-persistence'))
  process.exit(0)
}
if (kind === 'codex' && args[0] === 'login' && args[1] === 'status') {
  console.log(sc.loggedIn === false ? 'Not logged in' : 'Logged in using ChatGPT')
  process.exit(sc.loggedIn === false ? 1 : 0)
}
if (kind === 'claude' && args[0] === 'auth' && args[1] === 'status') {
  console.log(JSON.stringify({ loggedIn: sc.loggedIn !== false, authMethod: sc.loggedIn === false ? 'none' : 'claude.ai' }))
  process.exit(sc.loggedIn === false ? 1 : 0)
}

let stdin = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => (stdin += d))
process.stdin.on('end', main)

function main() {
  const calls = Number(readSafe(join(home, 'fake-calls.txt')) || 0) + 1
  writeFileSync(join(home, 'fake-calls.txt'), String(calls))
  writeFileSync(join(home, `fake-args-${calls}.json`), JSON.stringify(args))
  writeFileSync(join(home, `fake-env-${calls}.json`), JSON.stringify(process.env))
  writeFileSync(join(home, `fake-stdin-${calls}.txt`), stdin)
  writeFileSync(join(home, `fake-cwd-${calls}.txt`), process.cwd())
  const task = readSafe(join(process.cwd(), 'PIT_TASK.md'))
  if (task) writeFileSync(join(home, `fake-task-${calls}.txt`), task)
  const step = Array.isArray(sc.steps) ? sc.steps[Math.min(calls, sc.steps.length) - 1] : sc
  for (const [p, c] of Object.entries(step.writeFiles ?? {})) {
    mkdirSync(dirname(join(process.cwd(), p)), { recursive: true })
    writeFileSync(join(process.cwd(), p), c)
  }
  const mode = step.mode ?? 'success'
  if (mode === 'hang' || mode === 'hang-stubborn') {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    writeFileSync(join(home, 'grandchild.pid'), String(child.pid))
    if (mode === 'hang-stubborn') process.on('SIGTERM', () => {})
    if (kind === 'codex') out({ type: 'thread.started', thread_id: 't-hang' })
    setInterval(() => {}, 1000)
    return
  }
  if (kind === 'codex') codex(mode, step)
  else if (kind === 'claude') claude(mode, step)
  else if (kind === 'kimi') kimi(mode, step)
  else cmd(mode, step)
}

function readSafe(p) {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

function codex(mode, step) {
  out({ type: 'thread.started', thread_id: 'thread-123' })
  out({ type: 'turn.started' })
  if (mode === 'success') {
    out({ type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: 'thinking' } })
    out({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: step.text ?? 'OK' } })
    out({ type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 1000, output_tokens: 50, reasoning_output_tokens: 20 } })
    process.exit(0)
  }
  const msg =
    mode === 'rate_limit'
      ? "You've hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits"
      : mode === 'auth'
        ? 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header'
        : mode === 'sandbox'
          ? 'bwrap: setting up uid map: Permission denied'
          : 'internal error: something broke'
  if (mode === 'crash') {
    process.stderr.write('thread main panicked\n')
    process.exit(101)
  }
  out({ type: 'error', message: msg })
  out({ type: 'turn.failed', error: { message: msg } })
  process.exit(1)
}

function claude(mode, step) {
  out({ type: 'system', subtype: 'init', session_id: 'sess-1', tools: ['Read'], model: step.model ?? 'claude-opus-5-5', permissionMode: 'acceptEdits' })
  if (mode === 'success' || mode === 'max_turns') {
    out({ type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: step.text ?? 'OK' }], usage: { input_tokens: 10, output_tokens: 5 } }, session_id: 'sess-1' })
    out({ type: 'result', subtype: mode === 'success' ? 'success' : 'error_max_turns', is_error: mode !== 'success', num_turns: 3, result: mode === 'success' ? (step.text ?? 'OK') : undefined, session_id: 'sess-1', usage: { input_tokens: 300, cache_creation_input_tokens: 100, cache_read_input_tokens: 5000, output_tokens: 80 }, modelUsage: { 'claude-opus-5-5': {} } })
    process.exit(0)
  }
  if (mode === 'crash') {
    process.stderr.write('TypeError: cannot read properties of undefined\n')
    process.exit(1)
  }
  const [error, text] =
    mode === 'rate_limit' ? ['rate_limit', "You've hit your limit \u00b7 resets 3pm"] : mode === 'auth' ? ['authentication_failed', 'Not logged in \u00b7 Please run /login'] : ['unknown', 'bwrap: setting up uid map: Permission denied']
  out({ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text }], usage: { input_tokens: 0, output_tokens: 0 } }, error, is_api_error_message: true, session_id: 'sess-1' })
  out({ type: 'result', subtype: 'success', is_error: true, num_turns: 1, result: text, session_id: 'sess-1', usage: { input_tokens: 0, output_tokens: 0 } })
  process.exit(1)
}

const KIMI_ERR = {
  rate_limit: 'error: failed to run prompt: 429 Too Many Requests: rate limit reached',
  auth: 'error: failed to run prompt: No model configured. Run `kimi` and use /login to sign in, then retry; or set default_model in config.toml.',
  model: 'error: failed to run prompt: model kimi-nope not found',
  crash: 'error: something broke',
}

function kimi(mode, step) {
  if (mode === 'success' || mode === 'empty') {
    process.stdout.write(mode === 'empty' ? '\n' : `${step.text ?? 'OK'}\n`)
    process.exit(0)
  }
  process.stderr.write(`${KIMI_ERR[mode] ?? KIMI_ERR.crash}\nSee log: /tmp/kimi.log\n`)
  process.exit(1)
}

function cmd(mode, step) {
  out({ type: 'start', session_id: 'cmd-sess' })
  if (mode === 'success') {
    out({ type: 'result', result: step.text ?? 'OK', model: step.model ?? 'qwen3.6-plus', usage: { input_tokens: 70, output_tokens: 7 } })
    process.exit(0)
  }
  out({ type: 'error', error: { message: KIMI_ERR[mode] ?? 'boom' } })
  process.exit(2)
}
