/**
 * T9 founder skill: write-proposal. The holder writes today's 3 whitepapers from the founder brief (scout opportunity
 * cards with evidence links + seat pitches). The stub is deterministic and needs no model keys; a real holder runtime
 * gets the prompt from `pit skills --prompt write-proposal` and must return the same pit.proposal.v1 JSON.
 */
/** The part of the task context this skill reads (kept local so the backend tests can import this file directly). */
interface T7Context {
  title: string
  dependencies: { key: string; files: Record<string, string>; format?: string }[]
  feedback?: unknown
}

export const PROPOSAL_FORMAT = 'pit.proposal.v1'
export const DELIVERY_TYPES = ['token', 'repo', 'site', 'reply'] as const
type Delivery = (typeof DELIVERY_TYPES)[number]

interface Lead {
  id: string
  title: string
  problem: string
  audience: string
  evidence: { url: string; source: string; title: string }[]
  suggestedDelivery: string[]
  estCostEth: number
  score: number
}
interface Pitch {
  id: number
  seatId: number
  title: string
  problem: string
  product: string
}
interface Brief {
  format: string
  proposalId: string
  papers: number
  maxBudgetEth: number
  nonTokenBudgetEth: number
  leads: Lead[]
  pitches: Pitch[]
  recentTitles: string[]
  feedback: string[]
}

export const PROPOSAL_CONTRACT = [
  'Output contract (pit.proposal.v1): return only JSON (or one ```json block):',
  '  {"format":"pit.proposal.v1","papers":[{"title":"...","pitch":"...","problem":"...","product":"...",',
  '    "deliveryType":["repo","reply"],"sourceSignals":["<evidence url copied from a lead>"],"budgetEth":0.05,"pitchId":12?}]}',
  '- Exactly 3 papers, English only, each on a different lead (different evidence).',
  '- deliveryType: non-empty subset of token, repo, site, reply. sourceSignals: 1-5 evidence URLs copied exactly from the brief',
  '  (a paper on a seat pitch cites its pitchId). No links, coin tickers or contract addresses in title / pitch / problem / product.',
  '- No price, yield or return promises; no impersonation; a reply never promotes a coin. Papers without token: budgetEth <= nonTokenBudgetEth.',
].join('\n')

export const PROPOSAL_ROLE =
  'You are the AI founder for today. Read BRIEF.md and brief.json from the src input, pick the 3 strongest leads (real demand, buildable in days, safe), and write one whitepaper per lead. Fix every finding listed under feedback.'

function briefOf(ctx: T7Context): Brief | null {
  for (const d of ctx.dependencies) {
    for (const [p, body] of Object.entries(d.files)) {
      if (!p.endsWith('brief.json')) continue
      try {
        const b = JSON.parse(body) as Brief
        if (b?.format === 'pit.brief.v1') return b
      } catch {
        // not a brief
      }
    }
  }
  return null
}

/** Strip what the server rejects inside paper text: links, $TICKER-like tokens, addresses, control chars. */
export function cleanText(s: string, max: number): string {
  const t = String(s ?? '')
    .replace(/(https?:\/\/|www\.)\S+/gi, '')
    .replace(/\b0x[a-fA-F0-9]{6,}\b/g, '')
    .replace(/\$/g, '')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > max ? `${t.slice(0, max - 3).trimEnd()}...` : t
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000

/** Deterministic draft: top 3 leads by score with distinct evidence, then seat pitches if leads run out. */
export function stubWriteProposal(ctx: T7Context): string {
  const b = briefOf(ctx)
  if (!b) throw new Error('write-proposal: brief.json not found in the inputs')
  const recent = new Set((b.recentTitles ?? []).map((t) => t.trim().toLowerCase()))
  const used = new Set<string>()
  const papers: Record<string, unknown>[] = []
  const titleFor = (base: string) => {
    let t = cleanText(base, 110) || 'Untitled helper'
    for (let i = 2; recent.has(t.toLowerCase()) || papers.some((p) => String(p.title).toLowerCase() === t.toLowerCase()); i++) t = `${cleanText(base, 100)} (v${i})`
    return t
  }
  for (const l of [...b.leads].sort((x, y) => y.score - x.score)) {
    if (papers.length >= 3) break
    const urls = [...new Set(l.evidence.map((e) => e.url))].slice(0, 5)
    const key = [...urls].sort().join(' ')
    if (!urls.length || used.has(key)) continue
    used.add(key)
    const delivery = DELIVERY_TYPES.filter((d) => l.suggestedDelivery.includes(d))
    const dt: Delivery[] = delivery.length ? delivery : ['repo']
    const token = dt.includes('token')
    const src = l.evidence[0]?.source === 'github' ? 'a GitHub issue' : 'a Hacker News thread'
    const budget = Math.min(Math.max(l.estCostEth || 0.05, 0.01), token ? b.maxBudgetEth : b.nonTokenBudgetEth)
    papers.push({
      title: titleFor(`Build: ${l.title}`),
      pitch: cleanText(`A small open tool that answers a request from ${src}, built and reviewed by the Pit swarm.`, 300),
      problem: cleanText(l.problem || l.title, 700) || 'The request in the cited thread has no simple open answer yet.',
      product: cleanText(
        `First version for ${l.audience || 'the people in the thread'}: ${dt.includes('site') ? 'a static site' : 'an open-source repo with a README and tests'} that covers the core request.${dt.includes('reply') ? ' Then reply to the original thread with what was built.' : ''}`,
        700,
      ),
      deliveryType: dt,
      sourceSignals: urls,
      budgetEth: round4(budget),
    })
  }
  for (const p of b.pitches ?? []) {
    if (papers.length >= 3) break
    papers.push({
      title: titleFor(p.title),
      pitch: cleanText(`Seat #${p.seatId} pitch: ${p.title}`, 300),
      problem: cleanText(p.problem, 700) || 'See the seat pitch.',
      product: cleanText(p.product, 700) || 'First version as described in the seat pitch.',
      deliveryType: ['repo'],
      sourceSignals: [],
      pitchId: p.id,
      budgetEth: round4(Math.min(0.05, b.nonTokenBudgetEth)),
    })
  }
  if (papers.length < 3) throw new Error(`write-proposal: the brief has only ${papers.length} usable lead(s)`)
  return `${JSON.stringify({ format: PROPOSAL_FORMAT, papers }, null, 2)}\n`
}

/** Local pre-submit check (the backend validates again against the brief). */
export function checkProposal(text: string): string[] {
  let o: { format?: string; papers?: { deliveryType?: unknown; sourceSignals?: unknown; pitchId?: unknown }[] }
  try {
    o = JSON.parse(text)
  } catch {
    return ['not JSON']
  }
  const errs: string[] = []
  if (o.format !== PROPOSAL_FORMAT) errs.push(`format must be ${PROPOSAL_FORMAT}`)
  if (!Array.isArray(o.papers) || o.papers.length !== 3) return [...errs, 'need exactly 3 papers']
  o.papers.forEach((p, i) => {
    if (!Array.isArray(p.deliveryType) || !p.deliveryType.length || p.deliveryType.some((d) => !(DELIVERY_TYPES as readonly string[]).includes(String(d)))) errs.push(`paper ${i + 1}: bad deliveryType`)
    if (!(Array.isArray(p.sourceSignals) && p.sourceSignals.length) && p.pitchId === undefined) errs.push(`paper ${i + 1}: no evidence`)
  })
  return errs
}
