/**
 * hello payload (E11): declare multiple runtimes; smoke hooks stubbed as not_run until doctor probes.
 */
import { DAEMON_VERSION, PREMIUM_MODELS, RUNTIME_IDS, type RuntimeId } from './defaults.ts'

export type SmokeStatus = 'not_run' | 'passed' | 'failed' | 'missing'

export interface RuntimeDecl {
  id: RuntimeId
  available: boolean
  /** Self-reported premium model (routing only). */
  premiumModel: { model: string; effort: string } | null
  smoke: SmokeStatus
  /** Optional CLI version string when smoke ran. */
  version: string | null
}

export interface HelloPayload {
  version: string
  runtimes: RuntimeDecl[]
  skills: string[]
  kinds: string[]
  profiles: string[]
  tools: string[]
  concurrency: number
  /** T6 capability profile: declared model families (in addition to available runtimes) and max tier. */
  families: string[]
  maxTier: string
  /** --max-input-chars of a model seat: the backend offers review steps only when their bounded view fits it. */
  maxInputChars?: number
  /**
   * How this seat runs (backend PR will trust this instead of free-text families). One family, whether the harness is
   * OS-sandboxed, and whether the seat reads files on disk (`files`) or only a packed prompt (`prompt`).
   */
  runtime?: HelloRuntime
}

export interface HelloRuntime {
  mode: 'model' | 'harness' | 'stub' | 'local'
  kind: string
  family: string | null
  model: string | null
  sandboxed: boolean
  inputMode: 'prompt' | 'files'
}

export function buildHelloPayload(
  runtimes: RuntimeDecl[],
  caps: { skills?: readonly string[]; families?: string[]; maxTier?: string; concurrency?: number; maxInputChars?: number; runtime?: HelloRuntime } = {},
): HelloPayload {
  const families = caps.runtime ? (caps.families ?? []).slice(0, 1) : (caps.families ?? [])
  return {
    version: DAEMON_VERSION,
    runtimes,
    skills: [...(caps.skills ?? [])],
    kinds: [],
    profiles: [],
    tools: [],
    concurrency: caps.concurrency ?? 1,
    families,
    maxTier: caps.maxTier ?? 'standard',
    ...(caps.maxInputChars ? { maxInputChars: caps.maxInputChars } : {}),
    ...(caps.runtime ? { runtime: caps.runtime } : {}),
  }
}

/** Default declarations before doctor: all runtimes listed, smoke not_run, not available. */
export function defaultRuntimeDecls(): RuntimeDecl[] {
  return RUNTIME_IDS.map((id) => {
    const premium = PREMIUM_MODELS.find((p) => p.runtime === id)
    return {
      id,
      available: false,
      premiumModel: premium ? { model: premium.model, effort: premium.effort } : null,
      smoke: 'not_run',
      version: null,
    }
  })
}

/**
 * Runtime declarations for a seat that runs exactly one runtime (`only`) or none of the CLIs (null: an API-key model
 * seat). The backend derives a family from every runtime marked available, so the others are marked unavailable while
 * their probe results (version, smoke) stay visible.
 */
export function exactRuntimeDecls(decls: RuntimeDecl[], only: RuntimeId | null): RuntimeDecl[] {
  return decls.map((r) => ({ ...r, available: only !== null && r.id === only }))
}
