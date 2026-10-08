import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const cli = join(dirname(fileURLToPath(import.meta.url)), '..')
const bin = join(cli, 'src', 'index.ts')
const homes: string[] = []

function run(args: string[], extra: Record<string, string> = {}, input?: string) {
  const home = extra.PIT_HOME ?? mkdtempSync(join(tmpdir(), 'pit-pub-'))
  if (!extra.PIT_HOME) homes.push(home)
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', bin, ...args], {
    cwd: cli,
    encoding: 'utf8',
    input,
    env: { ...process.env, PIT_OFFICIAL: '', PIT_HOME: home, ...extra },
  })
  return { ...r, home, out: `${r.stdout}\n${r.stderr}` }
}

afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
})

describe('public DeepSeek and harness model lists', () => {
  it('lists harness models and rejects a free-text codex model', () => {
    const listed = run(['runtime', '--models'])
    expect(listed.status).toBe(0)
    expect(listed.out).toContain('gpt-5.6-terra')
    expect(listed.out).toContain('claude-sonnet-5-5')
    const bad = run(['runtime', '--set', '--codex-model', 'gpt-4o'], { PIT_HOME: listed.home })
    expect(bad.status).not.toBe(0)
    expect(bad.out).toMatch(/gpt-5.6-sol/)
  })

  it('stores a prompted DeepSeek key and rejects other providers, retired models, and custom base URLs', () => {
    const kimi = run(['model', '--set', '--provider', 'kimi'])
    expect(kimi.status).not.toBe(0)
    expect(kimi.out).toMatch(/deepseek/)

    const retired = run(['model', '--set', '--provider', 'deepseek', '--model', 'deepseek-chat'])
    expect(retired.status).not.toBe(0)
    expect(retired.out).toMatch(/retired/)

    const url = run(['model', '--set', '--provider', 'deepseek', '--base-url', 'https://example.com'])
    expect(url.status).not.toBe(0)
    expect(url.out).toMatch(/not a public option/)

    const argv = run(['model', '--set', '--provider', 'deepseek', '--api-key', 'sk-from-argv'])
    expect(argv.status).not.toBe(0)
    expect(argv.out).toMatch(/does not take a value/)

    const home = mkdtempSync(join(tmpdir(), 'pit-pub-'))
    homes.push(home)
    const ok = run(['model', '--set', '--provider', 'deepseek', '--model', 'deepseek-v4-pro', '--api-key'], { PIT_HOME: home }, 'sk-test-secret\n')
    expect(ok.status, ok.out).toBe(0)
    const raw = readFileSync(join(home, 'model.json'), 'utf8')
    expect(raw).not.toContain('sk-test-secret')
    expect(raw).toContain('deepseek-v4-pro')
    expect(raw).toContain('https://api.deepseek.com')
    expect(readFileSync(join(home, 'model.key'), 'utf8').trim()).toBe('sk-test-secret')
    expect(statSync(join(home, 'model.key')).mode & 0o777).toBe(0o600)

    const listed = run(['model', '--providers'], { PIT_HOME: home })
    expect(listed.status).not.toBe(0)
    expect(listed.out).toMatch(/PIT_OFFICIAL/)
  })
})

describe('public runtime gate', () => {
  const commandJson = JSON.stringify({
    name: 'mycli',
    bin: 'mycli',
    args: ['run', '--json', '{prompt}'],
    prompt: 'arg',
    output: 'jsonl',
    resultField: 'result',
    family: 'qwen',
    passEnv: ['DASHSCOPE_API_KEY'],
  })

  it('rejects runtime.json claudeProvider at load, including pit start --runtime claude', () => {
    const home = mkdtempSync(join(tmpdir(), 'pit-pub-'))
    homes.push(home)
    writeFileSync(join(home, 'runtime.json'), JSON.stringify({ claudeProvider: 'kimi', claudeModel: 'kimi-k3', termsAcceptedAt: 1 }))
    const shown = run(['runtime'], { PIT_HOME: home })
    expect(shown.status).not.toBe(0)
    expect(shown.out).toMatch(/claudeProvider/)
    expect(shown.out).not.toMatch(/claude-code:kimi/)
    expect(shown.out).not.toMatch(/moonshot/i)
    const start = run(['start', '--runtime', 'claude', '--duration', '1', '--no-reconnect'], { PIT_HOME: home, PIT_CLAUDE_BIN: '/no/such/claude' })
    expect(start.status).not.toBe(0)
    expect(start.out).toMatch(/claudeProvider/)
    expect(start.out).not.toMatch(/not found/)
    expect(start.out).not.toMatch(/api\.moonshot/)
    const baseOnly = run(['runtime'], { PIT_HOME: home })
    writeFileSync(join(home, 'runtime.json'), JSON.stringify({ claudeBaseUrl: 'https://api.moonshot.ai/anthropic', termsAcceptedAt: 1 }))
    const base = run(['runtime'], { PIT_HOME: home })
    expect(base.status).not.toBe(0)
    expect(base.out).toMatch(/claudeBaseUrl/)
    writeFileSync(join(home, 'runtime.json'), JSON.stringify({ kimiModel: 'kimi-k3' }))
    expect(run(['runtime'], { PIT_HOME: home }).out).toMatch(/kimiModel/)
    void baseOnly
  })

  it('rejects kimi, command and local before any sandbox or seat check', () => {
    for (const runtime of ['kimi', 'command', 'local']) {
      const r = run(['start', '--runtime', runtime, '--duration', '1'])
      expect(r.status, r.out).not.toBe(0)
      expect(r.out).toMatch(/not a public worker option/)
      expect(r.out).not.toMatch(/Never run a harness/)
    }
    const official = run(['start', '--runtime', 'kimi', '--duration', '1'], { PIT_OFFICIAL: '1', PIT_KIMI_BIN: '/no/such/kimi' })
    expect(official.out).not.toMatch(/not a public worker option/)
    expect(official.status).not.toBe(0)
  })

  it('does not save a command adapter or pass its third-party key', () => {
    const saved = run(['runtime', '--set', '--set-command', commandJson])
    expect(saved.status).not.toBe(0)
    expect(saved.out).toMatch(/--set-command/)
    expect(existsSync(join(saved.home, 'runtime.json'))).toBe(false)
    const eq = run(['runtime', '--set', `--set-command=${commandJson}`])
    expect(eq.status).not.toBe(0)
    expect(existsSync(join(eq.home, 'runtime.json'))).toBe(false)
    const home = mkdtempSync(join(tmpdir(), 'pit-pub-'))
    homes.push(home)
    writeFileSync(join(home, 'runtime.json'), JSON.stringify({ command: JSON.parse(commandJson), termsAcceptedAt: 1 }))
    const shown = run(['runtime'], { PIT_HOME: home })
    expect(shown.status).not.toBe(0)
    expect(shown.out).toMatch(/\bcommand\b/)
    expect(shown.out).not.toContain('sk-dashscope-live')
    const loaded = run(['start', '--runtime', 'codex', '--duration', '1'], { PIT_HOME: home, DASHSCOPE_API_KEY: 'sk-dashscope-live', PIT_CODEX_BIN: '/no/such/codex' })
    expect(loaded.status).not.toBe(0)
    expect(loaded.out).toMatch(/command/)
    expect(loaded.out).not.toContain('sk-dashscope-live')
    expect(loaded.out).not.toMatch(/not found/)
  })

  it('still allows a Claude subscription with no provider, and prompted DeepSeek', () => {
    const home = mkdtempSync(join(tmpdir(), 'pit-pub-'))
    homes.push(home)
    writeFileSync(join(home, 'runtime.json'), JSON.stringify({ termsAcceptedAt: 1, claudeModel: 'sonnet' }))
    const shown = run(['runtime'], { PIT_HOME: home })
    expect(shown.status, shown.out).toBe(0)
    expect(shown.out).toMatch(/claude-code/)
    expect(shown.out).not.toMatch(/claude-code:/)
    const start = run(['start', '--runtime', 'claude', '--duration', '1', '--no-reconnect'], { PIT_HOME: home, PIT_CLAUDE_BIN: '/no/such/claude' })
    expect(start.out).toMatch(/not found/)
    expect(start.out).not.toMatch(/not a public worker option/)
    expect(start.out).not.toMatch(/claudeProvider/)
    const eq = run(['model', '--set', '--provider', 'deepseek', '--model', 'deepseek-flash', '--api-key=sk-from-equals'])
    expect(eq.status).not.toBe(0)
    expect(eq.out).toMatch(/does not take a value/)
  })
})
