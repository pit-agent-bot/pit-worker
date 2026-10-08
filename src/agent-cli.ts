/**
 * Harness runtimes: an agent CLI on the seat holder's machine (Codex CLI, Claude Code, Kimi Code, or any CLI declared
 * in config through the generic `command` adapter), run non-interactively with the holder's own login or with a
 * provider key the holder configured (Claude Code pointed at DeepSeek / Kimi / GLM Anthropic-compatible endpoints).
 * Clean-room implementation: behaviour follows each CLI's own public documentation and --help.
 *
 * Every harness is one HarnessSpec (binary, arguments, prompt delivery, event parser, own env vars, doctor checks);
 * the built-ins are presets of the same mechanism the `command` adapter uses.
 *
 * Every invocation:
 * - gets an allowlisted minimal environment (PATH, HOME, locale, temp dir, proxy / CA settings and the CLI's own auth
 *   variables); wallet keys, Pit settings, tokens, secrets and other API keys never reach the child,
 * - reads its prompt from stdin (argv is visible to other local users in `ps` and limited to 128 KiB per argument),
 * - runs in its own process group, so a timeout or a daemon stop kills the CLI and everything it started,
 * - is parsed from the CLI's JSON event stream (final answer, token usage, model, error kind).
 * Failures are classified: timeouts / kills / crashes are machine failures (retryable elsewhere); a rate limit pauses
 * new leases for a few minutes; a missing login, a billing problem or a broken sandbox pauses them longer.
 */
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { keccak256, toBytes } from 'viem'
import { ModelError, scrub, TIERS, type ChatUsage, type Tier } from './model.ts'
import { pitHome } from './paths.ts'
import { presetFamily, providerPreset, PROVIDERS } from './providers.ts'
import { assertClaudeModel, assertCodexModel } from './official-models.ts'
import { planLaunch } from './sandbox.ts'

export const AGENT_KINDS = ['codex', 'claude', 'kimi', 'command'] as const
export type AgentKind = (typeof AGENT_KINDS)[number]
export const AGENT_BIN_ENV: Record<AgentKind, string> = { codex: 'PIT_CODEX_BIN', claude: 'PIT_CLAUDE_BIN', kimi: 'PIT_KIMI_BIN', command: 'PIT_COMMAND_BIN' }
/** Order `--runtime local` tries when no default is configured (first installed wins). */
export const LOCAL_ORDER: AgentKind[] = ['codex', 'claude', 'kimi', 'command']
export const BUILTIN_DEFAULT: AgentKind = 'codex'

/** Generic adapter: any agent CLI declared in runtime.json. */
export interface CommandSpec {
  /** Label shown in logs / heartbeats (e.g. "aider", "qwen-code"). */
  name: string
  /** Binary (absolute path or command on PATH). */
  bin: string
  /** Argument template: {dir} working dir, {model}, {mode} (read-only | workspace-write), {prompt}, {task_file}. */
  args: string[]
  /** stdin = full prompt on stdin; arg = {prompt} is the full prompt when it fits, else a pointer to TASK.md; file = always the pointer. */
  prompt: 'stdin' | 'arg' | 'file'
  /** text = stdout is the answer; jsonl = last JSON line with `resultField` holds it (usage from its `usage`). */
  output: 'text' | 'jsonl'
  resultField?: string
  /** Model family the CLI runs (declared + claimed: never a borrowed label). */
  family: string
  model?: string
  /** Extra env var NAMES the CLI needs (its own API key, config dir). Wallet / Pit variables are refused. */
  passEnv?: string[]
  versionArgs?: string[]
}

export const CODEX_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export interface AgentConfig {
  /** Runtime `pit start --runtime local` uses when several harnesses are installed. */
  default?: AgentKind
  /** Tier the seat declares and claims (the backend fails work below the node's tier). */
  tier: Tier
  /** Wall-clock budget for one lease, all repair rounds included; the process group is killed when it runs out. */
  timeoutSec: number
  /** Claude Code --max-turns per invocation (Codex has no turn cap; the timeout bounds it). */
  maxTurns: number
  /** Extra rounds after an answer fails the local contract check (each round is a fresh CLI run in the same dir). */
  repairs: number
  /** Upstream input budget (characters): reported in hello; larger inputs are refused (config_refused). */
  maxInputChars: number
  /** Stop accepting offers after this many CLI-reported tokens in the last 24 h (0 = no limit). */
  dailyTokenBudget: number
  /** Let sandboxed commands use the network (default off). */
  network: boolean
  codexModel?: string
  codexEffort?: (typeof CODEX_EFFORTS)[number]
  claudeModel?: string
  claudeEffort?: (typeof CLAUDE_EFFORTS)[number]
  /**
   * Point Claude Code at a provider's Anthropic-compatible endpoint (deepseek, kimi, kimi-cn, glm, glm-cn, or anthropic
   * for an API key) instead of the holder's Claude subscription. The seat then declares that provider's family.
   */
  claudeProvider?: string
  /** Env var NAME holding that provider's key (default: the preset's, e.g. ZAI_API_KEY). */
  claudeKeyEnv?: string
  /** Override the preset's Anthropic-compatible base URL. */
  claudeBaseUrl?: string
  kimiModel?: string
  command?: CommandSpec
  /** When the holder accepted the subscription / terms notice (unix seconds); harness runtimes refuse to start without it. */
  termsAcceptedAt?: number
  /** Extra acknowledgement for the unsandboxed `command` adapter (H5). */
  commandTermsAcceptedAt?: number
}

export const AGENT_DEFAULTS: AgentConfig = {
  tier: 'standard',
  timeoutSec: 1200,
  maxTurns: 40,
  repairs: 1,
  maxInputChars: 200_000,
  dailyTokenBudget: 0,
  network: false,
}

export const agentConfigPath = () => join(pitHome(), 'runtime.json')
const MODEL_ID = /^[A-Za-z0-9._:/\[\]-]{1,80}$/
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/
/** Variables that may never be handed to a harness, even when configured (wallet keys, Pit settings). */
export const WALLET_ENV = /(^PIT_)|(^|_)PK$|PRIVATE|MNEMONIC|SEED|WALLET|DEPLOYER/i

export function normalizeAgentConfig(raw: Record<string, unknown>): AgentConfig {
  for (const k of Object.keys(raw)) if (/^(api_?key|key|token|secret|password|authorization)$/i.test(k)) throw new Error(`runtime config must not contain "${k}": store env var NAMES only`)
  const cfg = { ...AGENT_DEFAULTS, ...raw } as AgentConfig
  if (cfg.default !== undefined && !(AGENT_KINDS as readonly string[]).includes(cfg.default)) throw new Error(`default must be ${AGENT_KINDS.join(' or ')}`)
  if (!(TIERS as readonly string[]).includes(cfg.tier)) throw new Error(`tier must be one of ${TIERS.join(', ')}`)
  const int = (v: unknown, lo: number, hi: number, name: string) => {
    const n = Math.floor(Number(v))
    if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${name} must be ${lo}..${hi}`)
    return n
  }
  cfg.timeoutSec = int(cfg.timeoutSec, 30, 3600, 'timeoutSec')
  cfg.maxTurns = int(cfg.maxTurns, 1, 500, 'maxTurns')
  cfg.repairs = int(cfg.repairs, 0, 3, 'repairs')
  cfg.maxInputChars = int(cfg.maxInputChars, 1000, 400_000, 'maxInputChars')
  cfg.dailyTokenBudget = int(cfg.dailyTokenBudget, 0, 1_000_000_000, 'dailyTokenBudget')
  if (typeof cfg.network !== 'boolean') throw new Error('network must be true or false')
  for (const k of ['codexModel', 'claudeModel'] as const) if (cfg[k] !== undefined && !MODEL_ID.test(String(cfg[k]))) throw new Error(`${k} is invalid`)
  if (cfg.codexModel !== undefined) assertCodexModel(cfg.codexModel)
  // Subscription Claude picks an official Claude Code model. A claudeProvider is the official-seat API path and may name that vendor's model.
  if (cfg.claudeModel !== undefined && cfg.claudeProvider === undefined) assertClaudeModel(cfg.claudeModel)
  if (cfg.codexEffort !== undefined && !(CODEX_EFFORTS as readonly string[]).includes(cfg.codexEffort)) throw new Error(`codexEffort must be ${CODEX_EFFORTS.join(' / ')}`)
  if (cfg.claudeEffort !== undefined && !(CLAUDE_EFFORTS as readonly string[]).includes(cfg.claudeEffort)) throw new Error(`claudeEffort must be ${CLAUDE_EFFORTS.join(' / ')}`)
  if (cfg.kimiModel !== undefined && !MODEL_ID.test(String(cfg.kimiModel))) throw new Error('kimiModel is invalid')
  if (cfg.claudeProvider !== undefined) {
    const p = providerPreset(String(cfg.claudeProvider))
    if (!p.anthropic && !cfg.claudeBaseUrl) throw new Error(`${p.label} has no Anthropic-compatible endpoint for Claude Code`)
    cfg.claudeProvider = p.id
    if (p.id !== 'anthropic' && !cfg.claudeModel && !p.anthropic?.model) throw new Error(`${p.label} needs --claude-model (no default model)`)
    presetFamily(p, cfg.claudeModel ?? p.anthropic?.model)
  }
  if (cfg.claudeKeyEnv !== undefined && (!ENV_NAME.test(cfg.claudeKeyEnv) || WALLET_ENV.test(cfg.claudeKeyEnv))) throw new Error('claudeKeyEnv must be an env var name (not a wallet / Pit variable)')
  if (cfg.claudeBaseUrl !== undefined && !/^https:\/\/\S+$/.test(cfg.claudeBaseUrl)) throw new Error('claudeBaseUrl must be https://')
  if (cfg.command !== undefined) cfg.command = normalizeCommand(cfg.command as unknown as Record<string, unknown>)
  if (cfg.termsAcceptedAt !== undefined && !(Number.isInteger(cfg.termsAcceptedAt) && cfg.termsAcceptedAt > 0)) throw new Error('termsAcceptedAt must be a unix time')
  if (cfg.commandTermsAcceptedAt !== undefined && !(Number.isInteger(cfg.commandTermsAcceptedAt) && cfg.commandTermsAcceptedAt > 0)) throw new Error('commandTermsAcceptedAt must be a unix time')
  return cfg
}

export function normalizeCommand(raw: Record<string, unknown>): CommandSpec {
  const c = { prompt: 'stdin', output: 'text', ...raw } as CommandSpec
  if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(String(c.name ?? ''))) throw new Error('command.name is required (lowercase label, e.g. aider)')
  if (typeof c.bin !== 'string' || !c.bin.trim() || /\s/.test(c.bin)) throw new Error('command.bin is required (a binary path or name, no spaces)')
  if (!Array.isArray(c.args) || c.args.some((a) => typeof a !== 'string') || c.args.length > 64) throw new Error('command.args must be a list of strings')
  if (!['stdin', 'arg', 'file'].includes(c.prompt)) throw new Error('command.prompt must be stdin, arg or file')
  if ((c.prompt === 'arg' || c.prompt === 'file') && !c.args.some((a) => a.includes(c.prompt === 'arg' ? '{prompt}' : '{task_file}') || a.includes('{prompt}'))) throw new Error(`command.args must contain {prompt}${c.prompt === 'file' ? ' or {task_file}' : ''} for prompt=${c.prompt}`)
  if (!['text', 'jsonl'].includes(c.output)) throw new Error('command.output must be text or jsonl')
  if (c.resultField !== undefined && !/^[A-Za-z0-9_.]{1,64}$/.test(c.resultField)) throw new Error('command.resultField must be a dotted field name')
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(String(c.family ?? '')) || c.family === 'stub') throw new Error('command.family is required (the model family it runs: gpt / claude / deepseek / kimi / glm / qwen / ...)')
  if (c.model !== undefined && !MODEL_ID.test(c.model)) throw new Error('command.model is invalid')
  for (const n of c.passEnv ?? []) if (!ENV_NAME.test(n) || WALLET_ENV.test(n)) throw new Error(`command.passEnv: ${n} is not allowed (wallet / Pit variables never reach a harness)`)
  if (c.versionArgs !== undefined && (!Array.isArray(c.versionArgs) || c.versionArgs.some((a) => typeof a !== 'string'))) throw new Error('command.versionArgs must be a list of strings')
  return c
}

/**
 * Public workers (PIT_OFFICIAL is not exactly "1") may only run stub, a Codex subscription, a Claude subscription
 * with no provider, or the official DeepSeek API. These runtime.json fields point Claude Code or an unsandboxed
 * command at another vendor and are rejected when the file is loaded or saved, not only when a flag is passed.
 */
const PUBLIC_RUNTIME_KEYS = ['claudeProvider', 'claudeBaseUrl', 'claudeKeyEnv', 'kimiModel', 'command'] as const

export function assertPublicRuntime(raw: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): void {
  if (env.PIT_OFFICIAL === '1') return
  const blocked: string[] = []
  for (const key of PUBLIC_RUNTIME_KEYS) {
    const v = raw[key]
    if (v !== undefined && v !== null && v !== '') blocked.push(key)
  }
  if (raw.default === 'kimi' || raw.default === 'command') blocked.push(`default ${String(raw.default)}`)
  if (!blocked.length) return
  throw new Error(
    `public workers cannot use ${blocked.join(', ')}. Use --runtime codex, --runtime claude with no provider, or the official DeepSeek API (pit model). kimi, command, local and third-party providers need PIT_OFFICIAL=1.`,
  )
}

export function loadAgentConfig(): AgentConfig {
  const p = agentConfigPath()
  if (!existsSync(p)) return { ...AGENT_DEFAULTS }
  const raw = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('runtime.json must be a JSON object')
  assertPublicRuntime(raw)
  return normalizeAgentConfig(raw)
}

export function saveAgentConfig(cfg: AgentConfig) {
  assertPublicRuntime(cfg as unknown as Record<string, unknown>)
  const p = agentConfigPath()
  writeFileSync(p, JSON.stringify(normalizeAgentConfig(cfg as unknown as Record<string, unknown>), null, 2) + '\n', { mode: 0o600 })
  try {
    chmodSync(p, 0o600)
  } catch {
    /* ignore */
  }
}

/** Model the holder configured for a harness (undefined = the CLI's own default; Pit never substitutes another). */
export function configuredModel(kind: AgentKind, cfg: AgentConfig): string | undefined {
  if (kind === 'codex') return cfg.codexModel
  if (kind === 'kimi') return cfg.kimiModel
  if (kind === 'command') return cfg.command?.model
  if (cfg.claudeModel) return cfg.claudeModel
  return cfg.claudeProvider && cfg.claudeProvider !== 'anthropic' ? PROVIDERS[cfg.claudeProvider]?.anthropic?.model : undefined
}

/** Family the seat declares and claims for a harness (codex -> gpt; claude -> claude or its provider's family). */
export function harnessFamily(kind: AgentKind, cfg: AgentConfig): string {
  if (kind === 'codex') return 'gpt'
  if (kind === 'kimi') return 'kimi'
  if (kind === 'command') {
    if (!cfg.command) throw new Error('no command adapter configured (pit runtime --set-command ...)')
    return cfg.command.family
  }
  return cfg.claudeProvider ? presetFamily(PROVIDERS[cfg.claudeProvider]!, configuredModel('claude', cfg)) : 'claude'
}

/** Runtime label in heartbeats (seat page). */
export function harnessLabel(kind: AgentKind, cfg: AgentConfig): string {
  if (kind === 'codex') return 'codex-cli'
  if (kind === 'kimi') return 'kimi-code'
  if (kind === 'command') return `cmd:${cfg.command?.name ?? '?'}`
  return cfg.claudeProvider ? `claude-code:${cfg.claudeProvider}` : 'claude-code'
}

// ------------------------------------------------------------------ binaries

/** Absolute path of a command on PATH (no shell), or null. */
export function findOnPath(cmd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (isAbsolute(cmd)) return existsSync(cmd) ? cmd : null
  const exts = process.platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : ['']
  for (const dir of (env.PATH || '').split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const p = join(dir, cmd + ext)
      if (existsSync(p)) return p
    }
  }
  return null
}

/**
 * The CLI binary: PIT_<NAME>_BIN override (absolute path or command name), else the default name on PATH (codex,
 * claude, kimi; the command adapter's configured bin). Kimi Code's installer puts it in ~/.kimi-code/bin.
 */
export function agentBin(kind: AgentKind, env: NodeJS.ProcessEnv = process.env, cfg?: AgentConfig): string | null {
  const override = env[AGENT_BIN_ENV[kind]]?.trim()
  if (override) return findOnPath(override, env)
  if (kind === 'command') return cfg?.command ? findOnPath(cfg.command.bin, env) : null
  const found = findOnPath(kind, env)
  if (found || kind !== 'kimi' || !env.HOME) return found
  const home = join(env.HOME, '.kimi-code', 'bin', 'kimi')
  return existsSync(home) ? home : null
}

/** `--runtime local`: the configured default if installed, else the first installed harness (codex, claude, kimi, command). */
export function pickAgent(cfg: AgentConfig, env: NodeJS.ProcessEnv = process.env): AgentKind {
  if (cfg.default && agentBin(cfg.default, env, cfg)) return cfg.default
  const first = LOCAL_ORDER.find((k) => agentBin(k, env, cfg))
  if (!first) throw new Error('no agent CLI found (install codex, claude or kimi, set PIT_CODEX_BIN / PIT_CLAUDE_BIN / PIT_KIMI_BIN, or configure pit runtime --set-command)')
  return first
}

// ------------------------------------------------------------------ child environment

/** Generic variables a CLI needs to start, find its login and reach its API (proxies / custom CAs). */
const BASE_ENV = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LANGUAGE', 'TZ', 'TERM',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'all_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'PROGRAMDATA',
]
/** Each CLI's own config / auth variables (only that CLI gets them). */
const OWN_ENV: Record<AgentKind, string[]> = {
  codex: ['CODEX_HOME'],
  // CLAUDE_CODE_OAUTH_TOKEN is the subscription token `claude setup-token` prints for headless machines.
  claude: ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN'],
  kimi: ['KIMI_CODE_HOME'],
  command: [],
}
/** Never passed, whatever the allowlist says (defence in depth against a future allowlist edit). */
export const NEVER_ENV = /(^PIT_)|(^|_)PK$|PRIVATE|MNEMONIC|SEED|WALLET|SECRET|PASSW|API_?KEY|ACCESS_KEY|_TOKEN$|^GH_|^GITHUB_|^AWS_|^CLOUDFLARE_/i

/**
 * Minimal environment for the child CLI. `own` adds names configured for this harness (the command adapter's
 * passEnv); `extra` sets values the harness needs (Claude Code provider endpoint + key).
 */
export function childEnv(kind: AgentKind, env: NodeJS.ProcessEnv = process.env, opts: { network?: boolean; own?: string[]; extra?: Record<string, string> } = {}): Record<string, string> {
  const out: Record<string, string> = {}
  const ownNames = [...OWN_ENV[kind], ...(opts.own ?? []).filter((n) => !WALLET_ENV.test(n))]
  // The command adapter is not sandboxed, so it sees the real HOME. Without PIT_OFFICIAL=1, passEnv must not
  // carry third-party API keys (DASHSCOPE_API_KEY, OPENAI_API_KEY, ...) into that process.
  const stripOwnSecrets = kind === 'command' && env.PIT_OFFICIAL !== '1'
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue
    const own = ownNames.includes(k)
    if (!own && !(BASE_ENV.includes(k) || k.startsWith('LC_'))) continue
    if (NEVER_ENV.test(k) && (!own || stripOwnSecrets)) continue
    out[k] = v
  }
  out.NO_COLOR = '1'
  // Forge must not escape the jail through FFI or a wide filesystem permission (C1).
  out.FOUNDRY_FFI = 'false'
  out.FOUNDRY_FS_PERMISSIONS = 'read'
  if (!opts.network) out.FOUNDRY_OFFLINE = 'true'
  if (kind === 'claude') {
    out.ENABLE_CLAUDEAI_MCP_SERVERS = 'false'
    out.DISABLE_AUTOUPDATER = '1'
    out.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  }
  for (const [k, v] of Object.entries(opts.extra ?? {})) if (!WALLET_ENV.test(k)) out[k] = v
  return out
}

/**
 * Claude Code against a provider's Anthropic-compatible endpoint: base URL, the provider key (from the env var the
 * holder named) and the model. The subscription token is dropped so the two logins never mix.
 */
export function claudeProviderEnv(cfg: AgentConfig, env: NodeJS.ProcessEnv = process.env): { extra: Record<string, string>; drop: string[] } {
  if (!cfg.claudeProvider) return { extra: {}, drop: [] }
  const p = providerPreset(cfg.claudeProvider)
  const keyEnv = cfg.claudeKeyEnv ?? p.keyEnv
  const key = env[keyEnv]?.trim()
  if (!key) throw new AgentError('auth', `claude via ${p.label}: env ${keyEnv} is not set`)
  if (p.id === 'anthropic' && !cfg.claudeBaseUrl) return { extra: { ANTHROPIC_API_KEY: key }, drop: ['CLAUDE_CODE_OAUTH_TOKEN'] }
  const model = configuredModel('claude', cfg)
  return {
    extra: {
      ANTHROPIC_BASE_URL: cfg.claudeBaseUrl ?? p.anthropic!.baseUrl,
      ANTHROPIC_AUTH_TOKEN: key,
      // Every Claude Code model slot points at the configured model, so no request silently runs another one.
      ...(model
        ? { ANTHROPIC_MODEL: model, ANTHROPIC_DEFAULT_OPUS_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_HAIKU_MODEL: model, ANTHROPIC_SMALL_FAST_MODEL: model, CLAUDE_CODE_SUBAGENT_MODEL: model }
        : {}),
    },
    drop: ['CLAUDE_CODE_OAUTH_TOKEN'],
  }
}

// ------------------------------------------------------------------ terms

/** Shown once by `pit runtime --accept-terms` (and whenever a harness start is refused for lack of it). */
export const TERMS_NOTICE = [
  'Before this machine runs Pit work with your own agent CLI or API key:',
  '- It uses YOUR subscription or API account. You are responsible for following its terms of service.',
  '- Providers may limit, suspend or ban accounts used for automated or third-party work. That risk is yours.',
  '- Every lease consumes your quota or API credit (pit runtime --daily-budget caps tokens per 24 h).',
  '- Use a dedicated machine or user account: the agent runs commands in a temp folder, and a read-only sandbox can still',
  '  read files your user can read. Keep wallets, keys and personal data off that machine.',
  '- Earnings are not guaranteed: work can be rejected, reassigned or paid nothing.',
  '- Do not run this on a machine that holds wallet, relayer or admin keys (including an ops box). Use a dedicated machine or user.',
].join('\n')

export function termsAccepted(cfg: AgentConfig): boolean {
  return typeof cfg.termsAcceptedAt === 'number' && cfg.termsAcceptedAt > 0
}

export const COMMAND_TERMS_NOTICE = [
  'The command adapter is NOT sandboxed by Pit. It can read and run whatever its own CLI allows, including files in your home directory.',
  'Pit only lets it do text skills (no project bundles), scans its answer for secret shapes, and still recommends a dedicated machine.',
  'Accept this once with: pit runtime --accept-command-terms',
].join('\n')

export function commandTermsAccepted(cfg: AgentConfig): boolean {
  return typeof cfg.commandTermsAcceptedAt === 'number' && cfg.commandTermsAcceptedAt > 0
}

// ------------------------------------------------------------------ arguments

export interface InvokeOptions {
  /** Working directory (the lease's temp dir). */
  dir: string
  /** Research / review work: the agent may read but not write or run commands. */
  readOnly: boolean
  model?: string
  effort?: string
  maxTurns: number
  network: boolean
  /** Claude: appended system prompt. Codex has no flag for it; the caller prepends it to the prompt. */
  system: string
  /** Absolute paths the agent's file tools must not read (Claude permission deny rules). */
  denyRead?: string[]
}

/** Kimi Code CLI (flags checked against kimi-code 2.1.1 `kimi --help`). The prompt is a pointer to PIT_TASK.md. */
export function kimiArgs(o: InvokeOptions, pointer: string): string[] {
  // -p runs one prompt non-interactively. Never --yolo: Kimi Code has no OS sandbox of its own, so Pit only uses it for
  // text skills, inside the bubblewrap/seatbelt jail (write work is refused before it starts).
  const a = ['-p', pointer, '--output-format', 'text']
  if (o.model) a.push('-m', o.model)
  return a
}

/** Expand the command adapter's argument template. */
export function commandArgs(c: CommandSpec, o: InvokeOptions, vals: { prompt: string; taskFile: string }): string[] {
  const map: Record<string, string> = { dir: o.dir, model: o.model ?? c.model ?? '', mode: o.readOnly ? 'read-only' : 'workspace-write', prompt: vals.prompt, task_file: vals.taskFile }
  return c.args.map((a) => a.replace(/\{(dir|model|mode|prompt|task_file)\}/g, (_, k: string) => map[k] ?? '')).filter((a, i) => a !== '' || c.args[i] === '')
}

/** codex exec (flags checked against codex-cli 0.161 `codex exec --help`). The prompt comes from stdin (`-`). */
export function codexArgs(o: InvokeOptions): string[] {
  const a = [
    'exec', '--json', '--color', 'never',
    '--sandbox', o.readOnly ? 'read-only' : 'workspace-write',
    '-C', o.dir,
    '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '--ephemeral',
    '-c', 'approval_policy="never"',
    '-c', `sandbox_workspace_write.network_access=${o.network && !o.readOnly ? 'true' : 'false'}`,
  ]
  if (o.model) a.push('-m', o.model)
  if (o.effort) a.push('-c', `model_reasoning_effort="${o.effort}"`)
  a.push('-')
  return a
}

export const CLAUDE_READ_TOOLS = ['Read', 'Glob', 'Grep']
export const CLAUDE_WRITE_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'TodoWrite', 'Bash']
export const CLAUDE_WRITE_ALLOWED = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'TodoWrite', 'Bash(forge build:*)', 'Bash(forge test:*)', 'Bash(forge fmt:*)']

/** claude -p (flags checked against Claude Code 2.1.293 `claude --help`; --max-turns is accepted but not listed). */
export function claudeArgs(o: InvokeOptions): string[] {
  const deny = (o.denyRead ?? []).flatMap((p) => [`Read(/${p}/**)`, `Edit(/${p}/**)`])
  const settings = { disableAllHooks: true, permissions: { deny } }
  const a = [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'acceptEdits',
    '--strict-mcp-config',
    // Ignore user / project / local settings files: their hooks and allow rules must not widen this tool list.
    '--setting-sources', '',
    '--settings', JSON.stringify(settings),
    '--no-session-persistence',
    '--max-turns', String(o.maxTurns),
    '--tools', (o.readOnly ? CLAUDE_READ_TOOLS : CLAUDE_WRITE_TOOLS).join(','),
    '--allowedTools', (o.readOnly ? CLAUDE_READ_TOOLS : CLAUDE_WRITE_ALLOWED).join(','),
    '--disallowedTools', 'WebFetch,WebSearch,Task,Agent',
    '--append-system-prompt', o.system,
  ]
  if (o.model) a.push('--model', o.model)
  if (o.effort) a.push('--effort', o.effort)
  return a
}

// ------------------------------------------------------------------ process

export interface ProcResult {
  code: number | null
  signal: string | null
  timedOut: boolean
  aborted: boolean
  stderrTail: string
  ms: number
}

export interface ProcOptions {
  bin: string
  args: string[]
  cwd: string
  env: Record<string, string>
  input: string
  timeoutMs: number
  onLine: (line: string) => void
  signal?: AbortSignal
  /** SIGTERM -> SIGKILL grace (default 3 s). */
  killGraceMs?: number
}

const MAX_LINE = 16 * 1024 * 1024

/** Spawn in a new process group, feed stdin, stream stdout lines; kill the whole group on timeout / abort / exit. */
export function runProcess(o: ProcOptions): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const group = process.platform !== 'win32'
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(o.bin, o.args, { cwd: o.cwd, env: o.env, detached: group, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) {
      reject(e)
      return
    }
    let timedOut = false
    let aborted = false
    let exited = false
    let settled = false
    let buf = ''
    let stderr = ''
    const killGroup = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) return
      try {
        if (group) process.kill(-child.pid, sig)
        else child.kill(sig)
      } catch {
        /* already gone */
      }
    }
    const timers: ReturnType<typeof setTimeout>[] = []
    const stop = (why: 'timeout' | 'abort') => {
      if (exited) return
      if (why === 'timeout') timedOut = true
      else aborted = true
      killGroup('SIGTERM')
      timers.push(setTimeout(() => killGroup('SIGKILL'), o.killGraceMs ?? 3000))
    }
    timers.push(setTimeout(() => stop('timeout'), o.timeoutMs))
    const onAbort = () => stop('abort')
    if (o.signal?.aborted) queueMicrotask(onAbort)
    else o.signal?.addEventListener('abort', onAbort, { once: true })
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return
      settled = true
      for (const t of timers) clearTimeout(t)
      o.signal?.removeEventListener('abort', onAbort)
      if (buf) o.onLine(buf)
      buf = ''
      resolve({ code, signal, timedOut, aborted, stderrTail: stderr, ms: Date.now() - t0 })
    }
    child.on('error', (e) => {
      if (settled) return
      settled = true
      for (const t of timers) clearTimeout(t)
      reject(e)
    })
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (d: string) => {
      buf += d
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        o.onLine(line)
      }
      if (buf.length > MAX_LINE) buf = '' // a runaway line without newline: drop it
    })
    child.stderr!.setEncoding('utf8')
    child.stderr!.on('data', (d: string) => {
      stderr = (stderr + d).slice(-4000)
    })
    child.stdin!.on('error', () => {
      /* EPIPE: the CLI exited before reading the whole prompt; its exit status says why */
    })
    child.stdin!.end(o.input)
    child.on('exit', (code, signal) => {
      exited = true
      // Anything the CLI left running in its group (a dev server, a stuck test) goes with it.
      killGroup('SIGKILL')
      // 'close' waits for stdio; a grandchild that escaped the group could hold a pipe open forever.
      timers.push(setTimeout(() => {
        child.stdout?.destroy()
        child.stderr?.destroy()
        finish(code, signal)
      }, 2000))
      child.once('close', () => finish(code, signal))
    })
  })
}

// ------------------------------------------------------------------ event streams

export interface AgentTurn {
  /** Final answer text (last agent message / result). */
  text: string
  usage: ChatUsage
  /** Model the CLI reported (Claude: init event); null when the stream does not say (Codex). */
  model: string | null
  /** Session / thread id hash (receipt providerMsgIdHash). */
  sessionHash: string | null
  /** Error texts from the stream (warnings included). */
  errors: string[]
  /** The stream reported a failed turn / an error result. */
  failed: boolean
  /** Claude assistant-message error kind (rate_limit, authentication_failed, billing_error, ...). */
  errorKind: string | null
  /** Claude result subtype (success, error_max_turns, error_during_execution, ...). */
  subtype: string | null
  turns: number
  sawResult: boolean
}

const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0)
const emptyUsage = (): ChatUsage => ({ promptTokens: 0, completionTokens: 0, totalTokens: 0, reasoningTokens: 0, cachedTokens: 0 })
const newTurn = (): AgentTurn => ({ text: '', usage: emptyUsage(), model: null, sessionHash: null, errors: [], failed: false, errorKind: null, subtype: null, turns: 0, sawResult: false })
const hashId = (id: unknown) => (typeof id === 'string' && id ? keccak256(toBytes(id)) : null)
const parse = (line: string): Record<string, any> | null => {
  try {
    const j = JSON.parse(line)
    return j && typeof j === 'object' ? j : null
  } catch {
    return null
  }
}

/**
 * codex exec --json: thread.started, turn.started, item.started / item.completed (agent_message, command_execution,
 * file_change, error, ...), turn.completed {usage}, turn.failed {error}, error {message}. Usage input_tokens includes
 * cached_input_tokens; we count uncached input + output as the turn's tokens and report the cached part separately.
 */
export function parseCodexStream(lines: string[]): AgentTurn {
  const t = newTurn()
  for (const line of lines) {
    const e = parse(line)
    if (!e) continue
    if (e.type === 'thread.started') t.sessionHash = hashId(e.thread_id)
    else if (e.type === 'item.completed' && e.item?.type === 'agent_message' && typeof e.item.text === 'string') t.text = e.item.text
    else if (e.type === 'item.completed' && e.item?.type === 'error') t.errors.push(String(e.item.message ?? ''))
    else if (e.type === 'turn.completed') {
      t.turns++
      t.sawResult = true
      const u = e.usage ?? {}
      const cached = n(u.cached_input_tokens)
      const prompt = Math.max(0, n(u.input_tokens) - cached)
      t.usage.promptTokens += prompt
      t.usage.cachedTokens += cached
      t.usage.completionTokens += n(u.output_tokens)
      t.usage.reasoningTokens += n(u.reasoning_output_tokens)
      t.usage.totalTokens += prompt + n(u.output_tokens)
    } else if (e.type === 'turn.failed') {
      t.failed = true
      t.errors.push(String(e.error?.message ?? 'turn failed'))
    } else if (e.type === 'error') t.errors.push(String(e.message ?? ''))
  }
  return t
}

/**
 * claude -p --output-format stream-json --verbose: system/init {model, session_id}, assistant {message, error?},
 * user (tool results), result {subtype, is_error, result, num_turns, usage}. Usage of the result is the run's total;
 * cache reads are reported as cached tokens, cache writes count as input.
 */
export function parseClaudeStream(lines: string[]): AgentTurn {
  const t = newTurn()
  let lastAssistant = ''
  for (const line of lines) {
    const e = parse(line)
    if (!e) continue
    if (e.type === 'system' && e.subtype === 'init') {
      if (typeof e.model === 'string') t.model = e.model
      t.sessionHash = hashId(e.session_id)
    } else if (e.type === 'assistant') {
      if (typeof e.error === 'string') t.errorKind = e.error
      const content = Array.isArray(e.message?.content) ? e.message.content : []
      const text = content.filter((c: { type?: string }) => c?.type === 'text').map((c: { text?: string }) => c.text ?? '').join('')
      if (text) lastAssistant = text
      if (e.is_api_error_message && text) t.errors.push(text)
    } else if (e.type === 'result') {
      t.sawResult = true
      t.subtype = typeof e.subtype === 'string' ? e.subtype : null
      t.turns = n(e.num_turns)
      t.failed = e.is_error === true || (t.subtype !== null && t.subtype !== 'success')
      t.text = typeof e.result === 'string' ? e.result : lastAssistant
      if (t.failed && t.text) t.errors.push(t.text)
      for (const er of Array.isArray(e.errors) ? e.errors : []) t.errors.push(String(er))
      const u = e.usage ?? {}
      const prompt = n(u.input_tokens) + n(u.cache_creation_input_tokens)
      t.usage = {
        promptTokens: prompt,
        completionTokens: n(u.output_tokens),
        totalTokens: prompt + n(u.output_tokens),
        reasoningTokens: n(u.output_tokens_details?.thinking_tokens),
        cachedTokens: n(u.cache_read_input_tokens),
      }
      if (!t.model && e.modelUsage && typeof e.modelUsage === 'object') t.model = Object.keys(e.modelUsage)[0] ?? null
    }
  }
  if (!t.sawResult) t.text = lastAssistant
  return t
}

// ------------------------------------------------------------------ text / generic JSONL output

/** Plain-text harness output: stdout is the answer (JSON meta lines some CLIs print first are dropped). */
export function parseTextOutput(lines: string[]): AgentTurn {
  const t = newTurn()
  const body = lines.filter((l) => {
    const j = l.trim().startsWith('{') ? parse(l) : null
    return !(j && (j.role === 'meta' || j.type === 'system.version'))
  })
  t.text = body.join('\n').trim()
  t.sawResult = true
  return t
}

const pick = (o: Record<string, any>, path: string): unknown => path.split('.').reduce<any>((v, k) => (v && typeof v === 'object' ? v[k] : undefined), o)

/** JSONL harness output: the last object carrying `resultField` (default "result") is the answer; usage / model / errors from the stream. */
export function parseJsonlOutput(lines: string[], resultField = 'result'): AgentTurn {
  const t = newTurn()
  for (const line of lines) {
    const e = parse(line)
    if (!e) continue
    const r = pick(e, resultField)
    if (typeof r === 'string') {
      t.text = r
      t.sawResult = true
      if (e.is_error === true) t.failed = true
    }
    if (typeof e.model === 'string') t.model = e.model
    const sid = e.session_id ?? e.thread_id
    if (typeof sid === 'string') t.sessionHash = hashId(sid)
    const u = e.usage
    if (u && typeof u === 'object') {
      const prompt = n(u.input_tokens ?? u.prompt_tokens)
      const out = n(u.output_tokens ?? u.completion_tokens)
      t.usage = { promptTokens: prompt, completionTokens: out, totalTokens: n(u.total_tokens) || prompt + out, reasoningTokens: n(u.reasoning_tokens ?? u.reasoning_output_tokens), cachedTokens: n(u.cached_tokens ?? u.cache_read_input_tokens) }
    }
    if (e.type === 'error' || (typeof e.error === 'string' && e.error) || (e.error && typeof e.error === 'object')) {
      t.errors.push(String(typeof e.error === 'string' ? e.error : (e.error?.message ?? e.message ?? 'error')))
    }
  }
  return t
}

// ------------------------------------------------------------------ failures

export type AgentFailKind = 'timeout' | 'aborted' | 'crash' | 'rate_limit' | 'auth' | 'model' | 'sandbox' | 'missing'

/** What the backend is allowed to see. Never stderr, never a quote of the order (M5). */
export function failureDetail(kind: AgentFailKind): string {
  return kind === 'model' ? 'model_unavailable' : kind
}

/** Pause before taking new leases after a failure of this kind (seconds). */
export const PAUSE_SEC: Record<AgentFailKind, number> = { timeout: 0, aborted: 0, crash: 0, missing: 1800, rate_limit: 300, auth: 1800, model: 1800, sandbox: 1800 }

/** A CLI failure that is not about the work itself: reported as a machine failure (the lease goes to another seat). */
export class AgentError extends ModelError {
  kind: AgentFailKind
  pauseSec: number
  constructor(kind: AgentFailKind, message: string) {
    super(message, null, kind !== 'auth' && kind !== 'missing' && kind !== 'model')
    this.kind = kind
    this.pauseSec = PAUSE_SEC[kind]
  }
}

const RATE = /rate[ _-]?limit|usage[ _-]limit|hit your (\w+ )*limit|too many requests|\b429\b|quota exceeded|exceeded your (current )?quota|overloaded/i
const AUTH = /not logged in|please run \/login|use \/login|run `?(codex|kimi) login|no model configured|\b401\b|unauthori[sz]ed|invalid api key|invalid x-api-key|authentication[ _]failed|oauth token|token (has )?expired|credit balance|billing|insufficient (balance|credits?)|\b402\b/i
const MODEL = /model[^\n]{0,60}(not found|does not exist|not exist|unknown|unsupported|not supported|not available|unavailable|no access|not allowed)|(unknown|invalid|unsupported) model|model_not_found/i
const SANDBOX = /bwrap|bubblewrap|landlock|seatbelt|sandbox-exec|setting up uid map|new namespace|sandbox (error|failure|denied|failed|unavailable)/i

/** Classify a failed run (null = the run did not fail at the CLI level). */
export function classifyFailure(kind: AgentKind, turn: AgentTurn, proc: ProcResult, name: string = kind): { kind: AgentFailKind; message: string } | null {
  if (proc.aborted) return { kind: 'aborted', message: `${name} stopped (daemon shutting down)` }
  if (proc.timedOut) return { kind: 'timeout', message: `${name} timed out after ${Math.round(proc.ms / 1000)}s (process group killed)` }
  const failedRun = proc.code !== 0 || turn.failed || !turn.sawResult || (kind !== 'claude' && kind !== 'codex' && !turn.text.trim())
  if (!failedRun) return null
  // Claude's max-turn stop is not a CLI failure: the work is judged on what it produced.
  if (kind === 'claude' && turn.subtype === 'error_max_turns' && proc.code === 0) return null
  const corpus = [turn.errorKind ?? '', ...turn.errors, proc.stderrTail, kind === 'claude' || kind === 'codex' ? '' : turn.text.slice(0, 2000)].join('\n')
  const tail = scrub(turn.errors.at(-1) || proc.stderrTail.trim().split('\n').filter((l) => !/^see log:/i.test(l)).at(-1) || '', [])
  if (turn.errorKind === 'rate_limit' || RATE.test(corpus)) return { kind: 'rate_limit', message: `${name} rate limited: ${tail}`.slice(0, 300) }
  if (turn.errorKind === 'authentication_failed' || turn.errorKind === 'billing_error' || AUTH.test(corpus)) return { kind: 'auth', message: `${name} login / billing problem: ${tail}`.slice(0, 300) }
  if (MODEL.test(corpus)) return { kind: 'model', message: `${name} model unavailable: ${tail}`.slice(0, 300) }
  if (SANDBOX.test(corpus)) return { kind: 'sandbox', message: `${name} sandbox error: ${tail}`.slice(0, 300) }
  const how = proc.signal ? `killed by ${proc.signal}` : `exit ${proc.code}`
  return { kind: 'crash', message: `${name} failed (${how}): ${tail || 'no result in its output'}`.slice(0, 300) }
}

const INSTALL: Record<AgentKind, string> = {
  codex: 'install Codex (npm i -g @openai/codex) or set PIT_CODEX_BIN',
  claude: 'install Claude Code (npm i -g @anthropic-ai/claude-code) or set PIT_CLAUDE_BIN',
  kimi: 'install Kimi Code (see https://moonshotai.github.io/kimi-code/) or set PIT_KIMI_BIN',
  command: 'install the CLI named in `pit runtime` (command.bin) or set PIT_COMMAND_BIN',
}
const LOGIN: Record<AgentKind, string> = {
  codex: 'run `codex login` (on a server: `codex login --device-auth`), then `pit doctor --live`',
  claude: 'run `claude` and /login (on a server: `claude setup-token`, then export CLAUDE_CODE_OAUTH_TOKEN), then `pit doctor --live`',
  kimi: 'run `kimi login`, then `pit doctor --live`',
  command: "sign the CLI in (or export the key named in command.passEnv), then `pit doctor --live`",
}
const MODEL_FLAG: Record<AgentKind, string> = { codex: '--codex-model', claude: '--claude-model', kimi: '--kimi-model', command: '--set-command (model)' }

/** What the holder should do about a failure (log lines and `pit doctor`). One line each. */
export function fixHint(agent: AgentKind, kind: AgentFailKind, cfg?: AgentConfig): string {
  if (kind === 'missing') return INSTALL[agent]
  if (kind === 'auth') {
    if (agent === 'claude' && cfg?.claudeProvider) {
      const p = PROVIDERS[cfg.claudeProvider]!
      return `export ${cfg.claudeKeyEnv ?? p.keyEnv} with a valid ${p.label} key (and check its balance), then \`pit doctor --live\``
    }
    return LOGIN[agent]
  }
  if (kind === 'model') return `pick a model your plan includes: pit runtime --set ${MODEL_FLAG[agent]} <model> (Pit never falls back to another model)`
  if (kind === 'rate_limit') return 'the subscription / API limit is used up; new leases resume automatically after the pause'
  if (kind === 'sandbox') return 'Codex runs commands in a sandbox; on Linux it needs unprivileged user namespaces (Ubuntu 24.04: sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0)'
  if (kind === 'timeout') return 'raise the per-lease budget with `pit runtime --set --timeout <sec>` if this repeats'
  return 'check the CLI by hand (`pit doctor --live`)'
}

// ------------------------------------------------------------------ harness registry

/** One harness = how to call it, feed it, read it and check it. Built-ins and the `command` adapter share this shape. */
export interface HarnessSpec {
  kind: AgentKind
  /** Name in log lines and failure messages. */
  name: string
  /** stdin = full prompt on stdin; pointer = full prompt in <dir>/PIT_TASK.md, a short pointer in argv or stdin. */
  args(o: InvokeOptions, v: { prompt: string; taskFile: string }): string[]
  /** What goes to stdin. */
  stdin(o: InvokeOptions, prompt: string): string
  /** Whether the full prompt is written to PIT_TASK.md (argv-delivered prompts never carry the task itself). */
  writesTaskFile: boolean
  parse(lines: string[]): AgentTurn
  /** Env var names this harness may receive in addition to the base allowlist. */
  ownEnv: string[]
  /** Values to set / names to drop for this run (Claude Code provider mode). */
  envFor(env: NodeJS.ProcessEnv): { extra: Record<string, string>; drop: string[] }
  doctor: { versionArgs: string[]; help?: string[]; flags?: string[]; login?: (run: (args: string[]) => { status: number | null; out: string }) => { loggedIn: boolean | null; detail: string } }
}

export const TASK_FILE = 'PIT_TASK.md'
/** Short prompt for argv-delivered harnesses: the real task is in the file (keeps it out of `ps` and under ARG_MAX). */
export const POINTER_PROMPT = `Your full task is in the file ${TASK_FILE} in the current directory. Read it first and follow it exactly; your final message is your answer.`
const ARG_PROMPT_MAX = 64 * 1024
const fullPrompt = (o: InvokeOptions, prompt: string) => `${o.system}\n\n${prompt}`

export function harnessSpec(kind: AgentKind, cfg: AgentConfig = normalizeAgentConfig({}), env: NodeJS.ProcessEnv = process.env): HarnessSpec {
  const none = () => ({ extra: {}, drop: [] as string[] })
  if (kind === 'codex') {
    return {
      kind, name: 'codex', writesTaskFile: false, ownEnv: OWN_ENV.codex, envFor: none,
      args: (o) => codexArgs(o),
      stdin: fullPrompt, // codex exec has no system-prompt flag
      parse: parseCodexStream,
      doctor: {
        versionArgs: ['--version'], help: ['exec', '--help'], flags: ['--json', '--sandbox', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '--ephemeral'],
        login: (run) => {
          const s = run(['login', 'status'])
          const text = s.out.split('\n').filter((l) => l.trim() && !/^WARNING/.test(l)).join(' ').trim()
          return { loggedIn: s.status === 0 && !/not logged in/i.test(text), detail: scrub(text).slice(0, 160) }
        },
      },
    }
  }
  if (kind === 'claude') {
    return {
      kind, name: cfg.claudeProvider ? `claude(${cfg.claudeProvider})` : 'claude', writesTaskFile: false, ownEnv: cfg.claudeProvider ? ['CLAUDE_CONFIG_DIR'] : OWN_ENV.claude,
      envFor: (e) => claudeProviderEnv(cfg, e),
      args: (o) => claudeArgs(o),
      stdin: (_o, p) => p,
      parse: parseClaudeStream,
      doctor: {
        versionArgs: ['--version'], help: ['--help'], flags: ['--output-format', '--permission-mode', '--strict-mcp-config', '--setting-sources', '--tools', '--allowedTools', '--disallowedTools', '--append-system-prompt', '--no-session-persistence'],
        login: cfg.claudeProvider
          ? () => {
              const p = PROVIDERS[cfg.claudeProvider!]!
              const keyEnv = cfg.claudeKeyEnv ?? p.keyEnv
              return { loggedIn: Boolean(env[keyEnv]?.trim()), detail: `${p.label} endpoint ${cfg.claudeBaseUrl ?? p.anthropic?.baseUrl}, key from ${keyEnv}${env[keyEnv]?.trim() ? '' : ' (not set)'}` }
            }
          : (run) => {
              const s = run(['auth', 'status'])
              try {
                const j = JSON.parse(s.out.slice(s.out.indexOf('{'))) as { loggedIn?: boolean; authMethod?: string }
                return { loggedIn: j.loggedIn === true, detail: `authMethod=${j.authMethod ?? '?'}` }
              } catch {
                return { loggedIn: null, detail: 'login state unknown (older Claude Code); run pit doctor --live' }
              }
            },
      },
    }
  }
  if (kind === 'kimi') {
    return {
      kind, name: 'kimi', writesTaskFile: true, ownEnv: OWN_ENV.kimi, envFor: none,
      args: (o) => kimiArgs(o, POINTER_PROMPT),
      stdin: () => '',
      parse: parseTextOutput,
      // kimi-code has no login-status command; the live check is the real test.
      doctor: { versionArgs: ['--version'], help: ['--help'], flags: ['--prompt', '--output-format', '--model', '--yolo'] },
    }
  }
  const c = cfg.command
  if (!c) throw new Error('no command adapter configured (pit runtime --set-command <json>)')
  return {
    kind, name: c.name, writesTaskFile: c.prompt !== 'stdin', ownEnv: c.passEnv ?? [], envFor: none,
    args: (o, v) => commandArgs(c, o, { prompt: c.prompt === 'arg' && v.prompt.length <= ARG_PROMPT_MAX ? v.prompt : POINTER_PROMPT, taskFile: v.taskFile }),
    stdin: (o, p) => (c.prompt === 'stdin' ? fullPrompt(o, p) : ''),
    parse: (lines) => (c.output === 'jsonl' ? parseJsonlOutput(lines, c.resultField) : parseTextOutput(lines)),
    doctor: { versionArgs: c.versionArgs ?? ['--version'] },
  }
}

// ------------------------------------------------------------------ one invocation

export interface AgentInvocation {
  kind: AgentKind
  bin: string
  prompt: string
  opts: InvokeOptions
  timeoutMs: number
  /** Harness settings (command adapter spec, Claude Code provider). */
  cfg?: AgentConfig
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  killGraceMs?: number
  /** Wrap in bwrap / seatbelt. pit start sets this; tests leave it off so the fake CLIs can record under HOME. */
  sandbox?: boolean
}

/** Run the CLI once; returns the parsed turn or throws AgentError for CLI-level failures. */
export async function invokeAgent(inv: AgentInvocation): Promise<AgentTurn & { ms: number }> {
  const env = inv.env ?? process.env
  const h = harnessSpec(inv.kind, inv.cfg, env)
  const taskFile = join(inv.opts.dir, TASK_FILE)
  if (h.writesTaskFile) writeFileSync(taskFile, fullPrompt(inv.opts, inv.prompt), { mode: 0o600 })
  const { extra, drop } = h.envFor(env)
  const cenv = childEnv(inv.kind, env, { network: inv.opts.network, own: h.ownEnv, extra })
  for (const d of drop) delete cenv[d]
  const launch = planLaunch({
    kind: inv.kind,
    bin: inv.bin,
    args: h.args(inv.opts, { prompt: fullPrompt(inv.opts, inv.prompt), taskFile }),
    cwd: inv.opts.dir,
    realHome: env.HOME || '',
    network: inv.opts.network,
    enable: inv.sandbox === true,
  })
  cenv.HOME = launch.home
  if (launch.sandboxed) {
    if (inv.kind === 'codex') cenv.CODEX_HOME = join(launch.home, '.codex')
    if (inv.kind === 'claude' && cenv.CLAUDE_CONFIG_DIR) cenv.CLAUDE_CONFIG_DIR = join(launch.home, '.claude')
    if (inv.kind === 'kimi') cenv.KIMI_CODE_HOME = join(launch.home, '.kimi-code')
  }
  const lines: string[] = []
  let proc: ProcResult
  try {
    proc = await runProcess({
      bin: launch.bin,
      args: launch.args,
      cwd: inv.opts.dir,
      env: cenv,
      input: h.stdin(inv.opts, inv.prompt),
      timeoutMs: inv.timeoutMs,
      onLine: (l) => {
        if (lines.length < 50_000) lines.push(l)
      },
      signal: inv.signal,
      killGraceMs: inv.killGraceMs,
    })
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT' || code === 'EACCES') throw new AgentError('missing', `${h.name} binary not runnable (${code}): ${inv.bin}`)
    throw new AgentError('crash', `${h.name} could not start: ${scrub(String((e as Error)?.message ?? e))}`)
  }
  const turn = h.parse(lines)
  const fail = classifyFailure(inv.kind, turn, proc, h.name)
  if (fail) throw new AgentError(fail.kind, fail.message)
  return { ...turn, ms: proc.ms }
}

// ------------------------------------------------------------------ doctor

export interface AgentProbe {
  kind: AgentKind
  name: string
  bin: string | null
  version: string | null
  family: string | null
  model: string | null
  /** Required flags missing from the installed CLI's help (empty = compatible). */
  missingFlags: string[]
  loggedIn: boolean | null
  loginDetail: string
  live?: { ok: boolean; answer?: string; tokens?: number; model?: string | null; ms?: number; error?: string; failKind?: AgentFailKind }
  hints: string[]
}

/** Presence, version, flag compatibility and login state (no model call); `live` adds one tiny real prompt. */
export async function probeAgent(kind: AgentKind, o: { live?: boolean; env?: NodeJS.ProcessEnv; timeoutMs?: number; cfg?: AgentConfig; sandbox?: boolean } = {}): Promise<AgentProbe> {
  const env = o.env ?? process.env
  const cfg = o.cfg ?? normalizeAgentConfig({})
  const p: AgentProbe = { kind, name: kind, bin: null, version: null, family: null, model: configuredModel(kind, cfg) ?? null, missingFlags: [], loggedIn: null, loginDetail: '', hints: [] }
  let h: HarnessSpec
  try {
    h = harnessSpec(kind, cfg, env)
    p.family = harnessFamily(kind, cfg)
  } catch (e) {
    p.hints.push((e as Error).message)
    return p
  }
  p.name = h.name
  p.bin = agentBin(kind, env, cfg)
  if (!p.bin) {
    p.hints.push(fixHint(kind, 'missing'))
    return p
  }
  const bin = p.bin
  const cenv = childEnv(kind, env, { own: h.ownEnv })
  const run = (args: string[], timeout = 20_000) => {
    const r = spawnSync(bin, args, { encoding: 'utf8', env: cenv, timeout, input: '' })
    return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` }
  }
  const v = run(h.doctor.versionArgs, 10_000)
  p.version = v.out.trim().split('\n').filter((l) => l.trim() && !/^WARNING/.test(l))[0]?.slice(0, 120) || null
  if (!p.version) p.hints.push(`\`${bin} ${h.doctor.versionArgs.join(' ')}\` printed nothing: check the binary`)
  if (h.doctor.help && h.doctor.flags) {
    const helpText = run(h.doctor.help).out
    p.missingFlags = h.doctor.flags.filter((f) => !helpText.includes(f))
    if (p.missingFlags.length) p.hints.push(`this ${h.name} version lacks ${p.missingFlags.join(', ')}: upgrade it (${INSTALL[kind]})`)
  }
  if (h.doctor.login) {
    const l = h.doctor.login(run)
    p.loggedIn = l.loggedIn
    p.loginDetail = l.detail
    if (l.loggedIn === false) p.hints.push(fixHint(kind, 'auth', cfg))
  }
  if (o.live) {
    const dir = mkdtempSync(join(tmpdir(), 'pit-doctor-'))
    try {
      const t = await invokeAgent({
        kind,
        bin,
        cfg,
        prompt: 'Reply with the single word OK',
        opts: { dir, readOnly: true, maxTurns: 2, network: false, model: configuredModel(kind, cfg), system: 'You are a connectivity check. Answer with exactly one word.' },
        timeoutMs: o.timeoutMs ?? 180_000,
        env,
        // Same jail as pit start unless a test turns it off. Provider network stays up so the prompt can finish.
        sandbox: o.sandbox ?? kind !== 'command',
      })
      p.live = { ok: /\bOK\b/i.test(t.text), answer: t.text.trim().slice(0, 40), tokens: t.usage.totalTokens, model: t.model, ms: t.ms }
      if (!p.live.ok) p.hints.push('the CLI answered but not with OK; check its model settings')
      const want = configuredModel(kind, cfg)
      if (want && t.model && !t.model.toLowerCase().includes(want.toLowerCase().replace(/\[.*$/, ''))) p.hints.push(`configured model ${want} but the CLI reported ${t.model}: Pit claims what the CLI reports; fix the model setting if this is not intended`)
    } catch (e) {
      const fk = e instanceof AgentError ? e.kind : 'crash'
      p.live = { ok: false, error: scrub((e as Error).message), failKind: fk }
      p.hints.push(fixHint(kind, fk, cfg))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  return p
}
