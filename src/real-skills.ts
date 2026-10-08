/**
 * Real-model skill runtime (holder side). Each skill gets the T7 prompt template + output contract (review-skills.ts),
 * the upstream inputs packed into the prompt (text files only, bounded), and a local contract check; an invalid answer is
 * sent back to the model with the problems (at most 2 repair rounds). Steps that must be byte-exact copies
 * (import-site, integrate-project) stay deterministic: a model must not retype files, so they make no model call and
 * claim zero tokens.
 */
import { checkProposal } from './founder-skills.ts'
import { chatComplete, ModelError, type ChatMessage, type ChatResult, type ModelConfig, type Tier } from './model.ts'
import { checkReply, parseReplyText, replyBriefOf, REPLY_FORMAT } from './outbound-skills.ts'
import { checkReview, promptFor, renderReview, REVIEW_FORMAT, REVIEW_SKILLS, T7_SKILLS, type ReviewDoc, type T7Context } from './review-skills.ts'
import { BUNDLE_FORMAT, stubIntegrate, underRoot, type SkillContext, type SkillInput, type SkillOutput } from './skill.ts'
import { stubImportSite } from './review-skills.ts'

/** Skills the model runtime can run (declared in hello). */
export const MODEL_SKILLS = [
  'write-readme',
  'research-report',
  'build-foundry',
  'build-vite',
  'integrate-project',
  'deploy-manifest',
  ...T7_SKILLS,
] as const

/** Deterministic tool steps (no model call). */
export const TOOL_SKILLS = new Set(['import-site', 'integrate-project'])
export const BUNDLE_MODEL_SKILLS = new Set(['build-foundry', 'build-vite', 'write-foundry-tests', 'fix-findings', 'deploy-manifest'])

/** Completion-token caps per skill (the config cap still applies). */
export const SKILL_MAX_TOKENS: Record<string, number> = {
  'write-proposal': 8000,
  'adversarial-review': 4500,
  'review-judge': 4000,
  'audit-specialist': 10000,
  'audit-judge': 10000,
  'code-review': 4500,
  'site-content-check': 3500,
  'outbound-content-check': 3000,
  'draft-reply': 2500,
  'write-readme': 2500,
  'research-report': 3000,
  'build-foundry': 8000,
  'build-vite': 8000,
  'write-foundry-tests': 6000,
  'fix-findings': 8000,
  'deploy-manifest': 3000,
}

export const SYSTEM = (skill: string) =>
  [
    `You are a holder AI working on a Pit seat (skill: ${skill}). Pit is a network where independent AI seats build and review small software deliverables; other seats check your work and the server validates the output format.`,
    'Follow the output contract exactly. Write plain English (ASCII punctuation). Be specific and grounded in the input files; do not invent facts about them.',
    'Be concise: keep prose short (reviews and checks under about 500 words) so the answer fits the token cap.',
    'Never include secrets or credentials, coin tickers, prices, investment or return talk, or personal data.',
  ].join('\n')

/** Foundry projects are verified fully offline: no lib/ dependencies, solc only from the runner's cache. */
const FOUNDRY_OFFLINE = [
  'Foundry build rules (the runner builds and tests fully offline; anything else fails the build):',
  '- No dependencies: do NOT import forge-std, OpenZeppelin, solmate or anything under lib/ or @...; no remappings. Write every contract you need yourself in src/.',
  '- Imports are relative ("../src/Counter.sol") or from the project root ("src/Counter.sol").',
  '- Use "pragma solidity ^0.8.20;" and do not pin another solc version in foundry.toml.',
  '- Tests are plain contracts in test/ with public functions named test_...; fail with require / assert / revert.',
  '- Cheatcodes without forge-std: declare a minimal interface in the test file, e.g. interface Vm { function prank(address) external; function deal(address, uint256) external; function expectRevert() external; } and Vm constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);',
  '- No deploy scripts that need forge-std (script/ may stay empty).',
  '- vm.expectRevert() and vm.prank() apply to the very NEXT external call, and calls inside the arguments come first: compute every argument in a local variable before the cheatcode (uint256 tooMuch = token.totalSupply() + 1; vm.expectRevert(); token.transfer(alice, tooMuch);), never token.transfer(alice, token.totalSupply() + 1) right after it.',
].join('\n')

export const EXTRA: Record<string, string> = {
  'research-report': [
    'You have no web access: this is desk research. For each tool, product or standard you discuss, cite its official homepage or documentation URL (only URLs you are sure exist).',
    'Qualify claims you cannot verify (for example "typically", "in our experience", "depends on project size"); do not invent benchmark numbers, dates or statistics. Put measurements you recommend under ## Next steps.',
  ].join('\n'),
  'build-foundry': FOUNDRY_OFFLINE,
  'write-foundry-tests': FOUNDRY_OFFLINE,
  'fix-findings': `If the project is a Foundry project:\n${FOUNDRY_OFFLINE}`,
  'deploy-manifest': [
    'Write exactly one file, pit-deploy.json, for the runner pre-deploy gate (Sepolia only). Schema:',
    '{"schema":"pit.deploy.v1","chainId":11155111,"gasBudget":15000000,"requireInvariants":true,"lintPaths":["src"],"contracts":[{"name":"<ContractName>","artifact":"out/<File>.sol/<ContractName>.json","constructorSlots":<number of storage slots the constructor writes>}]}',
    'List every contract in src/ that gets deployed (not interfaces, abstract contracts or libraries that are only internal), in deploy order. Count immutables as 0 slots; count each storage variable set in the constructor (including inherited ones such as Ownable) as 1 slot.',
    'Do not change gasBudget above 15000000 and do not use any other chainId.',
  ].join('\n'),
  'write-proposal': [
    'How to choose: pick the 3 strongest leads (real demand stated in the evidence, buildable as a small open-source tool, library, CLI or static site within a few days, safe). Skip opinion polls and vague chat.',
    'Each paper must name a concrete deliverable, its first-version features, and how it answers the cited evidence. Titles are short product names, not "Build: <question>".',
    'Use deliveryType token only if the lead itself needs a coin (it almost never does). Prefer repo / site, plus reply when the original poster can be answered with a link.',
    'budgetEth: realistic small numbers (about 0.01-0.05 for papers without token).',
    'Return ONLY the JSON object (no prose, no markdown fence).',
  ].join('\n'),
  'adversarial-review': [
    'If the inputs contain proposal.json (whitepapers) and a brief: check every paper against the brief and its cited evidence: grounded in the evidence, specific and buildable in days, no coin promotion / financial promises / impersonation / personal data, rules followed.',
    'Use blocking findings only for real problems that must be fixed before the work can go ahead; style suggestions are non-blocking (low / info). verdict pass when nothing blocks.',
    'If the inputs are a research report (desk research, written without web access): a missing citation or benchmark for a claim that is qualified or common knowledge is non-blocking (medium at most). Block only claims that are wrong, misleading or unsafe, or a report that does not answer the brief.',
    'Start with "# <title>", a short summary, then the pit-review block.',
    'Omit "poc" unless you include a real Foundry test (code + test_name); omit "path" / "line" when they do not apply (never null).',
  ].join('\n'),
  'review-judge': [
    'Rule on every finding of the reviews in your inputs (ref "<review node>/<finding id>", e.g. "review_a/F1"): confirmed, rejected or duplicate, with a short note.',
    'Your findings list keeps only confirmed findings. verdict pass only if no confirmed blocking finding stands; revise if the author can fix it; fail if the work must be dropped.',
  ].join('\n'),
  'site-content-check': [
    'Inspect the site files. Blocking (verdict fail): wallet connection or signing requests, phishing / claim bait, impersonation of brands or people, malware, illegal content.',
    'Scripts loaded from third-party origins without an integrity hash are a non-blocking medium finding. verdict pass when the site may be hosted.',
  ].join('\n'),
  'draft-reply': [
    'Read reply.json (the brief). Write 2-5 short sentences for the original poster: acknowledge their exact ask, say what the deliverable does for it, include the allowedLink exactly once, and end with the disclosure line copied verbatim.',
    'Return ONLY the JSON object {"format":"pit.reply.v1","body":"..."} (no prose, no markdown fence).',
  ].join('\n'),
  'outbound-content-check': [
    'The inputs hold the brief (src: reply.json with the thread, the deliverable and the community rules) and the draft (draft: reply.json, format pit.reply.v1).',
    'Judge the draft as a maintainer of that community would. Start with "# Outbound content check", a short summary, then the pit-review block.',
  ].join('\n'),
}

// ------------------------------------------------------------------ inputs

const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|bmp|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|mp[34]|wav|ogg|webm|wasm|bin|lock|b64)$/i

/** Pack upstream files into the prompt: text only, each file and the total bounded (truncation is marked). */
export function packInputs(deps: NonNullable<SkillContext['dependencies']>, maxChars: number): { text: string; files: number; truncated: boolean } {
  const perFile = Math.max(2000, Math.floor(maxChars / 3))
  let used = 0
  let truncated = false
  let files = 0
  const parts: string[] = []
  for (const d of deps) {
    for (const [p, raw] of Object.entries(d.files).sort(([a], [b]) => a.localeCompare(b))) {
      if (BINARY_EXT.test(p) || raw.includes('\u0000')) {
        parts.push(`=== ${d.key}: ${p} (binary, ${raw.length} bytes, not shown) ===`)
        continue
      }
      const room = maxChars - used
      if (room < 400) {
        truncated = true
        parts.push(`=== ${d.key}: ${p} (omitted: prompt budget reached) ===`)
        continue
      }
      let body = raw
      const cap = Math.min(perFile, room)
      if (body.length > cap) {
        body = `${body.slice(0, cap)}\n[... truncated ${raw.length - cap} chars ...]`
        truncated = true
      }
      used += body.length
      files++
      parts.push(`=== ${d.key}: ${p} ===\n${body}`)
    }
  }
  return { text: parts.join('\n\n') || '(no input files)', files, truncated }
}

// ------------------------------------------------------------------ output parsing + local checks

/** First JSON object in the text: whole text, a fenced block, or the outermost braces. */
export function extractJson(text: string): unknown {
  const t = text.trim()
  const fence = /```(?:json|pit-proposal)?[ \t]*\r?\n([\s\S]*?)\r?\n```/.exec(t)
  for (const cand of [t, fence?.[1], t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)]) {
    if (!cand || !cand.trim().startsWith('{')) continue
    try {
      return JSON.parse(cand)
    } catch {
      // next candidate
    }
  }
  return null
}

const URL_IN_TEXT = /(https?:\/\/|www\.)\S/i
const TICKER = /(^|[^\w$])\$[A-Za-z][A-Za-z0-9]{1,9}\b/
const ADDRESS = /\b0x[a-fA-F0-9]{8,}\b/
const NON_ASCII = /[^\x09\x0a\x0d\x20-\x7e]/

const PUNCT: [RegExp, string][] = [
  [/[\u2018\u2019\u201a\u201b\u2032\u00b4]/g, "'"],
  // Curly double quotes become single quotes: they may sit inside JSON string values, where a raw " would break JSON.
  [/[\u201c\u201d\u201e\u201f\u2033\u00ab\u00bb]/g, "'"],
  [/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-'],
  [/\u2026/g, '...'],
  [/\u2192/g, '->'],
  [/\u2190/g, '<-'],
  [/\u2194/g, '<->'],
  [/\u21d2/g, '=>'],
  [/[\u00a0\u2009\u200a\u202f\u2007\u2002\u2003]/g, ' '],
  [/[\u200b\u200c\u200d\ufeff]/g, ''],
  [/[\u2022\u00b7\u2023\u25aa]/g, '-'],
  [/\u00d7/g, 'x'],
  [/\u2264/g, '<='],
  [/\u2265/g, '>='],
  [/\u2248/g, '~'],
  [/\u2260/g, '!='],
]

/** Typographic punctuation -> ASCII (models love em dashes and curly quotes); letters are left alone. */
export function asciiPunct(s: string): string {
  let out = s
  for (const [re, to] of PUNCT) out = out.replace(re, to)
  return out
}

interface BriefLite {
  leads?: { evidence?: { url: string }[] }[]
  pitches?: { id: number }[]
  recentTitles?: string[]
  nonTokenBudgetEth?: number
  maxBudgetEth?: number
}

function briefOf(ctx: SkillContext): BriefLite | null {
  for (const d of ctx.dependencies ?? [])
    for (const [p, body] of Object.entries(d.files))
      if (p.endsWith('brief.json'))
        try {
          const b = JSON.parse(body) as BriefLite & { format?: string }
          if (b?.format === 'pit.brief.v1') return b
        } catch {
          // not a brief
        }
  return null
}

/** Local mirror of the server's proposal checks (the server validates again). */
export function proposalProblems(obj: unknown, brief: BriefLite | null): string[] {
  const text = JSON.stringify(obj ?? null)
  const errs = obj && typeof obj === 'object' ? checkProposal(text) : ['output is not a JSON object']
  if (errs.length) return errs
  const papers = (obj as { papers: Record<string, unknown>[] }).papers
  const evidence = new Set((brief?.leads ?? []).flatMap((l) => (l.evidence ?? []).map((e) => e.url)))
  const recent = new Set((brief?.recentTitles ?? []).map((t) => t.trim().toLowerCase()))
  const sets = new Set<string>()
  papers.forEach((p, i) => {
    const n = `paper ${i + 1}`
    const lim: [string, number][] = [
      ['title', 120],
      ['pitch', 400],
      ['problem', 800],
      ['product', 800],
    ]
    for (const [k, max] of lim) {
      const v = p[k]
      if (typeof v !== 'string' || !v.trim()) errs.push(`${n}: ${k} is required`)
      else {
        if (v.length > max) errs.push(`${n}: ${k} is longer than ${max} characters`)
        if (URL_IN_TEXT.test(v)) errs.push(`${n}: ${k} contains a link (links belong only in sourceSignals)`)
        if (TICKER.test(v) || ADDRESS.test(v)) errs.push(`${n}: ${k} contains a $TICKER-like word or an address`)
        if (NON_ASCII.test(v)) errs.push(`${n}: ${k} must be plain ASCII English`)
      }
    }
    if (typeof p.title === 'string' && recent.has(p.title.trim().toLowerCase())) errs.push(`${n}: title repeats a recent title`)
    const ss = Array.isArray(p.sourceSignals) ? (p.sourceSignals as unknown[]).map(String) : []
    for (const u of ss) if (evidence.size && !evidence.has(u)) errs.push(`${n}: sourceSignals URL is not copied exactly from the brief evidence: ${u.slice(0, 100)}`)
    if (ss.length > 5) errs.push(`${n}: at most 5 sourceSignals`)
    const key = [...ss].sort().join(' ')
    if (key && sets.has(key)) errs.push(`${n}: same evidence as another paper; use a different lead`)
    sets.add(key)
    const b = Number(p.budgetEth)
    const dt = Array.isArray(p.deliveryType) ? (p.deliveryType as string[]) : []
    if (!(Number.isFinite(b) && b > 0)) errs.push(`${n}: budgetEth must be a positive number`)
    else if (!dt.includes('token') && brief?.nonTokenBudgetEth && b > brief.nonTokenBudgetEth) errs.push(`${n}: budgetEth above nonTokenBudgetEth (${brief.nonTokenBudgetEth})`)
  })
  return errs
}

const COIN =
  /\b(coins?|crypto(currency|currencies)?|tokenomics|airdrops?|presales?|memecoins?|pump(ing)?|to the moon|market ?caps?|staking|nfts?|token (sale|launch|price|holders?)|invest(ment|ing|ors?)?|price (target|prediction|action)|financial advice)\b/i
const PROMO = /\b(join (our|us)|follow (us|me)|subscribe|sign up|discord|telegram|whatsapp|upvote|star (us|the repo|this repo))\b/i
const MENTION = /(^|[\s(])@[A-Za-z0-9][A-Za-z0-9-]{0,38}\b/
const MEDIA = /!\[|<\s*(img|script|iframe|a|video|style)\b/i

/** Local mirror of the server's reply checks. */
export function replyProblems(text: string, allowedLink?: string, disclosure?: string): string[] {
  const errs = checkReply(text, allowedLink)
  const body = parseReplyText(text)
  if (body === null) return errs
  if (NON_ASCII.test(body)) errs.push('plain ASCII English only')
  if (TICKER.test(body) || ADDRESS.test(body)) errs.push('no tickers or addresses')
  if (COIN.test(body)) errs.push('no coin / token-sale / price / investment words')
  if (PROMO.test(body)) errs.push('no promotion (follow / join / star / discord ...)')
  if (MENTION.test(body)) errs.push('no @mentions')
  if (MEDIA.test(body)) errs.push('no images or HTML')
  if (disclosure && !body.includes(disclosure)) errs.push(`end with the disclosure line verbatim: ${disclosure}`)
  return errs
}

/** Accept a review as markdown + pit-review block; rescue a bare JSON review by rendering it. */
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info']
const REVIEW_BLOCK = /```pit-review[ \t]*\r?\n([\s\S]*?)\r?\n```/
const nonEmpty = (v: unknown, max: number) => typeof v === 'string' && v.trim().length > 0 && v.length <= max
const clipStr = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : v)

/**
 * Mechanical clean-up of a model's pit-review JSON to the server contract (backend/src/findings.ts parseReview): null /
 * malformed optional fields (path, line, poc, reproduction) are dropped, a PoC is kept only with real code and a
 * test_name, over-long strings are clipped, invalid coverage / ruling rows are dropped. Verdict and findings are never
 * changed in substance.
 */
export function sanitizeReviewDoc(raw: Record<string, unknown>): Record<string, unknown> {
  const o: Record<string, unknown> = { ...raw, format: REVIEW_FORMAT }
  o.summary = clipStr(o.summary, 2000)
  const ids = new Set<string>()
  let pocs = 0
  o.findings = (Array.isArray(o.findings) ? o.findings : []).slice(0, 50).map((f0, i) => {
    const f: Record<string, unknown> = { ...((f0 ?? {}) as Record<string, unknown>) }
    let id = typeof f.id === 'string' && /^[A-Za-z0-9_-]{1,16}$/.test(f.id) ? f.id : `F${i + 1}`
    while (ids.has(id)) id = `${id.slice(0, 12)}_${i + 1}`
    ids.add(id)
    f.id = id
    if (typeof f.severity === 'string') f.severity = f.severity.toLowerCase()
    f.title = clipStr(f.title, 200)
    f.description = clipStr(f.description, 4000)
    if (f.path === null || (f.path !== undefined && (!nonEmpty(f.path, 300) || String(f.path).includes('..')))) delete f.path
    if (f.line !== undefined) {
      const n = Number(f.line)
      if (f.line === null || !Number.isInteger(n) || n <= 0) delete f.line
      else f.line = n
    }
    if (f.reproduction === null || (f.reproduction !== undefined && typeof f.reproduction !== 'string')) delete f.reproduction
    else if (typeof f.reproduction === 'string') f.reproduction = f.reproduction.slice(0, 4000)
    if (f.poc !== undefined) {
      const pc = (f.poc ?? {}) as Record<string, unknown>
      if (!nonEmpty(pc.code, 20_000) || pocs >= 5) delete f.poc
      else {
        pocs++
        f.poc = { code: String(pc.code).trim(), ...(typeof pc.test === 'string' && /^test\w{0,60}$/.test(pc.test) ? { test: pc.test } : {}) }
      }
    }
    return f
  })
  o.coverage = (Array.isArray(o.coverage) ? o.coverage : []).filter((c) => {
    const x = (c ?? {}) as Record<string, unknown>
    return nonEmpty(x.target, 200) && ['holds', 'breaks', 'n/a'].includes(String(x.verdict))
  }).slice(0, 50)
  o.rulings = (Array.isArray(o.rulings) ? o.rulings : []).filter((r) => {
    const x = (r ?? {}) as Record<string, unknown>
    return nonEmpty(x.ref, 80) && ['confirmed', 'rejected', 'duplicate'].includes(String(x.decision))
  }).slice(0, 200)
  return o
}

/** Same rules as the server's review validator (subset that a clean-up cannot fix). Empty = ok. */
export function serverReviewProblems(text: string): string[] {
  const errs: string[] = []
  if (!/^#\s+\S/m.test(text)) errs.push('report needs a "# title" line')
  const m = REVIEW_BLOCK.exec(text)
  if (!m) return [...errs, 'missing or invalid pit-review block']
  let o: Record<string, unknown>
  try {
    o = JSON.parse(m[1]!) as Record<string, unknown>
  } catch {
    return [...errs, 'pit-review block is not valid JSON']
  }
  if (o.format !== REVIEW_FORMAT) errs.push(`format must be ${REVIEW_FORMAT}`)
  if (!['pass', 'revise', 'fail'].includes(String(o.verdict))) errs.push('verdict must be pass | revise | fail')
  if (!nonEmpty(o.summary, 2000)) errs.push('summary required (<= 2000 chars)')
  const fs = Array.isArray(o.findings) ? (o.findings as Record<string, unknown>[]) : null
  if (!fs) errs.push('findings must be an array')
  else
    fs.forEach((f, i) => {
      if (!SEVERITIES.includes(String(f?.severity))) errs.push(`findings[${i}].severity invalid`)
      if (!nonEmpty(f?.title, 200)) errs.push(`findings[${i}].title required`)
      if (!nonEmpty(f?.description, 4000)) errs.push(`findings[${i}].description required`)
    })
  if (o.verdict === 'pass' && fs?.some((f) => f?.blocking === true || (f?.blocking === undefined && ['critical', 'high'].includes(String(f?.severity))))) errs.push('verdict pass is inconsistent with blocking findings')
  return errs
}

export function normalizeReview(text: string, title: string): string {
  let t = text.trim()
  const wrapped = /^```(?:markdown|md)?[ \t]*\r?\n([\s\S]*)\r?\n```$/.exec(t)
  if (wrapped && !/```pit-review/.test(t.slice(3, 40))) t = wrapped[1]!.trim()
  const m = REVIEW_BLOCK.exec(t)
  if (m) {
    try {
      const clean = sanitizeReviewDoc(JSON.parse(m[1]!) as Record<string, unknown>)
      t = t.replace(m[0], '```pit-review\n' + JSON.stringify(clean, null, 2) + '\n```')
    } catch {
      // invalid JSON: left for the local check / repair round
    }
    return /^#\s+\S/m.test(t) ? t : `# ${title}\n\n${t}`
  }
  const o = extractJson(t) as (ReviewDoc & { format?: string }) | null
  if (o && typeof o === 'object' && typeof o.verdict === 'string' && Array.isArray(o.findings)) {
    const { format: _f, ...doc } = sanitizeReviewDoc(o as unknown as Record<string, unknown>) as unknown as ReviewDoc & { format?: string }
    void _f
    return renderReview(title, { coverage: [], rulings: [], ...doc })
  }
  return t
}

const REVIEW_TITLE: Record<string, string> = {
  'adversarial-review': 'Review',
  'review-judge': 'Review judgement',
  'audit-specialist': 'Audit',
  'audit-judge': 'Audit judgement',
  'code-review': 'Code review',
  'site-content-check': 'Site content check',
  'outbound-content-check': 'Outbound content check',
}

function bundleProblems(obj: unknown, paths: string[]): string[] {
  const o = obj as { format?: unknown; files?: unknown } | null
  if (!o || o.format !== BUNDLE_FORMAT || !o.files || typeof o.files !== 'object') return [`output must be JSON {"format":"${BUNDLE_FORMAT}","files":{...}}`]
  const files = o.files as Record<string, unknown>
  const errs: string[] = []
  if (!Object.keys(files).length) errs.push('no files')
  const ok = (p: string) => paths.length === 0 || paths.some((g) => g === '**' || (g.endsWith('/**') ? p.startsWith(g.slice(0, -2)) : p === g))
  for (const [p, c] of Object.entries(files)) {
    if (typeof c !== 'string') errs.push(`${p}: content must be a string`)
    if (p.startsWith('/') || p.includes('..') || /(^|\/)(\.env|node_modules|out|dist)(\/|$)/.test(p)) errs.push(`${p}: path not allowed`)
    else if (!ok(p)) errs.push(`${p}: outside the node paths (${paths.join(', ')})`)
  }
  return errs
}

// ------------------------------------------------------------------ runtime

export interface ModelRun {
  out: SkillOutput
  /** Model actually used ('tool:<skill>' for deterministic steps). */
  model: string
  tier: Tier
  tokens: number
  calls: number
  providerMsgIdHash: string | null
}

export interface ModelRuntime {
  cfg: ModelConfig
  chat?: typeof chatComplete
  log?: (s: string) => void
  /** Called after every model call (usage logging). */
  onCall?: (r: ChatResult, ok: boolean) => void
  /** Max repair rounds after an invalid answer (default 2). */
  repairs?: number
}

export class SkillQualityError extends Error {}

/** Upstream input does not fit this seat's prompt budget: fail loudly instead of working on a truncated view. */
export class InputTooLargeError extends Error {}

/** Problems with a deploy-manifest bundle (mirrors the runner's parseManifest). */
const FOUNDRY_SKILLS = new Set(['build-foundry', 'write-foundry-tests', 'fix-findings'])
/** solc builds in the runner's read-only svm cache (runner/src/sandbox.ts mounts it; nothing is downloaded). */
export const RUNNER_SOLC = ['0.8.20', '0.8.24', '0.8.26', '0.8.28', '0.8.30']

/** Imports and compiler pins that cannot resolve in the offline runner (checked before the work is submitted). */
export function foundryOfflineProblems(files: Record<string, string>, deps: NonNullable<SkillContext['dependencies']> = []): string[] {
  const errs: string[] = []
  // A project that vendors its libraries (lib/<pkg>/ in the tree) resolves them offline; only missing packages fail.
  const libs = [...deps.flatMap((d) => Object.keys(d.files)), ...Object.keys(files)].filter((f) => /(^|\/)lib\//.test(f)).map((f) => f.slice(f.indexOf('lib/') + 4))
  const vendored = (imp: string) => {
    const seg = imp.split('/')[0]!.replace(/^@/, '')
    return libs.some((l) => l.startsWith(`${seg}/`) || l.startsWith(`${seg}-`))
  }
  for (const [p, src] of Object.entries(files)) {
    if (p.endsWith('.sol')) {
      for (const m of src.matchAll(/^\s*import\s+(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/gm)) {
        const imp = m[1]!
        if (imp.startsWith('./') || imp.startsWith('../')) continue
        const rootRel = imp.replace(/^\/+/, '')
        if (/^(src|test|script)\//.test(rootRel)) continue // project-root path (forge resolves it; the file may come from another step)
        if (vendored(rootRel)) continue
        errs.push(`${p}: import "${imp}" cannot resolve offline (no forge-std / lib / remapped packages); write the code in src/ and import it relatively`)
      }
      for (const m of src.matchAll(/pragma\s+solidity\s+([^;]+);/g)) {
        const v = m[1]!.trim()
        const exact = /^=?\s*(\d+\.\d+\.\d+)$/.exec(v)
        if (exact && !RUNNER_SOLC.includes(exact[1]!)) errs.push(`${p}: pragma solidity ${v} is not available offline; use ^0.8.20`)
      }
    }
    if (/(^|\/)foundry\.toml$/.test(p)) {
      const pin = /^\s*solc(?:_version)?\s*=\s*["']?([0-9.]+)["']?/m.exec(src)
      if (pin && !RUNNER_SOLC.includes(pin[1]!)) errs.push(`${p}: solc ${pin[1]} is not available offline; remove the pin or use one of ${RUNNER_SOLC.join(', ')}`)
    }
    if (/(^|\/)remappings\.txt$/.test(p) && src.trim() && !libs.length) errs.push(`${p}: remappings point at packages the offline runner does not have; remove the file`)
  }
  return [...new Set(errs)].slice(0, 12)
}

/** Receivers that look like `x.y(` but are not external calls (Solidity built-ins). */
const NOT_EXTERNAL = new Set(['abi', 'bytes', 'string', 'type', 'block', 'msg', 'tx', 'super'])
/** Common libraries whose functions are all internal (inlined, no call): Strings.toString(id), SafeCast.toUint8(x). */
const INTERNAL_LIBS = new Set(['Strings', 'SafeCast', 'Math', 'SignedMath', 'SafeMath'])
/** Their usual function names, for `using SafeMath for uint256; amount.add(1)`. */
const INTERNAL_LIB_FN = /^(?:try)?(?:add|sub|mul|div|mod|max|min|average|ceilDiv|mulDiv|sqrt|abs|log2|log10|log256|equal|to(?:U?int\d*|String|HexString|Checksum\w*))$/
/** Members of non-contract values that read like calls: arr.push(x), arr.pop(), Price.wrap(x), p.unwrap(). */
const NOT_EXTERNAL_MEMBER = new Set(['push', 'pop', 'wrap', 'unwrap'])
/** One-shot cheatcodes that apply to the next call at the test's depth. */
const CHEATS = 'expectRevert|expectPartialRevert|prank'
/** Size caps (P3-3): files and statements beyond these are not checked (the runner's forge test still is). */
const MAX_TEST_FILE = 200_000
const MAX_STATEMENT = 4_000

/** Comments and string contents blanked to spaces (newlines kept), in one pass: `"ipfs://x"` is not a comment. */
function blankSolidity(src: string): string {
  const out = src.split('')
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]!
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') out[i++] = ' '
    } else if (c === '/' && src[i + 1] === '*') {
      out[i] = out[i + 1] = ' '
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] !== '\n') out[i] = ' '
        i++
      }
      if (i < n) out[i] = out[i + 1] = ' '
      i += 2
    } else if (c === '"' || c === "'") {
      i++
      while (i < n && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\' && i + 1 < n) out[i++] = ' '
        out[i++] = ' '
      }
      i++
    } else i++
  }
  return out.join('')
}

/** Matching bracket for every ( [ { and ) ] } (-1 when unbalanced), in one pass. */
function bracketPairs(src: string): Int32Array {
  const pair = new Int32Array(src.length).fill(-1)
  const stack: number[] = []
  const open: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!
    if (c === '(' || c === '[' || c === '{') stack.push(i)
    else if (c in open && stack.length && src[stack[stack.length - 1]!] === open[c]) {
      const o = stack.pop()!
      pair[o] = i
      pair[i] = o
    }
  }
  return pair
}

/**
 * Libraries declared in the bundle -> their internal / private function names.
 *
 * Linear (PR #35 P3-35c): Solidity cannot nest a library, contract or interface inside a library, so a body ends at its
 * closing brace or at the next library / contract / interface declaration, whichever comes first. Bodies never
 * overlap, so an unclosed or deeply nested `library L {` no longer rescans the rest of the file.
 */
function internalLibraryFunctions(blanked: string[]): Map<string, Set<string>> {
  const libs = new Map<string, Set<string>>()
  for (const src of blanked) {
    if (!/\blibrary\b/.test(src)) continue
    const pair = bracketPairs(src)
    const decls = [...src.matchAll(/\b(?:library|contract|interface)\s+[A-Za-z_]\w*/g)].map((d) => d.index!)
    let next = 0
    for (const m of src.matchAll(/\blibrary\s+([A-Za-z_]\w*)\s*\{/g)) {
      const open = m.index! + m[0].length - 1
      while (next < decls.length && decls[next]! <= m.index!) next++
      const bound = next < decls.length ? decls[next]! : src.length
      const close = pair[open]! > open ? Math.min(pair[open]!, bound) : bound
      const fns = libs.get(m[1]!) ?? new Set<string>()
      const body = src.slice(open, close)
      for (const f of body.matchAll(/\bfunction\s+([A-Za-z_]\w*)\s*\(/g)) {
        const p = open + f.index! + f[0].length - 1
        const after = pair[p]! > p ? pair[p]! + 1 : p + 1
        const head = src.slice(after, Math.min(close, after + 400)).split(/[{;]/, 1)[0]!
        if (/\b(?:internal|private)\b/.test(head)) fns.add(f[1]!)
      }
      libs.set(m[1]!, fns)
    }
  }
  return libs
}

/** Struct types declared in the bundle: `Market.Order({...})` / `Types.Order(a, 1)` build a value, they make no call. */
function declaredStructs(blanked: string[]): Set<string> {
  const structs = new Set<string>()
  for (const src of blanked) for (const m of src.matchAll(/\bstruct\s+([A-Za-z_]\w*)\s*\{/g)) structs.add(m[1]!)
  return structs
}

interface CallSite {
  /** Start of the whole call expression (receiver included: `factory.token().totalSupply()` starts at `factory`). */
  from: number
  /** Index of the closing `)` of the arguments. */
  to: number
  label: string
}

const isId = (c: string | undefined) => !!c && /[A-Za-z0-9_$]/.test(c)

/**
 * External calls in src[s, e): `x.f(...)`, `x.f{...}(...)`, `Cast(a).f(...)`, `g().f(...)`, `new C(...)`, minus
 * built-ins, cheatcodes, internal library functions, qualified struct literals and members of plain values.
 */
function externalCalls(src: string, pair: Int32Array, s: number, e: number, ctx: { vm: Set<string>; libs: Map<string, Set<string>>; structs: Set<string>; using: string[] }): CallSite[] {
  const calls: CallSite[] = []
  const startAt = new Map<number, number>() // closing paren of a call -> start of that call (receiver walk memo)
  const back = (i: number) => {
    while (i >= s && /\s/.test(src[i]!)) i--
    return i
  }
  // Start of the receiver expression that ends right before `dot`.
  const receiverStart = (dot: number) => {
    let i = back(dot - 1)
    let from = dot
    while (i >= s) {
      if (isId(src[i])) {
        let j = i
        while (j > s && isId(src[j - 1])) j--
        from = j
        i = back(j - 1)
      } else if (src[i] === ')' || src[i] === ']') {
        const memo = startAt.get(i)
        const o = memo ?? pair[i]!
        if (o < s) break
        from = o
        i = back(o - 1)
        if (memo === undefined && isId(src[i])) continue // Token(addr) / foo(): the name before the parens
      } else break
      if (i >= s && src[i] === '.') i = back(i - 1)
      else break
    }
    return from
  }
  // Index of the closing `)` of the arguments after `{options}` or `(` at `at`, else -1.
  const argsEnd = (at: number) => {
    if (src[at] === '{') {
      const close = pair[at]!
      if (close < at || close >= e) return -1
      let k = close + 1
      while (k < e && /\s/.test(src[k]!)) k++
      at = k
    }
    if (src[at] !== '(') return -1
    const close = pair[at]!
    return close > at && close < e ? close : -1
  }
  const part = src.slice(s, e)
  for (const m of part.matchAll(/([A-Za-z_]\w*|[)\]])\s*\.\s*([A-Za-z_]\w*)\s*([({])|\bnew\s+([A-Za-z_][\w.]*)\s*([({])/g)) {
    const at = s + m.index! + m[0].length - 1
    const to = argsEnd(at)
    if (to < 0) continue
    if (m[4] !== undefined) {
      if (m[4] === 'bytes' || m[4] === 'string') continue
      calls.push({ from: s + m.index!, to, label: `new ${m[4]}` })
      startAt.set(to, s + m.index!)
      continue
    }
    const recv = m[1]!
    const fn = m[2]!
    const named = recv !== ')' && recv !== ']'
    if (named && (NOT_EXTERNAL.has(recv) || ctx.vm.has(recv) || /^\d/.test(recv))) continue
    if (named && (INTERNAL_LIBS.has(recv) || ctx.libs.get(recv)?.has(fn))) continue
    if (named && ctx.structs.has(fn)) continue // Market.Order({...}): a struct literal, its arguments are still scanned
    if (NOT_EXTERNAL_MEMBER.has(fn)) continue
    if (ctx.using.some((l) => ctx.libs.get(l)?.has(fn) || (INTERNAL_LIBS.has(l) && INTERNAL_LIB_FN.test(fn)))) continue
    const dot = s + m.index! + m[0].indexOf('.')
    const from = receiverStart(dot)
    calls.push({ from, to, label: `${named ? recv : src.slice(from, dot).replace(/\s+/g, '')}.${fn}` })
    startAt.set(to, from)
  }
  return calls
}

/**
 * Test pitfalls that fail the runner's forge test: vm.expectRevert / vm.prank apply to the next external call, and an
 * external call evaluated before the call under test (in its receiver, call options or arguments) runs first, e.g.
 * token.transfer(a, token.totalSupply() + 1) right after vm.expectRevert(): the expectation is spent on totalSupply(),
 * "next call did not revert as expected". Calls after the call under test (require(a.f() && b.g())) are fine.
 *
 * Linear: one pass blanks strings and comments, one pass pairs brackets, and each statement is read once. A bundle
 * with no cheatcode in any .sol file returns before the library scan.
 *
 * Accepted misses (PR #35 P3-35b): these are not flagged, and the runner's forge test still fails such a bundle, i.e.
 * the behaviour before this check existed. A miss never produces a false refusal.
 * - The call under test is itself an internal library function with an external call in its arguments:
 *   `using SafeT for Token; vm.expectRevert(); token.safeTransfer(a, token.totalSupply() + 1);`. The target is
 *   inlined (no call), so only one external call is left in the statement and nothing is compared.
 * - A bundle library named like a well-known internal-only library (Math, Strings, SafeCast, SignedMath, SafeMath)
 *   whose functions are public: the name is trusted and its calls are treated as inlined, not as DELEGATECALLs.
 * - An internal helper of the test contract that makes an external call (`vm.expectRevert(); token.transfer(a,
 *   _supply() + 1);` where _supply() calls token.totalSupply()): the helper's body is not followed.
 */
export function foundryTestProblems(files: Record<string, string>): string[] {
  const errs: string[] = []
  const sol = Object.entries(files).filter(([p, raw]) => p.endsWith('.sol') && typeof raw === 'string' && raw.length <= MAX_TEST_FILE)
  const blanked = new Map(sol.map(([p, raw]) => [p, blankSolidity(raw)]))
  const cheat = new RegExp(`\\b(?:${CHEATS})\\b`)
  const tests = [...blanked].filter(([, src]) => cheat.test(src))
  if (!tests.length) return errs
  const libs = internalLibraryFunctions([...blanked.values()])
  const structs = declaredStructs([...blanked.values()])
  for (const [p, src] of tests) {
    const pair = bracketPairs(src)
    // Anything typed Vm / Hevm is the cheatcode contract (vm, hevm, cheats).
    const vm = new Set(['vm', 'hevm', 'cheats'])
    for (const d of src.matchAll(/\b(?:Vm|Hevm)\s+(?:(?:constant|immutable|internal|private|public)\s+)*([A-Za-z_]\w*)\s*[=;]/g)) vm.add(d[1]!)
    const using = [...src.matchAll(/\busing\s+([A-Za-z_]\w*)\s+for\b/g)].map((u) => u[1]!)
    let line = 1
    let lineAt = 0
    for (const m of src.matchAll(new RegExp(`\\b([A-Za-z_]\\w*)\\s*\\.\\s*(${CHEATS})\\s*\\(`, 'g'))) {
      if (!vm.has(m[1]!)) continue
      const open = m.index! + m[0].length - 1
      const close = pair[open]!
      if (close < open) continue
      let s = close + 1
      while (s < src.length && /\s/.test(src[s]!)) s++
      if (src[s] !== ';') continue
      s++
      const semi = src.indexOf(';', s)
      if (semi < 0 || semi - s > MAX_STATEMENT) continue
      let parens = 0
      for (let k = s; k < semi && parens < 2; k++) if (src.charCodeAt(k) === 40) parens++
      if (parens < 2) continue // two calls need two argument lists
      const calls = externalCalls(src, pair, s, semi, { vm, libs, structs, using })
      if (calls.length < 2) continue
      // The call under test is the outermost one that starts first; flag calls it evaluates before itself.
      const target = calls.reduce((a, b) => (b.from < a.from || (b.from === a.from && b.to > a.to) ? b : a))
      const early = calls.find((c) => c !== target && c.from >= target.from && c.to <= target.to)
      if (!early) continue
      for (; lineAt < m.index!; lineAt++) if (src.charCodeAt(lineAt) === 10) line++
      const stmt = files[p]!.slice(s, semi).trim().replace(/\s+/g, ' ').slice(0, 80)
      errs.push(
        `${p}:${line}: ${m[1]}.${m[2]}() applies to the next external call, but in "${stmt}" the call ${early.label}() runs before ${target.label}() (it is part of that call's receiver, options or arguments); compute that value in a local variable before ${m[1]}.${m[2]}()`,
      )
      if (errs.length >= 12) return errs
    }
  }
  return [...new Set(errs)].slice(0, 12)
}

export function deployManifestProblems(files: Record<string, string>): string[] {
  const raw = files['pit-deploy.json']
  if (raw === undefined) return ['write pit-deploy.json']
  let o: Record<string, unknown>
  try { o = JSON.parse(raw) } catch { return ['pit-deploy.json is not valid JSON'] }
  const out: string[] = []
  if (o.schema !== 'pit.deploy.v1') out.push('schema must be "pit.deploy.v1"')
  if (o.chainId !== 11155111) out.push('chainId must be 11155111 (Sepolia)')
  if (o.gasBudget !== undefined && (!Number.isInteger(o.gasBudget) || (o.gasBudget as number) <= 0 || (o.gasBudget as number) > 15_000_000)) out.push('gasBudget must be an integer <= 15000000')
  const cs = Array.isArray(o.contracts) ? o.contracts : []
  if (!cs.length || cs.length > 32) out.push('contracts needs 1..32 entries')
  for (const c of cs as Record<string, unknown>[]) {
    if (typeof c?.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(c.name)) out.push('each contract needs a valid name')
    else if (typeof c.artifact !== 'string' || !/^out\/[A-Za-z0-9_.\/-]+\.json$/.test(c.artifact) || c.artifact.includes('..')) out.push(`${c.name}: artifact must be out/<File>.sol/<Name>.json`)
    if (c?.constructorSlots !== undefined && (!Number.isInteger(c.constructorSlots) || (c.constructorSlots as number) < 0 || (c.constructorSlots as number) > 200)) out.push('constructorSlots must be an integer 0..200')
  }
  return out
}

/** Briefs some skills check their answer against (proposal evidence, reply link + disclosure). */
export interface AnswerBriefs {
  brief: BriefLite | null
  replyBrief: ReturnType<typeof replyBriefOf> | null
}

export function answerBriefs(skill: string, input: SkillInput, ctx: SkillContext): AnswerBriefs {
  return { brief: skill === 'write-proposal' ? briefOf(ctx) : null, replyBrief: skill === 'draft-reply' ? replyBriefOf(t7ctx(input, ctx)) : null }
}

/**
 * The local contract check of one answer (shared by the model runtime and the local CLI runtimes): the skill's output
 * when the answer passes, else the problems to send back in a repair round. `text` is already ASCII-normalised for
 * non-bundle skills.
 */
export function checkSkillAnswer(skill: string, text: string, ctx: SkillContext, briefs: AnswerBriefs): { out: SkillOutput | null; problems: string[] } {
  let out: SkillOutput | null = null
  let problems: string[]
  if (skill === 'write-proposal') {
    const obj = extractJson(text)
    problems = proposalProblems(obj, briefs.brief)
    if (!problems.length) out = { kind: 'markdown', markdown: `${JSON.stringify(obj, null, 2)}\n` }
  } else if (skill === 'draft-reply') {
    const obj = extractJson(text) as { format?: string; body?: unknown } | null
    const norm = obj && obj.format === REPLY_FORMAT && typeof obj.body === 'string' ? `${JSON.stringify({ format: REPLY_FORMAT, body: obj.body.trim() }, null, 2)}\n` : text
    problems = replyProblems(norm, briefs.replyBrief?.allowedLink, briefs.replyBrief?.disclosure)
    if (!problems.length) out = { kind: 'markdown', markdown: norm }
  } else if ((REVIEW_SKILLS as readonly string[]).includes(skill)) {
    const md = normalizeReview(text, REVIEW_TITLE[skill] ?? 'Review')
    problems = [...new Set([...checkReview(md), ...serverReviewProblems(md)])]
    if (NON_ASCII.test(md.replace(/```pit-review[\s\S]*?```/, ''))) problems.push('plain ASCII English only')
    if (!problems.length) out = { kind: 'markdown', markdown: md.endsWith('\n') ? md : `${md}\n` }
  } else if (BUNDLE_MODEL_SKILLS.has(skill)) {
    const obj = extractJson(text) as { files?: Record<string, string> } | null
    problems = bundleProblems(obj, ctx.paths ?? [])
    if (!problems.length && skill === 'deploy-manifest') problems = deployManifestProblems(obj?.files ?? {})
    if (!problems.length && FOUNDRY_SKILLS.has(skill)) problems = foundryOfflineProblems(obj?.files ?? {}, ctx.dependencies ?? [])
    if (!problems.length && FOUNDRY_SKILLS.has(skill)) problems = foundryTestProblems(obj?.files ?? {})
    if (!problems.length) out = { kind: 'bundle', files: skill === 'build-foundry' || skill === 'build-vite' ? maybeUnderRoot(obj!.files!, ctx.root) : obj!.files! }
  } else {
    problems = text.trim().length < 40 ? ['answer is empty or too short'] : NON_ASCII.test(text) ? ['plain ASCII English only'] : README_SKILLS.has(skill) ? readmeProblems(text) : []
    if (!problems.length) out = { kind: 'markdown', markdown: text.trim() + '\n' }
  }
  return { out, problems }
}

export async function runSkillModel(skill: string, input: SkillInput, ctx: SkillContext & { tier?: string | null }, rt: ModelRuntime): Promise<ModelRun> {
  const cfg = rt.cfg
  const useCheap = ctx.tier === 'economy' && !!cfg.cheapModel
  const model = useCheap ? cfg.cheapModel! : cfg.model
  const tier: Tier = useCheap ? 'economy' : cfg.tier
  if (TOOL_SKILLS.has(skill)) {
    const t7 = t7ctx(input, ctx)
    const files = skill === 'import-site' ? stubImportSite(t7) : stubIntegrate(input, ctx.dependencies ?? [])
    return { out: { kind: 'bundle', files }, model: `tool:${skill}`, tier: cfg.tier, tokens: 0, calls: 0, providerMsgIdHash: null }
  }
  const chat = rt.chat ?? chatComplete
  const t7 = t7ctx(input, ctx)
  const isT7 = (T7_SKILLS as readonly string[]).includes(skill)
  const head = isT7
    ? promptFor(skill as (typeof T7_SKILLS)[number], t7)
    : [`Pit task: ${skill}`, `Objective: ${input.title}`, `Summary: ${input.summary}`, ...(ctx.root ? [`Project root: ${ctx.root}/`] : []), '', outputContractFor(skill, ctx.paths ?? [])].join('\n')
  const packed = packInputs(ctx.dependencies ?? [], cfg.maxInputChars)
  if (packed.truncated) {
    const total = (ctx.dependencies ?? []).reduce((n, d) => n + Object.values(d.files).reduce((m, f) => m + f.length, 0), 0)
    throw new InputTooLargeError(`${skill}: input too large for this seat (${total} chars of upstream files, maxInputChars ${cfg.maxInputChars}); refusing to work on a truncated view (split the job or raise --max-input-chars)`)
  }
  const user = [head, '', '## Input files', packed.text, ...(packed.truncated ? ['(Some input was truncated to fit the prompt budget.)'] : []), ...(EXTRA[skill] ? ['', '## Notes for this skill', EXTRA[skill]] : [])].join('\n')
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM(skill) },
    { role: 'user', content: user },
  ]
  const { brief, replyBrief } = answerBriefs(skill, input, ctx)
  let maxTokens = Math.min(cfg.maxTokensCap, SKILL_MAX_TOKENS[skill] ?? cfg.maxTokens)
  let tokens = 0
  let calls = 0
  let lastHash: string | null = null
  let problems: string[] = []
  const rounds = 1 + Math.max(0, rt.repairs ?? 2)
  for (let round = 0; round < rounds; round++) {
    const r = await chat(cfg, messages, { model, maxTokens })
    calls++
    tokens += r.usage.totalTokens
    lastHash = r.providerMsgIdHash ?? lastHash
    const text = BUNDLE_MODEL_SKILLS.has(skill) ? (r.text ?? '') : asciiPunct(r.text ?? '')
    let out: SkillOutput | null = null
    if (r.finishReason === 'length' && !text.trim()) problems = ['the answer was cut off (token limit) before any content']
    else ({ out, problems } = checkSkillAnswer(skill, text, ctx, { brief, replyBrief }))
    rt.onCall?.(r, !!out)
    if (out) return { out, model: r.model || model, tier, tokens, calls, providerMsgIdHash: lastHash }
    rt.log?.(`${skill}: answer rejected by the local contract check (${problems.slice(0, 3).join('; ')})${round + 1 < rounds ? '; asking for a fix' : ''}`)
    if (r.finishReason === 'length') maxTokens = Math.min(cfg.maxTokensCap, Math.floor(maxTokens * 1.5))
    messages.push({ role: 'assistant', content: text.slice(0, 12_000) || '(empty)' })
    messages.push({ role: 'user', content: `Your answer does not meet the output contract:\n${problems.slice(0, 12).map((p) => `- ${p}`).join('\n')}\nReturn the corrected answer only, in the exact contract format.` })
  }
  throw new SkillQualityError(`${skill}: no valid answer after ${calls} model call(s): ${problems.slice(0, 3).join('; ')}`)
}

function maybeUnderRoot(files: Record<string, string>, root?: string | null) {
  const r = (root || '').replace(/\/+$/, '')
  if (!r) return files
  return Object.keys(files).every((p) => p.startsWith(`${r}/`)) ? files : underRoot(files, r)
}

export function outputContractFor(skill: string, paths: string[]): string {
  if (BUNDLE_MODEL_SKILLS.has(skill))
    return [`Output contract (${BUNDLE_FORMAT}): JSON {"format":"${BUNDLE_FORMAT}","files":{"<relative path>":"<text>"}}.`, `- Write only inside: ${paths.join(', ') || '**'}.`, '- No binaries, no .env files, no secrets, no node_modules / out / dist.', 'Return only the JSON object.'].join('\n')
  if (README_SKILLS.has(skill)) return `Output: a markdown document starting with "# <title>", English only, with these sections in order: ${README_SECTIONS.join(', ')}.`
  return 'Output: a markdown document starting with "# <title>", English only.'
}

/** Sections the server's structural README verifier requires (backend verifyReadmeStructure). */
const README_SECTIONS = ['## Summary', '## Approach', '## Next steps']
/** Markdown skills the server checks with verifyReadmeStructure (backend tasks.ts falls through to it for plain text nodes). */
const README_SKILLS = new Set(['write-readme', 'research-report'])

export function readmeProblems(md: string): string[] {
  const out: string[] = []
  if (!/^# \S/m.test(md)) out.push('start with a "# <title>" line')
  for (const h of README_SECTIONS) if (!new RegExp(`^${h}\\s*$`, 'm').test(md)) out.push(`missing the "${h}" section`)
  return out
}

export function t7ctx(input: SkillInput, ctx: SkillContext): T7Context {
  return {
    title: input.title,
    nodeKey: ctx.nodeKey,
    root: ctx.root,
    paths: ctx.paths,
    focus: ctx.focus,
    revision: ctx.revision,
    inputs: ctx.inputs,
    feedback: ctx.feedback,
    review: ctx.review,
    dependencies: ctx.dependencies ?? [],
  }
}

export const isModelError = (e: unknown): e is ModelError => e instanceof ModelError
export { REVIEW_FORMAT }
