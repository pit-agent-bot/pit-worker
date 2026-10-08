/**
 * Local skill runtimes. The stub runtime is deterministic and needs no model keys; real runtimes (claude / codex) run on
 * this machine and keys never leave it. Project skills return a `pit.files.v1` bundle that the verifier runner rebuilds.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { checkProposal } from './founder-skills.ts'
import { checkReply } from './outbound-skills.ts'
import { checkReview, REVIEW_SKILLS, runT7Stub, T7_SKILLS, type T7Context } from './review-skills.ts'

export interface SkillInput {
  title: string
  summary: string
  topic?: string
  variant?: string
}

/** T6 DAG context from lease_ok.task: project root, node key and accepted dependency bundles (T7: text outputs too). */
export interface SkillContext {
  nodeKey?: string | null
  root?: string | null
  dependencies?: { key: string; files: Record<string, string>; treeHash?: string | null; format?: string }[]
  /** T7 */
  paths?: string[]
  focus?: string | null
  revision?: number
  inputs?: Record<string, unknown>
  feedback?: T7Context['feedback']
  review?: T7Context['review']
}

export const BUNDLE_FORMAT = 'pit.files.v1'
export const PROJECT_SKILLS = ['build-foundry', 'build-vite'] as const
/** Skills the stub runtime can run (declared in hello so the scheduler only offers these). */
export const STUB_SKILLS = ['write-readme', 'research-report', 'build-foundry', 'build-vite', 'integrate-project', ...T7_SKILLS] as const

export type SkillOutput = { kind: 'markdown'; markdown: string } | { kind: 'bundle'; files: Record<string, string> }

export function stubWriteReadme(input: SkillInput): string {
  const title = (input.title || 'Untitled').replace(/\s+/g, ' ').trim()
  const summary = (input.summary || 'No summary provided.').replace(/\s+/g, ' ').trim()
  const topic = (input.topic || title).replace(/\s+/g, ' ').trim()
  return [
    `# ${title}`,
    '',
    '## Summary',
    summary,
    '',
    '## Approach',
    `This README was produced by the Pit stub runtime for skill write-readme on topic: ${topic}.`,
    'It is deterministic and does not call any model API.',
    '',
    '## Next steps',
    '- Replace the stub runtime with a local Claude Code / Codex session (T4+).',
    '- Wire peer review and domain judges (later tasks).',
    '',
  ].join('\n')
}

/** Tiny Foundry project (no forge-std, so the runner needs no network). variant=broken ships a failing test. */
export function stubFoundryProject(input: SkillInput): Record<string, string> {
  const broken = input.variant === 'broken'
  return {
    'foundry.toml': ['[profile.default]', 'src = "src"', 'test = "test"', 'out = "out"', 'solc = "0.8.26"', ''].join('\n'),
    'README.md': `# ${input.title || 'Counter'}\n\nTiny Foundry project produced by the Pit stub runtime.\n`,
    'src/Counter.sol': [
      '// SPDX-License-Identifier: MIT',
      'pragma solidity ^0.8.20;',
      '',
      'contract Counter {',
      '    uint256 public number;',
      '',
      '    function increment() public {',
      '        number += 1;',
      '    }',
      '}',
      '',
    ].join('\n'),
    'test/Counter.t.sol': [
      '// SPDX-License-Identifier: MIT',
      'pragma solidity ^0.8.20;',
      '',
      'import {Counter} from "../src/Counter.sol";',
      '',
      'contract CounterTest {',
      '    function test_increment() public {',
      '        Counter c = new Counter();',
      '        c.increment();',
      `        require(c.number() == ${broken ? 2 : 1}, "counter should be ${broken ? 2 : 1}");`,
      '    }',
      '}',
      '',
    ].join('\n'),
  }
}

/** Tiny Vite site. Adds package-lock.json when npm is available (so the runner can use npm ci). */
export function stubViteProject(input: SkillInput, opts: { lockfile?: boolean } = {}): Record<string, string> {
  const broken = input.variant === 'broken'
  const title = (input.title || 'Pit Vite demo').replace(/[<>&"]/g, '')
  const files: Record<string, string> = {
    'package.json':
      JSON.stringify(
        { name: 'pit-vite-demo', private: true, version: '0.0.0', type: 'module', scripts: { build: 'vite build' }, devDependencies: { vite: '6.4.4' } },
        null,
        2,
      ) + '\n',
    'index.html': `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8" />\n    <title>${title}</title>\n  </head>\n  <body>\n    <div id="app"></div>\n    <script type="module" src="/src/main.js"></script>\n  </body>\n</html>\n`,
    'src/main.js': broken
      ? "import { missing } from './does-not-exist.js'\ndocument.getElementById('app').textContent = missing\n"
      : `document.getElementById('app').textContent = ${JSON.stringify(title)}\n`,
  }
  if (opts.lockfile !== false) {
    const lock = generateLockfile(files['package.json']!)
    if (lock) files['package-lock.json'] = lock
  }
  return files
}

function generateLockfile(packageJson: string): string | null {
  const dir = mkdtempSync(join(tmpdir(), 'pit-lock-'))
  try {
    writeFileSync(join(dir, 'package.json'), packageJson)
    const r = spawnSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: dir,
      timeout: 90_000,
      stdio: 'ignore',
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? dir },
    })
    if (r.status !== 0) return null
    return readFileSync(join(dir, 'package-lock.json'), 'utf8')
  } catch {
    return null
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Place project files under the node's root (e.g. contracts/ or site/). */
export function underRoot(files: Record<string, string>, root?: string | null): Record<string, string> {
  const r = (root || '').replace(/\/+$/, '')
  if (!r) return files
  return Object.fromEntries(Object.entries(files).map(([p, c]) => [`${r}/${p}`, c]))
}

/**
 * Integrate stub: copy every accepted dependency file unchanged (the backend rejects edits outside the node's paths)
 * and write PIT-MANIFEST.md listing each branch.
 */
export function stubIntegrate(input: SkillInput, deps: NonNullable<SkillContext['dependencies']>): Record<string, string> {
  const files: Record<string, string> = {}
  for (const d of deps) Object.assign(files, d.files)
  const lines = [`# ${input.title || 'Integrated project'}`, '', 'Integrated by the Pit stub runtime from accepted branches:', '']
  for (const d of [...deps].sort((a, b) => a.key.localeCompare(b.key))) {
    lines.push(`- ${d.key}: ${Object.keys(d.files).length} files${d.treeHash ? `, tree ${d.treeHash}` : ''}`)
  }
  lines.push('', 'Branch files are copied unchanged; the runner re-builds every project root.', '')
  files['PIT-MANIFEST.md'] = lines.join('\n')
  return files
}

export function runSkill(skill: string, input: SkillInput, mode: 'stub' | 'local', ctx: SkillContext = {}): SkillOutput {
  // Only the stub runtime is wired; the local runtime path (claude / codex in a sandbox) comes later.
  void mode
  const t7 = runT7Stub(skill, {
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
  })
  if (t7) {
    // Local pre-submit check of the review contract (the backend validates again).
    if (t7.kind === 'markdown' && (REVIEW_SKILLS as readonly string[]).includes(skill)) {
      const problems = checkReview(t7.markdown)
      if (problems.length) throw new Error(`review output violates pit.review.v1: ${problems.join('; ')}`)
    }
    if (skill === 'write-proposal' && t7.kind === 'markdown') {
      const problems = checkProposal(t7.markdown)
      if (problems.length) throw new Error(`proposal output violates pit.proposal.v1: ${problems.join('; ')}`)
    }
    if (skill === 'draft-reply' && t7.kind === 'markdown') {
      const problems = checkReply(t7.markdown)
      if (problems.length) throw new Error(`reply output violates pit.reply.v1: ${problems.join('; ')}`)
    }
    return t7
  }
  if (skill === 'build-foundry') return { kind: 'bundle', files: underRoot(stubFoundryProject(input), ctx.root) }
  if (skill === 'build-vite') return { kind: 'bundle', files: underRoot(stubViteProject(input), ctx.root) }
  if (skill === 'integrate-project') return { kind: 'bundle', files: stubIntegrate(input, ctx.dependencies ?? []) }
  return { kind: 'markdown', markdown: stubWriteReadme(input) }
}

/** Write a bundle to disk (debug helper for `pit` users inspecting what was produced). */
export function writeBundle(root: string, files: Record<string, string>) {
  for (const [p, c] of Object.entries(files)) {
    const abs = join(root, p)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, c)
  }
}
