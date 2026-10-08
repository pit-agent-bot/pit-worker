import type { PitConfig } from './store.ts'

export class ApiError extends Error {
  status: number
  body?: unknown
  /** Parsed Retry-After header (seconds), when the server sent one. */
  retryAfterSec?: number
  constructor(status: number, message: string, body?: unknown, retryAfterSec?: number) {
    super(message)
    this.status = status
    this.body = body
    this.retryAfterSec = retryAfterSec
  }
}

/** Retry-After as seconds: delta-seconds or an HTTP date. Undefined when missing or unparseable. */
export function parseRetryAfter(v: string | null | undefined, nowMs = Date.now()): number | undefined {
  if (!v) return undefined
  const t = v.trim()
  if (/^\d+$/.test(t)) return Number(t)
  const at = Date.parse(t)
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - nowMs) / 1000)) : undefined
}

export interface BackoffOptions {
  /** Retries after the first attempt (default 5). */
  retries?: number
  /** First exponential delay in ms (default 2000), doubled each retry. */
  baseMs?: number
  /** Cap for any single wait in ms, Retry-After included (default 60000). */
  maxMs?: number
  sleep?: (ms: number) => Promise<void>
  onWait?: (ms: number, attempt: number) => void
}

/**
 * Runs `fn` and retries only on HTTP 429: waits Retry-After when the server sends it, otherwise exponential backoff
 * (base, 2x base, ...) with up to 20% jitter; every wait is capped at maxMs. Other errors are thrown at once.
 */
export async function withBackoff<T>(fn: () => Promise<T>, o: BackoffOptions = {}): Promise<T> {
  const retries = o.retries ?? 5
  const base = o.baseMs ?? 2000
  const max = o.maxMs ?? 60_000
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 429 || attempt > retries) throw e
      const expo = base * 2 ** (attempt - 1) * (1 + Math.random() * 0.2)
      const wait = Math.min(max, e.retryAfterSec !== undefined ? e.retryAfterSec * 1000 : expo)
      o.onWait?.(wait, attempt)
      await sleep(wait)
    }
  }
}

export async function apiJson<T>(cfg: PitConfig, path: string, init?: RequestInit): Promise<T> {
  const url = `${cfg.apiUrl.replace(/\/+$/, '')}${path}`
  const res = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers || {}) },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, (body as { error?: string }).error || res.statusText, body, parseRetryAfter(res.headers.get('retry-after')))
  return body as T
}

export function agentWssUrl(cfg: PitConfig, seatId: number): string {
  const base = cfg.apiUrl.replace(/^http/, 'ws').replace(/\/+$/, '')
  return `${base}/api/agent?seatId=${seatId}`
}
