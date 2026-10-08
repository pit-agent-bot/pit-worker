import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, parseRetryAfter, withBackoff } from '../src/api.ts'
import { pairStatus } from '../src/pair.ts'
import type { PitConfig } from '../src/store.ts'

const cfg = { apiUrl: 'https://api.example.test', daemonVersion: 'test' } as unknown as PitConfig
const res = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

afterEach(() => vi.unstubAllGlobals())

describe('pit pair backs off on HTTP 429', () => {
  it('parses Retry-After as seconds or an HTTP date', () => {
    expect(parseRetryAfter('17')).toBe(17)
    expect(parseRetryAfter(new Date(1_000_000 + 30_000).toUTCString(), 1_000_000)).toBe(30)
    expect(parseRetryAfter('soon')).toBeUndefined()
    expect(parseRetryAfter(null)).toBeUndefined()
  })
  it('waits Retry-After (capped) then succeeds; the 429 reaches the caller only after the retries run out', async () => {
    const calls: string[] = []
    let n = 0
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url)
      return ++n <= 2 ? res(429, { error: 'rate limit reached' }, { 'retry-after': n === 1 ? '7' : '600' }) : res(200, { status: 'pending' })
    })
    const waits: number[] = []
    const out = await pairStatus(cfg, { code: '123456' }, { sleep: async (ms) => void waits.push(ms), onWait: () => undefined })
    expect(out).toEqual({ status: 'pending' })
    expect(calls.length).toBe(3)
    expect(waits).toEqual([7000, 60_000]) // second Retry-After (600 s) is capped at 60 s
  })
  it('without Retry-After uses capped exponential backoff and gives up after `retries`', async () => {
    const waits: number[] = []
    let calls = 0
    const err = await withBackoff(
      async () => {
        calls++
        throw new ApiError(429, 'rate limited')
      },
      { retries: 4, baseMs: 1000, maxMs: 5000, sleep: async (ms) => void waits.push(ms) },
    ).catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(429)
    expect(calls).toBe(5)
    expect(waits.length).toBe(4)
    expect(waits[0]).toBeGreaterThanOrEqual(1000)
    expect(waits[0]).toBeLessThanOrEqual(1200)
    expect(waits[1]).toBeGreaterThanOrEqual(2000)
    expect(waits[1]).toBeLessThanOrEqual(2400)
    expect(waits[3]).toBe(5000) // 8 s capped at 5 s
  })
  it('does not retry other errors', async () => {
    let calls = 0
    const err = await withBackoff(async () => {
      calls++
      throw new ApiError(400, 'bad request')
    }).catch((e) => e)
    expect(err.status).toBe(400)
    expect(calls).toBe(1)
  })
})
