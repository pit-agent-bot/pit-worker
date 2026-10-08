import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { backoffDelay, FATAL_DISCONNECTS, startDaemon, type WebSocketLike } from '../src/start.ts'
import { initDevice, loadConfig, saveConfig } from '../src/store.ts'

type Listener = (ev: unknown) => void

/** In-memory socket: the "server" side is a handler that receives every client frame. */
class FakeSocket implements WebSocketLike {
  readyState = 0
  private ls: Record<string, { fn: Listener; once: boolean }[]> = {}
  constructor(private server: FakeGateway) {
    queueMicrotask(() => {
      if (server.refuse > 0) {
        server.refuse--
        this.fire('error', { message: 'connection refused (redeploy)' })
        this.readyState = 3
        return
      }
      this.readyState = 1
      this.fire('open', {})
    })
  }
  addEventListener(type: string, fn: Listener, opts?: { once?: boolean }) {
    ;(this.ls[type] ??= []).push({ fn, once: !!opts?.once })
  }
  removeEventListener(type: string, fn: Listener) {
    this.ls[type] = (this.ls[type] ?? []).filter((l) => l.fn !== fn)
  }
  fire(type: string, ev: unknown) {
    for (const l of [...(this.ls[type] ?? [])]) {
      if (l.once) this.removeEventListener(type, l.fn)
      l.fn(ev)
    }
  }
  send(data: string) {
    if (this.readyState !== 1) return
    this.server.onFrame(this, JSON.parse(data))
  }
  close(code = 1000, reason = '') {
    if (this.readyState === 3) return
    this.readyState = 3
    queueMicrotask(() => this.fire('close', { code, reason }))
  }
  /** Server -> client. */
  push(frame: Record<string, unknown>) {
    if (this.readyState === 1) queueMicrotask(() => this.fire('message', { data: JSON.stringify({ v: 1, ...frame }) }))
  }
}

class FakeGateway {
  sockets: FakeSocket[] = []
  frames: { session: number; kind: string; payload?: Record<string, unknown> }[] = []
  refuse = 0
  /** Hook per client frame kind (after the handshake). */
  on: Record<string, (s: FakeSocket, f: Record<string, unknown>) => void> = {}
  connect = (_url: string) => {
    const s = new FakeSocket(this)
    this.sockets.push(s)
    return s
  }
  get current() {
    return this.sockets.at(-1)!
  }
  onFrame(s: FakeSocket, f: Record<string, unknown>) {
    const session = this.sockets.indexOf(s) + 1
    this.frames.push({ session, kind: String(f.kind), payload: f.payload as Record<string, unknown> })
    if (f.kind === 'hello') return s.push({ kind: 'challenge', payload: { nonce: '0x' + 'ab'.repeat(32) } })
    if (f.kind === 'challenge_response') return s.push({ kind: 'welcome', payload: { protocol: 'pit.v1', limits: {} } })
    this.on[String(f.kind)]?.(s, f)
  }
  kinds(session?: number) {
    return this.frames.filter((f) => session === undefined || f.session === session).map((f) => f.kind)
  }
  /** Drop like a backend redeploy (1012 service restart, no disconnect frame). */
  drop(s = this.current) {
    s.close(1012, 'service restart')
  }
}

// Generous bound: polling every 5 ms, a starved CI worker (parallel test trees) must not turn into a false failure.
const until = async (cond: () => boolean, ms = 15_000) => {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('daemon reconnect (T9)', () => {
  let home: string
  const sleeps: number[] = []
  const sleep = async (ms: number) => {
    sleeps.push(ms)
    await new Promise((r) => setTimeout(r, 1))
  }
  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'pit-cli-rc-'))
    process.env.PIT_HOME = home
    await initDevice(false, { network: 'sepolia' })
    saveConfig({ ...loadConfig(), seatId: 42, apiUrl: 'https://api.test' })
    sleeps.length = 0
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    rmSync(home, { recursive: true, force: true })
    delete process.env.PIT_HOME
  })

  it('backoff is exponential with jitter and capped', () => {
    expect(backoffDelay(1, {}, () => 0)).toBe(500)
    expect(backoffDelay(1, {}, () => 1)).toBe(1000)
    expect(backoffDelay(3, {}, () => 0)).toBe(2000)
    expect(backoffDelay(3, {}, () => 1)).toBe(4000)
    expect(backoffDelay(20, {}, () => 1)).toBe(60_000)
    expect(backoffDelay(20, { maxMs: 10_000 }, () => 0)).toBe(5000)
    const spread = new Set(Array.from({ length: 20 }, () => backoffDelay(4)))
    expect(spread.size).toBeGreaterThan(1) // jitter: devices do not reconnect in lockstep
    expect(FATAL_DISCONNECTS.has('duplicate_session')).toBe(true)
    expect(FATAL_DISCONNECTS.has('heartbeat_timeout')).toBe(false)
  })

  it('reconnects after a redeploy drop and refused connects, redoing hello / challenge each time', async () => {
    const gw = new FakeGateway()
    const logs: string[] = []
    const run = startDaemon({ probe: false, connect: gw.connect, sleep, random: () => 0.5, log: (l) => logs.push(l), heartbeatMs: 60_000 })
    await until(() => gw.kinds(1).includes('heartbeat'))
    gw.refuse = 2 // the backend is still restarting: two refused connects before it accepts again
    gw.drop()
    await until(() => gw.kinds().filter((k) => k === 'challenge_response').length === 2)
    await until(() => gw.frames.some((f) => f.kind === 'heartbeat' && f.session === 4))
    expect(gw.sockets.length).toBe(4)
    expect(gw.kinds(4).slice(0, 2)).toEqual(['hello', 'challenge_response'])
    expect(sleeps).toEqual([750, 1500, 3000]) // after the drop, then two refused connects (random 0.5)
    expect(logs.some((l) => l.includes('connection lost (close 1012'))).toBe(true)
    expect(logs.some((l) => l.includes('reconnected, session 2'))).toBe(true)
    // A later drop starts the backoff from the beginning again.
    gw.drop()
    await until(() => gw.kinds().filter((k) => k === 'challenge_response').length === 3)
    expect(sleeps.at(-1)).toBe(750)
    gw.current.close(1000)
    gw.on = {}
    process.emit('SIGTERM')
    const res = await run
    expect(res.sessions).toBeGreaterThanOrEqual(3)
    expect(res.reason).toBe('stopped')
  })

  it('does not reconnect after a fatal disconnect (revoked / duplicate session)', async () => {
    const gw = new FakeGateway()
    const run = startDaemon({ probe: false, connect: gw.connect, sleep, heartbeatMs: 60_000, log: () => {} })
    await until(() => gw.kinds(1).includes('heartbeat'))
    gw.current.push({ kind: 'disconnect', payload: { reason: 'duplicate_session' } })
    await new Promise((r) => setTimeout(r, 5))
    gw.current.close(1000, 'duplicate_session')
    const res = await run
    expect(res).toMatchObject({ sessions: 1, reason: 'disconnected: duplicate_session' })
    expect(gw.sockets.length).toBe(1)
  })

  it('an in-progress lease survives the drop: renewed and submitted on the new session', async () => {
    const gw = new FakeGateway()
    let uploads = 0
    vi.stubGlobal('fetch', async (u: string) => {
      if (String(u).includes('/upload')) {
        uploads++
        gw.drop() // the socket dies while the artifact is uploading
        return new Response(JSON.stringify({ hash: '0x01' }), { status: 200 })
      }
      return new Response(JSON.stringify({ head: null }), { status: 200 })
    })
    gw.on.accept = (s, f) => {
      const leaseId = (f.payload as { leaseId: string }).leaseId
      s.push({ kind: 'lease_ok', payload: { leaseId, leaseUntil: 9_999_999_999, uploadUrl: 'https://api.test/upload/x', task: { taskId: 'n1', jobId: 'j1', nodeId: 'n1', inputs: { title: 'Demo' } } } })
    }
    gw.on.renew = (s, f) => s.push({ kind: 'lease_ok', payload: { renew: true, leaseId: (f.payload as { leaseId: string }).leaseId, leaseUntil: 9_999_999_999 } })
    gw.on.submit = (s) => s.push({ kind: 'lease_ok', payload: { submitted: true, receiptHash: '0xfeed', verification: { result: 'pass' } } })
    const logs: string[] = []
    const run = startDaemon({ probe: false, connect: gw.connect, sleep, random: () => 0, heartbeatMs: 60_000, log: (l) => logs.push(l) })
    await until(() => gw.kinds(1).includes('heartbeat'))
    gw.current.push({ kind: 'offer', payload: { leaseId: 'lease_1', skill: 'write-readme', title: 'Demo' } })
    await until(() => gw.kinds(2).includes('submit'))
    expect(uploads).toBe(1)
    expect(gw.kinds(1)).not.toContain('submit')
    const k2 = gw.kinds(2)
    expect(k2.slice(0, 2)).toEqual(['hello', 'challenge_response'])
    expect(k2.indexOf('renew')).toBeGreaterThan(-1)
    expect(k2.indexOf('renew')).toBeLessThan(k2.indexOf('submit'))
    expect(gw.frames.find((f) => f.kind === 'submit')!.payload!.leaseId).toBe('lease_1')
    await until(() => logs.some((l) => l.startsWith('SUBMITTED receipt=0xfeed')))
    process.emit('SIGTERM')
    await run
  })

  it('an accept cut off before lease_ok is released with a signed fail after reconnecting', async () => {
    const gw = new FakeGateway()
    gw.on.accept = () => gw.drop() // no lease_ok: the session dies first
    gw.on.fail = (s, f) => s.push({ kind: 'cancel', payload: { leaseId: (f.payload as { leaseId: string }).leaseId, reason: 'failed' } })
    const logs: string[] = []
    const run = startDaemon({ probe: false, connect: gw.connect, sleep, random: () => 0, heartbeatMs: 60_000, log: (l) => logs.push(l) })
    await until(() => gw.kinds(1).includes('heartbeat'))
    gw.on.accept = () => gw.drop()
    gw.current.push({ kind: 'offer', payload: { leaseId: 'lease_9', skill: 'write-readme' } })
    await until(() => gw.kinds(2).includes('fail'))
    const fail = gw.frames.find((f) => f.kind === 'fail')!
    expect(fail.payload).toMatchObject({ leaseId: 'lease_9', failureClass: 'machine' })
    await until(() => logs.some((l) => l.includes('released lease lease_9')))
    process.emit('SIGTERM')
    const res = await run
    expect(res.sessions).toBe(2)
  })

  it('a half-open socket (acks stop, no close event) is dropped and reconnected', async () => {
    const gw = new FakeGateway()
    let acking = true
    gw.on.heartbeat = (s) => acking && s.push({ kind: 'heartbeat_ack', payload: {} })
    const logs: string[] = []
    const run = startDaemon({ probe: false, connect: gw.connect, sleep, random: () => 0, heartbeatMs: 20, log: (l) => logs.push(l) })
    await until(() => gw.kinds(1).filter((k) => k === 'heartbeat').length >= 2)
    acking = false
    // Socket stays "open" but the server never answers again.
    gw.current.send = () => {}
    await until(() => gw.sockets.length >= 2 && gw.kinds(2).includes('challenge_response'))
    expect(logs.some((l) => /no heartbeat ack for \d+s; dropping the socket/.test(l))).toBe(true)
    acking = true
    process.emit('SIGTERM')
    await run
  })
})
