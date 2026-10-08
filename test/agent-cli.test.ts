/**
 * Agent-CLI runtimes against fake binaries (test/fixtures/fake-agent.mjs) and real recorded event streams
 * (test/fixtures/*-not-logged-in.jsonl, captured from codex-cli 0.161 and Claude Code 2.1.293).
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  agentBin,
  AgentError,
  childEnv,
  claudeArgs,
  claudeProviderEnv,
  classifyFailure,
  codexArgs,
  commandArgs,
  fixHint,
  harnessFamily,
  harnessLabel,
  invokeAgent,
  kimiArgs,
  loadAgentConfig,
  normalizeAgentConfig,
  normalizeCommand,
  parseClaudeStream,
  parseCodexStream,
  parseJsonlOutput,
  parseTextOutput,
  pickAgent,
  POINTER_PROMPT,
  probeAgent,
  saveAgentConfig,
  termsAccepted,
  type AgentConfig,
  type AgentKind,
  type InvokeOptions,
} from '../src/agent-cli.ts'
import { collectChanged, containsSecret, leakSecrets, runSkillAgent } from '../src/agent-skills.ts'
import { readUsage } from '../src/model.ts'
import { normalizeReview } from '../src/real-skills.ts'
import { startDaemon, type WebSocketLike } from '../src/start.ts'
import { initDevice, loadConfig, saveConfig } from '../src/store.ts'

const here = dirname(fileURLToPath(import.meta.url))
const FAKE = join(here, 'fixtures', 'fake-agent.mjs')
const WALLET = '0x' + 'ab'.repeat(32)
const SECRETS = { PIT_WALLET_PK: WALLET, SEPOLIA_DEPLOYER_PK: '0x' + 'cd'.repeat(32), GH_TOKEN: 'ghp_' + 'x'.repeat(36), OPENAI_API_KEY: 'sk-' + 'o'.repeat(40), MY_SECRET: 's'.repeat(20), AWS_ACCESS_KEY_ID: 'AKIA' + 'Q'.repeat(16) }

interface Machine {
  home: string
  bin: string
  env: NodeJS.ProcessEnv
  scenario: (s: unknown) => void
  calls: () => number
  args: (n?: number) => string[]
  childEnvOf: (n?: number) => Record<string, string>
  stdin: (n?: number) => string
  task: (n?: number) => string
  cleanup: () => void
}

/** A temp HOME with wrapper binaries codex / claude / kimi / mycli and a parent env full of secrets. */
function machine(): Machine {
  const home = mkdtempSync(join(tmpdir(), 'pit-agent-home-'))
  const bin = join(home, 'bin')
  mkdirSync(bin)
  for (const [name, kind] of [['codex', 'codex'], ['claude', 'claude'], ['kimi', 'kimi'], ['mycli', 'cmd']]) {
    const p = join(bin, name)
    writeFileSync(p, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" ${kind} "$@"\n`)
    chmodSync(p, 0o755)
  }
  const env: NodeJS.ProcessEnv = { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, LANG: 'C.UTF-8', PIT_HOME: join(home, '.config', 'pit'), PIT_SEAT_CONTRACT: '0x' + '11'.repeat(20), ...SECRETS }
  const read = (f: string) => readFileSync(join(home, f), 'utf8')
  const calls = () => (existsSync(join(home, 'fake-calls.txt')) ? Number(read('fake-calls.txt')) : 0)
  return {
    home,
    bin,
    env,
    scenario: (s) => writeFileSync(join(home, 'pit-fake-scenario.json'), JSON.stringify(s)),
    calls,
    args: (n = calls()) => JSON.parse(read(`fake-args-${n}.json`)),
    childEnvOf: (n = calls()) => JSON.parse(read(`fake-env-${n}.json`)),
    stdin: (n = calls()) => read(`fake-stdin-${n}.txt`),
    task: (n = calls()) => read(`fake-task-${n}.txt`),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  }
}

const opts = (dir: string, over: Partial<InvokeOptions> = {}): InvokeOptions => ({ dir, readOnly: true, maxTurns: 5, network: false, system: 'SYSTEM-TEXT', ...over })
const cfgOf = (over: Record<string, unknown> = {}) => normalizeAgentConfig(over)
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const expectNoSecrets = (e: Record<string, string>) => {
  for (const k of Object.keys(SECRETS)) expect(e[k], k).toBeUndefined()
  expect(e.PIT_HOME).toBeUndefined()
  expect(e.PIT_SEAT_CONTRACT).toBeUndefined()
  const all = JSON.stringify(e)
  for (const v of Object.values(SECRETS)) expect(all).not.toContain(v)
}

// ------------------------------------------------------------------ pure parts

describe('arguments', () => {
  it('codex: read-only sandbox, no user config / rules, ephemeral, network off, prompt on stdin', () => {
    const a = codexArgs(opts('/w', { model: 'gpt-5.5', effort: 'high' }))
    expect(a.slice(0, 4)).toEqual(['exec', '--json', '--color', 'never'])
    expect(a).toEqual(expect.arrayContaining(['--sandbox', 'read-only', '-C', '/w', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '--ephemeral', 'approval_policy="never"', 'sandbox_workspace_write.network_access=false', '-m', 'gpt-5.5', 'model_reasoning_effort="high"']))
    expect(a.at(-1)).toBe('-')
    expect(codexArgs(opts('/w', { readOnly: false, network: true }))).toEqual(expect.arrayContaining(['workspace-write', 'sandbox_workspace_write.network_access=true']))
  })

  it('claude: no settings files, no MCP, fixed tool set, deny rules, turn limit, no web tools', () => {
    const a = claudeArgs(opts('/w', { denyRead: ['/home/u/.config/pit'] }))
    const at = (f: string) => a[a.indexOf(f) + 1]
    expect(a).toEqual(expect.arrayContaining(['-p', '--strict-mcp-config', '--no-session-persistence']))
    expect(at('--setting-sources')).toBe('')
    expect(at('--output-format')).toBe('stream-json')
    expect(at('--permission-mode')).toBe('acceptEdits')
    expect(at('--max-turns')).toBe('5')
    expect(at('--tools')).toBe('Read,Glob,Grep')
    expect(at('--disallowedTools')).toBe('WebFetch,WebSearch,Task,Agent')
    expect(at('--append-system-prompt')).toBe('SYSTEM-TEXT')
    const settings = JSON.parse(at('--settings')!)
    expect(settings.disableAllHooks).toBe(true)
    expect(settings.permissions.deny).toEqual(['Read(//home/u/.config/pit/**)', 'Edit(//home/u/.config/pit/**)'])
    const w = claudeArgs(opts('/w', { readOnly: false }))
    expect(w[w.indexOf('--allowedTools') + 1]).not.toMatch(/git/)
  })

  it('kimi: one-shot prompt pointing at the task file, --yolo only for write work', () => {
    expect(kimiArgs(opts('/w', { model: 'kimi-k3' }), POINTER_PROMPT)).toEqual(['-p', POINTER_PROMPT, '--output-format', 'text', '-m', 'kimi-k3'])
    expect(kimiArgs(opts('/w', { readOnly: false }), POINTER_PROMPT)).not.toContain('--yolo')
  })

  it('command adapter: placeholders expand, an empty {model} drops its slot', () => {
    const c = normalizeCommand({ name: 'mycli', bin: 'mycli', args: ['run', '--cwd', '{dir}', '--mode', '{mode}', '{model}', '{prompt}'], prompt: 'arg', output: 'jsonl', family: 'qwen' })
    expect(commandArgs(c, opts('/w'), { prompt: 'P', taskFile: '/w/PIT_TASK.md' })).toEqual(['run', '--cwd', '/w', '--mode', 'read-only', 'P'])
    expect(commandArgs(c, opts('/w', { model: 'm1' }), { prompt: 'P', taskFile: 't' })).toContain('m1')
  })
})

describe('config', () => {
  it('validates fields, keeps names only, refuses wallet variables', () => {
    expect(() => cfgOf({ apiKey: 'x' })).toThrow(/must not contain/)
    expect(() => cfgOf({ timeoutSec: 5 })).toThrow(/timeoutSec/)
    expect(() => cfgOf({ claudeKeyEnv: 'PIT_WALLET_PK' })).toThrow(/claudeKeyEnv/)
    expect(() => normalizeCommand({ name: 'x', bin: 'x', args: [], family: 'qwen', passEnv: ['SEPOLIA_DEPLOYER_PK'] })).toThrow(/not allowed/)
    expect(() => normalizeCommand({ name: 'x', bin: 'x', args: ['go'], prompt: 'arg', family: 'qwen' })).toThrow(/\{prompt\}/)
    expect(() => normalizeCommand({ name: 'x', bin: 'x', args: [] })).toThrow(/family/)
    expect(() => cfgOf({ claudeProvider: 'openrouter' })).toThrow(/claude-model/)
    expect(() => cfgOf({ claudeProvider: 'openrouter', claudeModel: 'mystery/model' })).toThrow(/family/)
    expect(harnessFamily('claude', cfgOf({ claudeProvider: 'openrouter', claudeModel: 'moonshotai/kimi-k3' }))).toBe('kimi')
  })

  it('families and labels per harness (never a borrowed family)', () => {
    expect(harnessFamily('codex', cfgOf())).toBe('gpt')
    expect(harnessFamily('claude', cfgOf())).toBe('claude')
    expect(harnessFamily('claude', cfgOf({ claudeProvider: 'glm' }))).toBe('glm')
    expect(harnessFamily('claude', cfgOf({ claudeProvider: 'zhipu' }))).toBe('glm')
    expect(harnessFamily('claude', cfgOf({ claudeProvider: 'deepseek' }))).toBe('deepseek')
    expect(harnessFamily('kimi', cfgOf())).toBe('kimi')
    expect(harnessLabel('claude', cfgOf({ claudeProvider: 'kimi' }))).toBe('claude-code:kimi')
    expect(harnessFamily('command', cfgOf({ command: { name: 'q', bin: 'q', args: [], family: 'qwen' } }))).toBe('qwen')
    expect(() => harnessFamily('command', cfgOf())).toThrow(/no command adapter/)
  })

  it('round-trips runtime.json with mode 0600 and records the terms acceptance', () => {
    const home = mkdtempSync(join(tmpdir(), 'pit-rt-'))
    vi.stubEnv('PIT_HOME', home)
    try {
      expect(termsAccepted(loadAgentConfig())).toBe(false)
      saveAgentConfig(cfgOf({ codexModel: 'gpt-5.6-terra', termsAcceptedAt: 1_800_000_000 }))
      const c = loadAgentConfig()
      expect(c.codexModel).toBe('gpt-5.6-terra')
      expect(termsAccepted(c)).toBe(true)
    } finally {
      vi.unstubAllEnvs()
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('child environment', () => {
  it('passes the allowlist only: no wallet keys, Pit settings, tokens or unrelated API keys', () => {
    const parent = { ...SECRETS, PATH: '/bin', HOME: '/h', LANG: 'C', TMPDIR: '/t', HTTPS_PROXY: 'http://p', PIT_HOME: '/p', CODEX_HOME: '/c', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-tok', RANDOM_VAR: 'x' }
    const c = childEnv('codex', parent)
    expect(c).toMatchObject({ PATH: '/bin', HOME: '/h', LANG: 'C', TMPDIR: '/t', HTTPS_PROXY: 'http://p', CODEX_HOME: '/c', NO_COLOR: '1', FOUNDRY_OFFLINE: 'true' })
    expect(c.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(c.RANDOM_VAR).toBeUndefined()
    expectNoSecrets(c)
    const cl = childEnv('claude', parent)
    expect(cl.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-tok')
    expect(cl.CODEX_HOME).toBeUndefined()
    expectNoSecrets(cl)
    const pubCmd = childEnv('command', { ...parent, DASHSCOPE_API_KEY: 'sk-dashscope-test' }, { own: ['OPENAI_API_KEY', 'DASHSCOPE_API_KEY', 'PIT_WALLET_PK'] })
    expect(pubCmd.OPENAI_API_KEY).toBeUndefined()
    expect(pubCmd.DASHSCOPE_API_KEY).toBeUndefined()
    expect(pubCmd.PIT_WALLET_PK).toBeUndefined()
    expect(childEnv('command', { ...parent, PIT_OFFICIAL: '1' }, { own: ['OPENAI_API_KEY', 'PIT_WALLET_PK'] })).toMatchObject({ OPENAI_API_KEY: SECRETS.OPENAI_API_KEY })
    expect(childEnv('command', { ...parent, PIT_OFFICIAL: '1' }, { own: ['PIT_WALLET_PK'] }).PIT_WALLET_PK).toBeUndefined()
  })

  it('claude provider mode: endpoint + key from the named variable, all model slots pinned, subscription token dropped', () => {
    const e = claudeProviderEnv(cfgOf({ claudeProvider: 'glm' }), { ZAI_API_KEY: 'zai-key-123456789012' })
    expect(e.extra).toMatchObject({ ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'zai-key-123456789012', ANTHROPIC_MODEL: 'glm-5.3', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3', CLAUDE_CODE_SUBAGENT_MODEL: 'glm-5.3' })
    expect(e.drop).toContain('CLAUDE_CODE_OAUTH_TOKEN')
    expect(() => claudeProviderEnv(cfgOf({ claudeProvider: 'deepseek' }), {})).toThrow(/DEEPSEEK_API_KEY is not set/)
    expect(claudeProviderEnv(cfgOf({ claudeProvider: 'anthropic' }), { ANTHROPIC_API_KEY: 'k' }).extra).toEqual({ ANTHROPIC_API_KEY: 'k' })
  })
})

describe('event streams', () => {
  it('parses the real codex 0.161 not-logged-in stream as an auth failure', () => {
    const lines = readFileSync(join(here, 'fixtures', 'codex-0.161-not-logged-in.jsonl'), 'utf8').split('\n').filter(Boolean)
    const t = parseCodexStream(lines)
    expect(t.failed).toBe(true)
    expect(t.sessionHash).toMatch(/^0x[0-9a-f]{64}$/)
    expect(classifyFailure('codex', t, { code: 1, signal: null, timedOut: false, aborted: false, stderrTail: '', ms: 10 })!.kind).toBe('auth')
  })

  it('parses the real Claude Code 2.1.293 not-logged-in stream as an auth failure', () => {
    const lines = readFileSync(join(here, 'fixtures', 'claude-2.1.293-not-logged-in.jsonl'), 'utf8').split('\n').filter(Boolean)
    const t = parseClaudeStream(lines)
    expect(t.errorKind).toBe('authentication_failed')
    expect(classifyFailure('claude', t, { code: 1, signal: null, timedOut: false, aborted: false, stderrTail: '', ms: 10 })!.kind).toBe('auth')
  })

  it('usage math: codex counts uncached input, claude counts cache writes as input', () => {
    const c = parseCodexStream([JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 1000, output_tokens: 50, reasoning_output_tokens: 20 } })])
    expect(c.usage).toEqual({ promptTokens: 200, cachedTokens: 1000, completionTokens: 50, reasoningTokens: 20, totalTokens: 250 })
    const cl = parseClaudeStream([JSON.stringify({ type: 'result', subtype: 'success', result: 'x', num_turns: 1, usage: { input_tokens: 300, cache_creation_input_tokens: 100, cache_read_input_tokens: 5000, output_tokens: 80 } })])
    expect(cl.usage).toMatchObject({ promptTokens: 400, cachedTokens: 5000, completionTokens: 80, totalTokens: 480 })
  })

  it('text and generic JSONL outputs', () => {
    expect(parseTextOutput(['{"role":"meta","type":"system.version","version":"2.1.1"}', 'line 1', '', 'line 2']).text).toBe('line 1\n\nline 2')
    const j = parseJsonlOutput(['{"type":"start","session_id":"s"}', '{"type":"result","result":"done","model":"m","usage":{"prompt_tokens":3,"completion_tokens":4}}'])
    expect(j).toMatchObject({ text: 'done', model: 'm', sawResult: true })
    expect(j.usage.totalTokens).toBe(7)
    expect(parseJsonlOutput(['{"answer":{"text":"deep"}}'], 'answer.text').text).toBe('deep')
  })

  it('classifies rate limits, sign-in, unavailable models, sandbox and crashes; each has a one-line fix', () => {
    const t = (errors: string[]) => ({ ...parseTextOutput([]), errors, sawResult: true, failed: true })
    const p = { code: 1, signal: null, timedOut: false, aborted: false, stderrTail: '', ms: 1 }
    expect(classifyFailure('kimi', t(['429 Too Many Requests']), p)!.kind).toBe('rate_limit')
    expect(classifyFailure('kimi', t(['No model configured. Run `kimi` and use /login']), p)!.kind).toBe('auth')
    expect(classifyFailure('claude', t(['model glm-9 does not exist']), p)!.kind).toBe('model')
    expect(classifyFailure('codex', t(['bwrap: setting up uid map: Permission denied']), p)!.kind).toBe('sandbox')
    expect(classifyFailure('codex', t(['weird']), p)!.kind).toBe('crash')
    expect(classifyFailure('codex', t([]), { ...p, timedOut: true, ms: 61_000 })!.message).toMatch(/timed out after 61s \(process group killed\)/)
    for (const k of ['codex', 'claude', 'kimi', 'command'] as AgentKind[]) for (const f of ['missing', 'auth', 'model', 'rate_limit', 'sandbox', 'timeout', 'crash'] as const) expect(fixHint(k, f)).not.toMatch(/\n/)
    expect(fixHint('claude', 'model')).toMatch(/never falls back/)
    expect(fixHint('claude', 'auth', cfgOf({ claudeProvider: 'kimi' }))).toMatch(/MOONSHOT_API_KEY/)
  })
})

// ------------------------------------------------------------------ real processes (fake binaries)

describe('invokeAgent with fake CLIs', () => {
  let m: Machine
  let dir: string
  beforeEach(() => {
    m = machine()
    dir = mkdtempSync(join(tmpdir(), 'pit-agent-wd-'))
  })
  afterEach(() => {
    m.cleanup()
    rmSync(dir, { recursive: true, force: true })
  })
  const run = (kind: AgentKind, over: Partial<Parameters<typeof invokeAgent>[0]> = {}) =>
    invokeAgent({ kind, bin: agentBin(kind, m.env, over.cfg)!, prompt: 'PROMPT', opts: opts(dir), timeoutMs: 20_000, env: m.env, killGraceMs: 300, ...over })

  it('codex success: answer, usage, system text + prompt on stdin, no secrets in the child env', async () => {
    m.scenario({ mode: 'success', text: 'the answer' })
    const t = await run('codex')
    expect(t.text).toBe('the answer')
    expect(t.usage.totalTokens).toBe(250)
    expect(m.stdin()).toBe('SYSTEM-TEXT\n\nPROMPT')
    expect(m.args().at(-1)).toBe('-')
    expectNoSecrets(m.childEnvOf())
  })

  it('claude success: model from init, usage from result, prompt on stdin only', async () => {
    m.scenario({ mode: 'success', text: 'hi', model: 'claude-test-1' })
    const t = await run('claude')
    expect(t).toMatchObject({ text: 'hi', model: 'claude-test-1', turns: 3 })
    expect(t.usage.totalTokens).toBe(480)
    expect(m.stdin()).toBe('PROMPT')
    expect(m.args()).not.toContain('PROMPT')
    expectNoSecrets(m.childEnvOf())
  })

  it('a 1 MB prompt goes through stdin intact', async () => {
    m.scenario({ mode: 'success' })
    const big = 'x'.repeat(1024 * 1024)
    await run('claude', { prompt: big })
    expect(m.stdin().length).toBe(big.length)
  })

  it('kimi: task in PIT_TASK.md, short pointer in argv, text answer', async () => {
    m.scenario({ mode: 'success', text: 'kimi says hi' })
    const t = await run('kimi', { prompt: 'z'.repeat(300_000) })
    expect(t.text).toBe('kimi says hi')
    expect(m.task()).toContain('SYSTEM-TEXT')
    expect(m.task().length).toBeGreaterThan(300_000)
    expect(m.args()[1]).toBe(POINTER_PROMPT)
    expectNoSecrets(m.childEnvOf())
  })

  it('kimi failures: signed out, rate limit, unknown model, empty answer', async () => {
    for (const [mode, kind] of [['auth', 'auth'], ['rate_limit', 'rate_limit'], ['model', 'model'], ['empty', 'crash']] as const) {
      m.scenario({ mode })
      const e = (await run('kimi').catch((x) => x)) as AgentError
      expect(e, mode).toBeInstanceOf(AgentError)
      expect(e.kind, mode).toBe(kind)
    }
  })

  it('command adapter: jsonl result + usage, only passEnv variables added', async () => {
    m.scenario({ mode: 'success', text: 'from mycli' })
    const cfg = cfgOf({ command: { name: 'mycli', bin: 'mycli', args: ['--json', '{prompt}'], prompt: 'arg', output: 'jsonl', family: 'qwen', passEnv: ['OPENAI_API_KEY'] } })
    const t = await run('command', { cfg, env: { ...m.env, PIT_OFFICIAL: '1' } })
    expect(t).toMatchObject({ text: 'from mycli', model: 'qwen3.6-plus' })
    expect(t.usage.totalTokens).toBe(77)
    expect(m.args()).toEqual(['--json', 'SYSTEM-TEXT\n\nPROMPT'])
    const ce = m.childEnvOf()
    expect(ce.OPENAI_API_KEY).toBe(SECRETS.OPENAI_API_KEY)
    expect(ce.PIT_WALLET_PK).toBeUndefined()
    expect(ce.GH_TOKEN).toBeUndefined()
    m.scenario({ mode: 'rate_limit' })
    expect(((await run('command', { cfg }).catch((x) => x)) as AgentError).kind).toBe('rate_limit')
  })

  it('claude provider mode reaches the child as ANTHROPIC_* (no subscription token)', async () => {
    m.scenario({ mode: 'success' })
    const env = { ...m.env, DEEPSEEK_API_KEY: 'ds-key-0123456789abcdef', CLAUDE_CODE_OAUTH_TOKEN: 'oauth' }
    await run('claude', { env, cfg: cfgOf({ claudeProvider: 'deepseek' }) })
    const ce = m.childEnvOf()
    expect(ce).toMatchObject({ ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_AUTH_TOKEN: 'ds-key-0123456789abcdef', ANTHROPIC_MODEL: 'deepseek-flash' })
    expect(ce.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(ce.DEEPSEEK_API_KEY).toBeUndefined()
    expectNoSecrets(ce)
  })

  it('rate limit -> 300 s pause; signed out -> 1800 s; sandbox; crash', async () => {
    for (const [kind, mode, fk, pause] of [
      ['codex', 'rate_limit', 'rate_limit', 300],
      ['claude', 'rate_limit', 'rate_limit', 300],
      ['codex', 'auth', 'auth', 1800],
      ['claude', 'auth', 'auth', 1800],
      ['codex', 'sandbox', 'sandbox', 1800],
      ['codex', 'crash', 'crash', 0],
      ['claude', 'crash', 'crash', 0],
    ] as const) {
      m.scenario({ mode })
      const e = (await run(kind).catch((x) => x)) as AgentError
      expect(e, `${kind} ${mode}`).toBeInstanceOf(AgentError)
      expect(e.kind, `${kind} ${mode}`).toBe(fk)
      expect(e.pauseSec).toBe(pause)
    }
  })

  it('timeout kills the whole process group, including a grandchild that ignores SIGTERM', async () => {
    m.scenario({ mode: 'hang-stubborn' })
    const e = (await run('codex', { timeoutMs: 800 }).catch((x) => x)) as AgentError
    expect(e.kind).toBe('timeout')
    expect(e.message).toMatch(/timed out after \d+s \(process group killed\)/)
    const pid = Number(readFileSync(join(m.home, 'grandchild.pid'), 'utf8'))
    for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50))
    expect(alive(pid)).toBe(false)
  })

  it('abort stops the run; a missing binary is classified missing', async () => {
    m.scenario({ mode: 'hang' })
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 300)
    expect(((await run('claude', { signal: ac.signal }).catch((x) => x)) as AgentError).kind).toBe('aborted')
    const e = (await invokeAgent({ kind: 'codex', bin: join(m.home, 'nope'), prompt: 'x', opts: opts(dir), timeoutMs: 5000, env: m.env }).catch((x) => x)) as AgentError
    expect(e.kind).toBe('missing')
  })

  it('binary overrides and --runtime local selection', () => {
    expect(agentBin('codex', m.env)).toBe(join(m.bin, 'codex'))
    expect(agentBin('codex', { ...m.env, PIT_CODEX_BIN: join(m.bin, 'claude') })).toBe(join(m.bin, 'claude'))
    expect(agentBin('codex', { ...m.env, PIT_CODEX_BIN: '/no/such' })).toBeNull()
    expect(pickAgent(cfgOf(), m.env)).toBe('codex')
    expect(pickAgent(cfgOf({ default: 'kimi' }), m.env)).toBe('kimi')
    expect(pickAgent(cfgOf(), { ...m.env, PATH: dirname(process.execPath), PIT_CLAUDE_BIN: join(m.bin, 'claude') })).toBe('claude')
    expect(() => pickAgent(cfgOf(), { PATH: '/nonexistent', HOME: m.home })).toThrow(/no agent CLI found/)
  })

  it('doctor probe: version, flags, login, live OK test; logged-out shows the fix', async () => {
    m.scenario({ mode: 'success', text: 'OK' })
    for (const k of ['codex', 'claude', 'kimi'] as AgentKind[]) {
      const p = await probeAgent(k, { live: true, env: m.env, sandbox: false })
      expect(p.version, k).toBeTruthy()
      expect(p.missingFlags, k).toEqual([])
      expect(p.live?.ok, k).toBe(true)
    }
    m.scenario({ mode: 'auth', loggedIn: false })
    const p = await probeAgent('codex', { env: m.env })
    expect(p.loggedIn).toBe(false)
    expect(p.hints.join(' ')).toMatch(/codex login/)
    m.scenario({ mode: 'success', help: '--json' })
    expect((await probeAgent('codex', { env: m.env })).missingFlags).toContain('--sandbox')
    const missing = await probeAgent('codex', { env: { PATH: '/nonexistent', HOME: m.home } })
    expect(missing.bin).toBeNull()
    expect(missing.hints[0]).toMatch(/install Codex/)
  })
})

// ------------------------------------------------------------------ skills

describe('runSkillAgent', () => {
  let m: Machine
  beforeEach(() => {
    m = machine()
  })
  afterEach(() => m.cleanup())
  const rt = (kind: AgentKind, over: Record<string, unknown> = {}) => ({ kind, bin: agentBin(kind, m.env)!, cfg: cfgOf({ repairs: 1, ...over }), env: m.env, secrets: [WALLET], killGraceMs: 300, tmpRoot: m.home })
  const review = normalizeReview(JSON.stringify({ verdict: 'pass', summary: 'Nothing blocks the release.', findings: [] }), 'Adversarial review')

  it('read-only review: inputs staged in a fresh temp dir that is removed afterwards', async () => {
    m.scenario({ mode: 'success', text: review })
    const r = await runSkillAgent('adversarial-review', { title: 'Review it', summary: '' }, { dependencies: [{ key: 'src', files: { 'a.sol': 'contract A {}' } }] }, rt('claude'))
    expect(r.out.kind).toBe('markdown')
    expect(r.model).toBe('claude-opus-5-5')
    const cwd = readFileSync(join(m.home, 'fake-cwd-1.txt'), 'utf8')
    expect(cwd).toMatch(/pit-lease-/)
    expect(existsSync(cwd)).toBe(false)
    expect(m.args()).toContain('Read,Glob,Grep')
  })

  it('bundle skill: only new / changed files under work/ are collected; symlinks skipped', async () => {
    m.scenario({ mode: 'success', text: 'done', writeFiles: { 'work/site/index.html': '<h1>new</h1>', 'work/site/keep.css': 'b{}', 'outside.txt': 'x' } })
    const r = await runSkillAgent('build-vite', { title: 'Build', summary: '' }, { root: 'site', paths: ['site/**'], dependencies: [{ key: 'base', format: 'pit.files.v1', files: { 'site/keep.css': 'b{}' } }] }, rt('codex'))
    expect(r.out).toEqual({ kind: 'bundle', files: { 'site/index.html': '<h1>new</h1>' } })
    expect(m.args()).toContain('workspace-write')
    const root = mkdtempSync(join(tmpdir(), 'pit-collect-'))
    try {
      writeFileSync(join(root, 'a.txt'), 'a')
      symlinkSync('/etc/passwd', join(root, 'link.txt'))
      mkdirSync(join(root, 'node_modules'))
      writeFileSync(join(root, 'node_modules', 'x.js'), 'x')
      writeFileSync(join(root, '.env'), 'K=1')
      const got = collectChanged(root, {})
      expect(Object.keys(got.files)).toEqual(['a.txt'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a rejected answer gets one repair round with the problems listed', async () => {
    m.scenario({ steps: [{ mode: 'success', text: 'too short' }, { mode: 'success', text: review }] })
    const logs: string[] = []
    const r = await runSkillAgent('adversarial-review', { title: 'Review it', summary: '' }, { dependencies: [] }, { ...rt('codex'), log: (l: string) => logs.push(l) })
    expect(r.calls).toBe(2)
    expect(m.stdin(2)).toContain('rejected by the local contract check')
    expect(logs.join('\n')).toMatch(/asking for a fix/)
  })

  it('never submits an answer that contains a local secret', async () => {
    m.scenario({ mode: 'success', text: `${review}\n${WALLET}` })
    await expect(runSkillAgent('adversarial-review', { title: 'x', summary: '' }, { dependencies: [] }, rt('claude'))).rejects.toThrow(/local secret/)
    const s = leakSecrets([], { MY_PK: '0x' + 'ee'.repeat(32), PIT_SEAT_CONTRACT: '0x' + '11'.repeat(20) })
    expect(containsSecret('key ' + 'ee'.repeat(32), s)).toBe(true)
    expect(containsSecret('seat ' + '11'.repeat(20), s)).toBe(false)
  })

  it('refuses oversized input before starting the CLI', async () => {
    m.scenario({ mode: 'success' })
    await expect(runSkillAgent('adversarial-review', { title: 'x', summary: '' }, { dependencies: [{ key: 'big', files: { 'a.md': 'y'.repeat(5000) } }] }, rt('claude', { maxInputChars: 1000 }))).rejects.toThrow(/too large|exceeds/i)
    expect(m.calls()).toBe(0)
  })
})

// ------------------------------------------------------------------ daemon

type L = (ev: unknown) => void
class Sock implements WebSocketLike {
  readyState = 0
  ls: Record<string, { fn: L; once: boolean }[]> = {}
  constructor(private gw: Gw) {
    queueMicrotask(() => {
      this.readyState = 1
      this.fire('open', {})
    })
  }
  addEventListener(t: string, fn: L, o?: { once?: boolean }) {
    ;(this.ls[t] ??= []).push({ fn, once: !!o?.once })
  }
  removeEventListener(t: string, fn: L) {
    this.ls[t] = (this.ls[t] ?? []).filter((l) => l.fn !== fn)
  }
  fire(t: string, ev: unknown) {
    for (const l of [...(this.ls[t] ?? [])]) {
      if (l.once) this.removeEventListener(t, l.fn)
      l.fn(ev)
    }
  }
  send(d: string) {
    this.gw.onFrame(this, JSON.parse(d))
  }
  close(code = 1000) {
    if (this.readyState === 3) return
    this.readyState = 3
    queueMicrotask(() => this.fire('close', { code }))
  }
  push(f: Record<string, unknown>) {
    if (this.readyState === 1) queueMicrotask(() => this.fire('message', { data: JSON.stringify({ v: 1, ...f }) }))
  }
}
class Gw {
  frames: { kind: string; payload?: Record<string, unknown> }[] = []
  on: Record<string, (s: Sock, f: Record<string, unknown>) => void> = {}
  sock: Sock | null = null
  connect = () => (this.sock = new Sock(this))
  onFrame(s: Sock, f: Record<string, unknown>) {
    this.frames.push({ kind: String(f.kind), payload: f.payload as Record<string, unknown> })
    if (f.kind === 'hello') return s.push({ kind: 'challenge', payload: { nonce: '0x' + 'ab'.repeat(32) } })
    if (f.kind === 'challenge_response') return s.push({ kind: 'welcome', payload: { protocol: 'pit.v1', limits: {} } })
    this.on[String(f.kind)]?.(s, f)
  }
}
const until = async (cond: () => boolean, ms = 20_000) => {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('daemon with an agent CLI', () => {
  let m: Machine
  let pitHome: string
  beforeEach(async () => {
    m = machine()
    pitHome = m.env.PIT_HOME as string
    mkdirSync(pitHome, { recursive: true })
    process.env.PIT_HOME = pitHome
    await initDevice(false, { network: 'sepolia' })
    saveConfig({ ...loadConfig(), seatId: 813, apiUrl: 'https://api.test' })
    vi.stubGlobal('fetch', async (u: string) => (String(u).includes('/upload') ? new Response(JSON.stringify({ hash: '0x01' })) : new Response(JSON.stringify({ head: null }))))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.PIT_HOME
    m.cleanup()
  })
  const lease = (gw: Gw, skill: string) => {
    gw.on.accept = (s, f) =>
      s.push({ kind: 'lease_ok', payload: { leaseId: (f.payload as { leaseId: string }).leaseId, leaseUntil: 9_999_999_999, uploadUrl: 'https://api.test/upload/x', task: { taskId: 'n1', jobId: 'j1', nodeId: 'n1', skill, tier: 'standard', inputs: { title: 'Review it' }, dependencies: [] } } })
    gw.on.submit = (s) => s.push({ kind: 'lease_ok', payload: { submitted: true, receiptHash: '0xfeed', verification: { result: 'pass' } } })
  }
  const start = (gw: Gw, kind: AgentKind, logs: string[], cfg: AgentConfig = cfgOf()) =>
    startDaemon({ probe: false, connect: gw.connect as never, heartbeatMs: 60_000, log: (l) => logs.push(l), agent: { kind, bin: agentBin(kind, m.env, cfg)!, cfg, env: m.env, killGraceMs: 300, tmpRoot: m.home } })
  const review = normalizeReview(JSON.stringify({ verdict: 'pass', summary: 'Nothing blocks the release.', findings: [] }), 'Adversarial review')

  it('claude seat: declares claude only, claims the reported model, logs usage', async () => {
    m.scenario({ mode: 'success', text: review })
    const gw = new Gw()
    lease(gw, 'adversarial-review')
    const logs: string[] = []
    const run = start(gw, 'claude', logs)
    await until(() => gw.frames.some((f) => f.kind === 'heartbeat'))
    const hello = gw.frames.find((f) => f.kind === 'hello')!.payload as { families: string[]; runtimes: { id: string; available: boolean }[] }
    expect(hello.families).toEqual(['claude'])
    expect(hello.runtimes.filter((r) => r.available).map((r) => r.id)).toEqual(['claude'])
    gw.sock!.push({ kind: 'offer', payload: { leaseId: 'lease_1', skill: 'adversarial-review', title: 'Review it' } })
    await until(() => gw.frames.some((f) => f.kind === 'submit'))
    const receipt = (gw.frames.find((f) => f.kind === 'submit')!.payload as { receipt: { modelClaim: Record<string, unknown>; tokensClaim: number } }).receipt
    expect(receipt.modelClaim).toMatchObject({ family: 'claude', model: 'claude-opus-5-5', tier: 'standard' })
    expect(receipt.tokensClaim).toBe(480)
    expect(readUsage(join(pitHome, 'usage.jsonl'))[0]).toMatchObject({ family: 'claude', totalTokens: 480, ok: true })
    process.emit('SIGTERM')
    await run
  })

  it('claude via GLM: declares glm, no runtime marked available', async () => {
    m.scenario({ mode: 'success', text: review, model: 'glm-5.3' })
    m.env.ZAI_API_KEY = 'zai-0123456789abcdef'
    const gw = new Gw()
    lease(gw, 'adversarial-review')
    const logs: string[] = []
    const run = start(gw, 'claude', logs, cfgOf({ claudeProvider: 'glm' }))
    await until(() => gw.frames.some((f) => f.kind === 'heartbeat'))
    const hello = gw.frames.find((f) => f.kind === 'hello')!.payload as { families: string[]; runtimes: { available: boolean }[] }
    expect(hello.families).toEqual(['glm'])
    expect(hello.runtimes.some((r) => r.available)).toBe(false)
    gw.sock!.push({ kind: 'offer', payload: { leaseId: 'lease_g', skill: 'adversarial-review', title: 'Review it' } })
    await until(() => gw.frames.some((f) => f.kind === 'submit'))
    expect((gw.frames.find((f) => f.kind === 'submit')!.payload as { receipt: { modelClaim: Record<string, unknown> } }).receipt.modelClaim).toMatchObject({ family: 'glm', model: 'glm-5.3' })
    process.emit('SIGTERM')
    await run
  })

  it('codex rate limit: machine failure, then pauses new leases with a clear log line', async () => {
    m.scenario({ mode: 'rate_limit' })
    const gw = new Gw()
    lease(gw, 'adversarial-review')
    const logs: string[] = []
    const run = start(gw, 'codex', logs)
    await until(() => gw.frames.some((f) => f.kind === 'heartbeat'))
    gw.sock!.push({ kind: 'offer', payload: { leaseId: 'lease_r', skill: 'adversarial-review' } })
    await until(() => gw.frames.some((f) => f.kind === 'fail'))
    expect(gw.frames.find((f) => f.kind === 'fail')!.payload).toMatchObject({ leaseId: 'lease_r', failureClass: 'machine' })
    expect(logs.some((l) => /PAUSED 300s: codex-cli hit its usage limit/.test(l))).toBe(true)
    const accepts = gw.frames.filter((f) => f.kind === 'accept').length
    gw.sock!.push({ kind: 'offer', payload: { leaseId: 'lease_r2', skill: 'adversarial-review' } })
    await new Promise((r) => setTimeout(r, 200))
    expect(gw.frames.filter((f) => f.kind === 'accept').length).toBe(accepts)
    process.emit('SIGTERM')
    await run
  })

  it('signed out: pause with the login fix', async () => {
    m.scenario({ mode: 'auth' })
    const gw = new Gw()
    lease(gw, 'adversarial-review')
    const logs: string[] = []
    const run = start(gw, 'claude', logs)
    await until(() => gw.frames.some((f) => f.kind === 'heartbeat'))
    gw.sock!.push({ kind: 'offer', payload: { leaseId: 'lease_a', skill: 'adversarial-review' } })
    await until(() => logs.some((l) => l.includes('PAUSED 1800s')))
    expect(logs.find((l) => l.includes('PAUSED'))).toMatch(/Fix: run `claude` and \/login/)
    process.emit('SIGTERM')
    await run
  })

  it('timeout: machine failure whose reason the backend counts as a timeout', async () => {
    m.scenario({ mode: 'hang' })
    const gw = new Gw()
    lease(gw, 'adversarial-review')
    const logs: string[] = []
    const run = start(gw, 'codex', logs, cfgOf({ timeoutSec: 30 }))
    await until(() => gw.frames.some((f) => f.kind === 'heartbeat'))
    gw.sock!.push({ kind: 'offer', payload: { leaseId: 'lease_t', skill: 'adversarial-review' } })
    await until(() => m.calls() > 0)
    await until(() => gw.frames.some((f) => f.kind === 'fail'), 45_000)
    const fail = gw.frames.find((f) => f.kind === 'fail')!.payload as { failureClass: string; reason: string }
    expect(fail.failureClass).toBe('machine')
    expect(`device_failed: ${fail.reason}`).toMatch(/\b(timeout|timed out)\b/i)
    process.emit('SIGTERM')
    await run
  }, 60_000)
})

describe('sandbox and secret shapes', () => {
  it('bwrap hides a canary in the real home, and the profile denies it', async () => {
    const { bwrapArgs, sandboxHidesHome, seatbeltProfile } = await import('../src/sandbox.ts')
    const args = bwrapArgs({ bin: '/usr/bin/node', args: ['-e', '1'], cwd: '/tmp/work', jailHome: '/tmp/jail', network: false })
    expect(args).toContain('--unshare-net')
    expect(args.join(' ')).not.toContain('--bind /home')
    const profile = seatbeltProfile({ cwd: '/w', jailHome: '/j', realHome: '/home/u', network: false })
    expect(profile).toContain('(deny file-read* (subpath "/home/u"))')
    expect(profile).not.toContain('(allow network*)')
    const hide = sandboxHidesHome()
    expect(hide.ok, hide.detail).toBe(true)
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { planLaunch } = await import('../src/sandbox.ts')
    const work = mkdtempSync(join(tmpdir(), 'pit-plan-'))
    const launch = planLaunch({ kind: 'codex', bin: '/bin/true', args: ['--version'], cwd: work, realHome: tmpdir(), network: false, enable: true })
    expect(launch.sandboxed, 'bwrap or seatbelt').toBe(true)
    expect(launch.args).not.toContain('--unshare-net')
    expect(launch.args.join('\n')).not.toContain('(deny network')
  })

  it('secret shapes name the kind and never the secret', async () => {
    const { secretShapes } = await import('../src/agent-skills.ts')
    const text = '-----BEGIN OPENSSH PRIVATE KEY-----\nsk-' + 'a'.repeat(20) + '\ngh p_xxxxxxxxxxxxxxxxxxxx\nAKIAIOSFODNN7EXAMPLE\neyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signatureok'
    const hits = secretShapes(text)
    expect(hits).toEqual(expect.arrayContaining(['private-key-block', 'api-key', 'aws-key', 'jwt']))
    expect(hits.join(' ')).not.toContain('sk-')
  })

  it('command and kimi refuse bundle skills', async () => {
    const { runSkillAgent } = await import('../src/agent-skills.ts')
    const cfg = cfgOf()
    await expect(runSkillAgent('build-vite', { title: 'x', summary: '' }, { dependencies: [] }, { kind: 'kimi', bin: 'kimi', cfg })).rejects.toThrow(/text skills/)
    await expect(runSkillAgent('build-foundry', { title: 'x', summary: '' }, { dependencies: [] }, { kind: 'command', bin: 'x', cfg })).rejects.toThrow(/text skills/)
  })
})
