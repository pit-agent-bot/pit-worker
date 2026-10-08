/**
 * Real model adapter (holder side only): OpenAI-compatible chat completions or Anthropic-compatible messages on THIS
 * machine, with provider presets (providers.ts) for OpenAI, Anthropic, DeepSeek, Kimi, GLM, Qwen and OpenRouter. The server never sees a
 * model key; the per-seat config stores only the NAMES of the environment variables that hold the base URL / key, never
 * their values. Every call is bounded (timeout, retries with backoff, completion-token cap) and its token usage is
 * appended to <PIT_HOME>/usage.jsonl (tokens only; no prompt text, no key).
 */
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { keccak256, toBytes } from 'viem'
import { pitHome } from './paths.ts'
import { presetEndpoint, presetFamily, providerPreset, type WireApi } from './providers.ts'

export const MODEL_RUNTIME = 'openai-compat'
export const MODEL_RUNTIMES: readonly WireApi[] = ['openai-compat', 'anthropic-compat']
export const TIERS = ['economy', 'standard', 'premium'] as const
export type Tier = (typeof TIERS)[number]

export interface ModelConfig {
  /** Wire API: openai-compat (POST <baseUrl>/chat/completions) or anthropic-compat (POST <baseUrl>/v1/messages). */
  runtime: WireApi
  /** Preset the defaults came from (informational; every field below is explicit in the saved file). */
  provider?: string
  /** Real model family of `model` (claude / gpt / gemini / deepseek / ...): declared to the scheduler and claimed in receipts. */
  family: string
  /** Base URL (e.g. https://api.deepseek.com) or the name of an env var holding it (e.g. RELAY_BASE_URL). */
  baseUrl?: string
  baseUrlEnv?: string
  /** Name of the env var holding the API key. The key itself is never stored or logged. */
  keyEnv: string
  /** When set, the key is read from PIT_HOME/model.key instead of keyEnv. Still never logged. */
  keyFile?: string
  model: string
  /** Tier the main model runs at (claimed in receipts; the backend refuses work below the node's tier). */
  tier: Tier
  /** Optional cheaper model of the same family for economy-tier nodes (claimed as tier economy). */
  cheapModel?: string
  /** Default completion-token cap per call (skills may ask for less; never more than maxTokensCap). */
  maxTokens: number
  maxTokensCap: number
  /** Prompt budget: characters of upstream input packed into one prompt. */
  maxInputChars: number
  timeoutSec: number
  retries: number
  temperature: number
  /** Stop accepting offers after this many tokens in the last 24 h (0 = no limit). */
  dailyTokenBudget: number
  /** Optional reasoning controls for reasoning models (sent as reasoning_effort / thinking.type); keeps hidden reasoning cheap. */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high'
  thinking?: 'adaptive' | 'enabled' | 'disabled'
  /** Stream the answer (SSE). Headers arrive at once, so slow models are not cut by a proxy's first-byte timeout (e.g. HTTP 524). */
  stream?: boolean
}

export const MODEL_DEFAULTS: Omit<ModelConfig, 'family' | 'keyEnv' | 'model' | 'provider'> = {
  runtime: MODEL_RUNTIME,
  tier: 'standard',
  maxTokens: 2500,
  maxTokensCap: 8000,
  maxInputChars: 120_000,
  timeoutSec: 240,
  retries: 2,
  temperature: 0.3,
  dailyTokenBudget: 400_000,
}

export const modelConfigPath = () => join(pitHome(), 'model.json')
export const usagePath = () => join(pitHome(), 'usage.jsonl')
/** Basename only. The key lives in this file (mode 0600), never in model.json or argv. */
export const MODEL_KEY_FILE = 'model.key'
export const modelKeyPath = () => join(pitHome(), MODEL_KEY_FILE)

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/

/** Validate + fill defaults. Throws on anything that could leak a secret into the file (raw keys) or is malformed. */
export function normalizeModelConfig(raw: Record<string, unknown>): ModelConfig {
  for (const k of ['apiKey', 'key', 'token', 'authorization']) if (k in raw) throw new Error(`model config must not contain "${k}": store the env var NAME in keyEnv`)
  const filled: Record<string, unknown> = { ...raw }
  if (raw.provider !== undefined) {
    // A preset fills only what the holder did not set; the saved file then holds explicit values.
    const p = providerPreset(String(raw.provider))
    const ep = presetEndpoint(p, raw.runtime as WireApi | undefined)
    filled.provider = p.id
    filled.runtime = ep.api
    if (filled.baseUrl === undefined && filled.baseUrlEnv === undefined) filled.baseUrl = ep.baseUrl
    if (filled.model === undefined && ep.model) filled.model = ep.model
    if (filled.keyEnv === undefined) filled.keyEnv = p.keyEnv
    if (filled.family === undefined && filled.model) filled.family = presetFamily(p, String(filled.model))
  }
  const cfg = { ...MODEL_DEFAULTS, ...filled } as ModelConfig
  if (!MODEL_RUNTIMES.includes(cfg.runtime)) throw new Error(`runtime must be ${MODEL_RUNTIMES.join(' or ')}`)
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(String(cfg.family ?? ''))) throw new Error('family is required (claude / gpt / gemini / deepseek / ...)')
  if (cfg.family === 'stub') throw new Error('family "stub" is reserved for the stub runtime')
  if (!ENV_NAME.test(String(cfg.keyEnv ?? ''))) throw new Error('keyEnv must be an environment variable name (e.g. DEEPSEEK_API_KEY)')
  if (!cfg.model || !/^[A-Za-z0-9._:/\[\]-]{1,80}$/.test(cfg.model)) throw new Error('model is required')
  if (cfg.cheapModel !== undefined && !/^[A-Za-z0-9._:/-]{1,80}$/.test(cfg.cheapModel)) throw new Error('cheapModel is invalid')
  if (!!cfg.baseUrl === !!cfg.baseUrlEnv) throw new Error('set exactly one of baseUrl or baseUrlEnv')
  if (cfg.baseUrlEnv && !ENV_NAME.test(cfg.baseUrlEnv)) throw new Error('baseUrlEnv must be an environment variable name')
  if (cfg.baseUrl && !/^https:\/\/[^\s]+$/.test(cfg.baseUrl)) throw new Error('baseUrl must be https://')
  if (!(TIERS as readonly string[]).includes(cfg.tier)) throw new Error(`tier must be one of ${TIERS.join(', ')}`)
  const int = (v: unknown, lo: number, hi: number, name: string) => {
    const n = Math.floor(Number(v))
    if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${name} must be ${lo}..${hi}`)
    return n
  }
  cfg.maxTokensCap = int(cfg.maxTokensCap, 64, 64_000, 'maxTokensCap')
  cfg.maxTokens = Math.min(int(cfg.maxTokens, 64, 64_000, 'maxTokens'), cfg.maxTokensCap)
  cfg.maxInputChars = int(cfg.maxInputChars, 1000, 400_000, 'maxInputChars')
  cfg.timeoutSec = int(cfg.timeoutSec, 5, 900, 'timeoutSec')
  cfg.retries = int(cfg.retries, 0, 5, 'retries')
  cfg.dailyTokenBudget = int(cfg.dailyTokenBudget, 0, 100_000_000, 'dailyTokenBudget')
  if (cfg.reasoningEffort !== undefined && !['minimal', 'low', 'medium', 'high'].includes(cfg.reasoningEffort)) throw new Error('reasoningEffort must be minimal / low / medium / high')
  if (cfg.thinking !== undefined && !['adaptive', 'enabled', 'disabled'].includes(cfg.thinking)) throw new Error('thinking must be adaptive / enabled / disabled')
  if (cfg.stream !== undefined && typeof cfg.stream !== 'boolean') throw new Error('stream must be true or false')
  if (cfg.keyFile !== undefined && cfg.keyFile !== MODEL_KEY_FILE) throw new Error('keyFile must be model.key (the key itself is never stored in model.json)')
  const t = Number(cfg.temperature)
  cfg.temperature = Number.isFinite(t) ? Math.min(1.5, Math.max(0, t)) : 0.3
  return cfg
}

export function loadModelConfig(): ModelConfig | null {
  const p = modelConfigPath()
  if (!existsSync(p)) return null
  return normalizeModelConfig(JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>)
}

export function saveModelConfig(cfg: ModelConfig) {
  const p = modelConfigPath()
  writeFileSync(p, JSON.stringify(normalizeModelConfig(cfg as unknown as Record<string, unknown>), null, 2) + '\n', { mode: 0o600 })
  try {
    chmodSync(p, 0o600)
  } catch {
    /* ignore */
  }
}

/** Write the API key to PIT_HOME/model.key (mode 0600). The caller must not log `key`. */
export function modelKeyPresent(): boolean {
  return existsSync(modelKeyPath())
}

export function saveModelKey(key: string) {
  const trimmed = key.trim()
  if (!trimmed) throw new Error('empty api key')
  if (trimmed.includes('\n') || trimmed.includes('\r')) throw new Error('api key must be a single line')
  const p = modelKeyPath()
  writeFileSync(p, trimmed + '\n', { mode: 0o600 })
  try { chmodSync(p, 0o600) } catch { /* ignore */ }
}

/** Resolve base URL + key. A keyFile wins over the env var. Values stay in memory and are never logged. */
export function resolveEndpoint(cfg: ModelConfig, env: NodeJS.ProcessEnv = process.env): { baseUrl: string; apiKey: string } {
  const baseUrl = (cfg.baseUrl ?? env[cfg.baseUrlEnv!] ?? '').trim().replace(/\/+$/, '')
  if (!/^https:\/\//.test(baseUrl)) throw new Error(`model base URL missing or not https (${cfg.baseUrl ? 'baseUrl' : `env ${cfg.baseUrlEnv}`})`)
  let apiKey = ''
  if (cfg.keyFile) {
    const p = modelKeyPath()
    if (!existsSync(p)) throw new Error('model key file is missing (pit model --api-key)')
    apiKey = (readFileSync(p, 'utf8').split('\n')[0] ?? '').trim()
    if (!apiKey) throw new Error('model key file is empty (pit model --api-key)')
  } else {
    apiKey = (env[cfg.keyEnv] ?? '').trim()
    if (!apiKey) throw new Error(`model key env ${cfg.keyEnv} is not set`)
  }
  return { baseUrl, apiKey }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  reasoningTokens: number
  cachedTokens: number
}

export interface ChatResult {
  text: string
  model: string
  finishReason: string
  usage: ChatUsage
  /** keccak256 of the provider's response id (receipt field providerMsgIdHash; the id itself is not sent). */
  providerMsgIdHash: string | null
  ms: number
  attempts: number
}

export class ModelError extends Error {
  status: number | null
  retryable: boolean
  constructor(message: string, status: number | null, retryable: boolean) {
    super(message)
    this.status = status
    this.retryable = retryable
  }
}

export interface ChatOptions {
  model?: string
  maxTokens?: number
  temperature?: number
  /** Test hooks. */
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  env?: NodeJS.ProcessEnv
}

/** Remove anything key-like from provider error text before it can reach a log. */
export function scrub(s: string, secrets: string[] = []): string {
  let out = String(s ?? '')
  for (const v of secrets) if (v && v.length >= 8) out = out.split(v).join('[redacted]')
  return out.replace(/\b(sk|pk|key|tok)[-_][A-Za-z0-9_-]{12,}\b/g, '[redacted]').replace(/Bearer\s+[A-Za-z0-9._-]{12,}/g, 'Bearer [redacted]').slice(0, 300)
}

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0)

export function usageOf(u: Record<string, unknown> | undefined | null): ChatUsage {
  const p = num(u?.prompt_tokens)
  const c = num(u?.completion_tokens)
  const details = (u?.completion_tokens_details ?? {}) as Record<string, unknown>
  const pdetails = (u?.prompt_tokens_details ?? {}) as Record<string, unknown>
  return { promptTokens: p, completionTokens: c, totalTokens: num(u?.total_tokens) || p + c, reasoningTokens: num(details.reasoning_tokens), cachedTokens: num(pdetails.cached_tokens) || num(u?.prompt_cache_hit_tokens) }
}

/** Fold an SSE chat-completion stream into the non-streamed response shape (content, finish_reason, usage, id, model). */
export function fromSse(text: string): Record<string, any> {
  let content = ''
  let finish = ''
  let usage: unknown = null
  let id = ''
  let model = ''
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') continue
    let c: Record<string, any>
    try {
      c = JSON.parse(data)
    } catch {
      continue
    }
    if (c.error) return { error: c.error }
    id ||= String(c.id ?? '')
    model ||= String(c.model ?? '')
    if (c.usage) usage = c.usage
    const ch = c.choices?.[0]
    const d = ch?.delta?.content ?? ch?.message?.content
    if (typeof d === 'string') content += d
    else if (Array.isArray(d)) content += d.map((p: { text?: string }) => p?.text ?? '').join('')
    if (ch?.finish_reason) finish = String(ch.finish_reason)
  }
  return { id: id || undefined, model: model || undefined, choices: [{ message: { content }, finish_reason: finish }], usage }
}

/** Connect or body-read failure: a timeout / abort or a network error; retryable, and a machine failure upstream. */
function transportError(e: unknown, cfg: ModelConfig, apiKey: string, phase: string): ModelError {
  const err = e as Error | undefined
  const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError'
  return new ModelError(timeout ? `model call timed out after ${cfg.timeoutSec}s${phase}` : `network error${phase}: ${scrub(String(err?.message ?? e), [apiKey])}`, null, true)
}

/**
 * One chat completion with timeout + retries (429 / 5xx / network / timeout; exponential backoff). A 400 that names
 * max_tokens is retried once with max_completion_tokens (newer OpenAI-style endpoints); a 400 that names temperature is
 * retried once without it (models that only accept the default).
 */
export async function chatComplete(cfg: ModelConfig, messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
  if (cfg.runtime === 'anthropic-compat') return messagesComplete(cfg, messages, opts)
  const { baseUrl, apiKey } = resolveEndpoint(cfg, opts.env)
  const f = opts.fetch ?? fetch
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const model = opts.model ?? cfg.model
  const maxTokens = Math.max(16, Math.min(cfg.maxTokensCap, Math.floor(opts.maxTokens ?? cfg.maxTokens)))
  let tokenField: 'max_tokens' | 'max_completion_tokens' = 'max_tokens'
  let sendTemperature = true
  const t0 = Date.now()
  let last: ModelError | null = null
  for (let attempt = 1; attempt <= cfg.retries + 1; attempt++) {
    const body: Record<string, unknown> = { model, messages, [tokenField]: maxTokens, stream: !!cfg.stream }
    if (cfg.stream) body.stream_options = { include_usage: true }
    if (sendTemperature) body.temperature = opts.temperature ?? cfg.temperature
    if (cfg.reasoningEffort) body.reasoning_effort = cfg.reasoningEffort
    if (cfg.thinking) body.thinking = { type: cfg.thinking }
    let res: Response
    try {
      res = await f(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(cfg.timeoutSec * 1000),
      })
    } catch (e) {
      last = transportError(e, cfg, apiKey, '')
      if (attempt <= cfg.retries) await sleep(Math.min(30_000, 1500 * 2 ** (attempt - 1)))
      continue
    }
    // The timeout signal also covers the body: a provider that sends headers and then stalls fails here, not in fetch.
    // Report it as a ModelError (a machine failure, retried like a connect timeout), never as a bad answer.
    let text: string
    try {
      text = await res.text()
    } catch (e) {
      last = transportError(e, cfg, apiKey, ' (reading the response)')
      if (attempt <= cfg.retries) await sleep(Math.min(30_000, 1500 * 2 ** (attempt - 1)))
      continue
    }
    let j: Record<string, any> = {}
    try {
      j = res.ok && /^\s*(data:|event:|:)/.test(text) ? fromSse(text) : JSON.parse(text)
    } catch {
      j = {}
    }
    if (!res.ok) {
      const msg = scrub(String(j?.error?.message ?? text), [apiKey])
      if (res.status === 400 && tokenField === 'max_tokens' && /max_tokens|max_completion_tokens/i.test(msg)) {
        tokenField = 'max_completion_tokens'
        attempt--
        continue
      }
      // Some models only accept the default temperature: retry once without it.
      if (res.status === 400 && sendTemperature && /temperature/i.test(msg)) {
        sendTemperature = false
        attempt--
        continue
      }
      const retryable = res.status === 429 || res.status >= 500 || res.status === 408
      last = new ModelError(`model HTTP ${res.status}: ${msg}`, res.status, retryable)
      if (!retryable) throw last
      if (attempt <= cfg.retries) {
        const ra = Number(res.headers.get('retry-after'))
        await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(60_000, ra * 1000) : Math.min(30_000, 2000 * 2 ** (attempt - 1)))
      }
      continue
    }
    const choice = j?.choices?.[0]
    const content = choice?.message?.content
    const out = typeof content === 'string' ? content : Array.isArray(content) ? content.map((p: { text?: string }) => p?.text ?? '').join('') : ''
    return {
      text: out,
      model: String(j?.model ?? model),
      finishReason: String(choice?.finish_reason ?? ''),
      usage: usageOf(j?.usage),
      providerMsgIdHash: j?.id ? keccak256(toBytes(String(j.id))) : null,
      ms: Date.now() - t0,
      attempts: attempt,
    }
  }
  throw last ?? new ModelError('model call failed', null, true)
}

/** Anthropic Messages usage: cache writes count as input, cache reads are reported as cached. */
export function anthropicUsageOf(u: Record<string, unknown> | undefined | null): ChatUsage {
  const p = num(u?.input_tokens) + num(u?.cache_creation_input_tokens)
  const c = num(u?.output_tokens)
  return { promptTokens: p, completionTokens: c, totalTokens: p + c, reasoningTokens: 0, cachedTokens: num(u?.cache_read_input_tokens) }
}

/**
 * One Anthropic-compatible Messages call (Anthropic, and the endpoints DeepSeek / Kimi / GLM / Qwen / OpenRouter offer):
 * POST <baseUrl>/v1/messages. The key goes in x-api-key; non-Anthropic endpoints also get it as a Bearer token (Kimi,
 * GLM and Qwen document ANTHROPIC_AUTH_TOKEN). Same timeout / retry rules as chatComplete (429, 529, 5xx, network).
 */
export async function messagesComplete(cfg: ModelConfig, messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
  const { baseUrl, apiKey } = resolveEndpoint(cfg, opts.env)
  const f = opts.fetch ?? fetch
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const model = opts.model ?? cfg.model
  const maxTokens = Math.max(16, Math.min(cfg.maxTokensCap, Math.floor(opts.maxTokens ?? cfg.maxTokens)))
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
  const turns = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }))
  const official = /^https:\/\/api\.anthropic\.com(\/|$)/.test(baseUrl)
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
  if (!official) headers.authorization = `Bearer ${apiKey}`
  const url = /\/v1$/.test(baseUrl) ? `${baseUrl}/messages` : `${baseUrl}/v1/messages`
  let sendTemperature = true
  const t0 = Date.now()
  let last: ModelError | null = null
  for (let attempt = 1; attempt <= cfg.retries + 1; attempt++) {
    const body: Record<string, unknown> = { model, max_tokens: maxTokens, messages: turns }
    if (system) body.system = system
    if (sendTemperature) body.temperature = Math.min(1, opts.temperature ?? cfg.temperature)
    let res: Response
    try {
      res = await f(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(cfg.timeoutSec * 1000) })
    } catch (e) {
      last = transportError(e, cfg, apiKey, '')
      if (attempt <= cfg.retries) await sleep(Math.min(30_000, 1500 * 2 ** (attempt - 1)))
      continue
    }
    let text: string
    try {
      text = await res.text()
    } catch (e) {
      last = transportError(e, cfg, apiKey, ' (reading the response)')
      if (attempt <= cfg.retries) await sleep(Math.min(30_000, 1500 * 2 ** (attempt - 1)))
      continue
    }
    let j: Record<string, any> = {}
    try {
      j = JSON.parse(text)
    } catch {
      j = {}
    }
    if (!res.ok || j?.type === 'error') {
      const status = res.ok ? 500 : res.status
      const msg = scrub(String(j?.error?.message ?? text), [apiKey])
      if (status === 400 && sendTemperature && /temperature/i.test(msg)) {
        sendTemperature = false
        attempt--
        continue
      }
      const retryable = status === 429 || status >= 500 || status === 408
      last = new ModelError(`model HTTP ${status}: ${msg}`, status, retryable)
      if (!retryable) throw last
      if (attempt <= cfg.retries) {
        const ra = Number(res.headers.get('retry-after'))
        await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(60_000, ra * 1000) : Math.min(30_000, 2000 * 2 ** (attempt - 1)))
      }
      continue
    }
    const content = Array.isArray(j?.content) ? j.content : []
    return {
      text: content.filter((c: { type?: string }) => c?.type === 'text').map((c: { text?: string }) => c.text ?? '').join(''),
      model: String(j?.model ?? model),
      // max_tokens -> 'length' so the skill loop treats a cut-off answer the same way on both wire APIs.
      finishReason: j?.stop_reason === 'max_tokens' ? 'length' : String(j?.stop_reason ?? ''),
      usage: anthropicUsageOf(j?.usage),
      providerMsgIdHash: j?.id ? keccak256(toBytes(String(j.id))) : null,
      ms: Date.now() - t0,
      attempts: attempt,
    }
  }
  throw last ?? new ModelError('model call failed', null, true)
}

// ------------------------------------------------------------------ usage log (tokens only)

export interface UsageLine {
  at: number
  seatId: number | null
  family: string
  model: string
  skill: string
  leaseId: string | null
  jobId: string | null
  promptTokens: number
  completionTokens: number
  totalTokens: number
  reasoningTokens: number
  cachedTokens: number
  ms: number
  ok: boolean
}

export function logUsage(line: UsageLine, path = usagePath()) {
  appendFileSync(path, JSON.stringify(line) + '\n', { mode: 0o600 })
}

export function readUsage(path = usagePath()): UsageLine[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as UsageLine]
      } catch {
        return []
      }
    })
}

export interface UsageTotals {
  calls: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  reasoningTokens: number
  cachedTokens: number
}

export function usageTotals(lines: UsageLine[], since = 0): Record<string, UsageTotals> {
  const out: Record<string, UsageTotals> = {}
  for (const l of lines) {
    if (l.at < since) continue
    const t = (out[l.model] ??= { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, reasoningTokens: 0, cachedTokens: 0 })
    t.calls++
    t.promptTokens += l.promptTokens
    t.completionTokens += l.completionTokens
    t.totalTokens += l.totalTokens
    t.reasoningTokens += l.reasoningTokens ?? 0
    t.cachedTokens += l.cachedTokens ?? 0
  }
  return out
}

/** Tokens used in the last 24 h (budget check before accepting an offer). */
export function tokensLast24h(lines: UsageLine[], nowSec = Math.floor(Date.now() / 1000)): number {
  return lines.filter((l) => l.at > nowSec - 86_400).reduce((s, l) => s + l.totalTokens, 0)
}
