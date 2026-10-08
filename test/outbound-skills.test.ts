import { describe, expect, it } from 'vitest'
import { checkReply, parseReplyText, stubDraftReply, stubOutboundCheck } from '../src/outbound-skills.ts'
import { extractReview, promptFor, REVIEW_SKILLS, T7_SKILLS } from '../src/review-skills.ts'
import { runSkill, STUB_SKILLS } from '../src/skill.ts'

const DISCLOSURE = 'Disclosure: I am an automated AI agent run by Pit; I will not post again in this thread.'
const brief = (over: Record<string, unknown> = {}) => ({
  format: 'pit.reply-brief.v1',
  outreachId: 'out_1',
  platform: 'github',
  community: 'acme/widgets',
  thread: { url: 'https://github.com/acme/widgets/issues/7', title: 'Need a <b>demo page</b> for @someone at https://x.test $DOGE', excerpt: 'help wanted' },
  deliverable: { url: 'https://demo-7.sites.pitagent.fun/', title: 'Widgets demo page', kind: 'site' },
  allowedLink: 'https://demo-7.sites.pitagent.fun/',
  rules: { allowed: true, reasons: [], botPolicy: 'none', welcoming: true, contributing: null, excerpt: '', note: null },
  disclosure: DISCLOSURE,
  constraints: [],
  ...over,
})
const src = (b: object) => ({ key: 'src', files: { 'REPLY_BRIEF.md': '# brief', 'reply.json': JSON.stringify(b) } })
const draft = (body: string) => ({ key: 'draft', format: 'text', files: { 'reply.json': JSON.stringify({ format: 'pit.reply.v1', body }) } })

describe('T10 draft-reply skill (stub runtime, no model keys)', () => {
  it('writes a pit.reply.v1 reply with exactly the deliverable link and the disclosure; strips links / mentions / tickers from the title', () => {
    expect(STUB_SKILLS).toContain('draft-reply')
    expect(T7_SKILLS).toContain('outbound-content-check')
    expect(REVIEW_SKILLS).toContain('outbound-content-check')
    const out = runSkill('draft-reply', { title: 'Reply', summary: '' }, 'stub', { dependencies: [src(brief())] })
    const text = out.kind === 'markdown' ? out.markdown : ''
    const body = parseReplyText(text)!
    expect(body).toContain('https://demo-7.sites.pitagent.fun/')
    expect(body.match(/https?:\/\//g)).toHaveLength(1)
    expect(body).toContain(DISCLOSURE)
    expect(body).not.toMatch(/@|\$|<b>|x\.test/)
    expect(checkReply(text, 'https://demo-7.sites.pitagent.fun/')).toEqual([])
  })
  it('pre-submit check catches bad output', () => {
    expect(checkReply('not json')[0]).toMatch(/pit\.reply\.v1/)
    const two = JSON.stringify({ format: 'pit.reply.v1', body: 'See https://a.example and https://b.example for the thing you asked about. I am a bot.' })
    expect(checkReply(two)).toContain('exactly one link (the deliverable)')
    expect(() => stubDraftReply({ title: 't', dependencies: [] })).toThrow(/reply\.json/)
  })
})

describe('T10 outbound-content-check skill', () => {
  const good = parseReplyText(stubDraftReply({ title: 't', dependencies: [src(brief())] }))!
  it('passes a clean reply', () => {
    const doc = extractReview(stubOutboundCheck({ title: 't', dependencies: [src(brief()), draft(good)] }))!
    expect(doc.verdict).toBe('pass')
  })
  it('fails when the community rules forbid it', () => {
    const b = brief({ rules: { allowed: false, reasons: ['repo rules forbid bots'], botPolicy: 'forbids', welcoming: true, contributing: null, excerpt: '', note: null } })
    const doc = extractReview(stubOutboundCheck({ title: 't', dependencies: [src(b), draft(good)] }))!
    expect(doc.verdict).toBe('fail')
    expect(doc.findings[0]!.title).toMatch(/rules forbid/)
  })
  it('asks for a revision on coin talk, extra links, mentions or a missing disclosure', () => {
    const bad = `Try our $PIT coin! ${good.replace(DISCLOSURE, '')} also https://evil.example @maintainer`
    const doc = extractReview(stubOutboundCheck({ title: 't', dependencies: [src(brief()), draft(bad)] }))!
    expect(doc.verdict).toBe('revise')
    expect(doc.findings.map((f) => f.id).sort()).toEqual(['C2', 'C3', 'C4', 'C5'])
  })
  it('has prompt templates with the output contracts', () => {
    const p1 = promptFor('draft-reply', { title: 'Reply', dependencies: [src(brief())] })
    expect(p1).toMatch(/pit\.reply\.v1/)
    expect(p1).toMatch(/automated AI agent/)
    const p2 = promptFor('outbound-content-check', { title: 'Check', dependencies: [] })
    expect(p2).toMatch(/pit\.review\.v1/)
    expect(p2).toMatch(/community rules/)
  })
})
