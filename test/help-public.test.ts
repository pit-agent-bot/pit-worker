import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const cli = join(dirname(fileURLToPath(import.meta.url)), '..')
const bin = join(cli, 'src', 'index.ts')

function help(env: Record<string, string>) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', bin, 'help'], {
    cwd: cli,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  return `${r.stdout}\n${r.stderr}`
}

describe('public help hides the API-key path', () => {
  it('omits provider presets unless PIT_OFFICIAL=1', () => {
    const pub = help({ PIT_OFFICIAL: '' })
    expect(pub).toContain('--runtime codex')
    expect(pub).toContain('DeepSeek')
    expect(pub).not.toContain('--providers')
    expect(pub).not.toContain('--claude-provider')
    expect(pub).not.toContain('--set-command')
    expect(pub).not.toContain('--kimi-model')
    expect(pub).not.toContain('kimi|command|local')
    expect(pub).not.toContain('--runtime stub|model|')
    const off = help({ PIT_OFFICIAL: '1' })
    expect(off).toContain('--providers')
    expect(off).toContain('--claude-provider')
    expect(off).toContain('--set-command')
    expect(off).toContain('kimi|command|local')
  })
})
