import { describe, expect, it } from 'vitest'
import { runSkill, stubFoundryProject, stubIntegrate, stubViteProject, STUB_SKILLS, underRoot } from '../src/skill.ts'
import { buildHelloPayload, defaultRuntimeDecls } from '../src/hello.ts'

describe('stub skills', () => {
  it('foundry project: ok vs broken differ only in the test assertion', () => {
    const ok = stubFoundryProject({ title: 'C', summary: 's' })
    const bad = stubFoundryProject({ title: 'C', summary: 's', variant: 'broken' })
    expect(Object.keys(ok).sort()).toEqual(['README.md', 'foundry.toml', 'src/Counter.sol', 'test/Counter.t.sol'])
    expect(ok['test/Counter.t.sol']).toContain('== 1')
    expect(bad['test/Counter.t.sol']).toContain('== 2')
    expect(ok['src/Counter.sol']).toBe(bad['src/Counter.sol'])
  })
  it('vite project without lockfile has the required files', () => {
    const v = stubViteProject({ title: 'Demo <x>', summary: 's' }, { lockfile: false })
    expect(Object.keys(v).sort()).toEqual(['index.html', 'package.json', 'src/main.js'])
    expect(v['index.html']).not.toContain('<x>')
    expect(JSON.parse(v['package.json']!).scripts.build).toBe('vite build')
  })
  it('runSkill routes project skills to bundles and others to markdown', () => {
    expect(runSkill('build-foundry', { title: 't', summary: 's' }, 'stub').kind).toBe('bundle')
    expect(runSkill('write-readme', { title: 't', summary: 's' }, 'stub').kind).toBe('markdown')
  })
  it('T6: build skills place files under the node root', () => {
    const out = runSkill('build-foundry', { title: 't', summary: 's' }, 'stub', { root: 'contracts' })
    expect(out.kind).toBe('bundle')
    if (out.kind === 'bundle') expect(Object.keys(out.files).every((p) => p.startsWith('contracts/'))).toBe(true)
    expect(underRoot({ a: '1' }, '')).toEqual({ a: '1' })
  })
  it('T6: integrate copies dependency files unchanged and lists every branch in PIT-MANIFEST.md', () => {
    const files = stubIntegrate({ title: 'P', summary: 's' }, [
      { key: 'site', files: { 'site/index.html': 'x' } },
      { key: 'contract', files: { 'contracts/foundry.toml': 'y' }, treeHash: '0xabc' },
    ])
    expect(files['site/index.html']).toBe('x')
    expect(files['contracts/foundry.toml']).toBe('y')
    expect(files['PIT-MANIFEST.md']).toMatch(/- contract: 1 files, tree 0xabc\n- site: 1 files/)
  })
  it('T6: hello declares stub skills, families and tier', () => {
    const h = buildHelloPayload(defaultRuntimeDecls(), { skills: STUB_SKILLS, families: ['claude'], maxTier: 'standard' })
    expect(h.skills).toContain('integrate-project')
    expect(h.families).toEqual(['claude'])
    expect(h.version).toBe('0.1.0+t11b')
  })
})
