import { describe, expect, it } from 'vitest'
import { buildHelloPayload, defaultRuntimeDecls } from '../src/hello.ts'
import { runDoctor } from '../src/doctor.ts'
import { DAEMON_VERSION } from '../src/defaults.ts'

describe('hello E11 + doctor stubs', () => {
  it('declares multiple runtimes with premium placeholders and empty skills', () => {
    const payload = buildHelloPayload(defaultRuntimeDecls())
    expect(payload.version).toBe(DAEMON_VERSION)
    expect(payload.runtimes.map((r) => r.id)).toEqual(['claude', 'codex', 'gemini'])
    expect(payload.runtimes.every((r) => r.smoke === 'not_run')).toBe(true)
    expect(payload.runtimes.find((r) => r.id === 'claude')?.premiumModel?.model).toBe('claude-fable-5-1')
    expect(payload.skills).toEqual([])
    expect(payload.kinds).toEqual([])
    expect(payload.concurrency).toBe(1)
    expect('maxInputChars' in payload).toBe(false) // not reported: the backend assumes the CLI default
  })

  it('a model seat reports its --max-input-chars (review steps are offered only when their bounded view fits)', () => {
    expect(buildHelloPayload(defaultRuntimeDecls(), { maxInputChars: 200_000 }).maxInputChars).toBe(200_000)
  })

  it('doctor marks missing CLIs without throwing', () => {
    const report = runDoctor()
    expect(report.ok).toBe(true)
    expect(report.runtimes.length).toBe(3)
    expect(report.notes.length).toBeGreaterThan(0)
  })
})
