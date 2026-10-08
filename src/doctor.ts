/**
 * Capability smoke hooks (E11). T3: detect whether claude / codex / gemini CLIs exist; do not execute models.
 */
import { spawnSync } from 'node:child_process'
import { defaultRuntimeDecls, type RuntimeDecl, type SmokeStatus } from './hello.ts'
import type { RuntimeId } from './defaults.ts'

const BINS: Record<RuntimeId, string[]> = {
  claude: ['claude'],
  codex: ['codex'],
  gemini: ['gemini'],
}

function which(bin: string): string | null {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' })
  if (r.status !== 0) return null
  const line = (r.stdout || '').trim().split('\n')[0]
  return line || null
}

function versionOf(bin: string): string | null {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 5_000 })
  if (r.status !== 0) return null
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n')[0]
  return out ? out.slice(0, 120) : null
}

export interface DoctorReport {
  ok: boolean
  runtimes: RuntimeDecl[]
  notes: string[]
}

/**
 * Probe local runtimes. Smoke is a presence check only (binary on PATH + --version).
 * Full model login / sandbox checks are deferred (T4+).
 */
export function runDoctor(): DoctorReport {
  const notes: string[] = [
    'Smoke hooks report CLI presence only; model login and sandbox are not verified in T3.',
    'Premium model fields are self-reported for routing; Pit verifies outcomes, not model identity.',
  ]
  const runtimes = defaultRuntimeDecls().map((r) => {
    const bins = BINS[r.id]
    let path: string | null = null
    for (const b of bins) {
      path = which(b)
      if (path) break
    }
    if (!path) {
      return { ...r, available: false, smoke: 'missing' as SmokeStatus, version: null }
    }
    const ver = versionOf(bins[0])
    // Presence of binary = smoke "passed" for T3 stub (not a model quality claim).
    return { ...r, available: true, smoke: 'passed' as SmokeStatus, version: ver }
  })
  const any = runtimes.some((r) => r.available)
  if (!any) notes.push('No Claude Code / Codex / Gemini CLI found on PATH. You can still pair and heartbeat; tasks need a runtime later.')
  return { ok: true, runtimes, notes }
}
