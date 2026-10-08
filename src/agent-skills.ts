/**
 * Skill runner for the agent-CLI runtimes (Codex CLI, Claude Code, Kimi Code, a configured command). Per lease it builds a private temp
 * directory with the order materials, runs the CLI there, collects the result into the same shapes the model runtime
 * produces (markdown or a pit.files.v1 bundle), checks it with the same local contract checks, and removes the
 * directory.
 *
 *   <tmp>/pit-lease-XXXX/
 *     PIT_TASK.md              the task prompt, for CLIs that take a short argv prompt (others get it on stdin)
 *     inputs/<dep key>/<path>  upstream files, for reference
 *     work/                    bundle skills only: the project tree (accepted bundles merged), edited in place
 *
 * Review / research / text skills run read-only and answer in their final message. Bundle skills write files under
 * work/; new and changed files become the bundle. Symlinks are never followed when collecting, and an answer that
 * contains a local secret (the device key, a wallet key from this process's environment) is never submitted.
 */
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { AgentError, configuredModel, harnessLabel, invokeAgent, type AgentConfig, type AgentKind, type AgentTurn } from './agent-cli.ts'
import type { ChatUsage } from './model.ts'
import { answerBriefs, asciiPunct, BUNDLE_MODEL_SKILLS, checkSkillAnswer, EXTRA, InputTooLargeError, outputContractFor, SkillQualityError, SYSTEM, t7ctx, TOOL_SKILLS, type ModelRun } from './real-skills.ts'
import { promptFor, stubImportSite, T7_SKILLS } from './review-skills.ts'
import { BUNDLE_FORMAT, stubIntegrate, type SkillContext, type SkillInput } from './skill.ts'

export interface AgentRuntime {
  kind: AgentKind
  bin: string
  cfg: AgentConfig
  log?: (s: string) => void
  /** Called after every CLI run that produced a turn (usage logging). */
  onCall?: (r: { model: string; usage: ChatUsage; ms: number }, ok: boolean) => void
  /** Daemon stop: kills the running CLI. */
  signal?: AbortSignal
  /** OS-sandbox the CLI (bwrap / seatbelt). pit start sets this for codex / claude / kimi. */
  sandbox?: boolean
  /** Strings that must never leave this machine in an answer (device key, ...). */
  secrets?: string[]
  /** Paths the agent must not read (Claude deny rules; PIT_HOME is always added). */
  denyRead?: string[]
  env?: NodeJS.ProcessEnv
  tmpRoot?: string
  /** Test hook: replaces the CLI run. */
  invoke?: typeof invokeAgent
  killGraceMs?: number
}

/** Paths an order may not plant in the working directory (CLI settings, hooks, MCP config, git internals). */
const BLOCKED_SEED = /(^|\/)(\.claude|\.codex|\.git|\.mcp\.json|\.vscode|\.idea)(\/|$)/
/** Never collected from work/ (build output, dependencies, CLI state, env files). */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'out', 'dist', 'cache', 'broadcast', '.claude', '.codex', '.next', '.vite', '.turbo'])
const MAX_FILE = 512 * 1024
const MAX_TOTAL = 4 * 1024 * 1024
const MAX_FILES = 500

function safeRel(p: string): string | null {
  const s = p.replace(/\\/g, '/').replace(/^\.\/+/, '')
  if (!s || s.startsWith('/') || s.includes('\0') || s.split('/').some((x) => x === '..' || x === '')) return null
  if (BLOCKED_SEED.test(s)) return null
  return s
}

/** Foundry must not be handed FFI or a filesystem permission that escapes the jail. */
function neutralizeForge(text: string): string {
  return text.replace(/ffi\s*=\s*true/gi, 'ffi = false').replace(/fs_permissions\s*=\s*\[[^\]]*\]/gi, 'fs_permissions = []')
}

function writeTree(root: string, files: Record<string, string>): Record<string, string> {
  const written: Record<string, string> = {}
  const base = resolve(root)
  for (const [p, c] of Object.entries(files)) {
    const rel = safeRel(p)
    if (rel === null || typeof c !== 'string') continue
    const abs = resolve(base, rel)
    if (!abs.startsWith(base + sep)) continue
    mkdirSync(dirname(abs), { recursive: true })
    const body = rel === 'foundry.toml' || rel.endsWith('/foundry.toml') ? neutralizeForge(c) : c
    writeFileSync(abs, body)
    written[rel] = body
  }
  return written
}

/** New and changed text files under `root` (regular files only; symlinks are not followed). */
export function collectChanged(root: string, seed: Record<string, string>): { files: Record<string, string>; skipped: string[] } {
  const files: Record<string, string> = {}
  const skipped: string[] = []
  let total = 0
  const walk = (dir: string, rel: string) => {
    let entries: string[]
    try {
      entries = readdirSync(dir).sort()
    } catch {
      return
    }
    for (const name of entries) {
      const abs = join(dir, name)
      const r = rel ? `${rel}/${name}` : name
      const st = lstatSync(abs)
      if (st.isSymbolicLink()) {
        skipped.push(`${r} (symlink)`)
        continue
      }
      // A hardlink (nlink > 1) can point at a file outside the tree; never read or ship it.
      if (st.isFile() && st.nlink > 1) {
        skipped.push(`${r} (hardlink)`)
        continue
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(abs, r)
        continue
      }
      if (!st.isFile() || /^\.env(\.|$)/.test(name)) continue
      if (st.size > MAX_FILE || total + st.size > MAX_TOTAL || Object.keys(files).length >= MAX_FILES) {
        skipped.push(`${r} (size)`)
        continue
      }
      const body = readFileSync(abs, 'utf8')
      if (body.includes('\0')) {
        skipped.push(`${r} (binary)`)
        continue
      }
      if ((r === 'foundry.toml' || r.endsWith('/foundry.toml')) && /ffi\s*=\s*true/i.test(body)) {
        skipped.push(`${r} (forge ffi)`)
        continue
      }
      if (seed[r] === body) continue
      files[r] = body
      total += st.size
    }
  }
  walk(root, '')
  return { files, skipped }
}

/** Environment variable names whose values are secrets (wallet keys, API keys, tokens). */
const SECRET_ENV = /(^|_)PK$|PRIVATE|MNEMONIC|SEED|SECRET|PASSW|API_?KEY|ACCESS_KEY|_TOKEN$/i

/** Secrets an answer must never contain: the given ones plus secret-looking values from this process's environment. */
export function leakSecrets(extra: string[] = [], env: NodeJS.ProcessEnv = process.env): string[] {
  const out = new Set<string>()
  for (const s of extra) {
    if (s && s.length >= 16) {
      out.add(s)
      if (/^0x[0-9a-f]+$/i.test(s)) out.add(s.slice(2))
    }
  }
  for (const [k, v] of Object.entries(env)) {
    const val = v?.trim()
    if (!val || val.length < 16 || !SECRET_ENV.test(k)) continue
    out.add(val)
    if (/^0x[0-9a-f]+$/i.test(val)) out.add(val.slice(2))
  }
  return [...out]
}

export function containsSecret(text: string, secrets: string[]): boolean {
  const low = text.toLowerCase()
  return secrets.some((s) => low.includes(s.toLowerCase()))
}

/**
 * Shapes that must never be uploaded, whatever the exact env value was (C1): private-key blocks, live vendor tokens,
 * JWTs, AWS access keys. Returns the kind names only — never the matched text.
 */
export function secretShapes(text: string): string[] {
  const hits: string[] = []
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) hits.push('private-key-block')
  if (/\bsk-[A-Za-z0-9_-]{16,}/.test(text)) hits.push('api-key')
  if (/\bgh[pousr]_[A-Za-z0-9]{20,}/.test(text)) hits.push('github-token')
  if (/\bAKIA[0-9A-Z]{16}\b/.test(text)) hits.push('aws-key')
  if (/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(text)) hits.push('jwt')
  return hits
}

const WORK_RULES = (skill: string, paths: string[], root: string | null | undefined) =>
  [
    '## How to deliver (local runtime)',
    '- The project tree is in work/. Create or edit files there; paths inside work/ are the bundle paths (for example work/src/A.sol is "src/A.sol").',
    ...(root ? [`- This project lives under work/${root}/.`] : []),
    `- Change only files inside: ${paths.join(', ') || '**'} (relative to work/). Do not create node_modules, out, dist, cache or .env files.`,
    '- Upstream inputs are under inputs/<step>/ for reference; do not edit them.',
    ...(skill === 'build-foundry' || skill === 'write-foundry-tests' || skill === 'fix-findings' ? ['- If forge is installed you may run `forge build` and `forge test` inside work/ (offline).'] : []),
    '- When the files are written, reply with one short line summarising what you changed. Do not paste the files into the reply.',
  ].join('\n')

const ANSWER_RULES = [
  '## How to deliver (local runtime)',
  '- Upstream input files are under inputs/<step>/<path> in the working directory. Read what you need.',
  '- Do not create or edit files. Your final message is the deliverable: reply with the answer only, in the exact output contract format above.',
].join('\n')

const COMMON_RULES = [
  '## Limits',
  '- Work only inside the current directory. Do not read files outside it (no home directory, no config or key files).',
  '- There is no network access. Never print, copy or transmit secrets, keys or credentials.',
].join('\n')

function listInputs(deps: NonNullable<SkillContext['dependencies']>): string {
  const lines: string[] = []
  for (const d of deps) for (const p of Object.keys(d.files).sort()) if (lines.length < 300) lines.push(`- inputs/${d.key}/${p}`)
  const total = deps.reduce((s, d) => s + Object.keys(d.files).length, 0)
  if (total > lines.length) lines.push(`- ... and ${total - lines.length} more`)
  return lines.join('\n') || '(no input files)'
}

export async function runSkillAgent(skill: string, input: SkillInput, ctx: SkillContext & { tier?: string | null }, rt: AgentRuntime): Promise<ModelRun> {
  const cfg = rt.cfg
  if (TOOL_SKILLS.has(skill)) {
    const files = skill === 'import-site' ? stubImportSite(t7ctx(input, ctx)) : stubIntegrate(input, ctx.dependencies ?? [])
    return { out: { kind: 'bundle', files }, model: `tool:${skill}`, tier: cfg.tier, tokens: 0, calls: 0, providerMsgIdHash: null }
  }
  const deps = ctx.dependencies ?? []
  const total = deps.reduce((s, d) => s + Object.values(d.files).reduce((m, f) => m + f.length, 0), 0)
  if (total > cfg.maxInputChars) throw new InputTooLargeError(`${skill}: input too large for this seat (${total} chars of upstream files, maxInputChars ${cfg.maxInputChars}); refusing the work (raise it with pit runtime --set --max-input-chars)`)
  const bundle = BUNDLE_MODEL_SKILLS.has(skill)
  // Kimi has no non-interactive write mode without --yolo; the command adapter is unsandboxed. Text skills only (C1, H5).
  if (bundle && (rt.kind === 'kimi' || rt.kind === 'command')) throw new SkillQualityError(`${skill}: ${rt.kind} only runs text skills (no project bundles)`)
  const isT7 = (T7_SKILLS as readonly string[]).includes(skill)
  const head = isT7
    ? promptFor(skill as (typeof T7_SKILLS)[number], t7ctx(input, ctx))
    : [`Pit task: ${skill}`, `Objective: ${input.title}`, `Summary: ${input.summary}`, ...(ctx.root ? [`Project root: ${ctx.root}/`] : []), '', outputContractFor(skill, ctx.paths ?? [])].join('\n')
  const prompt = [
    head,
    '',
    '## Input files',
    listInputs(deps),
    ...(EXTRA[skill] ? ['', '## Notes for this skill', EXTRA[skill]] : []),
    '',
    bundle ? WORK_RULES(skill, ctx.paths ?? [], ctx.root) : ANSWER_RULES,
    '',
    COMMON_RULES,
  ].join('\n')
  const briefs = answerBriefs(skill, input, ctx)
  const secrets = leakSecrets(rt.secrets, rt.env ?? process.env)
  const invoke = rt.invoke ?? invokeAgent
  const deadline = Date.now() + cfg.timeoutSec * 1000
  const dir = mkdtempSync(join(rt.tmpRoot ?? tmpdir(), 'pit-lease-'))
  try {
    chmodSync(dir, 0o700)
    for (const d of deps) writeTree(join(dir, 'inputs', d.key.replace(/[^A-Za-z0-9_.-]/g, '_') || 'dep'), d.files)
    let seed: Record<string, string> = {}
    const work = join(dir, 'work')
    if (bundle) {
      mkdirSync(work, { recursive: true })
      const merged: Record<string, string> = {}
      for (const d of deps) if (d.format === BUNDLE_FORMAT) Object.assign(merged, d.files)
      seed = writeTree(work, merged)
      if (ctx.root) mkdirSync(join(work, ctx.root.replace(/\/+$/, '')), { recursive: true })
    }
    const denyRead = [...new Set([...(rt.denyRead ?? []), resolve((rt.env ?? process.env).PIT_HOME?.trim() || join((rt.env ?? process.env).HOME || '~', '.config', 'pit'))])]
    let tokens = 0
    let calls = 0
    let problems: string[] = []
    let lastText = ''
    let lastHash: string | null = null
    const rounds = 1 + cfg.repairs
    for (let round = 0; round < rounds; round++) {
      const remaining = deadline - Date.now()
      if (remaining < 5000) throw new AgentError('timeout', `${harnessLabel(rt.kind, cfg)} timed out after ${cfg.timeoutSec}s (lease budget used up after ${calls} run(s))`)
      const p =
        round === 0
          ? prompt
          : [
              prompt,
              '',
              '## Your previous attempt was rejected by the local contract check',
              ...problems.slice(0, 12).map((x) => `- ${x}`),
              ...(bundle ? ['Fix the files in work/ so the deliverable meets the contract.'] : ['Previous answer (fix it and reply with the corrected answer only):', '```', lastText.slice(0, 12_000) || '(empty)', '```']),
            ].join('\n')
      const turn: AgentTurn & { ms: number } = await invoke({
        kind: rt.kind,
        bin: rt.bin,
        prompt: p,
        opts: { dir, readOnly: !bundle, model: configuredModel(rt.kind, cfg), effort: rt.kind === 'codex' ? cfg.codexEffort : rt.kind === 'claude' ? cfg.claudeEffort : undefined, maxTurns: cfg.maxTurns, network: cfg.network, system: SYSTEM(skill), denyRead },
        timeoutMs: remaining,
        cfg,
        env: rt.env,
        signal: rt.signal,
        killGraceMs: rt.killGraceMs,
        sandbox: rt.sandbox === true,
      })
      calls++
      tokens += turn.usage.totalTokens
      lastHash = turn.sessionHash ?? lastHash
      const model = turn.model || configuredModel(rt.kind, cfg) || `${harnessLabel(rt.kind, cfg)}-default`
      let text: string
      if (bundle) {
        const got = collectChanged(work, seed)
        if (got.skipped.length) rt.log?.(`${skill}: not collected: ${got.skipped.slice(0, 5).join(', ')}`)
        text = Object.keys(got.files).length ? JSON.stringify({ format: BUNDLE_FORMAT, files: got.files }) : turn.text
      } else text = asciiPunct(turn.text)
      lastText = text
      const shapes = secretShapes(text)
      if (containsSecret(text, secrets) || shapes.length) {
        rt.onCall?.({ model, usage: turn.usage, ms: turn.ms }, false)
        throw new SkillQualityError(`${skill}: the answer contained a local secret (${shapes.join(', ') || 'device or wallet key'}); not submitted`)
      }
      const checked = turn.subtype === 'error_max_turns' && !text.trim() ? { out: null, problems: [`the agent stopped at the turn limit (${cfg.maxTurns}) before finishing`] } : checkSkillAnswer(skill, text, ctx, briefs)
      problems = checked.problems
      rt.onCall?.({ model, usage: turn.usage, ms: turn.ms }, !!checked.out)
      if (checked.out) return { out: checked.out, model, tier: cfg.tier, tokens, calls, providerMsgIdHash: lastHash }
      rt.log?.(`${skill}: answer rejected by the local contract check (${problems.slice(0, 3).join('; ')})${round + 1 < rounds ? '; asking for a fix' : ''}`)
    }
    throw new SkillQualityError(`${skill}: no valid answer after ${calls} ${harnessLabel(rt.kind, cfg)} run(s): ${problems.slice(0, 3).join('; ')}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
