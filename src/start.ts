/**
 * pit start — WSS hello / challenge / welcome / heartbeat + offer accept / stub skill (README or project bundle) / submit.
 * T9: the daemon reconnects by itself when the socket drops (backend redeploy, network blip): exponential backoff with
 * jitter, a fresh hello / challenge on every session, and lease state carried across sessions (an in-progress lease is
 * renewed and submitted on the new session; an accept that never got its lease_ok is released with a signed fail).
 */
import { keccak256, toBytes, type Hex } from 'viem'
import { agentWssUrl, apiJson } from './api.ts'
import { DAEMON_VERSION, HEARTBEAT_SEC, PROTOCOL_V } from './defaults.ts'
import { runDoctor } from './doctor.ts'
import { buildHelloPayload, defaultRuntimeDecls, exactRuntimeDecls } from './hello.ts'
import { AgentError, configuredModel, failureDetail, fixHint, harnessFamily, harnessLabel, type AgentConfig, type AgentKind, type invokeAgent } from './agent-cli.ts'
import { runSkillAgent, secretShapes } from './agent-skills.ts'
import { dropOutbox, listOutbox, saveOutbox } from './outbox.ts'
import { sandboxProgram } from './sandbox.ts'
import { buildSignedFrame, challengeSignString, ed25519Sign, parseFrame, type AgentFrame } from './protocol.ts'
import { logUsage, readUsage, tokensLast24h, type ChatResult, type ModelConfig, chatComplete } from './model.ts'
import { MODEL_SKILLS, runSkillModel, isModelError, InputTooLargeError, type ModelRun } from './real-skills.ts'
import { BUNDLE_FORMAT, runSkill, STUB_SKILLS, type SkillContext, type SkillInput, type SkillOutput } from './skill.ts'
import { devicePrivateKeyBytes, loadConfig, requireDevice } from './store.ts'

/** Backend-facing failure: an enum, never stderr and never a quote of the order (M5). The full text stays in the local log. */
function wireFail(err: unknown): { failureClass: string; failureDetail: string; reason: string } {
  if (err instanceof InputTooLargeError) return { failureClass: 'config_refused', failureDetail: 'input_too_large', reason: 'input_too_large' }
  if (err instanceof AgentError) {
    const detail = failureDetail(err.kind)
    return { failureClass: 'machine', failureDetail: detail, reason: detail }
  }
  if (isModelError(err)) {
    const msg = (err as Error).message
    const status = (err as { status?: number | null }).status
    const detail = /\b(timeout|timed out)\b/i.test(msg) ? 'timeout' : status === 429 ? 'rate_limit' : status === 401 || status === 402 || status === 403 ? 'auth' : 'model_error'
    return { failureClass: 'machine', failureDetail: detail, reason: detail }
  }
  return { failureClass: 'quality', failureDetail: 'quality', reason: 'quality' }
}

function onceMessage(ws: WebSocketLike, timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('WebSocket message timeout')), timeoutMs)
    const onMsg = (ev: { data: unknown }) => {
      clearTimeout(t)
      cleanup()
      resolve(String(ev.data))
    }
    const onClose = (ev: { code?: number; reason?: string }) => {
      clearTimeout(t)
      cleanup()
      reject(new Error(`WebSocket closed ${ev.code} ${ev.reason || ''}`))
    }
    const cleanup = () => {
      ws.removeEventListener('message', onMsg)
      ws.removeEventListener('close', onClose)
    }
    ws.addEventListener('message', onMsg)
    ws.addEventListener('close', onClose)
  })
}

function treeHashFromFiles(files: Record<string, string>): Hex {
  const keys = Object.keys(files).sort()
  const payload = keys.map((k) => `${k}\n${files[k]}`).join('\n--\n')
  return keccak256(toBytes(payload))
}

function contentHash(text: string): Hex {
  return keccak256(toBytes(text))
}

const ZERO_HASH = ('0x' + '00'.repeat(32)) as Hex

/** The subset of the WebSocket API the daemon uses (tests inject an in-memory socket). */
export interface WebSocketLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addEventListener(type: string, listener: (ev: any) => void, opts?: { once?: boolean }): void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  removeEventListener(type: string, listener: (ev: any) => void): void
}

const WS_OPEN = 1

export interface BackoffOptions {
  /** First retry delay (ms). Default 1000. */
  baseMs?: number
  /** Cap (ms). Default 60000. */
  maxMs?: number
}

/**
 * Reconnect delay for retry `attempt` (1-based): exponential (base * 2^(attempt-1), capped) with "equal jitter"
 * (half fixed + half random), so many devices dropped by one redeploy do not reconnect in lockstep.
 */
export function backoffDelay(attempt: number, opts: BackoffOptions = {}, rnd: () => number = Math.random): number {
  const base = opts.baseMs ?? 1000
  const max = opts.maxMs ?? 60_000
  const exp = Math.min(max, base * 2 ** Math.max(0, Math.min(30, attempt - 1)))
  return Math.round(exp / 2 + rnd() * (exp / 2))
}

/** Disconnect reasons that a reconnect cannot fix: stop instead of retrying. */
export const FATAL_DISCONNECTS = new Set(['revoked', 'not_enrolled', 'nft_transferred', 'duplicate_session', 'version_unsupported', 'seat_mismatch', 'auth_failed'])

class FatalError extends Error {}

export interface StartOptions {
  seatId?: number
  /** Stop after N seconds (tests / rehearsal). 0 = run until signal. */
  durationSec?: number
  /** Include doctor smoke results in hello (default true). */
  probe?: boolean
  /** Use deterministic stub skill (default true; no model keys). Ignored when `model` is set. */
  stub?: boolean
  /**
   * Real model runtime (OpenAI-compatible chat completions on this machine; keys stay in this process's env). Declares
   * the model's real family + tier and claims them (and the token usage) in receipts.
   */
  model?: ModelConfig
  /** Test hook for the model call. */
  chat?: typeof chatComplete
  /**
   * Local subscription runtime: the holder's own Codex CLI or Claude Code runs each lease in a temp dir (declares the
   * CLI's real family: codex -> gpt, claude -> claude). Mutually exclusive with `model`.
   */
  agent?: { kind: AgentKind; bin: string; cfg: AgentConfig; invoke?: typeof invokeAgent; tmpRoot?: string; env?: NodeJS.ProcessEnv; killGraceMs?: number; sandbox?: boolean }
  /** Usage log path (default <PIT_HOME>/usage.jsonl). */
  usageLog?: string | null
  /**
   * Model families to declare for scheduling (T6). With the stub runtime this is only a routing label for rehearsals;
   * receipts still claim family "stub".
   */
  families?: string[]
  maxTier?: string
  log?: (line: string) => void
  /** Reconnect when the socket drops (default true). */
  reconnect?: boolean
  backoff?: BackoffOptions
  /** Give up after this many consecutive failed reconnects (default 0 = never). */
  maxRetries?: number
  /** Test hooks. */
  connect?: (url: string) => WebSocketLike
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  /** Heartbeat interval override (ms). */
  heartbeatMs?: number
}

export interface StartResult {
  seatId: number
  welcome: Record<string, unknown>
  /** Authenticated sessions (1 = never reconnected). */
  sessions: number
  /** Why the daemon stopped: stopped (signal / duration), fatal disconnect reason, or retries exhausted. */
  reason: string
}

export async function startDaemon(opts: StartOptions = {}): Promise<StartResult> {
  const log = opts.log ?? ((s: string) => console.log(s))
  const cfg = loadConfig()
  const device = requireDevice()
  const seatId = opts.seatId ?? cfg.seatId
  if (!seatId) throw new Error('no seatId — pair first or pass --seat')
  const modelCfg = opts.model ?? null
  const agent = modelCfg ? null : (opts.agent ?? null)
  const agentFamily = agent ? harnessFamily(agent.kind, agent.cfg) : null
  const agentName = agent ? harnessLabel(agent.kind, agent.cfg) : ''
  const useStub = !modelCfg && !agent && opts.stub !== false
  /** Tokens per 24 h this seat may spend (0 = no limit). */
  const dailyBudget = modelCfg?.dailyTokenBudget ?? agent?.cfg.dailyTokenBudget ?? 0
  /** Rate limit / login / sandbox failures pause new leases until this time (ms). */
  let pausedUntil = 0
  let pauseReason = ''
  /** Aborts the running local CLI (process group kill) when the daemon stops. */
  const agentAbort = new AbortController()
  /** Model the local CLI last reported (Claude names it in its init event). */
  let lastAgentModel: string | null = null
  const reconnect = opts.reconnect !== false
  const connect = opts.connect ?? ((u: string) => new WebSocket(u) as unknown as WebSocketLike)

  const probed = opts.probe === false ? defaultRuntimeDecls() : runDoctor().runtimes
  // The backend adds the family of every runtime marked available (caps.ts); a model or local-CLI seat marks only the
  // runtime it really runs, so it declares exactly one family (never one borrowed from another CLI on PATH).
  const runtimes = modelCfg ? exactRuntimeDecls(probed, null) : agent ? exactRuntimeDecls(probed, agentFamily === 'gpt' && agent.kind === 'codex' ? 'codex' : agentFamily === 'claude' && agent.kind === 'claude' ? 'claude' : null) : probed
  const declaredFamily = modelCfg ? modelCfg.family : agentFamily
  const sandboxed = Boolean(agent && agent.sandbox && agent.kind !== 'command' && sandboxProgram())
  const helloPayload = buildHelloPayload(runtimes, {
    skills: modelCfg || agent ? MODEL_SKILLS : useStub ? STUB_SKILLS : [],
    // One family. A model or harness seat never appends a second label.
    families: declaredFamily ? [declaredFamily] : (opts.families ?? []),
    maxTier: modelCfg ? modelCfg.tier : agent ? agent.cfg.tier : opts.maxTier,
    ...(modelCfg ? { maxInputChars: modelCfg.maxInputChars } : agent ? { maxInputChars: agent.cfg.maxInputChars } : {}),
    runtime: {
      mode: modelCfg ? 'model' : agent ? 'harness' : useStub ? 'stub' : 'local',
      kind: modelCfg ? modelCfg.runtime : agent ? agent.kind : useStub ? 'stub' : 'local',
      family: declaredFamily,
      model: modelCfg ? modelCfg.model : agent ? (configuredModel(agent.kind, agent.cfg) ?? null) : null,
      sandboxed,
      inputMode: agent && agent.kind !== 'command' ? 'files' : 'prompt',
    },
  })
  if (modelCfg) log(`model runtime ${modelCfg.runtime} family=${modelCfg.family} model=${modelCfg.model}${modelCfg.cheapModel ? ` cheap=${modelCfg.cheapModel}` : ''} tier=${modelCfg.tier} key=env:${modelCfg.keyEnv}`)
  if (agent) log(`local runtime ${agentName} (${agent.bin}) family=${agentFamily} model=${configuredModel(agent.kind, agent.cfg) ?? 'cli default'} tier=${agent.cfg.tier} timeout=${agent.cfg.timeoutSec}s network=${agent.cfg.network ? 'on' : 'off'}`)
  log(`capabilities skills=${helloPayload.skills.join(',') || '-'} families=${helloPayload.families.join(',') || '-'} tier=${helloPayload.maxTier}${helloPayload.maxInputChars ? ` input=${helloPayload.maxInputChars}` : ''}`)

  const url = agentWssUrl(cfg, seatId)
  const priv = devicePrivateKeyBytes(device)

  // ---- state that survives reconnects
  let ws: WebSocketLike | null = null
  let authed = false
  let sessions = 0
  let firstWelcome: Record<string, unknown> | null = null
  let seq = 0
  let stopped = false
  let stopReason = 'stopped'
  let activeLeaseId: string | null = null
  /** The active lease was cancelled / lost while the skill ran: do not submit it. */
  let leaseLost = false
  /** accept sent but the session dropped before lease_ok: release it (signed fail) on the next session. */
  const orphanLeases = new Set<string>()
  let busy = false
  let lastDisconnect: string | null = null
  /** Liveness: the backend acks heartbeats (T9); a session with acks that goes silent is half-open and gets dropped. */
  let ackSeen = false
  let lastServerFrameAt = 0
  let forceClose: ((why: string) => void) | null = null
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_SEC * 1000

  const pending: { kinds: string[]; leaseId?: string; resolve: (f: AgentFrame | null) => void; timer: ReturnType<typeof setTimeout> }[] = []
  /** A frame answers a waiter only for the same lease (a late answer to an earlier lease must never satisfy the next one). */
  const matches = (f: AgentFrame, kinds: string[], leaseId?: string) => kinds.includes(f.kind) && (!leaseId || !f.payload?.leaseId || String(f.payload.leaseId) === leaseId)
  const queue: AgentFrame[] = []
  const connectedWaiters: (() => void)[] = []
  let wake: (() => void) | null = null

  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => {
    const t = setTimeout(r, ms)
    wake = () => {
      clearTimeout(t)
      r()
    }
  }))

  const waitForKind = (kinds: string[], timeoutMs: number, leaseId?: string): Promise<AgentFrame | null> => {
    // Stale answers for other leases are dropped.
    if (leaseId) for (let i = queue.length - 1; i >= 0; i--) if (queue[i]!.payload?.leaseId && String(queue[i]!.payload!.leaseId) !== leaseId) queue.splice(i, 1)
    const found = queue.findIndex((f) => matches(f, kinds, leaseId))
    if (found >= 0) return Promise.resolve(queue.splice(found, 1)[0]!)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const i = pending.findIndex((p) => p.timer === timer)
        if (i >= 0) pending.splice(i, 1)
        resolve(null)
      }, timeoutMs)
      pending.push({ kinds, leaseId, resolve, timer })
    })
  }

  /** Resolve when a session is authenticated (false on timeout or stop). */
  const waitConnected = (timeoutMs: number): Promise<boolean> => {
    if (authed && ws?.readyState === WS_OPEN) return Promise.resolve(true)
    if (stopped) return Promise.resolve(false)
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        const i = connectedWaiters.indexOf(done)
        if (i >= 0) connectedWaiters.splice(i, 1)
        resolve(false)
      }, timeoutMs)
      const done = () => {
        clearTimeout(t)
        resolve(authed && !stopped)
      }
      connectedWaiters.push(done)
    })
  }

  const stop = (reason = 'stopped') => {
    if (stopped) return
    stopped = true
    stopReason = reason
    agentAbort.abort()
    try {
      ws?.close(1000, 'pit_stop')
    } catch {
      /* ignore */
    }
    wake?.()
    for (const w of connectedWaiters.splice(0)) w()
  }

  const sendSigned = async (kind: string, payload: Record<string, unknown>) => {
    const sock = ws
    if (!sock || !authed || sock.readyState !== WS_OPEN) throw new Error('not connected')
    seq += 1
    const frame = await buildSignedFrame(priv, kind, seatId, device.publicKey, seq, payload)
    sock.send(JSON.stringify(frame))
    return frame
  }

  /** Send a signed request and wait for its answer; resend on the next session when the socket drops meanwhile. */
  const request = async (kind: string, payload: Record<string, unknown>, kinds: string[], tries = 3, timeoutMs = 25_000): Promise<AgentFrame | null> => {
    for (let i = 0; i < tries && !stopped; i++) {
      if (!(await waitConnected(180_000))) return null
      const session = sessions
      try {
        await sendSigned(kind, payload)
      } catch {
        continue
      }
      const res = await waitForKind(kinds, timeoutMs, typeof payload.leaseId === 'string' ? payload.leaseId : undefined)
      if (res) return res
      if (session === sessions && authed) return null // plain timeout on a live session
      log(`${kind} interrupted by a disconnect; resending on the next session`)
    }
    return null
  }

  const handleOffer = async (offer: AgentFrame) => {
    if (busy) {
      log(`offer ignored (busy): ${offer.payload?.leaseId}`)
      return
    }
    const leaseId = String(offer.payload?.leaseId || '')
    if (Date.now() < pausedUntil) {
      log(`offer ${leaseId} declined: paused for ${Math.ceil((pausedUntil - Date.now()) / 1000)}s more (${pauseReason})`)
      return
    }
    if ((modelCfg || agent) && dailyBudget > 0 && opts.usageLog !== null) {
      const used = tokensLast24h(readUsage(opts.usageLog ?? undefined))
      if (used >= dailyBudget) {
        log(`offer ${leaseId} declined: daily token budget reached (${used}/${dailyBudget})`)
        return
      }
    }
    busy = true
    const skill = String(offer.payload?.skill || 'write-readme')
    const title = String(offer.payload?.title || skill)
    const nodeKey = offer.payload?.nodeKey ? String(offer.payload.nodeKey) : null
    log(`OFFER ${leaseId} skill=${skill}${nodeKey ? ` node=${nodeKey} attempt=${offer.payload?.attempt ?? 1} family=${offer.payload?.family ?? '-'}` : ''} title=${title}`)
    try {
      const session = sessions
      await sendSigned('accept', { leaseId })
      const leaseOk = await waitForKind(['lease_ok', 'cancel'], 25_000, leaseId)
      if (!leaseOk && (session !== sessions || !authed)) {
        // The socket dropped between accept and lease_ok: the lease may exist; release it on the next session.
        orphanLeases.add(leaseId)
        log(`offer ${leaseId}: disconnected before lease_ok; will release it after reconnecting`)
        return
      }
      if (!leaseOk || leaseOk.kind === 'cancel') {
        log(`offer not leased: ${JSON.stringify(leaseOk?.payload || {})}`)
        return
      }
      const task = (leaseOk.payload?.task || {}) as Record<string, unknown>
      const uploadUrl = String(leaseOk.payload?.uploadUrl || '')
      activeLeaseId = String(leaseOk.payload?.leaseId || leaseId)
      leaseLost = false
      log(`LEASE ok until=${leaseOk.payload?.leaseUntil}`)
      const inputs = (task.inputs || {}) as Partial<SkillInput> & { failFirst?: unknown }
      const attempt = Number(task.attempt ?? 1)
      // Rehearsal hook: input.failFirst = [nodeKey, ...] ships the broken variant on attempt 1 of those nodes only.
      const failFirst = Array.isArray(inputs.failFirst) && nodeKey !== null && inputs.failFirst.includes(nodeKey) && attempt === 1
      const input: SkillInput = {
        title: String(inputs.title || title),
        summary: String(inputs.summary || 'Pit Sepolia task protocol demo.'),
        topic: String(inputs.topic || skill),
        variant: failFirst ? 'broken' : typeof inputs.variant === 'string' ? inputs.variant : undefined,
      }
      const t0 = Date.now()
      const ctx: SkillContext = {
        nodeKey,
        root: typeof task.root === 'string' ? task.root : null,
        dependencies: [],
        paths: Array.isArray(task.paths) ? (task.paths as string[]) : undefined,
        focus: typeof task.focus === 'string' ? task.focus : null,
        revision: Number(task.revision ?? 0),
        inputs: inputs as Record<string, unknown>,
        feedback: Array.isArray(task.feedback) ? (task.feedback as SkillContext['feedback']) : undefined,
        review: task.review as SkillContext['review'],
      }
      for (const d of (Array.isArray(task.dependencies) ? task.dependencies : []) as { key: string; url: string; treeHash?: string | null; format?: string; path?: string }[]) {
        const res = await fetch(d.url)
        if (!res.ok) throw new Error(`dependency ${d.key} fetch failed: HTTP ${res.status}`)
        const text = await res.text()
        if (d.format === 'text') {
          // T7: text outputs (reports / reviews) land at the producing node's exact path.
          ctx.dependencies!.push({ key: d.key, files: { [d.path || `${d.key}.md`]: text }, treeHash: d.treeHash ?? null, format: 'text' })
          log(`dependency ${d.key}: text ${d.path || ''}`)
          continue
        }
        const bundle = JSON.parse(text) as { format?: string; files?: Record<string, string> }
        if (bundle.format !== BUNDLE_FORMAT || !bundle.files) throw new Error(`dependency ${d.key} is not a ${BUNDLE_FORMAT} bundle`)
        ctx.dependencies!.push({ key: d.key, files: bundle.files, treeHash: d.treeHash ?? null, format: BUNDLE_FORMAT })
        log(`dependency ${d.key}: ${Object.keys(bundle.files).length} files`)
      }
      let out: SkillOutput
      let run: ModelRun | null = null
      if (modelCfg) {
        const onCall = (r: ChatResult, ok: boolean) => {
          log(`model ${r.model} ${skill}: ${r.usage.promptTokens}+${r.usage.completionTokens} tokens${r.usage.reasoningTokens ? ` (reasoning ${r.usage.reasoningTokens})` : ''} ${r.ms}ms${ok ? '' : ' (rejected locally)'}`)
          if (opts.usageLog === null) return
          try {
            logUsage(
              {
                at: Math.floor(Date.now() / 1000),
                seatId,
                family: modelCfg.family,
                model: r.model,
                skill,
                leaseId: activeLeaseId,
                jobId: String(task.jobId || ''),
                promptTokens: r.usage.promptTokens,
                completionTokens: r.usage.completionTokens,
                totalTokens: r.usage.totalTokens,
                reasoningTokens: r.usage.reasoningTokens,
                cachedTokens: r.usage.cachedTokens,
                ms: r.ms,
                ok,
              },
              opts.usageLog ?? undefined,
            )
          } catch (err) {
            log(`usage log error: ${(err as Error).message}`)
          }
        }
        try {
          run = await runSkillModel(skill, input, { ...ctx, tier: typeof task.tier === 'string' ? task.tier : null }, { cfg: modelCfg, chat: opts.chat, log, onCall })
        } catch (err) {
          const wire = wireFail(err)
          log(`skill ${skill} failed (${wire.failureClass}/${wire.failureDetail}): ${(err as Error).message}`)
          if (!leaseLost) await sendSigned('fail', { leaseId: activeLeaseId, ...wire }).catch(() => undefined)
          return
        }
        out = run.out
        log(`skill ${skill} done: model=${run.model} calls=${run.calls} tokens=${run.tokens}`)
      } else if (agent) {
        const onCall = (r: { model: string; usage: ChatResult['usage']; ms: number }, ok: boolean) => {
          log(`${agentName} ${r.model} ${skill}: ${r.usage.promptTokens}+${r.usage.completionTokens} tokens${r.usage.cachedTokens ? ` (cached ${r.usage.cachedTokens})` : ''} ${r.ms}ms${ok ? '' : ' (rejected locally)'}`)
          if (opts.usageLog === null) return
          try {
            logUsage(
              { at: Math.floor(Date.now() / 1000), seatId, family: agentFamily!, model: r.model, skill, leaseId: activeLeaseId, jobId: String(task.jobId || ''), promptTokens: r.usage.promptTokens, completionTokens: r.usage.completionTokens, totalTokens: r.usage.totalTokens, reasoningTokens: r.usage.reasoningTokens, cachedTokens: r.usage.cachedTokens, ms: r.ms, ok },
              opts.usageLog ?? undefined,
            )
          } catch (err) {
            log(`usage log error: ${(err as Error).message}`)
          }
        }
        try {
          run = await runSkillAgent(skill, input, ctx, {
            kind: agent.kind,
            bin: agent.bin,
            cfg: agent.cfg,
            log,
            onCall,
            signal: agentAbort.signal,
            sandbox: sandboxed,
            secrets: [device.privateKey],
            env: agent.env,
            tmpRoot: agent.tmpRoot,
            invoke: agent.invoke,
            killGraceMs: agent.killGraceMs,
          })
        } catch (err) {
          const wire = wireFail(err)
          log(`skill ${skill} failed (${wire.failureClass}/${wire.failureDetail}): ${(err as Error).message}`)
          if (err instanceof AgentError && err.pauseSec > 0) {
            pausedUntil = Date.now() + err.pauseSec * 1000
            pauseReason = wire.failureDetail
            log(`PAUSED ${err.pauseSec}s: ${agentName} ${err.kind === 'rate_limit' ? 'hit its usage limit' : err.kind === 'auth' ? 'is not logged in or has a billing problem' : err.kind === 'model' ? 'cannot use the configured model' : err.kind === 'sandbox' ? 'cannot start its sandbox' : 'is not runnable'}; no new leases until then. Fix: ${fixHint(agent.kind, err.kind, agent.cfg)}`)
          }
          if (!leaseLost && !stopped) await sendSigned('fail', { leaseId: activeLeaseId, ...wire }).catch(() => undefined)
          return
        }
        out = run.out
        if (!run.model.startsWith('tool:')) lastAgentModel = run.model
        log(`skill ${skill} done: ${agentName} model=${run.model} runs=${run.calls} tokens=${run.tokens}`)
      } else out = runSkill(skill, input, useStub ? 'stub' : 'local', ctx)
      let content: string
      let treeHash: Hex
      if (out.kind === 'bundle') {
        content = JSON.stringify({ format: BUNDLE_FORMAT, files: out.files })
        treeHash = treeHashFromFiles(out.files)
        log(`skill produced ${Object.keys(out.files).length} files`)
      } else {
        content = out.markdown
        treeHash = treeHashFromFiles({ 'README.md': out.markdown })
      }
      const shapes = secretShapes(content)
      if (shapes.length) {
        log(`skill ${skill} output matched secret shapes (${shapes.join(', ')}); not uploaded`)
        if (!leaseLost) await sendSigned('fail', { leaseId: activeLeaseId, failureClass: 'quality', failureDetail: 'secret_in_output', reason: 'secret_in_output' }).catch(() => undefined)
        return
      }
      const artifactHash = contentHash(content)
      const claimFamily = run ? (agentFamily ?? modelCfg!.family) : useStub ? 'stub' : 'local'
      const leaseFamily = typeof task.family === 'string' ? task.family : null
      if (leaseFamily && leaseFamily !== claimFamily) {
        log(`lease family ${leaseFamily} does not match this seat (${claimFamily}); not submitting`)
        if (!leaseLost) await sendSigned('fail', { leaseId: activeLeaseId, failureClass: 'quality', failureDetail: 'family_mismatch', reason: 'family_mismatch' }).catch(() => undefined)
        return
      }

      if (!uploadUrl) throw new Error('lease_ok missing uploadUrl')
      const up = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content }),
      })
      const upBody = (await up.json().catch(() => ({}))) as { hash?: string; error?: string }
      if (!up.ok) throw new Error(`upload failed: ${upBody.error || up.status}`)
      log(`uploaded hash=${upBody.hash || artifactHash}`)

      let prev = ZERO_HASH
      try {
        const receipts = await apiJson<{ head: string }>(cfg, `/api/seats/${seatId}/receipts?limit=1`)
        if (receipts.head) prev = receipts.head as Hex
      } catch {
        /* first receipt on seat */
      }

      const durationMs = Date.now() - t0
      const receipt = {
        seatId,
        deviceKey: device.publicKey.toLowerCase(),
        taskId: String(task.taskId || task.nodeId || ''),
        jobId: String(task.jobId || ''),
        nodeId: String(task.nodeId || task.taskId || ''),
        leaseId: activeLeaseId,
        artifactHash,
        treeHash,
        prevReceiptHash: prev,
        modelClaim: {
          family: claimFamily,
          model: run ? run.model : useStub ? (out.kind === 'bundle' ? 'stub-project-v1' : 'stub-readme-v1') : 'local-runtime',
          providerMsgIdHash: (run?.providerMsgIdHash ?? null) as string | null,
          // Declared tier the work ran at; the backend fails the attempt (tier_mismatch) if it is below the node's tier.
          tier: run ? run.tier : helloPayload.maxTier,
        },
        tokensClaim: run ? run.tokens : 0,
        durationMs,
        outcome: 'submitted' as const,
        at: Math.floor(Date.now() / 1000),
      }

      if (leaseLost) {
        log(`lease ${activeLeaseId} was cancelled while the skill ran; not submitting`)
        return
      }
      saveOutbox({ leaseId: activeLeaseId, uploadUrl, content, artifactHash, treeHash, receipt, durationMs })
      const submitted = await request('submit', { leaseId: activeLeaseId, artifactHash, treeHash, receipt, durationMs, family: claimFamily }, ['lease_ok', 'cancel'], 3, 60_000)
      if (submitted?.kind === 'lease_ok' && submitted.payload?.submitted) {
        dropOutbox(activeLeaseId)
        const v = submitted.payload.verification as { result?: string } | undefined
        log(`SUBMITTED receipt=${submitted.payload.receiptHash} verify=${v?.result ?? '?'}`)
      } else {
        log(`submit result: ${JSON.stringify(submitted?.payload || {})} (kept in the outbox for resend)`)
      }
    } catch (err) {
      log(`offer handling error: ${(err as Error).message}`)
    } finally {
      activeLeaseId = null
      leaseLost = false
      busy = false
    }
  }

  const onMessage = (ev: { data: unknown }) => {
    const frame = parseFrame(String(ev.data))
    if (!frame) return
    lastServerFrameAt = Date.now()
    if (frame.kind === 'heartbeat_ack') {
      ackSeen = true
      return
    }
    // Renewal answers are bookkeeping only; they must not satisfy a pending accept / submit waiter.
    if (frame.kind === 'lease_ok' && frame.payload?.renew) {
      log(`renew ok lease=${frame.payload?.leaseId ?? activeLeaseId ?? '-'} until=${frame.payload?.leaseUntil ?? '-'}`)
      return
    }
    if (frame.kind === 'cancel' && frame.payload?.leaseId && orphanLeases.has(String(frame.payload.leaseId))) {
      orphanLeases.delete(String(frame.payload.leaseId))
      log(`released lease ${frame.payload.leaseId} (${frame.payload?.reason ?? '-'})`)
      return
    }
    const waiterIdx = pending.findIndex((p) => matches(frame, p.kinds, p.leaseId))
    if (waiterIdx >= 0) {
      const waiter = pending[waiterIdx]!
      clearTimeout(waiter.timer)
      pending.splice(waiterIdx, 1)
      waiter.resolve(frame)
      return
    }
    if (frame.kind === 'offer') {
      void handleOffer(frame)
      return
    }
    if (frame.kind === 'cancel') {
      log(`cancel ${JSON.stringify(frame.payload)}`)
      if (frame.payload?.leaseId && frame.payload.leaseId === activeLeaseId) leaseLost = true
      return
    }
    if (frame.kind === 'disconnect') {
      lastDisconnect = String(frame.payload?.reason || 'unknown')
      log(`disconnect ${JSON.stringify(frame.payload)}`)
      return
    }
    if (frame.kind === 'lease_ok') {
      queue.push(frame)
      if (queue.length > 20) queue.shift()
    }
  }

  /** One session: open, hello / challenge / welcome. Resolves with the authed socket; throws on failure. */
  const openSession = async (): Promise<{ sock: WebSocketLike; welcome: Record<string, unknown> }> => {
    log(`connecting ${url}`)
    const sock = connect(url)
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WebSocket open timeout')), 20_000)
      sock.addEventListener('open', () => (clearTimeout(t), resolve()), { once: true })
      sock.addEventListener('error', (e: { error?: Error; message?: string }) => (clearTimeout(t), reject(e?.error || new Error(e?.message || 'WebSocket error'))), { once: true })
      sock.addEventListener('close', (e: { code?: number }) => (clearTimeout(t), reject(new Error(`WebSocket closed ${e?.code ?? ''} before open`))), { once: true })
    })
    try {
      sock.send(JSON.stringify({ v: PROTOCOL_V, kind: 'hello', seatId, deviceKey: device.publicKey, payload: helloPayload }))
      const challengeRaw = await onceMessage(sock)
      const challenge = parseFrame(challengeRaw)
      if (!challenge || challenge.kind !== 'challenge') {
        if (challenge?.kind === 'disconnect') throwDisconnect(challenge)
        throw new Error(`expected challenge, got ${challengeRaw.slice(0, 200)}`)
      }
      const nonce = String(challenge.payload?.nonce || '')
      const authSig = await ed25519Sign(priv, challengeSignString(nonce))
      sock.send(JSON.stringify({ v: PROTOCOL_V, kind: 'challenge_response', payload: { sig: authSig } }))
      const welcomeRaw = await onceMessage(sock)
      const welcome = parseFrame(welcomeRaw)
      if (!welcome || welcome.kind !== 'welcome') {
        if (welcome?.kind === 'disconnect') throwDisconnect(welcome)
        throw new Error(`expected welcome, got ${welcomeRaw.slice(0, 200)}`)
      }
      return { sock, welcome: (welcome.payload || {}) as Record<string, unknown> }
    } catch (e) {
      try {
        sock.close(1000, 'handshake_failed')
      } catch {
        /* ignore */
      }
      throw e
    }
  }

  const throwDisconnect = (f: AgentFrame): never => {
    const reason = String(f.payload?.reason || 'unknown')
    if (FATAL_DISCONNECTS.has(reason)) throw new FatalError(`disconnected: ${reason}`)
    throw new Error(`disconnected: ${JSON.stringify(f.payload)}`)
  }

  /** After (re)connecting: release orphaned accepts, re-confirm an in-progress lease. */
  const resumeLeases = async () => {
    for (const id of [...orphanLeases]) {
      try {
        await sendSigned('fail', { leaseId: id, failureClass: 'machine', failureDetail: 'disconnected', reason: 'disconnected' })
        log(`releasing lease ${id} (accepted before the disconnect)`)
      } catch (err) {
        log(`release ${id} failed: ${(err as Error).message}`)
      }
    }
    if (activeLeaseId) {
      try {
        await sendSigned('renew', { leaseId: activeLeaseId })
        log(`resuming lease ${activeLeaseId} on the new session`)
      } catch (err) {
        log(`renew after reconnect failed: ${(err as Error).message}`)
      }
    }
    for (const item of listOutbox()) {
      if (item.leaseId === activeLeaseId) continue
      try {
        const up = await fetch(item.uploadUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: item.content }) })
        if (!up.ok) {
          log(`outbox ${item.leaseId}: upload not accepted (${up.status}); keeping it`)
          continue
        }
        const submitted = await request('submit', { leaseId: item.leaseId, artifactHash: item.artifactHash, treeHash: item.treeHash, receipt: item.receipt, durationMs: item.durationMs, family: (item.receipt.modelClaim as { family?: string } | undefined)?.family ?? null }, ['lease_ok', 'cancel'], 2, 60_000)
        if (submitted?.kind === 'lease_ok' && submitted.payload?.submitted) {
          dropOutbox(item.leaseId)
          log(`outbox ${item.leaseId}: resent`)
        } else log(`outbox ${item.leaseId}: not accepted yet`)
      } catch (err) {
        log(`outbox ${item.leaseId}: ${(err as Error).message}`)
      }
    }
  }

  const beat = async () => {
    if (stopped || !authed || ws?.readyState !== WS_OPEN) return
    if (ackSeen && Date.now() - lastServerFrameAt > 3 * heartbeatMs) {
      forceClose?.(`no heartbeat ack for ${Math.round((Date.now() - lastServerFrameAt) / 1000)}s`)
      return
    }
    await sendSigned('heartbeat', {
      runtime: modelCfg
        ? { mode: 'model', runtime: modelCfg.runtime, model: modelCfg.model, family: modelCfg.family, cliVersion: DAEMON_VERSION }
        : agent
          ? { mode: 'model', runtime: agentName, model: lastAgentModel ?? configuredModel(agent.kind, agent.cfg) ?? `${agent.kind}-default`, family: agentFamily, cliVersion: DAEMON_VERSION }
          : { mode: useStub ? 'stub' : 'local', runtime: null, model: null, family: null, cliVersion: DAEMON_VERSION },
      pausedUntil: pausedUntil > Date.now() ? Math.floor(pausedUntil / 1000) : 0,
      pauseReason: pausedUntil > Date.now() ? pauseReason : '',
    })
    log(`heartbeat seq=${seq}`)
    if (activeLeaseId) {
      try {
        await sendSigned('renew', { leaseId: activeLeaseId })
      } catch (err) {
        log(`renew error: ${(err as Error).message}`)
      }
    }
  }

  const onSignal = () => stop('stopped')
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  const durationMs = (opts.durationSec ?? 0) > 0 ? (opts.durationSec as number) * 1000 : 0
  const deadlineTimer = durationMs ? setTimeout(() => stop('duration'), durationMs) : null
  const interval = setInterval(() => {
    void beat().catch((err) => log(`heartbeat error: ${(err as Error).message}`))
  }, heartbeatMs)

  let failures = 0
  try {
    while (!stopped) {
      let sock: WebSocketLike
      try {
        const s = await openSession()
        sock = s.sock
        if (stopped) {
          sock.close(1000, 'pit_stop')
          break
        }
        firstWelcome ??= s.welcome
        log(`welcome protocol=${s.welcome.protocol} limits=${JSON.stringify(s.welcome.limits)} daemon=${DAEMON_VERSION}${sessions ? ` (reconnected, session ${sessions + 1})` : ''}`)
      } catch (err) {
        if (err instanceof FatalError) {
          log(`${err.message}: not reconnecting`)
          if (!sessions) throw err
          stopReason = err.message
          break
        }
        if (!reconnect && !sessions) throw err
        if (!reconnect) break
        failures++
        if (opts.maxRetries && failures > opts.maxRetries) {
          stopReason = `gave up after ${failures - 1} reconnect attempt(s): ${(err as Error).message}`
          log(stopReason)
          break
        }
        const d = backoffDelay(failures, opts.backoff, opts.random)
        log(`connect failed (${(err as Error).message}); retry ${failures} in ${(d / 1000).toFixed(1)}s`)
        await sleep(d)
        continue
      }
      // ---- authed session
      ws = sock
      authed = true
      sessions += 1
      failures = 0
      lastDisconnect = null
      ackSeen = false
      lastServerFrameAt = Date.now()
      sock.addEventListener('message', onMessage)
      const closed = new Promise<{ code?: number; reason?: string }>((resolve) => {
        sock.addEventListener('close', (e: { code?: number; reason?: string }) => resolve(e ?? {}), { once: true })
        // Half-open socket (no close event will come): stop waiting for it.
        forceClose = (why: string) => {
          log(`${why}; dropping the socket`)
          try {
            sock.close(4000, 'stale')
          } catch {
            /* ignore */
          }
          resolve({ code: 4000, reason: why })
        }
      })
      for (const w of connectedWaiters.splice(0)) w()
      await resumeLeases()
      await beat().catch((err) => log(`heartbeat error: ${(err as Error).message}`))
      const ev = await closed
      forceClose = null
      authed = false
      sock.removeEventListener('message', onMessage)
      // Fail the in-flight waiters of this session now (they resend on the next session).
      for (const p of pending.splice(0)) {
        clearTimeout(p.timer)
        p.resolve(null)
      }
      if (stopped) break
      const why = lastDisconnect ?? `close ${ev.code ?? '?'}${ev.reason ? ` ${ev.reason}` : ''}`
      if (lastDisconnect && FATAL_DISCONNECTS.has(lastDisconnect)) {
        stopReason = `disconnected: ${lastDisconnect}`
        log(`${stopReason}: not reconnecting`)
        break
      }
      if (!reconnect) {
        stopReason = `connection closed (${why})`
        break
      }
      failures = 1
      const d = backoffDelay(failures, opts.backoff, opts.random)
      log(`connection lost (${why}); reconnecting in ${(d / 1000).toFixed(1)}s${activeLeaseId ? ` (lease ${activeLeaseId} in progress)` : ''}`)
      await sleep(d)
    }
  } finally {
    clearInterval(interval)
    if (deadlineTimer) clearTimeout(deadlineTimer)
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    for (const p of pending.splice(0)) {
      clearTimeout(p.timer)
      p.resolve(null)
    }
  }
  // Let an in-flight task notice the stop before returning.
  for (let i = 0; i < 50 && busy; i++) await new Promise((r) => setTimeout(r, 20))
  log('stopped')
  return { seatId, welcome: firstWelcome ?? {}, sessions, reason: stopReason }
}
