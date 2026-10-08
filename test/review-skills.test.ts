import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkReview, extractReview, promptFor, T7_SKILLS, type T7Context } from '../src/review-skills.ts'
import { runSkill, stubFoundryProject, STUB_SKILLS, writeBundle } from '../src/skill.ts'

const counter = stubFoundryProject({ title: 'Counter', summary: 's' })
const ctx = (extra: Partial<T7Context> = {}): T7Context => ({ title: 't', dependencies: [{ key: 'impl', files: counter, format: 'pit.files.v1' }], ...extra })
const md = (skill: string, c: Partial<T7Context> = {}) => {
  const out = runSkill(skill, { title: 't', summary: 's' }, 'stub', { ...ctx(), ...c })
  if (out.kind !== 'markdown') throw new Error('expected markdown')
  return out.markdown
}
const hasForge = (() => {
  try {
    execFileSync('sh', ['-c', 'command -v forge'])
    return true
  } catch {
    return false
  }
})()

describe('T7 skills: contracts and prompt templates', () => {
  it('declares all eight T7 skills plus the content judge', () => {
    for (const s of ['write-foundry-tests', 'audit-specialist', 'audit-judge', 'code-review', 'adversarial-review', 'fix-findings', 'import-site', 'site-content-check', 'review-judge']) expect(STUB_SKILLS).toContain(s)
  })
  it('prompt templates carry the role, inputs, feedback and the output contract', () => {
    for (const s of T7_SKILLS) {
      const p = promptFor(s, ctx({ nodeKey: 'n', paths: ['test/**'], feedback: [{ from: 'review', verdict: 'revise', summary: 's', findings: [{ id: 'R1', title: 'Missing test', severity: 'medium' }] }] }))
      expect(p).toContain('impl: src/Counter.sol')
      expect(p).toContain('[review/R1] medium Missing test')
      expect(p).toMatch(/pit\.review\.v1|pit\.files\.v1|pit\.proposal\.v1|pit\.reply\.v1/)
    }
  })
})

describe('T7 deterministic stubs', () => {
  it('review skills emit a valid pit-review block', () => {
    for (const s of ['audit-specialist', 'audit-judge', 'code-review', 'adversarial-review', 'site-content-check', 'review-judge']) {
      const text = md(s, { focus: 'access' })
      expect(checkReview(text), s).toEqual([])
    }
  })
  it('code-review revises while revision < inputs.reviseRounds, then passes', () => {
    expect(extractReview(md('code-review', { inputs: { reviseRounds: 1 }, revision: 0 }))!.verdict).toBe('revise')
    expect(extractReview(md('code-review', { inputs: { reviseRounds: 1 }, revision: 1 }))!.verdict).toBe('pass')
  })
  it('audit judge merges specialist reports and rules on each finding', () => {
    const a = md('audit-specialist', { focus: 'access' })
    const doc = extractReview(md('audit-judge', { dependencies: [{ key: 'audit_access', files: { 'audits/access.md': a }, format: 'text' }, { key: 'audit_flow', files: { 'audits/flow.md': a }, format: 'text' }] }))!
    expect(doc.findings.length).toBe(1)
    expect(doc.rulings!.map((r) => r.decision)).toEqual(['confirmed', 'duplicate'])
    expect(doc.verdict).toBe('pass')
  })
  it('site check fails wallet pages; import copies byte for byte; fix copies the tree + FIXES.md', () => {
    const site = { 'web/index.html': '<script>window.ethereum.request({method:"eth_requestAccounts"})</script>', 'web/a.css': 'b{}' }
    const imp = runSkill('import-site', { title: 't', summary: 's' }, 'stub', { root: 'site', dependencies: [{ key: 'src', files: site }] })
    expect(imp.kind === 'bundle' && imp.files).toEqual({ 'site/index.html': site['web/index.html'], 'site/a.css': 'b{}' })
    const chk = extractReview(md('site-content-check', { dependencies: [{ key: 'import', files: imp.kind === 'bundle' ? imp.files : {} }] }))!
    expect(chk.verdict).toBe('fail')
    const fix = runSkill('fix-findings', { title: 't', summary: 's' }, 'stub', { ...ctx(), inputs: { findings: 'F1 anyone can increment' } })
    expect(fix.kind === 'bundle' && fix.files['FIXES.md']).toMatch(/F1 anyone can increment/)
  })
  it.skipIf(!hasForge)('tests compile and pass; adversarial PoC F1 reproduces and F2 does not (forge, offline)', () => {
    const tests = runSkill('write-foundry-tests', { title: 't', summary: 's' }, 'stub', ctx())
    const adv = extractReview(md('adversarial-review'))!
    const dir = mkdtempSync(join(tmpdir(), 'pit-t7-'))
    try {
      writeBundle(dir, { ...counter, ...(tests.kind === 'bundle' ? tests.files : {}) })
      const run = (args: string[]) => spawnSync('forge', ['test', '--offline', ...args], { cwd: dir, encoding: 'utf8', timeout: 120_000 })
      expect(run([]).status).toBe(0)
      const results: Record<string, boolean> = {}
      for (const f of adv.findings.filter((x) => x.poc)) {
        const p = `test/pit-poc/review_${f.id}.t.sol`
        writeBundle(dir, { [p]: f.poc!.code })
        results[f.id] = run(['--match-path', p]).status === 0
        rmSync(join(dir, p))
      }
      expect(results).toEqual({ F1: true, F2: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)
})
