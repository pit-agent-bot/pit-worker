/**
 * T7 holder-AI skills (no server model keys): prompt templates and output contracts for the holder's local runtime
 * (Claude Code / Codex / Gemini on this machine), plus deterministic `--stub` outputs for end-to-end rehearsals.
 *
 * Review-type skills (audit-specialist, audit-judge, code-review, adversarial-review, site-content-check, review-judge)
 * return a markdown report with ONE fenced `pit-review` JSON block (format pit.review.v1, parsed by the backend):
 *   { format, verdict: pass | revise | fail, summary,
 *     findings: [{ id, severity: critical|high|medium|low|info, blocking, title, path?, line?, description,
 *                  reproduction?, poc?: { code, test? } }],
 *     coverage: [{ target, verdict: holds|breaks|n/a, why }], rulings?: [{ ref, decision, note? }] }
 * A PoC is a Foundry test file placed by the runner at test/pit-poc/<node>_<id>.t.sol inside the project root (import
 * sources with ../../src/...; no forge-std unless the project vendors it). It must PASS when the bug is real. The runner
 * re-runs PoCs of blocking findings; a PoC that does not reproduce downgrades its finding.
 * Bundle skills (write-foundry-tests, fix-findings, import-site) return a pit.files.v1 bundle within the node's paths.
 * T9: write-proposal returns pit.proposal.v1 JSON (see founder-skills.ts).
 * T10: draft-reply returns pit.reply.v1 JSON; outbound-content-check is a review skill (see outbound-skills.ts).
 */
import { PROPOSAL_CONTRACT, PROPOSAL_ROLE, stubWriteProposal } from './founder-skills.ts'
import { CHECK_CONTRACT_NOTE, CHECK_ROLE, REPLY_CONTRACT, REPLY_ROLE, stubDraftReply, stubOutboundCheck } from './outbound-skills.ts'
export const REVIEW_FORMAT = 'pit.review.v1'
export const REVIEW_SKILLS = ['audit-specialist', 'audit-judge', 'code-review', 'adversarial-review', 'site-content-check', 'review-judge', 'outbound-content-check'] as const
export const BUNDLE_SKILLS_T7 = ['write-foundry-tests', 'fix-findings', 'import-site'] as const
/** T9: text skills outside the review contract. */
export const TEXT_SKILLS_T9 = ['write-proposal', 'draft-reply'] as const
export const T7_SKILLS = [...BUNDLE_SKILLS_T7, ...REVIEW_SKILLS, ...TEXT_SKILLS_T9] as const

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info'
export type Verdict = 'pass' | 'revise' | 'fail'
export interface Finding {
  id: string
  severity: Severity
  blocking: boolean
  title: string
  path?: string
  line?: number
  description: string
  reproduction?: string
  poc?: { code: string; test?: string }
}
export interface Coverage {
  target: string
  verdict: 'holds' | 'breaks' | 'n/a'
  why: string
}
export interface ReviewDoc {
  verdict: Verdict
  summary: string
  findings: Finding[]
  coverage?: Coverage[]
  rulings?: { ref: string; decision: 'confirmed' | 'rejected' | 'duplicate'; note?: string }[]
}

/** Context a T7 skill sees (from lease_ok.task). */
export interface T7Context {
  title: string
  nodeKey?: string | null
  root?: string | null
  paths?: string[]
  focus?: string | null
  revision?: number
  inputs?: Record<string, unknown>
  feedback?: { from: string; verdict: string; summary: string; findings: Partial<Finding>[] }[]
  review?: { gate: string; requirePoc: boolean; reviseTargets: string[] }
  dependencies: { key: string; files: Record<string, string>; format?: string }[]
}

// ------------------------------------------------------------------ output contracts + prompt templates

const REVIEW_CONTRACT = [
  'Output contract (pit.review.v1):',
  '- A markdown report starting with "# <title>", English only.',
  '- Exactly one fenced block tagged pit-review containing JSON:',
  '  {"format":"pit.review.v1","verdict":"pass|revise|fail","summary":"...",',
  '   "findings":[{"id":"F1","severity":"critical|high|medium|low|info","blocking":true,"title":"...","path":"src/X.sol","line":42,',
  '     "description":"...","reproduction":"...","poc":{"code":"<Foundry test>","test":"test_name"}}],',
  '   "coverage":[{"target":"...","verdict":"holds|breaks|n/a","why":"..."}],"rulings":[{"ref":"node/F1","decision":"confirmed|rejected|duplicate"}]}',
  '- verdict pass is invalid while any finding is blocking. Use revise for fixable blocking problems, fail to reject.',
  '- Every blocking finding on Solidity code should carry a PoC: a Foundry test placed at test/pit-poc/<node>_<id>.t.sol in the',
  '  project root (import sources with ../../src/...; no forge-std unless vendored). The test must PASS when the bug is real.',
  '  The runner re-runs it offline; a PoC that does not reproduce downgrades the finding to low / non-blocking.',
].join('\n')

const BUNDLE_CONTRACT = (paths: string[]) =>
  [
    'Output contract (pit.files.v1): JSON {"format":"pit.files.v1","files":{"<relative path>":"<text>"}}.',
    `- Write only inside: ${paths.join(', ') || '**'} (unchanged upstream files may be included as they are).`,
    '- No binaries, no .env files, no secrets, no node_modules / out / dist.',
  ].join('\n')

export const OUTPUT_CONTRACTS: Record<(typeof T7_SKILLS)[number], (paths: string[]) => string> = {
  'write-foundry-tests': (p) => `${BUNDLE_CONTRACT(p)}\n- Foundry tests under test/; they must compile and pass with forge test (offline).`,
  'fix-findings': (p) => `${BUNDLE_CONTRACT(p)}\n- Change only what the named findings need; add FIXES.md mapping each finding id to the fix or a rebuttal.`,
  'import-site': (p) => `${BUNDLE_CONTRACT(p)}\n- Copy the committed static site into site/ byte for byte (no builds, no edits); site/index.html must exist.`,
  'audit-specialist': () => REVIEW_CONTRACT,
  'audit-judge': () => `${REVIEW_CONTRACT}\n- Give one ruling per specialist finding (ref "<node>/<id>"); merge duplicates; keep only confirmed findings.`,
  'code-review': () => REVIEW_CONTRACT,
  'adversarial-review': () => REVIEW_CONTRACT,
  'site-content-check': () => `${REVIEW_CONTRACT}\n- verdict fail = the site must not be hosted under Pit.`,
  'review-judge': () => `${REVIEW_CONTRACT}\n- Rule on the reviewers' findings (ref "<node>/<id>"); pass only when no blocking issue stands.`,
  'write-proposal': () => PROPOSAL_CONTRACT,
  'draft-reply': () => REPLY_CONTRACT,
  'outbound-content-check': () => `${REVIEW_CONTRACT}\n${CHECK_CONTRACT_NOTE}`,
}

const ROLE_TEXT: Record<(typeof T7_SKILLS)[number], string> = {
  'write-foundry-tests': 'You write Foundry tests for an implementation written by another holder. Test the spec, not the implementation details; cover failure paths.',
  'fix-findings': 'You fix the named findings on an accepted project. Fix only what is named; rebut findings that do not hold, with evidence.',
  'import-site': 'You import a committed static site. Copy files byte for byte into site/; do not build or edit anything.',
  'audit-specialist': 'You are a smart-contract auditor with ONE focus area. Report only issues in your focus; give each a location, severity and, if blocking, an executable PoC test.',
  'audit-judge': 'You are the audit judge (L3). Merge, dedup and rule on every specialist finding; reproduce blocking ones with PoC tests; decide pass / revise / fail.',
  'code-review': 'You are an independent peer reviewer (L2) of an implementation and its tests. Pass, or revise with concrete blocking findings.',
  'adversarial-review': 'You are an adversarial reviewer. Try to break the work: wrong claims, missing checks, exploitable paths. Blocking findings on code need a PoC test.',
  'site-content-check': 'You decide whether a site may be hosted under Pit: wallet-connect / signing pages, unpinned third-party scripts, impersonation, illegal content.',
  'review-judge': 'You are the judge (L3) over peer reviews of a text artifact. Rule on each finding and decide pass / revise / fail.',
  'write-proposal': PROPOSAL_ROLE,
  'draft-reply': REPLY_ROLE,
  'outbound-content-check': CHECK_ROLE,
}

/** Prompt for the holder's local runtime. Dependencies are listed by path; the runtime reads them from the workdir. */
export function promptFor(skill: (typeof T7_SKILLS)[number], ctx: T7Context): string {
  const files = ctx.dependencies.flatMap((d) => Object.keys(d.files).map((p) => `${d.key}: ${p}`))
  const lines = [
    `Pit task: ${skill}${ctx.nodeKey ? ` (node ${ctx.nodeKey}${ctx.revision ? `, revision ${ctx.revision}` : ''})` : ''}`,
    `Objective: ${ctx.title}`,
    ...(ctx.focus ? [`Focus: ${ctx.focus}`] : []),
    ...(ctx.root ? [`Project root: ${ctx.root}/`] : []),
    '',
    ROLE_TEXT[skill],
    '',
    'Inputs (accepted upstream outputs, read-only):',
    ...(files.length ? files.slice(0, 200).map((f) => `- ${f}`) : ['- none']),
  ]
  if (ctx.feedback?.length) {
    lines.push('', 'Reviewer findings to address in this revision:')
    for (const fb of ctx.feedback) for (const f of fb.findings) lines.push(`- [${fb.from}/${f.id}] ${f.severity ?? ''} ${f.title ?? ''}: ${f.description ?? ''}`.trim())
  }
  lines.push('', OUTPUT_CONTRACTS[skill](ctx.paths ?? []), '', 'Answer in English only.')
  return lines.join('\n')
}

// ------------------------------------------------------------------ review document helpers

export function renderReview(title: string, doc: ReviewDoc): string {
  const full = { format: REVIEW_FORMAT, coverage: [], rulings: [], ...doc }
  const lines = [`# ${title}`, '', `Verdict: ${doc.verdict}`, '', doc.summary, '']
  for (const f of doc.findings) lines.push(`- [${f.severity}${f.blocking ? ', blocking' : ''}] ${f.id} ${f.title}${f.path ? ` (${f.path}${f.line ? `:${f.line}` : ''})` : ''}`)
  lines.push('', '```pit-review', JSON.stringify(full, null, 2), '```', '')
  return lines.join('\n')
}

export function extractReview(text: string): ReviewDoc | null {
  const m = /```pit-review[ \t]*\r?\n([\s\S]*?)\r?\n```/.exec(text)
  if (!m) return null
  try {
    const o = JSON.parse(m[1]!) as ReviewDoc & { format?: string }
    return o.format === REVIEW_FORMAT && Array.isArray(o.findings) ? o : null
  } catch {
    return null
  }
}

/** Local pre-submit check (the backend validates again). Returns problems; empty = ok. */
export function checkReview(text: string): string[] {
  const out: string[] = []
  if (!/^#\s+\S/m.test(text)) out.push('missing "# title"')
  const doc = extractReview(text)
  if (!doc) return [...out, 'missing or invalid pit-review block']
  if (!['pass', 'revise', 'fail'].includes(doc.verdict)) out.push('bad verdict')
  if (doc.verdict === 'pass' && doc.findings.some((f) => f.blocking)) out.push('pass with blocking findings')
  return out
}

// ------------------------------------------------------------------ deterministic stubs

const solFiles = (ctx: T7Context) => {
  const out: Record<string, string> = {}
  for (const d of ctx.dependencies) for (const [p, c] of Object.entries(d.files)) if (p.endsWith('.sol') && !p.includes('/test/') && !p.startsWith('test/') && !p.endsWith('.t.sol')) out[p] = c
  return out
}
const lineOf = (src: string, re: RegExp) => {
  const i = src.split('\n').findIndex((l) => re.test(l))
  return i >= 0 ? i + 1 : undefined
}

/** Foundry root of the upstream tree ('' when foundry.toml is at the top). */
function foundryRootOf(ctx: T7Context): string | null {
  const all = ctx.dependencies.flatMap((d) => Object.keys(d.files))
  if (all.includes('foundry.toml')) return ''
  const r = all.filter((p) => p.endsWith('/foundry.toml')).sort((a, b) => a.length - b.length)[0]
  return r ? r.slice(0, -'/foundry.toml'.length) : null
}

/** The stub Counter (or any contract with a public increment()) from build-foundry. */
function counterOf(ctx: T7Context): { path: string; src: string; name: string } | null {
  for (const [p, c] of Object.entries(solFiles(ctx))) {
    const m = /contract\s+(\w+)\s*\{/.exec(c)
    if (m && /function\s+increment\s*\(\s*\)\s*(public|external)/.test(c)) return { path: p, src: c, name: m[1]! }
  }
  return null
}

export function stubWriteFoundryTests(ctx: T7Context): Record<string, string> {
  const c = counterOf(ctx)
  const root = (ctx.root ?? '').replace(/\/+$/, '')
  const at = (p: string) => (root ? `${root}/${p}` : p)
  const body = c
    ? [
        `import {${c.name}} from "../src/${c.path.split('/').pop()}";`,
        '',
        `contract PitTests${c.name} {`,
        '    function test_incrementTwice() public {',
        `        ${c.name} x = new ${c.name}();`,
        '        x.increment();',
        '        x.increment();',
        '        require(x.number() == 2, "two increments");',
        '    }',
        '',
        '    function test_startsAtZero() public {',
        `        require(new ${c.name}().number() == 0, "starts at zero");`,
        '    }',
        '}',
      ]
    : ['contract PitSmokeTest {', '    function test_smoke() public pure {', '        require(1 + 1 == 2, "smoke");', '    }', '}']
  return { [at('test/PitTests.t.sol')]: ['// SPDX-License-Identifier: MIT', 'pragma solidity ^0.8.20;', '', ...body, ''].join('\n') }
}

const FOCUS_TARGET: Record<string, string> = {
  access: 'access control',
  econ: 'economics / MEV',
  flow: 'reentrancy / external calls',
  math: 'math / precision / storage',
}

export function stubAuditSpecialist(ctx: T7Context): string {
  const focus = String(ctx.focus || 'access')
  const findings: Finding[] = []
  const srcs = solFiles(ctx)
  let n = 0
  const add = (f: Omit<Finding, 'id'>) => findings.length < 6 && findings.push({ id: `F${++n}`, ...f })
  for (const [p, c] of Object.entries(srcs).sort(([a], [b]) => a.localeCompare(b))) {
    if (focus === 'access') {
      const m = /function\s+(\w+)\s*\([^)]*\)\s*(external|public)(?![^{]*\b(view|pure)\b)(?![^{]*\b(onlyOwner|onlyRole|auth|lock)\b)[^{]*\{/.exec(c)
      if (m && !/require\s*\(\s*msg\.sender/.test(c)) add({ severity: 'low', blocking: false, title: `Unrestricted state-changing function ${m[1]}`, path: p, line: lineOf(c, new RegExp(`function\\s+${m[1]}\\b`)), description: `${m[1]} can be called by any address; confirm this is intended.` })
    } else if (focus === 'econ') {
      if (/\/\s*\w/.test(c) && /\*/.test(c)) add({ severity: 'info', blocking: false, title: 'Rounding direction should favour the protocol', path: p, line: lineOf(c, /\//), description: 'Integer division is used; check that rounding never favours the caller.' })
    } else if (focus === 'flow') {
      if (/\.call\s*[({]|\.transfer\s*\(|\.send\s*\(/.test(c)) add({ severity: /\block\b|nonReentrant/.test(c) ? 'info' : 'medium', blocking: false, title: 'External call: verify checks-effects-interactions', path: p, line: lineOf(c, /\.call\s*[({]|\.transfer\s*\(|\.send\s*\(/), description: 'State should be updated before external calls; a reentrancy guard is ' + (/\block\b|nonReentrant/.test(c) ? 'present.' : 'not present.') })
    } else if (focus === 'math') {
      const v = /pragma solidity\s*[=^>]*\s*0\.(\d+)/.exec(c)
      if (v && Number(v[1]) < 8) add({ severity: 'low', blocking: false, title: 'Pre-0.8 compiler: no built-in overflow checks', path: p, line: lineOf(c, /pragma solidity/), description: 'Arithmetic must go through SafeMath or explicit checks.' })
      if (/unchecked\s*\{/.test(c)) add({ severity: 'low', blocking: false, title: 'Unchecked arithmetic block', path: p, line: lineOf(c, /unchecked\s*\{/), description: 'Confirm the unchecked block cannot overflow.' })
    }
  }
  const target = FOCUS_TARGET[focus] ?? focus
  const doc: ReviewDoc = {
    verdict: findings.some((f) => f.blocking) ? 'revise' : 'pass',
    summary: `Stub ${target} audit of ${Object.keys(srcs).length} Solidity file(s): ${findings.length} finding(s).`,
    findings,
    coverage: [{ target, verdict: findings.some((f) => f.severity === 'high' || f.severity === 'critical') ? 'breaks' : Object.keys(srcs).length ? 'holds' : 'n/a', why: Object.keys(srcs).length ? 'pattern scan by the stub runtime' : 'no Solidity sources in scope' }],
  }
  return renderReview(`Audit: ${target}`, doc)
}

/** Judge: merge specialist / reviewer findings, dedup by (path, title), confirm all; pass when nothing blocks. */
export function stubJudge(ctx: T7Context, title: string): string {
  const reports = ctx.dependencies
    .filter((d) => d.format === 'text')
    .map((d) => ({ key: d.key, doc: extractReview(Object.values(d.files)[0] ?? '') }))
    .filter((r): r is { key: string; doc: ReviewDoc } => !!r.doc)
  const seen = new Map<string, Finding>()
  const rulings: NonNullable<ReviewDoc['rulings']> = []
  let n = 0
  for (const r of reports) {
    for (const f of r.doc.findings) {
      const k = `${f.path ?? ''}|${f.title.toLowerCase()}`
      if (seen.has(k)) {
        rulings.push({ ref: `${r.key}/${f.id}`, decision: 'duplicate', note: `same as ${seen.get(k)!.id}` })
        continue
      }
      const merged: Finding = { ...f, id: `J${++n}`, description: `${f.description} (from ${r.key}/${f.id})` }
      seen.set(k, merged)
      rulings.push({ ref: `${r.key}/${f.id}`, decision: 'confirmed' })
    }
  }
  const findings = [...seen.values()].slice(0, 40)
  const forced = typeof ctx.inputs?.judgeVerdict === 'string' && ['pass', 'revise', 'fail'].includes(ctx.inputs.judgeVerdict) ? (ctx.inputs.judgeVerdict as Verdict) : null
  const verdict: Verdict = forced ?? (findings.some((f) => f.blocking) ? 'revise' : 'pass')
  return renderReview(title, {
    verdict,
    summary: `Stub judge over ${reports.length} report(s): ${findings.length} unique finding(s), ${rulings.filter((r) => r.decision === 'duplicate').length} duplicate(s).`,
    findings: verdict === 'pass' ? findings.map((f) => ({ ...f, blocking: false })) : findings,
    coverage: reports.flatMap((r) => r.doc.coverage ?? []).slice(0, 20),
    rulings,
  })
}

/** Code review: revise while revision < inputs.reviseRounds (rehearsal hook), then pass. */
export function stubCodeReview(ctx: T7Context): string {
  const rounds = Math.max(0, Math.floor(Number(ctx.inputs?.reviseRounds ?? 0)))
  const rev = ctx.revision ?? 0
  const c = counterOf(ctx)
  if (rev < rounds) {
    return renderReview('Code review', {
      verdict: 'revise',
      summary: `Round ${rev + 1}: tests do not cover a failure path yet.`,
      findings: [{ id: 'R1', severity: 'medium', blocking: true, title: 'Missing failure-path test', path: c?.path ?? 'test', description: 'Add a test that exercises a failing or edge path, not only the happy path.' }],
      coverage: [{ target: 'tests cover the spec', verdict: 'breaks', why: 'happy path only' }],
    })
  }
  return renderReview('Code review', {
    verdict: 'pass',
    summary: `Implementation and tests reviewed at revision ${rev}; no blocking issue.`,
    findings: [{ id: 'N1', severity: 'low', blocking: false, title: 'Consider emitting an event', ...(c ? { path: c.path } : {}), description: 'State changes are not observable off-chain.' }],
    coverage: [{ target: 'tests cover the spec', verdict: 'holds', why: 'implementation and tests agree' }],
  })
}

/** Adversarial review: on a Counter project, one reproducing PoC (no access control) and one that does not reproduce. */
export function stubAdversarialReview(ctx: T7Context): string {
  const c = counterOf(ctx)
  const root = foundryRootOf(ctx)
  if (c && root !== null) {
    const rel = root ? c.path.slice(root.length + 1) : c.path
    const imp = `import {${c.name}} from "../../${rel}";`
    const head = ['// SPDX-License-Identifier: MIT', 'pragma solidity ^0.8.20;', '', imp, '']
    const poc1 = [...head, 'contract Stranger {', `    function poke(${c.name} x) external { x.increment(); }`, '}', '', 'contract PocAccess {', '    function test_anyoneCanIncrement() public {', `        ${c.name} x = new ${c.name}();`, '        new Stranger().poke(x);', '        require(x.number() == 1, "a stranger could not increment");', '    }', '}', ''].join('\n')
    const poc2 = [...head, 'contract PocOverflow {', '    function test_incrementWrapsSilently() public {', `        ${c.name} x = new ${c.name}();`, '        x.increment();', '        require(x.number() == 0, "counter did not wrap");', '    }', '}', ''].join('\n')
    return renderReview('Adversarial review', {
      verdict: 'revise',
      summary: 'Two blocking claims with PoC tests; the runner re-runs both.',
      findings: [
        { id: 'F1', severity: 'high', blocking: true, title: 'Anyone can call increment', path: c.path, line: lineOf(c.src, /function\s+increment/), description: 'increment has no access control: any address can change the counter.', reproduction: 'A separate contract calls increment and the value changes.', poc: { code: poc1, test: 'test_anyoneCanIncrement' } },
        { id: 'F2', severity: 'high', blocking: true, title: 'increment wraps silently', path: c.path, line: lineOf(c.src, /number\s*\+=/), description: 'Claim: the counter wraps to zero without reverting.', reproduction: 'Increment and expect zero.', poc: { code: poc2, test: 'test_incrementWrapsSilently' } },
        { id: 'F3', severity: 'info', blocking: false, title: 'No events', path: c.path, description: 'State changes emit no events.' },
      ],
      coverage: [
        { target: 'access control', verdict: 'breaks', why: 'increment is public without checks' },
        { target: 'arithmetic', verdict: 'holds', why: 'Solidity 0.8 checked arithmetic' },
      ],
    })
  }
  const files = ctx.dependencies.flatMap((d) => Object.keys(d.files))
  return renderReview('Adversarial review', {
    verdict: 'pass',
    summary: `Reviewed ${files.length} input file(s)${ctx.focus ? ` (focus: ${ctx.focus})` : ''}; no blocking issue found by the stub runtime.`,
    findings: [{ id: 'I1', severity: 'info', blocking: false, title: 'Stub review', description: 'Deterministic stub output; a real holder runtime reviews the content itself.' }],
    coverage: [{ target: String(ctx.focus || 'content'), verdict: 'holds', why: 'no issue detected by the stub' }],
  })
}

/** Fix: copy the input tree unchanged and add FIXES.md listing the findings it addresses. */
export function stubFixFindings(ctx: T7Context): Record<string, string> {
  const files: Record<string, string> = {}
  for (const d of ctx.dependencies) if (d.format !== 'text') Object.assign(files, d.files)
  const named = String(ctx.inputs?.findings ?? '').trim()
  const fb = (ctx.feedback ?? []).flatMap((f) => f.findings.map((x) => `- ${f.from}/${x.id}: ${x.title}`))
  files['FIXES.md'] = ['# Fixes', '', 'Findings addressed (stub runtime: tree copied unchanged; a real runtime edits the code):', '', ...(named ? named.split(/\n+/).map((l) => `- ${l.replace(/^-\s*/, '')}`) : []), ...fb, ...(named || fb.length ? [] : ['- none named']), ''].join('\n')
  return files
}

/** Import: copy the site directory (the shallowest folder with index.html) into site/ byte for byte. */
export function stubImportSite(ctx: T7Context): Record<string, string> {
  const src: Record<string, string> = {}
  for (const d of ctx.dependencies) Object.assign(src, d.files)
  const idx = Object.keys(src).filter((p) => p === 'index.html' || p.endsWith('/index.html')).sort((a, b) => a.split('/').length - b.split('/').length)[0]
  const base = idx && idx !== 'index.html' ? idx.slice(0, -'index.html'.length) : ''
  const root = (ctx.root || 'site').replace(/\/+$/, '')
  const out: Record<string, string> = {}
  for (const [p, c] of Object.entries(src)) if (p.startsWith(base)) out[`${root}/${p.slice(base.length)}`] = c
  return out
}

/** Content check: wallet / signing calls, unpinned third-party scripts, impersonation phrases. */
export function stubSiteContentCheck(ctx: T7Context): string {
  const findings: Finding[] = []
  let n = 0
  for (const d of ctx.dependencies) {
    for (const [p, c] of Object.entries(d.files)) {
      if (!/\.(html?|js|mjs|ts|jsx|tsx)$/.test(p)) continue
      if (/eth_requestAccounts|window\.ethereum|setApprovalForAll|eth_sign|personal_sign/.test(c)) findings.push({ id: `C${++n}`, severity: 'high', blocking: true, title: 'Wallet connection / signing request', path: p, line: lineOf(c, /eth_requestAccounts|window\.ethereum|setApprovalForAll|eth_sign|personal_sign/), description: 'The page asks for wallet access or signatures; not allowed on Pit-hosted sites.' })
      const ext = /<script[^>]*src=["']https?:\/\/[^"']+["'][^>]*>/i.exec(c)
      if (ext && !/integrity=/.test(ext[0])) findings.push({ id: `C${++n}`, severity: 'medium', blocking: false, title: 'Unpinned third-party script', path: p, line: lineOf(c, /<script[^>]*src=["']https?:/i), description: 'External script without a subresource integrity hash.' })
      if (/official (airdrop|claim)|claim your (tokens|airdrop)|connect wallet to claim/i.test(c)) findings.push({ id: `C${++n}`, severity: 'high', blocking: true, title: 'Impersonation / claim bait', path: p, description: 'Text impersonates an official claim or airdrop.' })
    }
  }
  const fail = findings.some((f) => f.blocking)
  return renderReview('Site content check', {
    verdict: fail ? 'fail' : 'pass',
    summary: fail ? 'The site must not be hosted under Pit.' : `The site may be hosted under Pit (${findings.length} non-blocking note(s)).`,
    findings: findings.slice(0, 20),
    coverage: [
      { target: 'wallet / signing pages', verdict: findings.some((f) => f.title.startsWith('Wallet')) ? 'breaks' : 'holds', why: 'pattern scan' },
      { target: 'third-party scripts pinned', verdict: findings.some((f) => f.title.startsWith('Unpinned')) ? 'breaks' : 'holds', why: 'pattern scan' },
      { target: 'impersonation', verdict: findings.some((f) => f.title.startsWith('Impersonation')) ? 'breaks' : 'holds', why: 'pattern scan' },
    ],
  })
}

export type T7Output = { kind: 'markdown'; markdown: string } | { kind: 'bundle'; files: Record<string, string> }

export function runT7Stub(skill: string, ctx: T7Context): T7Output | null {
  switch (skill) {
    case 'write-foundry-tests':
      return { kind: 'bundle', files: stubWriteFoundryTests(ctx) }
    case 'fix-findings':
      return { kind: 'bundle', files: stubFixFindings(ctx) }
    case 'import-site':
      return { kind: 'bundle', files: stubImportSite(ctx) }
    case 'audit-specialist':
      return { kind: 'markdown', markdown: stubAuditSpecialist(ctx) }
    case 'audit-judge':
      return { kind: 'markdown', markdown: stubJudge(ctx, 'Audit judgement') }
    case 'review-judge':
      return { kind: 'markdown', markdown: stubJudge(ctx, 'Review judgement') }
    case 'code-review':
      return { kind: 'markdown', markdown: stubCodeReview(ctx) }
    case 'adversarial-review':
      return { kind: 'markdown', markdown: stubAdversarialReview(ctx) }
    case 'site-content-check':
      return { kind: 'markdown', markdown: stubSiteContentCheck(ctx) }
    case 'write-proposal':
      return { kind: 'markdown', markdown: stubWriteProposal(ctx) }
    case 'draft-reply':
      return { kind: 'markdown', markdown: stubDraftReply(ctx) }
    case 'outbound-content-check':
      return { kind: 'markdown', markdown: stubOutboundCheck(ctx) }
    default:
      return null
  }
}
