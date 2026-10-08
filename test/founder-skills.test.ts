import { describe, expect, it } from 'vitest'
import { checkProposal, cleanText, stubWriteProposal } from '../src/founder-skills.ts'
import { promptFor } from '../src/review-skills.ts'
import { runSkill, STUB_SKILLS } from '../src/skill.ts'

const lead = (n: number, delivery: string[], score: number) => ({
  id: `opp_${n}`,
  title: `Is there a tool for task ${n}?`,
  problem: `Problem ${n}: see https://x.test and pay $DOGE at 0x${'ab'.repeat(20)}`,
  audience: 'People in the thread',
  evidence: [{ url: `https://news.ycombinator.com/item?id=${n}`, source: n === 3 ? 'github' : 'hn', title: `t${n}`, excerpt: 'e' }],
  suggestedDelivery: delivery,
  flags: [],
  feasibility: 'small',
  estCostEth: 0.02,
  score,
})
const brief = {
  format: 'pit.brief.v1',
  proposalId: '2026-10-07',
  papers: 3,
  maxBudgetEth: 0.5,
  nonTokenBudgetEth: 0.1,
  leads: [lead(1, ['repo', 'reply'], 3), lead(2, ['site'], 9), lead(3, ['nope'], 5), lead(4, ['repo'], 1)],
  pitches: [],
  recentTitles: ['Build: Is there a tool for task 2?'],
  feedback: [],
}
const deps = [{ key: 'src', files: { 'BRIEF.md': '# brief', 'brief.json': JSON.stringify(brief) } }]

describe('T9 write-proposal skill (stub runtime, no model keys)', () => {
  it('writes 3 papers from the top leads with evidence links and deliveryType; text has no links / tickers / addresses', () => {
    expect(STUB_SKILLS).toContain('write-proposal')
    const out = runSkill('write-proposal', { title: 'Founder round', summary: '' }, 'stub', { dependencies: deps })
    expect(out.kind).toBe('markdown')
    const doc = JSON.parse(out.kind === 'markdown' ? out.markdown : '')
    expect(doc.format).toBe('pit.proposal.v1')
    expect(doc.papers.map((p: any) => p.sourceSignals[0])).toEqual(['https://news.ycombinator.com/item?id=2', 'https://news.ycombinator.com/item?id=3', 'https://news.ycombinator.com/item?id=1'])
    expect(doc.papers.map((p: any) => p.deliveryType)).toEqual([['site'], ['repo'], ['repo', 'reply']])
    expect(doc.papers[0].title).toBe('Build: Is there a tool for task 2? (v2)') // avoids a recent title
    for (const p of doc.papers) {
      const text = [p.title, p.pitch, p.problem, p.product].join(' ')
      expect(text).not.toMatch(/https?:|\$|0x[0-9a-f]{6}/i)
      expect(p.budgetEth).toBeLessThanOrEqual(0.1)
    }
    expect(checkProposal(out.kind === 'markdown' ? out.markdown : '')).toEqual([])
  })
  it('fails loudly without a brief or with too few leads; the prompt carries the contract', () => {
    expect(() => stubWriteProposal({ title: 'x', dependencies: [] })).toThrow(/brief\.json not found/)
    const thin = [{ key: 'src', files: { 'brief.json': JSON.stringify({ ...brief, leads: brief.leads.slice(0, 1) }) } }]
    expect(() => stubWriteProposal({ title: 'x', dependencies: thin })).toThrow(/only 1 usable lead/)
    expect(checkProposal('{"format":"pit.proposal.v1","papers":[]}')).toEqual(['need exactly 3 papers'])
    expect(cleanText('see https://a.b $X 0xabcdef12', 100)).toBe('see X')
    const prompt = promptFor('write-proposal', { title: 'Founder round', dependencies: deps })
    expect(prompt).toMatch(/pit\.proposal\.v1/)
    expect(prompt).toMatch(/src: brief\.json/)
  })
})
