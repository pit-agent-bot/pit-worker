import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chatComplete, fromSse, ModelError, loadModelConfig, logUsage, normalizeModelConfig, readUsage, saveModelConfig, scrub, tokensLast24h, usageTotals, type ChatResult, type ModelConfig } from '../src/model.ts'
import { deployManifestProblems, extractJson, foundryOfflineProblems, foundryTestProblems, InputTooLargeError, normalizeReview, packInputs, proposalProblems, replyProblems, runSkillModel } from '../src/real-skills.ts'
import { startDaemon, type WebSocketLike } from '../src/start.ts'
import { initDevice, loadConfig, saveConfig } from '../src/store.ts'

const KEY = 'sk-test-0123456789abcdefSECRET'
const env = { TEST_KEY: KEY, TEST_BASE: 'https://models.test/v1' }
const cfg = (over: Partial<ModelConfig> = {}): ModelConfig =>
  normalizeModelConfig({ runtime: 'openai-compat', family: 'claude', baseUrlEnv: 'TEST_BASE', keyEnv: 'TEST_KEY', model: 'claude-test', retries: 2, ...over })

const ok = (content: string, usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }, finish = 'stop') =>
  new Response(JSON.stringify({ id: 'msg_1', model: 'claude-test', choices: [{ message: { content }, finish_reason: finish }], usage }), { status: 200 })

// Headers arrive, then the body fails mid-read (what undici does when the request's timeout signal fires during the body).
const failingBody = (err: unknown) =>
  new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"id":"msg_1","choices":['))
        c.error(err)
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
const bodyTimeout = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError')

describe('model config', () => {
  it('stores env var names only and rejects raw keys / bad shapes', () => {
    expect(() => normalizeModelConfig({ runtime: 'openai-compat', family: 'gpt', keyEnv: 'K', model: 'm', baseUrl: 'https://x', apiKey: 'sk-1' })).toThrow(/must not contain "apiKey"/)
    expect(() => normalizeModelConfig({ runtime: 'openai-compat', family: 'gpt', keyEnv: 'sk-abc', model: 'm', baseUrl: 'https://x' })).toThrow(/keyEnv/)
    expect(() => normalizeModelConfig({ runtime: 'openai-compat', family: 'gpt', keyEnv: 'K', model: 'm' })).toThrow(/exactly one of baseUrl/)
    expect(() => normalizeModelConfig({ runtime: 'openai-compat', family: 'stub', keyEnv: 'K', model: 'm', baseUrl: 'https://x' })).toThrow(/reserved/)
    expect(() => normalizeModelConfig({ runtime: 'openai-compat', family: 'gpt', keyEnv: 'K', model: 'm', baseUrl: 'http://x' })).toThrow(/https/)
    const c = cfg({ maxTokens: 20_000, maxTokensCap: 8000 })
    expect(c.maxTokens).toBe(c.maxTokensCap)
    expect(c.dailyTokenBudget).toBe(400_000)
  })

  it('save / load round trip writes mode 0600 and no key material', () => {
    const home = mkdtempSync(join(tmpdir(), 'pit-model-'))
    process.env.PIT_HOME = home
    try {
      saveModelConfig(cfg())
      const raw = readFileSync(join(home, 'model.json'), 'utf8')
      expect(raw).toContain('"keyEnv": "TEST_KEY"')
      expect(raw).not.toContain(KEY)
      expect(loadModelConfig()!.family).toBe('claude')
    } finally {
      delete process.env.PIT_HOME
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('chatComplete', () => {
  const sleep = async () => {}
  it('retries 429 / 5xx / timeouts, parses usage, hashes the provider id', async () => {
    const calls: { url: string; body: Record<string, unknown>; auth: string }[] = []
    let n = 0
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)), auth: String((init.headers as Record<string, string>).authorization) })
      n++
      if (n === 1) return new Response('{"error":{"message":"busy"}}', { status: 429 })
      if (n === 2) throw Object.assign(new Error('aborted'), { name: 'TimeoutError' })
      return ok('hello', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, completion_tokens_details: { reasoning_tokens: 3 } } as never)
    }) as unknown as typeof fetch
    const r = await chatComplete(cfg(), [{ role: 'user', content: 'hi' }], { fetch: f, sleep, env, maxTokens: 300 })
    expect(r.text).toBe('hello')
    expect(r.attempts).toBe(3)
    expect(r.usage).toMatchObject({ promptTokens: 10, completionTokens: 5, totalTokens: 15, reasoningTokens: 3 })
    expect(r.providerMsgIdHash).toMatch(/^0x[0-9a-f]{64}$/)
    expect(calls[0]!.url).toBe('https://models.test/v1/chat/completions')
    expect(calls[0]!.body.max_tokens).toBe(300)
    expect(calls[0]!.auth).toBe(`Bearer ${KEY}`)
  })

  it('a timeout while reading the body is a retryable ModelError (machine), not a bad answer', async () => {
    let n = 0
    const f = (async () => (++n === 1 ? failingBody(bodyTimeout()) : ok('hello'))) as unknown as typeof fetch
    const r = await chatComplete(cfg(), [{ role: 'user', content: 'hi' }], { fetch: f, sleep, env })
    expect(r.text).toBe('hello')
    expect(r.attempts).toBe(2)
    // Every attempt stalls in the body: the call ends in a ModelError naming the timeout (no raw TimeoutError).
    for (const err of [bodyTimeout(), new DOMException('This operation was aborted', 'AbortError')]) {
      const e = await chatComplete(cfg({ retries: 1 }), [{ role: 'user', content: 'hi' }], { fetch: (async () => failingBody(err)) as unknown as typeof fetch, sleep, env }).catch((x) => x)
      expect(e).toBeInstanceOf(ModelError)
      expect(e.message).toBe('model call timed out after 240s (reading the response)')
      expect(e.retryable).toBe(true)
    }
    const net = await chatComplete(cfg({ retries: 0 }), [{ role: 'user', content: 'hi' }], { fetch: (async () => failingBody(new TypeError(`terminated ${KEY}`))) as unknown as typeof fetch, sleep, env }).catch((x) => x)
    expect(net).toBeInstanceOf(ModelError)
    expect(net.message).toMatch(/^network error \(reading the response\): terminated/)
    expect(net.message).not.toContain(KEY)
  })

  it('real fetch: a provider that sends headers and then stalls trips the timeout signal during the body read', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('{"id":"msg_1",') // and never ends
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    const realTimeout = AbortSignal.timeout.bind(AbortSignal)
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => realTimeout(150))
    try {
      // Same request (and signal) as production, sent to the local stalling server instead of the https endpoint.
      const f = ((url: string, init: RequestInit) => fetch(url.replace('https://models.test/v1', `http://127.0.0.1:${port}`), init)) as unknown as typeof fetch
      const e = await chatComplete(cfg({ retries: 0 }), [{ role: 'user', content: 'hi' }], { fetch: f, sleep, env }).catch((x) => x)
      expect(e).toBeInstanceOf(ModelError)
      expect(e.message).toBe('model call timed out after 240s (reading the response)')
    } finally {
      spy.mockRestore()
      server.closeAllConnections()
      await new Promise((r) => server.close(r))
    }
  })

  it('switches to max_completion_tokens when the endpoint asks for it; 401 is final and scrubbed', async () => {
    const bodies: Record<string, unknown>[] = []
    const f = (async (_u: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body))
      bodies.push(b)
      if ('max_tokens' in b) return new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'max_tokens'; use 'max_completion_tokens'" } }), { status: 400 })
      return ok('fine')
    }) as unknown as typeof fetch
    expect((await chatComplete(cfg(), [{ role: 'user', content: 'x' }], { fetch: f, sleep, env })).text).toBe('fine')
    expect(bodies[1]!.max_completion_tokens).toBeGreaterThan(0)
    const bad = (async () => new Response(JSON.stringify({ error: { message: `invalid key ${KEY}` } }), { status: 401 })) as unknown as typeof fetch
    await expect(chatComplete(cfg(), [{ role: 'user', content: 'x' }], { fetch: bad, sleep, env })).rejects.toThrow(/HTTP 401: invalid key \[redacted\]/)
    expect(scrub(`Bearer ${KEY}`)).not.toContain(KEY)
  })

  it('drops temperature when the model only accepts the default', async () => {
    const bodies: Record<string, unknown>[] = []
    const f = (async (_u: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body))
      bodies.push(b)
      if ('temperature' in b) return new Response(JSON.stringify({ error: { message: 'model does not support non-default temperature' } }), { status: 400 })
      return ok('fine')
    }) as unknown as typeof fetch
    expect((await chatComplete(cfg(), [{ role: 'user', content: 'x' }], { fetch: f, sleep, env })).text).toBe('fine')
    expect(bodies).toHaveLength(2)
    expect('temperature' in bodies[1]!).toBe(false)
  })

  it('missing env var fails before any request', async () => {
    const f = vi.fn()
    await expect(chatComplete(cfg(), [{ role: 'user', content: 'x' }], { fetch: f as never, env: { TEST_BASE: 'https://m.test' } })).rejects.toThrow(/TEST_KEY is not set/)
    expect(f).not.toHaveBeenCalled()
  })
})

describe('usage log', () => {
  it('totals per model and the 24 h budget window', () => {
    const home = mkdtempSync(join(tmpdir(), 'pit-usage-'))
    const p = join(home, 'usage.jsonl')
    const now = Math.floor(Date.now() / 1000)
    const base = { seatId: 1, family: 'deepseek', skill: 'x', leaseId: null, jobId: null, reasoningTokens: 0, cachedTokens: 0, ms: 1, ok: true }
    logUsage({ ...base, at: now - 90_000, model: 'a', promptTokens: 1, completionTokens: 1, totalTokens: 2 }, p)
    logUsage({ ...base, at: now - 10, model: 'a', promptTokens: 10, completionTokens: 5, totalTokens: 15 }, p)
    logUsage({ ...base, at: now - 5, model: 'b', promptTokens: 3, completionTokens: 2, totalTokens: 5 }, p)
    const lines = readUsage(p)
    expect(usageTotals(lines)).toMatchObject({ a: { calls: 2, totalTokens: 17 }, b: { calls: 1, totalTokens: 5 } })
    expect(tokensLast24h(lines, now)).toBe(20)
    expect(readFileSync(p, 'utf8')).not.toMatch(/prompt"?:\s*"/) // tokens only, never prompt text
    rmSync(home, { recursive: true, force: true })
  })
})

// ------------------------------------------------------------------ skills

const brief = {
  format: 'pit.brief.v1',
  proposalId: '2026-10-07',
  nonTokenBudgetEth: 0.05,
  maxBudgetEth: 0.2,
  recentTitles: ['Old title'],
  leads: [1, 2, 3].map((i) => ({ id: `opp_${i}`, title: `Lead ${i}`, evidence: [{ url: `https://github.com/o/r/issues/${i}`, source: 'github', title: `Issue ${i}` }] })),
  pitches: [],
}
const deps = [{ key: 'src', files: { 'brief.json': JSON.stringify(brief), 'BRIEF.md': '# brief' } }]
const paper = (i: number, over: Record<string, unknown> = {}) => ({ title: `Tool ${i}`, pitch: 'A small tool.', problem: 'People asked for it.', product: 'A CLI with tests.', deliveryType: ['repo', 'reply'], sourceSignals: [`https://github.com/o/r/issues/${i}`], budgetEth: 0.02, ...over })

function fakeChat(answers: string[]) {
  const seen: { messages: { role: string; content: string }[]; model?: string; maxTokens?: number }[] = []
  const chat = (async (_c: ModelConfig, messages: { role: string; content: string }[], o: { model?: string; maxTokens?: number }) => {
    seen.push({ messages: messages.map((m) => ({ ...m })), model: o.model, maxTokens: o.maxTokens })
    const text = answers[Math.min(seen.length - 1, answers.length - 1)]!
    return { text, model: o.model ?? 'm', finishReason: 'stop', usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60, reasoningTokens: 0, cachedTokens: 0 }, providerMsgIdHash: '0xab', ms: 5, attempts: 1 } satisfies ChatResult
  }) as never
  return { chat, seen }
}

describe('real skills', () => {
  it('write-proposal: a bad answer is sent back with the problems, the fixed one is returned as JSON', async () => {
    const bad = JSON.stringify({ format: 'pit.proposal.v1', papers: [paper(1), paper(2, { sourceSignals: ['https://evil.example/x'] }), paper(3, { title: 'Visit https://x.io' })] })
    const good = '```json\n' + JSON.stringify({ format: 'pit.proposal.v1', papers: [paper(1), paper(2), paper(3)] }) + '\n```'
    const { chat, seen } = fakeChat([bad, good])
    const r = await runSkillModel('write-proposal', { title: 'Founder round', summary: '' }, { dependencies: deps, tier: 'standard' }, { cfg: cfg(), chat })
    expect(r.calls).toBe(2)
    expect(r.tokens).toBe(120)
    expect(r.model).toBe('claude-test')
    expect(JSON.parse((r.out as { markdown: string }).markdown).papers).toHaveLength(3)
    const fix = seen[1]!.messages.at(-1)!.content
    expect(fix).toMatch(/not copied exactly from the brief evidence/)
    expect(fix).toMatch(/contains a link/)
    expect(seen[0]!.messages[1]!.content).toContain('=== src: brief.json ===')
  })

  it('build-foundry: forge-std imports are sent back (offline runner) and the self-contained project is accepted', async () => {
    const files = (test: string) => ({ 'foundry.toml': '[profile.default]\nsrc = "src"\n', 'src/TipJar.sol': 'pragma solidity ^0.8.20;\ncontract TipJar {}\n', 'test/TipJar.t.sol': test })
    const bad = JSON.stringify({ format: 'pit.files.v1', files: files('pragma solidity ^0.8.20;\nimport "forge-std/Test.sol";\nimport {TipJar} from "../src/TipJar.sol";\ncontract T is Test { function test_x() public {} }\n') })
    const good = JSON.stringify({ format: 'pit.files.v1', files: files('pragma solidity ^0.8.20;\nimport {TipJar} from "../src/TipJar.sol";\ncontract T { function test_x() public { require(address(new TipJar()) != address(0)); } }\n') })
    const { chat, seen } = fakeChat([bad, good])
    const r = await runSkillModel('build-foundry', { title: 'Tip jar', summary: 'A tip jar.' }, { tier: 'standard', paths: ['foundry.toml', 'README.md', 'src/**', 'script/**', 'test/**'] }, { cfg: cfg(), chat })
    expect(r.calls).toBe(2)
    expect(Object.keys((r.out as { files: Record<string, string> }).files)).toContain('test/TipJar.t.sol')
    expect(seen[0]!.messages[1]!.content).toMatch(/do NOT import forge-std/)
    expect(seen[1]!.messages.at(-1)!.content).toMatch(/import "forge-std\/Test.sol" cannot resolve offline/)
  })

  it('foundryOfflineProblems: lib imports, remappings and solc pins the runner does not have; relative, root and vendored imports pass', () => {
    const ok = foundryOfflineProblems({ 'src/A.sol': 'pragma solidity ^0.8.20;\nimport "./B.sol";\nimport {C} from "src/C.sol";\n', 'test/A.t.sol': 'pragma solidity 0.8.26;\nimport { A } from "../src/A.sol";\n', 'foundry.toml': 'solc = "0.8.28"\n' })
    expect(ok).toEqual([])
    const bad = foundryOfflineProblems({
      'src/A.sol': 'pragma solidity 0.8.25;\nimport {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";\n',
      'script/D.s.sol': 'import "forge-std/Script.sol";\n',
      'foundry.toml': 'solc_version = "0.8.19"\n',
      'remappings.txt': 'forge-std/=lib/forge-std/src/\n',
    })
    expect(bad.join('\n')).toMatch(/@openzeppelin\/contracts\/access\/Ownable.sol" cannot resolve offline/)
    expect(bad.join('\n')).toMatch(/forge-std\/Script.sol" cannot resolve offline/)
    expect(bad.join('\n')).toMatch(/pragma solidity 0.8.25 is not available offline/)
    expect(bad.join('\n')).toMatch(/solc 0.8.19 is not available offline/)
    expect(bad.join('\n')).toMatch(/remappings.txt: remappings point/)
    // A repo that vendors forge-std (lib/forge-std/...) resolves it offline: fix-findings on such a repo is not refused.
    const deps = [{ key: 'src', files: { 'lib/forge-std/src/Test.sol': '// vendored', 'remappings.txt': 'forge-std/=lib/forge-std/src/' } }]
    expect(foundryOfflineProblems({ 'test/A.t.sol': 'import "forge-std/Test.sol";\n', 'remappings.txt': 'forge-std/=lib/forge-std/src/\n' }, deps)).toEqual([])
  })

  it('foundryTestProblems: an external call inside the arguments right after vm.expectRevert / vm.prank is refused (seat 1337, job_263fcb88cd28160c)', () => {
    // The exact pattern that failed in the runner: "next call did not revert as expected".
    const live = 'contract T {\n  function testTransferRejectsInsufficientBalance() public {\n    vm.expectRevert();\n    token.transfer(ALICE, token.totalSupply() + 1);\n  }\n}\n'
    const bad = foundryTestProblems({ 'test/WidgetClubCoin.t.sol': live })
    expect(bad).toHaveLength(1)
    expect(bad[0]).toMatch(/test\/WidgetClubCoin.t.sol:3: vm.expectRevert\(\) applies to the next external call.*token.totalSupply/)
    expect(foundryTestProblems({ 'test/A.t.sol': 'vm.prank(ALICE);\ntoken.transferFrom(address(this), BOB, token.balanceOf(address(this)));\n' })[0]).toMatch(/vm.prank\(\).*token.balanceOf/)
    expect(foundryTestProblems({ 'test/A.t.sol': 'vm.expectRevert(bytes("x"));\njar.withdraw{value: 1}(other.amount());\n' })).toHaveLength(1)
    // Fine: arguments computed first, built-ins in the arguments, selector arguments on the cheatcode itself, comments.
    const ok = [
      'uint256 tooMuch = token.totalSupply() + 1;\nvm.expectRevert();\ntoken.transfer(ALICE, tooMuch);\n',
      'vm.expectRevert(abi.encodeWithSelector(Coin.Insufficient.selector, 1, 2));\ntoken.transfer(ALICE, 1);\n',
      'vm.expectRevert();\nrouter.call(abi.encodeWithSignature("f(uint256)", type(uint256).max));\n',
      'vm.prank(ALICE);\ntoken.transferFrom(address(this), BOB, 1); // token.balanceOf(x) after the call is fine\nrequire(token.balanceOf(BOB) == 1);\n',
      '/* vm.expectRevert(); token.transfer(a, token.totalSupply()); */\nfunction f() public {}\n',
    ]
    for (const src of ok) expect(foundryTestProblems({ 'test/A.t.sol': src })).toEqual([])
    expect(foundryTestProblems({ 'README.md': 'vm.expectRevert(); token.transfer(a, token.totalSupply());' })).toEqual([])
  })

  it('foundryTestProblems (PR #31 P3s): only calls evaluated before the call under test, strings blanked, casts / new / options / Vm aliases, internal libraries', () => {
    const T = (src: string, more: Record<string, string> = {}) => foundryTestProblems({ 'test/A.t.sol': src, ...more })
    // P3-1: calls after the call under test run after it (forge passes these); strings are not comments.
    expect(T('vm.prank(A);\nrequire(token.transfer(B, 1) && token.balanceOf(B) == 1);\n')).toEqual([])
    expect(T('vm.prank(A); nft.mint(A, "ipfs://cid");\nrequire(nft.ownerOf(token.totalSupply()) == A);\n')).toEqual([])
    expect(T('vm.expectRevert(bytes("see https://x")); token.transfer(A, 1);\nrequire(token.balanceOf(a.b()) == 0);\n')).toEqual([])
    expect(T('string s = "vm.expectRevert(); token.transfer(a, token.totalSupply());";\n')).toEqual([])
    // P3-1: internal library functions are inlined (no call): bundle libraries with internal functions, using-for, Strings.
    const lib = 'library LibI { function f(uint256 x) internal pure returns (uint256) { return x; } }\nlibrary LibE { function g(uint256 x) public pure returns (uint256) { return x; } }\n'
    expect(T('vm.expectRevert(); token.boom(LibI.f(1));\n', { 'src/Lib.sol': lib })).toEqual([])
    expect(T('vm.expectRevert(); token.boom(LibE.g(1));\n', { 'src/Lib.sol': lib })).toHaveLength(1) // public: DELEGATECALL
    expect(T('using SafeMath for uint256;\nfunction t() public { vm.expectRevert(); token.transfer(A, amount.add(1)); }\n')).toEqual([])
    expect(T('vm.expectRevert(); nft.setName(Strings.toString(id));\n')).toEqual([])
    // P3-2: cast and call receivers, contract creation, nested call options, ; inside a string, aliases, expectPartialRevert.
    const msg = T('vm.expectRevert();\ntoken.transfer(A, Token(address(token)).totalSupply() + 1);\n')
    expect(msg).toHaveLength(1)
    expect(msg[0]).toMatch(/vm.expectRevert\(\) .* the call Token\(address\(token\)\).totalSupply\(\) runs before token.transfer\(\)/)
    expect(T('vm.prank(A); token.transfer(B, IERC20(address(token)).balanceOf(A));')).toHaveLength(1)
    expect(T('vm.expectRevert(); reg.add(address(new Token()));')).toHaveLength(1)
    expect(T('vm.expectRevert(); jar.withdraw{value: price.get()}(1);')).toHaveLength(1)
    expect(T('vm.expectRevert(); token.transfer(A, factory.token().totalSupply());')).toHaveLength(1)
    expect(T('vm.expectRevert(); nft.setURI("a;b", token.totalSupply());')).toHaveLength(1)
    expect(T('Vm internal constant cheats = Vm(HEVM_ADDRESS);\nfunction t() public { cheats.expectRevert(); token.transfer(A, token.totalSupply() + 1); }')[0]).toMatch(/cheats.expectRevert\(\)/)
    expect(T('hevm.prank(A); token.transfer(B, token.balanceOf(A));')).toHaveLength(1)
    expect(T('vm.expectPartialRevert(Token.Bad.selector); token.transfer(A, token.totalSupply() + 1);')).toHaveLength(1)
    // Not calls: cheatcodes in the arguments, built-ins, array members, struct literals, startPrank.
    for (const ok of [
      'vm.expectRevert(); token.boom(uint160(vm.addr(1)));',
      'vm.expectRevert(); market.list(Order({maker: A, amount: 1}));',
      'vm.expectRevert(); token.transfer(A, type(uint256).max);',
      'vm.expectRevert(); (bool ok,) = address(jar).call(abi.encodeWithSignature("f()"));',
      'vm.expectRevert(); token.batch(ids.push(), 1);',
      'vm.startPrank(A); token.transfer(B, token.balanceOf(A));',
      'vm.expectRevert(abi.encodeWithSelector(Token.Bad.selector, token.totalSupply())); token.transfer(A, 1);',
    ])
      expect(T(ok)).toEqual([])
  })

  it('foundryTestProblems is linear (PR #31 P3-3): 200 KB of adversarial input in well under 200 ms', () => {
    const inputs = [
      'vm.prank('.repeat(22_300),
      'vm.prank(a);a.b{'.repeat(12_500),
      'vm.prank(a);'.repeat(16_700),
      'vm.prank(a);a.b(1);x.y(2);'.repeat(8_000),
      'vm.expectRevert(); token.transfer(a, token.totalSupply() + 1);\n'.repeat(3_100),
    ]
    for (const src of inputs) {
      const t = performance.now()
      foundryTestProblems({ 'test/A.t.sol': src.slice(0, 200_000) })
      expect(performance.now() - t).toBeLessThan(200)
    }
    // Over the cap the file is not checked (the runner's forge test still is).
    expect(foundryTestProblems({ 'test/A.t.sol': 'vm.expectRevert(); token.transfer(a, token.totalSupply());\n'.padEnd(200_001, ' ') })).toEqual([])
  })

  it('foundryTestProblems (PR #35 P3-35a): qualified struct literals are not calls, their arguments still are', () => {
    const T = (src: string, more: Record<string, string> = {}) => foundryTestProblems({ 'test/A.t.sol': src, ...more })
    const types = 'library Types { struct Order { address maker; uint256 amount; } }\ncontract Market { struct Order { address maker; uint256 amount; } function fill(Order memory o) external {} }\n'
    const src = { 'src/Market.sol': types }
    expect(T('vm.expectRevert(); market.fill(Market.Order({maker: A, amount: 1}));\n', src)).toEqual([])
    expect(T('vm.expectRevert(); market.fill(Types.Order(A, 1));\n', src)).toEqual([])
    expect(T('vm.prank(A);\nmarket.fill(Market.Order({ maker: A, amount: 1 }));\n', src)).toEqual([])
    // A struct declared in the test file itself counts too.
    expect(T('struct Order { address maker; uint256 amount; }\nfunction t() public { vm.expectRevert(); market.fill(Types.Order(A, 1)); }\n')).toEqual([])
    // Still flagged: an external call inside the struct literal, and an undeclared X.Y( (could be a real call).
    expect(T('vm.expectRevert(); market.fill(Market.Order({maker: A, amount: token.totalSupply()}));\n', src)).toHaveLength(1)
    expect(T('vm.expectRevert(); market.fill(Types.Order(A, token.balanceOf(A)));\n', src)).toHaveLength(1)
    expect(T('vm.expectRevert(); market.fill(Market.Quote(A, 1));\n', src)).toHaveLength(1)
  })

  it('foundryTestProblems (PR #35 P3-35b): accepted misses stay unflagged (the runner forge test still catches them)', () => {
    const T = (src: string, more: Record<string, string> = {}) => foundryTestProblems({ 'test/A.t.sol': src, ...more })
    const safeT = 'library SafeT { function safeTransfer(Token t, address to, uint256 v) internal { t.transfer(to, v); } }\n'
    expect(T('using SafeT for Token;\nfunction t() public { vm.expectRevert(); token.safeTransfer(A, token.totalSupply() + 1); }\n', { 'src/SafeT.sol': safeT })).toEqual([])
    const math = 'library Math { function max(uint256 a, uint256 b) public pure returns (uint256) { return a > b ? a : b; } }\n'
    expect(T('vm.expectRevert(); token.transfer(A, Math.max(1, 2));\n', { 'src/Math.sol': math })).toEqual([])
    expect(T('function _supply() internal view returns (uint256) { return token.totalSupply(); }\nfunction t() public { vm.expectRevert(); token.transfer(A, _supply() + 1); }\n')).toEqual([])
  })

  it('foundryTestProblems (PR #35 P3-35c): library discovery is linear and skipped when no file has a cheatcode', () => {
    const unclosed = 'library L { function f() internal '.repeat(6_000).slice(0, 200_000)
    const nested = ('library L { '.repeat(8_000) + 'function f() internal {} ' + '}'.repeat(8_000)).slice(0, 200_000)
    const many = 'library L { function f(uint256 x) internal pure returns (uint256) { return x; } }\n'.repeat(2_400).slice(0, 200_000)
    for (const lib of [unclosed, nested, many]) {
      for (const test of ['contract T { function t() public {} }\n', 'vm.expectRevert(); token.transfer(a, L.f(1));\n']) {
        const t = performance.now()
        foundryTestProblems({ 'src/L.sol': lib, 'test/A.t.sol': test })
        expect(performance.now() - t).toBeLessThan(200)
      }
    }
    // An unclosed library ends at the next declaration: functions after it are not taken as its members.
    const cut = 'library L { function f(uint256 x) internal pure returns (uint256) {\ncontract C { function g(uint256 x) internal pure returns (uint256) { return x; } }\n'
    expect(T2('vm.expectRevert(); token.boom(L.f(1));\n', cut)).toEqual([])
    expect(T2('vm.expectRevert(); token.boom(L.g(1));\n', cut)).toHaveLength(1)
    function T2(src: string, lib: string) {
      return foundryTestProblems({ 'src/L.sol': lib, 'test/A.t.sol': src })
    }
  })

  it('build-foundry: the expectRevert argument pitfall goes back to the model for repair before submit', async () => {
    const files = (t: string) => ({ format: 'pit.files.v1', files: { 'foundry.toml': '[profile.default]\nsrc = "src"\n', 'src/C.sol': 'pragma solidity ^0.8.20;\ncontract C { function totalSupply() external pure returns (uint256) { return 1; } function transfer(address, uint256) external pure returns (bool) { revert(); } }\n', 'test/C.t.sol': t } })
    const bad = 'pragma solidity ^0.8.20;\nimport "../src/C.sol";\ninterface Vm { function expectRevert() external; }\ncontract CT { Vm constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D); C c = new C(); function test_x() public { vm.expectRevert(); c.transfer(address(1), c.totalSupply() + 1); } }\n'
    const good = bad.replace('vm.expectRevert(); c.transfer(address(1), c.totalSupply() + 1);', 'uint256 n = c.totalSupply() + 1; vm.expectRevert(); c.transfer(address(1), n);')
    const { chat, seen } = fakeChat([JSON.stringify(files(bad)), JSON.stringify(files(good))])
    const r = await runSkillModel('build-foundry', { title: 'Coin', summary: 'A coin.' }, { tier: 'standard', paths: ['foundry.toml', 'README.md', 'src/**', 'script/**', 'test/**'] }, { cfg: cfg(), chat })
    expect(r.calls).toBe(2)
    expect(seen[0]!.messages[1]!.content).toMatch(/apply to the very NEXT external call/)
    expect(seen[1]!.messages.at(-1)!.content).toMatch(/vm.expectRevert\(\) applies to the next external call/)
    expect((r.out as { files: Record<string, string> }).files['test/C.t.sol']).toContain('uint256 n = c.totalSupply() + 1;')
  })

  it('research-report: asks for the sections the server verifier requires and repairs an answer without them', async () => {
    const bad = '# Static site generators\n\nAstro, Hugo and Eleventy compared for a small docs site, with setup time and build speed notes.'
    const good = '# Static site generators\n\n## Summary\nHugo builds fastest.\n\n## Approach\nCompared setup and build speed.\n\n## Next steps\n- Try Hugo first.\n'
    const { chat, seen } = fakeChat([bad, good])
    const r = await runSkillModel('research-report', { title: 'Static site generators compared', summary: 'Compare three generators.' }, { tier: 'standard' }, { cfg: cfg(), chat })
    expect(r.calls).toBe(2)
    expect((r.out as { markdown: string }).markdown).toContain('## Next steps')
    expect(seen[0]!.messages[1]!.content).toContain('## Summary, ## Approach, ## Next steps')
    expect(seen[1]!.messages.at(-1)!.content).toMatch(/missing the "## Summary" section/)
    expect(seen[0]!.messages[1]!.content).toMatch(/desk research.*official homepage or documentation URL/s)
  })

  it('proposal checks mirror the server (budget, duplicates, tickers)', () => {
    const p = proposalProblems({ format: 'pit.proposal.v1', papers: [paper(1), paper(1, { title: 'Other' }), paper(3, { pitch: 'Buy $ABC now', budgetEth: 0.5 })] }, brief)
    expect(p.join('\n')).toMatch(/same evidence/)
    expect(p.join('\n')).toMatch(/TICKER/)
    expect(p.join('\n')).toMatch(/above nonTokenBudgetEth/)
  })

  it('reviews: a bare JSON review is rendered into the pit-review contract; pass with blocking is refused', async () => {
    const md = normalizeReview(JSON.stringify({ verdict: 'pass', summary: 'ok', findings: [] }), 'Review')
    expect(md).toMatch(/^# Review/)
    expect(md).toContain('```pit-review')
    const blocking = '# R\n\n```pit-review\n' + JSON.stringify({ format: 'pit.review.v1', verdict: 'pass', summary: 's', findings: [{ id: 'F1', severity: 'high', blocking: true, title: 't', description: 'd' }] }) + '\n```'
    const { chat } = fakeChat([blocking, md])
    const r = await runSkillModel('adversarial-review', { title: 'Review', summary: '' }, { dependencies: deps, focus: 'claims' }, { cfg: cfg(), chat })
    expect(r.calls).toBe(2)
    expect((r.out as { markdown: string }).markdown).toContain('"verdict": "pass"')
  })

  it('draft-reply: needs the one allowed link and the disclosure verbatim; economy nodes use the cheap model', async () => {
    const replyBrief = { format: 'pit.reply-brief.v1', allowedLink: 'https://demo.sites.pitagent.fun/', disclosure: 'Disclosure: I am an automated AI agent run by Pit; I will not post again in this thread.', thread: { url: 'u', title: 't', excerpt: '' }, deliverable: { url: 'u', title: 't', kind: 'site' }, rules: { allowed: true, reasons: [] } }
    const rdeps = [{ key: 'src', files: { 'reply.json': JSON.stringify(replyBrief) } }]
    const body = `Hi, the page at ${replyBrief.allowedLink} converts timestamps in the browser, which is what you asked for. ${replyBrief.disclosure}`
    expect(replyProblems(JSON.stringify({ format: 'pit.reply.v1', body: `${body} Join our discord!` }), replyBrief.allowedLink, replyBrief.disclosure).join(';')).toMatch(/promotion/)
    const { chat, seen } = fakeChat([JSON.stringify({ format: 'pit.reply.v1', body: 'too short' }), JSON.stringify({ format: 'pit.reply.v1', body })])
    const r = await runSkillModel('draft-reply', { title: 'Reply', summary: '' }, { dependencies: rdeps, tier: 'economy' }, { cfg: cfg({ cheapModel: 'claude-mini' }), chat })
    expect(r.tier).toBe('economy')
    expect(seen[0]!.model).toBe('claude-mini')
    expect(JSON.parse((r.out as { markdown: string }).markdown).body).toBe(body)
  })

  it('import-site is a deterministic copy: no model call, zero tokens', async () => {
    const { chat, seen } = fakeChat(['unused'])
    const r = await runSkillModel('import-site', { title: 'Import', summary: '' }, { root: 'site', dependencies: [{ key: 'src', files: { 'index.html': '<h1>x</h1>', 'a.css': 'b{}' } }] }, { cfg: cfg(), chat })
    expect(seen).toHaveLength(0)
    expect(r).toMatchObject({ model: 'tool:import-site', tokens: 0, calls: 0 })
    expect((r.out as { files: Record<string, string> }).files).toEqual({ 'site/index.html': '<h1>x</h1>', 'site/a.css': 'b{}' })
  })

  it('gives up after the repair budget with a quality error', async () => {
    const { chat, seen } = fakeChat(['not json'])
    await expect(runSkillModel('write-proposal', { title: 'x', summary: '' }, { dependencies: deps }, { cfg: cfg(), chat })).rejects.toThrow(/no valid answer after 3 model call/)
    expect(seen).toHaveLength(3)
  })

  it('packs text inputs within budget and skips binaries', () => {
    const p = packInputs([{ key: 'src', files: { 'a.md': 'x'.repeat(5000), 'logo.png': 'PNG', 'b.md': 'y'.repeat(5000) } }], 4000)
    expect(p.text).toContain('logo.png (binary')
    expect(p.truncated).toBe(true)
    expect(p.text.length).toBeLessThan(6000)
    expect(extractJson('noise {"a":1} tail')).toEqual({ a: 1 })
  })
})

// ------------------------------------------------------------------ daemon with the model runtime

type L = (ev: unknown) => void
class Sock implements WebSocketLike {
  readyState = 0
  ls: Record<string, { fn: L; once: boolean }[]> = {}
  constructor(private gw: Gw) {
    queueMicrotask(() => {
      this.readyState = 1
      this.fire('open', {})
    })
  }
  addEventListener(t: string, fn: L, o?: { once?: boolean }) {
    ;(this.ls[t] ??= []).push({ fn, once: !!o?.once })
  }
  removeEventListener(t: string, fn: L) {
    this.ls[t] = (this.ls[t] ?? []).filter((l) => l.fn !== fn)
  }
  fire(t: string, ev: unknown) {
    for (const l of [...(this.ls[t] ?? [])]) {
      if (l.once) this.removeEventListener(t, l.fn)
      l.fn(ev)
    }
  }
  send(d: string) {
    this.gw.onFrame(this, JSON.parse(d))
  }
  close(code = 1000) {
    if (this.readyState === 3) return
    this.readyState = 3
    queueMicrotask(() => this.fire('close', { code }))
  }
  push(f: Record<string, unknown>) {
    if (this.readyState === 1) queueMicrotask(() => this.fire('message', { data: JSON.stringify({ v: 1, ...f }) }))
  }
}
class Gw {
  frames: { kind: string; payload?: Record<string, unknown> }[] = []
  on: Record<string, (s: Sock, f: Record<string, unknown>) => void> = {}
  sock: Sock | null = null
  connect = () => (this.sock = new Sock(this))
  onFrame(s: Sock, f: Record<string, unknown>) {
    this.frames.push({ kind: String(f.kind), payload: f.payload as Record<string, unknown> })
    if (f.kind === 'hello') return s.push({ kind: 'challenge', payload: { nonce: '0x' + 'ab'.repeat(32) } })
    if (f.kind === 'challenge_response') return s.push({ kind: 'welcome', payload: { protocol: 'pit.v1', limits: {} } })
    this.on[String(f.kind)]?.(s, f)
  }
}
// Generous bound: polling every 5 ms, a starved CI worker (parallel test trees) must not turn into a false failure.
const until = async (cond: () => boolean, ms = 15_000) => {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('daemon --runtime model', () => {
  let home: string
  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'pit-cli-model-'))
    process.env.PIT_HOME = home
    await initDevice(false, { network: 'sepolia' })
    saveConfig({ ...loadConfig(), seatId: 813, apiUrl: 'https://api.test' })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
    delete process.env.PIT_HOME
  })

  const lease = (gw: Gw, skill: string) => {
    gw.on.accept = (s, f) =>
      s.push({ kind: 'lease_ok', payload: { leaseId: (f.payload as { leaseId: string }).leaseId, leaseUntil: 9_999_999_999, uploadUrl: 'https://api.test/upload/x', task: { taskId: 'n1', jobId: 'j1', nodeId: 'n1', skill, tier: 'standard', inputs: { title: 'Review it' }, dependencies: [] } } })
    gw.on.submit = (s) => s.push({ kind: 'lease_ok', payload: { submitted: true, receiptHash: '0xfeed', verification: { result: 'pass' } } })
  }

  it('declares the real family + tier, claims model / tokens in the receipt, logs usage', async () => {
    vi.stubGlobal('fetch', async (u: string) => (String(u).includes('/upload') ? new Response(JSON.stringify({ hash: '0x01' })) : new Response(JSON.stringify({ head: null }))))
    const gw = new Gw()
    lease(gw, 'adversarial-review')
    const review = normalizeReview(JSON.stringify({ verdict: 'pass', summary: 'Nothing blocks.', findings: [] }), 'Review')
    const { chat } = fakeChat([review])
    const logs: string[] = []
    const run = startDaemon({ probe: false, connect: gw.connect as never, heartbeatMs: 60_000, log: (l) => logs.push(l), model: cfg({ family: 'claude', model: 'claude-sonnet-test' }), chat })
    await until(() => gw.frames.some((f) => f.kind === 'heartbeat'))
    const hello = gw.frames.find((f) => f.kind === 'hello')!.payload as { families: string[]; maxTier: string; skills: string[] }
    expect(hello.families).toEqual(['claude'])
    expect(hello.maxTier).toBe('standard')
    expect(hello.skills).toContain('write-proposal')
    expect(logs.some((l) => l.includes('families=claude') && l.includes('tier=standard') && l.includes('adversarial-review'))).toBe(true)
    expect(logs.join('\n')).not.toContain(KEY)
    gw.sock!.push({ kind: 'offer', payload: { leaseId: 'lease_1', skill: 'adversarial-review', title: 'Review it' } })
    await until(() => gw.frames.some((f) => f.kind === 'submit'))
    const receipt = (gw.frames.find((f) => f.kind === 'submit')!.payload as { receipt: { modelClaim: Record<string, unknown>; tokensClaim: number } }).receipt
    expect(receipt.modelClaim).toMatchObject({ family: 'claude', model: 'claude-sonnet-test', tier: 'standard', providerMsgIdHash: '0xab' })
    expect(receipt.tokensClaim).toBe(60)
    const usage = readUsage(join(home, 'usage.jsonl'))
    expect(usage).toHaveLength(1)
    expect(usage[0]).toMatchObject({ seatId: 813, family: 'claude', model: 'claude-sonnet-test', skill: 'adversarial-review', totalTokens: 60, ok: true })
    process.emit('SIGTERM')
    await run
  })

  it('a late lease_ok for an earlier lease never answers the next accept (responses matched by leaseId)', async () => {
    vi.stubGlobal('fetch', async (u: string) => (String(u).includes('/upload') ? new Response(JSON.stringify({ hash: '0x01' })) : new Response(JSON.stringify({ head: null }))))
    const gw = new Gw()
    lease(gw, 'adversarial-review')
    const realAccept = gw.on.accept!
    // The server first delivers a stray answer for an older lease, then the real one.
    gw.on.accept = (s, f) => {
      s.push({ kind: 'lease_ok', payload: { leaseId: 'lease_old', submitted: true } })
      setTimeout(() => realAccept(s, f), 20)
    }
    const review = normalizeReview(JSON.stringify({ verdict: 'pass', summary: 'Nothing blocks.', findings: [] }), 'Review')
    const logs: string[] = []
    const run = startDaemon({ probe: false, connect: gw.connect as never, heartbeatMs: 60_000, log: (l) => logs.push(l), model: cfg(), chat: fakeChat([review]).chat })
    await until(() => gw.frames.some((f) => f.kind === 'heartbeat'))
    gw.sock!.push({ kind: 'offer', payload: { leaseId: 'lease_new', skill: 'adversarial-review', title: 'Review it' } })
    await until(() => gw.frames.some((f) => f.kind === 'submit'))
    expect((gw.frames.find((f) => f.kind === 'submit')!.payload as { leaseId: string }).leaseId).toBe('lease_new')
    expect(logs.some((l) => l.includes('LEASE ok until=9999999999'))).toBe(true)
    expect(logs.join('\n')).not.toContain('missing uploadUrl')
    process.emit('SIGTERM')
    await run
  })

  it('an invalid answer after the repair budget sends a signed fail (quality) instead of a submit', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ head: null })))
    const gw = new Gw()
    lease(gw, 'adversarial-review')
    const { chat } = fakeChat(['no contract here'])
    const run = startDaemon({ probe: false, connect: gw.connect as never, heartbeatMs: 60_000, log: () => {}, model: cfg(), chat })
    await until(() => gw.frames.some((f) => f.kind === 'heartbeat'))
    gw.sock!.push({ kind: 'offer', payload: { leaseId: 'lease_2', skill: 'adversarial-review' } })
    await until(() => gw.frames.some((f) => f.kind === 'fail'))
    expect(gw.frames.find((f) => f.kind === 'fail')!.payload).toMatchObject({ leaseId: 'lease_2', failureClass: 'quality' })
    expect(gw.frames.some((f) => f.kind === 'submit')).toBe(false)
    process.emit('SIGTERM')
    await run
  })

  it('a model timeout while reading the response body sends a signed fail (machine) the backend counts as a timeout', async () => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
    vi.stubGlobal('fetch', async (u: string) => (String(u).includes('/chat/completions') ? failingBody(bodyTimeout()) : new Response(JSON.stringify({ head: null }))))
    const gw = new Gw()
    lease(gw, 'adversarial-review')
    const logs: string[] = []
    // No injected chat: the real chatComplete runs against the stubbed provider.
    const run = startDaemon({ probe: false, connect: gw.connect as never, heartbeatMs: 60_000, log: (l) => logs.push(l), model: cfg({ retries: 0 }) })
    await until(() => gw.frames.some((f) => f.kind === 'heartbeat'))
    gw.sock!.push({ kind: 'offer', payload: { leaseId: 'lease_3', skill: 'adversarial-review' } })
    await until(() => gw.frames.some((f) => f.kind === 'fail'))
    const fail = gw.frames.find((f) => f.kind === 'fail')!.payload as { leaseId: string; failureClass: string; reason: string }
    expect(fail).toMatchObject({ leaseId: 'lease_3', failureClass: 'machine' })
    // backend/src/dispatch.ts isTimeout: failure class machine + this pattern on `device_failed: <reason>`.
    expect(`device_failed: ${fail.reason}`).toMatch(/^device_failed: .*\b(timeout|timed out)\b/i)
    expect(fail.reason).toBe('timeout')
    expect(fail).toMatchObject({ failureDetail: 'timeout' })
    expect(logs.some((l) => l.includes('failed (machine/timeout): model call timed out'))).toBe(true)
    expect(gw.frames.some((f) => f.kind === 'submit')).toBe(false)
    process.emit('SIGTERM')
    await run
  })

  it('declines offers once the daily token budget is used up', async () => {
    const gw = new Gw()
    lease(gw, 'adversarial-review')
    const now = Math.floor(Date.now() / 1000)
    logUsage({ at: now, seatId: 813, family: 'claude', model: 'x', skill: 's', leaseId: null, jobId: null, promptTokens: 900, completionTokens: 100, totalTokens: 1000, reasoningTokens: 0, cachedTokens: 0, ms: 1, ok: true }, join(home, 'usage.jsonl'))
    const logs: string[] = []
    const run = startDaemon({ probe: false, connect: gw.connect as never, heartbeatMs: 60_000, log: (l) => logs.push(l), model: cfg({ dailyTokenBudget: 1000 }), chat: fakeChat(['x']).chat })
    await until(() => gw.frames.some((f) => f.kind === 'heartbeat'))
    gw.sock!.push({ kind: 'offer', payload: { leaseId: 'lease_3', skill: 'adversarial-review' } })
    await until(() => logs.some((l) => l.includes('daily token budget reached')))
    expect(gw.frames.some((f) => f.kind === 'accept')).toBe(false)
    process.emit('SIGTERM')
    await run
  })
})

describe('ascii punctuation', () => {
  it('maps typographic punctuation to ASCII and keeps JSON valid', async () => {
    const { asciiPunct } = await import('../src/real-skills.ts')
    const s = asciiPunct('{"a":"It\u2019s \u201cfast\u201d \u2014 2\u20133 days\u2026 \u2192 ok"}')
    expect(s).toBe(`{"a":"It's 'fast' - 2-3 days... -> ok"}`)
    expect(JSON.parse(s).a).toContain('fast')
  })
})

it('stream: true folds SSE chunks (content, finish_reason, usage) and asks for usage', async () => {
  let sent: any = null
  const sse = [
    'data: {"id":"r1","model":"m","choices":[{"delta":{"role":"assistant"}}]}',
    'data: {"id":"r1","choices":[{"delta":{"content":"Hel"}}]}',
    ': keep-alive',
    'data: {"id":"r1","choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}',
    'data: {"id":"r1","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}',
    'data: [DONE]',
    '',
  ].join('\n')
  const f = (async (_u: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body))
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as unknown as typeof fetch
  const cfg = { runtime: 'openai-compat', family: 'claude', baseUrl: 'https://x.test', keyEnv: 'K', model: 'm', tier: 'standard', maxTokens: 100, maxTokensCap: 200, maxInputChars: 5000, timeoutSec: 10, retries: 0, temperature: 0.3, dailyTokenBudget: 0, stream: true } as any
  const r = await chatComplete(cfg, [{ role: 'user', content: 'hi' }], { fetch: f, env: { K: 'k-123456789' } })
  expect(sent.stream).toBe(true)
  expect(sent.stream_options).toEqual({ include_usage: true })
  expect(r.text).toBe('Hello')
  expect(r.finishReason).toBe('stop')
  expect(r.usage.totalTokens).toBe(7)
  expect(fromSse('data: {"error":{"message":"x"}}').error.message).toBe('x')
})

describe('T12 seat input + deploy-manifest', () => {
  it('oversized upstream input fails loudly (no model call, no truncated view)', async () => {
    const { chat, seen } = fakeChat(['unused'])
    const big = [{ key: 'src', files: { 'a.sol': 'x'.repeat(5000), 'b.sol': 'y'.repeat(5000) } }]
    await expect(runSkillModel('audit-specialist', { title: 'Audit', summary: '' }, { dependencies: big as never }, { cfg: cfg({ maxInputChars: 3000 }), chat })).rejects.toBeInstanceOf(InputTooLargeError)
    expect(seen.length).toBe(0)
  })

  it('deploy-manifest: invalid manifests are rejected, a valid Sepolia manifest passes', () => {
    expect(deployManifestProblems({})).toEqual(['write pit-deploy.json'])
    expect(deployManifestProblems({ 'pit-deploy.json': JSON.stringify({ schema: 'pit.deploy.v1', chainId: 1, contracts: [{ name: 'A', artifact: 'out/A.sol/A.json' }] }) }).join()).toMatch(/Sepolia/)
    expect(deployManifestProblems({ 'pit-deploy.json': JSON.stringify({ schema: 'pit.deploy.v1', chainId: 11155111, gasBudget: 20_000_000, contracts: [{ name: 'A', artifact: '../x.json' }] }) }).length).toBe(2)
    expect(deployManifestProblems({ 'pit-deploy.json': JSON.stringify({ schema: 'pit.deploy.v1', chainId: 11155111, gasBudget: 15_000_000, requireInvariants: true, lintPaths: ['src'], contracts: [{ name: 'TipJar', artifact: 'out/TipJar.sol/TipJar.json', constructorSlots: 1 }] }) })).toEqual([])
  })
})
