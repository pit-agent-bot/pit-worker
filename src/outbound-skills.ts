/**
 * T10 outbound skills (no server model keys): draft-reply writes a short reply to the original poster of a scout card
 * that links the Pit deliverable answering it; outbound-content-check reviews that reply (content red lines, relevance,
 * no promotion, the community's own rules on bots / links / self-promotion). The stubs are deterministic; a real holder
 * runtime gets the prompts from `pit skills --prompt draft-reply` / `--prompt outbound-content-check`.
 * The server re-checks every reply (one allowed link, no coin / price talk, no mentions, disclosure) and only sends it
 * through the Pit GitHub App after its own switches, rate limits, dedup and a fresh community-rules check.
 * Standalone on purpose (no `.ts` imports) so the backend tests can import it directly.
 */
interface OutboundContext {
  title: string
  focus?: string | null
  dependencies: { key: string; files: Record<string, string>; format?: string }[]
  feedback?: { from: string; verdict: string; summary: string; findings: { id?: string; title?: string; description?: string }[] }[]
}

export const REPLY_FORMAT = 'pit.reply.v1'

export interface ReplyBrief {
  format: string
  outreachId: string
  platform: string
  community: string
  thread: { url: string; title: string; excerpt: string }
  deliverable: { url: string; title: string; kind: string }
  allowedLink: string
  rules: { allowed: boolean; reasons: string[]; botPolicy: string | null; welcoming: boolean | null; contributing: string | null; excerpt: string; note: string | null }
  disclosure: string
  constraints: string[]
}

export const REPLY_CONTRACT = [
  'Output contract (pit.reply.v1): return only JSON (or one ```json block): {"format":"pit.reply.v1","body":"<reply text>"}',
  '- 60-1200 characters, English, plain text or light markdown (no images, no HTML).',
  '- Exactly one link: brief.allowedLink, copied exactly. No other links, domains or @mentions.',
  '- No coin / token / ticker / contract address / price / investment talk; no follow / join / star / upvote / discord / telegram asks.',
  '- End with brief.disclosure (automated AI agent, no further posts in this thread).',
].join('\n')

export const REPLY_ROLE =
  'You reply, on behalf of Pit (an automated AI agent), to the person who asked for help in the thread in REPLY_BRIEF.md / reply.json. Pit built something that answers the request. Say briefly what it is and how it helps with their exact ask, link it once, and disclose that you are an automated agent. Be useful, modest and specific; no marketing. Fix every finding listed under feedback.'

export const CHECK_ROLE =
  'You check an outbound reply drafted by another holder before Pit may post it in a public community. Fail it if the community rules (CONTRIBUTING / bot policy excerpt in reply.json) forbid bots, links or self-promotion, or if the reply does not actually answer the post. Revise for fixable problems: promotion, coin / price talk, extra links, mentions, missing disclosure, wrong tone. Pass only a reply a maintainer would welcome.'

export const CHECK_CONTRACT_NOTE = '- verdict fail = Pit must not post in this thread at all; revise = the drafter fixes the findings (one round).'

export function replyBriefOf(ctx: OutboundContext): ReplyBrief | null {
  for (const d of ctx.dependencies) {
    for (const [p, body] of Object.entries(d.files)) {
      if (!p.endsWith('reply.json')) continue
      try {
        const b = JSON.parse(body) as ReplyBrief
        if (b?.format === 'pit.reply-brief.v1') return b
      } catch {
        // a draft, not the brief
      }
    }
  }
  return null
}

const clean = (s: string, max: number) => {
  const t = String(s ?? '')
    .replace(/(https?:\/\/|www\.)\S+/gi, '')
    .replace(/\b0x[a-fA-F0-9]{6,}\b/g, '')
    .replace(/[$@#<>`*_[\]]/g, '')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > max ? `${t.slice(0, max - 3).trimEnd()}...` : t
}

/** Deterministic reply: acknowledge the ask, name the deliverable, one link, disclosure. */
export function stubDraftReply(ctx: OutboundContext): string {
  const b = replyBriefOf(ctx)
  if (!b) throw new Error('draft-reply: reply.json (pit.reply-brief.v1) not found in the inputs')
  const ask = clean(b.thread.title, 120) || 'this request'
  const what = clean(b.deliverable.title, 100) || `a ${b.deliverable.kind}`
  const kind = b.deliverable.kind === 'site' ? 'a small static site' : 'a small open-source repo'
  const body = [
    `Hi, regarding "${ask}": we put together ${kind} that may help: ${what}.`,
    `It is here: ${b.allowedLink}`,
    'It is free to use and adapt; feel free to ignore it if it does not fit what you need.',
    '',
    b.disclosure,
  ].join('\n')
  return `${JSON.stringify({ format: REPLY_FORMAT, body }, null, 2)}\n`
}

export function parseReplyText(text: string): string | null {
  const m = /```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```/.exec(text)
  for (const cand of [text, m?.[1]]) {
    if (!cand) continue
    try {
      const o = JSON.parse(cand) as { format?: unknown; body?: unknown }
      if (o?.format === REPLY_FORMAT && typeof o.body === 'string') return o.body
    } catch {
      // try the next form
    }
  }
  return null
}

/** Local pre-submit check (the backend validates again with the full rule set). */
export function checkReply(text: string, allowedLink?: string): string[] {
  const body = parseReplyText(text)
  if (body === null) return [`output must be JSON {"format":"${REPLY_FORMAT}","body":"..."}`]
  const errs: string[] = []
  if (body.trim().length < 60 || body.trim().length > 1200) errs.push('body must be 60-1200 characters')
  const urls = body.match(/https?:\/\/\S+/g) ?? []
  if (urls.length !== 1) errs.push('exactly one link (the deliverable)')
  if (allowedLink && urls[0] && urls[0].replace(/[.,;:!?]+$/, '').replace(/\/+$/, '') !== allowedLink.replace(/\/+$/, '')) errs.push('the link must be the deliverable')
  if (!/\b(automated|bot|ai agent)\b/i.test(body)) errs.push('missing disclosure')
  return errs
}

const COIN = /\$[A-Za-z]{2,10}\b|\b0x[a-fA-F0-9]{8,}\b|\b(coins?|crypto\w*|tokenomics|airdrops?|presales?|memecoins?|price (target|prediction)|token (sale|price)|invest(ment|ing|ors?)?|pump(ing)?|to the moon|nfts?|staking)\b/i
const PROMO = /\b(join (our|us)|follow (us|me)|subscribe|discord|telegram|upvote|star (us|the repo|this repo)|sign up)\b/i

/** Content check stub: rules from the brief first (fail), then the reply text (revise), else pass. */
export function stubOutboundCheck(ctx: OutboundContext): string {
  const b = replyBriefOf(ctx)
  const draftDep = ctx.dependencies.find((d) => d.format === 'text') ?? ctx.dependencies.find((d) => d.key === 'draft')
  const draftText = draftDep ? (Object.values(draftDep.files)[0] ?? '') : ''
  const body = parseReplyText(draftText) ?? ''
  const findings: { id: string; severity: string; blocking: boolean; title: string; description: string }[] = []
  let verdict: 'pass' | 'revise' | 'fail' = 'pass'
  if (!b) {
    verdict = 'fail'
    findings.push({ id: 'R1', severity: 'high', blocking: true, title: 'No reply brief', description: 'reply.json is missing from the inputs; nothing to check against.' })
  } else if (!b.rules.allowed || b.rules.botPolicy === 'forbids') {
    verdict = 'fail'
    findings.push({ id: 'R1', severity: 'high', blocking: true, title: 'Community rules forbid this reply', description: (b.rules.reasons.join('; ') || 'bot policy forbids automated comments').slice(0, 300) })
  } else {
    const urls = body.match(/https?:\/\/\S+/g) ?? []
    if (!body) findings.push({ id: 'C1', severity: 'high', blocking: true, title: 'Draft not readable', description: 'The draft is not pit.reply.v1 JSON.' })
    if (COIN.test(body)) findings.push({ id: 'C2', severity: 'high', blocking: true, title: 'Coin / price talk', description: 'Remove any coin, token, ticker, address, price or investment wording.' })
    if (PROMO.test(body) || /(^|\s)@\w/.test(body)) findings.push({ id: 'C3', severity: 'medium', blocking: true, title: 'Promotion or mentions', description: 'Remove follow / join / star requests and @mentions.' })
    if (urls.length !== 1 || (urls[0] && urls[0].replace(/[.,;:!?]+$/, '').replace(/\/+$/, '') !== b.allowedLink.replace(/\/+$/, '')))
      findings.push({ id: 'C4', severity: 'medium', blocking: true, title: 'Link policy', description: `Exactly one link, the deliverable: ${b.allowedLink}` })
    if (body && !/\b(automated|bot|ai agent)\b/i.test(body)) findings.push({ id: 'C5', severity: 'medium', blocking: true, title: 'Missing disclosure', description: `End with: ${b.disclosure}` })
    if (findings.length) verdict = 'revise'
  }
  if (!findings.length) findings.push({ id: 'I1', severity: 'info', blocking: false, title: 'Stub check', description: 'Deterministic stub output; a real holder runtime judges relevance and tone itself.' })
  const doc = {
    format: 'pit.review.v1',
    verdict,
    summary:
      verdict === 'pass'
        ? `Reply to ${b?.community ?? 'the thread'} links only the deliverable, discloses automation and has no promotion${ctx.focus ? ` (focus: ${ctx.focus})` : ''}.`
        : verdict === 'fail'
          ? 'Pit must not post in this thread.'
          : 'The reply needs fixes before it can be posted.',
    findings,
    coverage: [
      { target: 'community rules', verdict: verdict === 'fail' ? 'breaks' : 'holds', why: b ? `server snapshot: ${b.rules.allowed ? 'allowed' : 'not allowed'}, bot policy ${b.rules.botPolicy ?? 'n/a'}` : 'no brief' },
      { target: 'content red lines', verdict: findings.some((f) => f.id === 'C2' || f.id === 'C3') ? 'breaks' : 'holds', why: 'pattern scan by the stub runtime' },
    ],
    rulings: [],
  }
  const lines = [`# Outbound content check`, '', `Verdict: ${verdict}`, '', doc.summary, '']
  for (const f of findings) lines.push(`- [${f.severity}${f.blocking ? ', blocking' : ''}] ${f.id} ${f.title}`)
  lines.push('', '```pit-review', JSON.stringify(doc, null, 2), '```', '')
  return lines.join('\n')
}
