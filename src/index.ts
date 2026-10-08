/**
 * pit — clean-room seat daemon CLI (T4): init / pair / doctor / start (offers+stub) / update.
 * Model API keys never leave this machine. Auto-update is signature-gated and off by default.
 */
import { isHex, type Hex } from 'viem'
import { DAEMON_VERSION, DEFAULT_API_URL, DEFAULT_CHAIN_ID, DEFAULT_SEAT_CONTRACT } from './defaults.ts'
import { runDoctor } from './doctor.ts'
import {
  pairComplete,
  pairStart,
  pairStatus,
  pairWatch,
  printPairInstructions,
  signAuthorization,
} from './pair.ts'
import { paths } from './paths.ts'
import { startDaemon } from './start.ts'
import { assertSupportedChain, supportedNetworks } from './networks.ts'
import { initDevice, loadConfig, requireDevice } from './store.ts'
import { cmdUpdate } from './update.ts'

function officialSeats(): boolean {
  return process.env.PIT_OFFICIAL === '1'
}

function usage(): string {
  const official = officialSeats()
  const modelHelp = official
    ? `
  pit model                       Official seats only. Show model.json (env var names, never key values)
  pit model --providers           List provider presets (base URLs, default models, key env names)
  pit model --set [--provider <id>] [--api openai|anthropic] [--family <f>] [--model <m>] [--key-env <ENV>]
            [--base-url <https://..> | --base-url-env <ENV>]
            [--cheap-model <m>] [--tier standard] [--max-tokens N] [--max-tokens-cap N] [--max-input-chars N]
            [--timeout <sec>] [--retries N] [--daily-budget <tokens>]
            [--reasoning-effort minimal|low|medium|high] [--thinking adaptive|enabled|disabled]
                                  --provider fills base URL, model, family and key env from the preset; flags override.
  pit model --test                One tiny completion (token usage + latency; logged to usage.jsonl)`
    : `
  pit model                       Official DeepSeek API only (https://api.deepseek.com)
  pit model --models              deepseek-flash (default) or deepseek-v4-pro
  pit model --set --provider deepseek --model deepseek-flash|deepseek-v4-pro --api-key
                                  --api-key prompts. The key is never a command argument.
  pit model --test                One tiny completion (spends a little credit)
  pit runtime --models            Official Codex and Claude Code model ids`
  const claudeApi = official
    ? `
            [--claude-provider deepseek|kimi|kimi-cn|glm|glm-cn|qwen|qwen-cn|openrouter|anthropic|none]
            [--claude-key-env <ENV>] [--claude-base-url <https://..>]`
    : ''
  const doctorRuntime = official ? 'codex|claude|kimi|command|model' : 'codex|claude|model'
  const startRuntime = official ? 'stub|model|codex|claude|kimi|command|local' : 'stub|codex|claude|model'
  const commandHelp = official
    ? `
  pit runtime --accept-command-terms
                                  Extra notice for the unsandboxed command adapter (text skills only)`
    : ''
  const runtimeSet = official
    ? `pit runtime --set [--default codex|claude|kimi|command] [--tier standard] [--timeout <sec>] [--max-turns N]
            [--repairs N] [--max-input-chars N] [--daily-budget <tokens>] [--network on|off]
            [--codex-model <m>] [--codex-effort minimal|low|medium|high|xhigh]
            [--claude-model <m>] [--claude-effort low|medium|high|xhigh|max]${claudeApi} [--kimi-model <m>]
            [--set-command '<json>' | --clear-command]
                                  --set-command example: '{"name":"mycli","bin":"mycli","args":["run","--json","{prompt}"],
                                  "prompt":"arg","output":"jsonl","resultField":"result","family":"qwen","passEnv":["DASHSCOPE_API_KEY"]}'`
    : `pit runtime --set [--default codex|claude] [--tier standard] [--timeout <sec>] [--max-turns N]
            [--repairs N] [--max-input-chars N] [--daily-budget <tokens>] [--network on|off]
            [--codex-model <m>] [--codex-effort minimal|low|medium|high|xhigh]
            [--claude-model <m>] [--claude-effort low|medium|high|xhigh|max]`
  const officialBins = official
    ? `
  PIT_KIMI_BIN      kimi binary for --runtime kimi (default: kimi on PATH, then ~/.kimi-code/bin/kimi)
  PIT_COMMAND_BIN   binary override for --runtime command (default: command.bin from pit runtime)`
    : ''
  return `pit ${DAEMON_VERSION} — Pit seat daemon (clean-room)

Usage:
  pit init --network <name|chainId> [--force]
                                  Generate Ed25519 device key under ${paths.home()} for an explicit network
                                  (supported: ${supportedNetworks()}; PIT_CHAIN_ID is accepted instead of --network)
  pit pair                        Start pairing, print the browser link, and wait for the wallet signature
  pit pair --sign --seat <id>     Start + sign with PIT_WALLET_PK (test only) + complete
  pit pair --complete --code --seat --sig --expires
  pit pair --status [--code]
  pit pair --watch --code         Poll until paired
  pit doctor [--live] [--runtime ${doctorRuntime}]
                                  One line per check with a fix: harness CLIs (installed, version, required flags,
                                  login) and the OS sandbox. --live sends one tiny prompt ("Reply with the single word
                                  OK") through that subscription CLI, inside the sandbox. It spends a little of your quota.
  pit start [--seat <id>] [--duration <sec>] [--stub|--no-stub] [--family claude,gpt] [--tier standard] [--no-reconnect]
            [--runtime ${startRuntime}]
                                  Public workers use a local subscription: --runtime codex (ChatGPT / Codex) or
                                  --runtime claude (Claude Code). DeepSeek is the official API: pit model --set --provider deepseek --model deepseek-flash|deepseek-v4-pro --api-key, then --runtime model.
                                  Reconnects with backoff + jitter when the socket drops (default).
                                  Agent CLIs need a one-time pit runtime --accept-terms.
                                  ${official ? '--runtime model is the official-seat API-key path (PIT_OFFICIAL=1).' : ''}
  pit runtime                     Show agent-CLI settings (runtime.json) and which CLIs are installed
  pit runtime --models            Official Codex and Claude Code models
  pit runtime --accept-terms      Read and accept the subscription / risk notice (once per machine)${commandHelp}
  ${runtimeSet}${modelHelp}
  pit usage [--since <unix sec>]  Token usage per model from usage.jsonl
  pit skills [--prompt <skill>]   List skills the daemon can run; print a T7 prompt template + output contract
  pit update                      Show update policy (auto-update off)
  pit update --check --version --hash --sig
  pit version | pit help

Env:
  PIT_HOME          config directory (default ~/.config/pit)
  PIT_API_URL       default ${DEFAULT_API_URL}
  PIT_CHAIN_ID      chain for pit init when --network is not given (must match --network if both are set)
  PIT_SEAT_CONTRACT seat address override on a supported chain (default: per-chain table, e.g. ${DEFAULT_CHAIN_ID}: ${DEFAULT_SEAT_CONTRACT})
  PIT_WALLET_PK     test-only wallet key for --sign (or SEPOLIA_DEPLOYER_PK)
  PIT_OFFICIAL      set to 1 on official seats to unlock the API-key runtime (not a public worker path)
  PIT_CODEX_BIN     codex binary for --runtime codex (path or command; default: codex on PATH)
  PIT_CLAUDE_BIN    claude binary for --runtime claude (default: claude on PATH)${officialBins}
                    Agent CLIs get a minimal env: wallet keys, PIT_* and unrelated API keys never reach them.

Docs: pair with the seat wallet, then pit start to accept offers and run skills (stub by default).`
}

function promptSecret(label: string): Promise<string> {
  const { stdin, stdout } = process
  if (!stdin.isTTY) {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      stdin.on('data', (c: Buffer | string) => chunks.push(typeof c === 'string' ? Buffer.from(c) : c))
      stdin.on('end', () => {
        const key = Buffer.concat(chunks).toString('utf8').split('\n')[0]?.trim() ?? ''
        if (!key) reject(new Error('empty api key'))
        else resolve(key)
      })
      stdin.resume()
    })
  }
  stdout.write(label)
  stdin.setRawMode?.(true)
  stdin.resume()
  stdin.setEncoding('utf8')
  return new Promise((resolve, reject) => {
    let buf = ''
    const onData = (chunk: string) => {
      if (chunk.includes('\u0003')) process.exit(1)
      if (chunk.includes('\n') || chunk.includes('\r')) {
        stdin.setRawMode?.(false)
        stdin.off('data', onData)
        stdout.write('\n')
        const key = buf.trim()
        if (!key) reject(new Error('empty api key'))
        else resolve(key)
        return
      }
      if (chunk === '\u007f' || chunk === '\b') buf = buf.slice(0, -1)
      else buf += chunk
    }
    stdin.on('data', onData)
  })
}

function argVal(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  if (i < 0 || i + 1 >= args.length) return undefined
  return args[i + 1]
}

function has(args: string[], name: string): boolean {
  return args.includes(name)
}

function walletPkFromEnv(): Hex | null {
  const raw = (process.env.PIT_WALLET_PK || process.env.SEPOLIA_DEPLOYER_PK || '').trim()
  if (!raw) return null
  if (!isHex(raw) || raw.length !== 66) throw new Error('PIT_WALLET_PK must be 0x + 64 hex')
  return raw as Hex
}

async function main(argv: string[]) {
  const [cmd, ...args] = argv
  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') {
    console.log(usage())
    return
  }
  if (cmd === 'version' || cmd === '-V' || cmd === '--version') {
    console.log(DAEMON_VERSION)
    return
  }

  if (cmd === 'skills') {
    const { STUB_SKILLS } = await import('./skill.ts')
    const { promptFor, T7_SKILLS } = await import('./review-skills.ts')
    const want = argVal(args, '--prompt')
    if (!want) {
      console.log(STUB_SKILLS.join('\n'))
      return
    }
    if (!(T7_SKILLS as readonly string[]).includes(want)) throw new Error(`no prompt template for ${want} (T7 skills: ${T7_SKILLS.join(', ')})`)
    console.log(promptFor(want as (typeof T7_SKILLS)[number], { title: '<objective from the job>', nodeKey: '<node>', focus: want === 'audit-specialist' ? '<focus>' : null, paths: ['<node paths>'], dependencies: [] }))
    return
  }
  if (cmd === 'model') {
    const { loadModelConfig, saveModelConfig, normalizeModelConfig, chatComplete, logUsage, modelConfigPath, saveModelKey, modelKeyPresent } = await import('./model.ts')
    if (has(args, '--models')) {
      console.log('deepseek-flash     DeepSeek-V4.1-Flash (default)')
      console.log('deepseek-v4-pro    DeepSeek-V4-Pro-0813')
      console.log('Retired and rejected: deepseek-chat, deepseek-reasoner (2026-07-24).')
      return
    }
    if (has(args, '--providers')) {
      if (!officialSeats()) throw new Error('Provider presets other than DeepSeek are for official Pit seats (PIT_OFFICIAL=1). Use pit model --models.')
      const { providerTable } = await import('./providers.ts')
      console.log(providerTable())
      console.log('Default models are starting points: pass --model with an exact id from your provider (Pit never substitutes one).')
      return
    }
    if (has(args, '--set')) {
      if (args.some((a) => a.startsWith('--api-key='))) throw new Error('--api-key does not take a value. It prompts so the key is not stored in shell history.')
      if (has(args, '--api-key')) {
        const nxt = args[args.indexOf('--api-key') + 1]
        if (nxt !== undefined && !nxt.startsWith('--')) throw new Error('--api-key does not take a value. It prompts so the key is not stored in shell history.')
      }
      const prev = (loadModelConfig() ?? {}) as Record<string, unknown>
      const provider = argVal(args, '--provider')
      if (provider !== undefined) {
        // Switching provider: the preset refills endpoint, model, family and key env unless given on this command line.
        for (const k of ['baseUrl', 'baseUrlEnv', 'model', 'cheapModel', 'keyEnv', 'family', 'runtime']) delete prev[k]
        prev.provider = provider
      }
      const api = argVal(args, '--api')
      if (api !== undefined) {
        if (api !== 'openai' && api !== 'anthropic') throw new Error('--api must be openai or anthropic')
        prev.runtime = `${api}-compat`
      } else if (prev.runtime === undefined && provider === undefined) prev.runtime = 'openai-compat'
      const pick = (flag: string, key: string, numeric = false) => {
        const v = argVal(args, flag)
        if (v !== undefined) prev[key] = numeric ? Number(v) : v
      }
      pick('--family', 'family')
      pick('--model', 'model')
      pick('--key-env', 'keyEnv')
      pick('--cheap-model', 'cheapModel')
      pick('--tier', 'tier')
      pick('--max-tokens', 'maxTokens', true)
      pick('--max-tokens-cap', 'maxTokensCap', true)
      pick('--max-input-chars', 'maxInputChars', true)
      pick('--timeout', 'timeoutSec', true)
      pick('--retries', 'retries', true)
      pick('--daily-budget', 'dailyTokenBudget', true)
      pick('--reasoning-effort', 'reasoningEffort')
      pick('--thinking', 'thinking')
      if (argVal(args, '--base-url') !== undefined) {
        prev.baseUrl = argVal(args, '--base-url')
        delete prev.baseUrlEnv
      }
      if (argVal(args, '--base-url-env') !== undefined) {
        prev.baseUrlEnv = argVal(args, '--base-url-env')
        delete prev.baseUrl
      }
      if (!officialSeats()) {
        for (const flag of ['--base-url', '--base-url-env', '--family', '--api', '--key-env']) {
          if (has(args, flag)) throw new Error(`${flag} is not a public option. DeepSeek uses https://api.deepseek.com and a prompted key.`)
        }
        if (String(prev.provider ?? '') !== 'deepseek') throw new Error('Public workers can only set --provider deepseek. Other providers need PIT_OFFICIAL=1.')
        if (prev.model === undefined) prev.model = 'deepseek-flash'
      }
      if (has(args, '--api-key')) {
        saveModelKey(await promptSecret('API key (input hidden): '))
        prev.keyFile = 'model.key'
      }
      const saved = normalizeModelConfig(prev)
      if (!officialSeats()) {
        const { assertPublicDeepseek } = await import('./official-models.ts')
        assertPublicDeepseek(saved)
      }
      saveModelConfig(saved)
      console.log(`saved ${modelConfigPath()}`)
    }
    const cfg = loadModelConfig()
    if (cfg && !officialSeats()) {
      const { assertPublicDeepseek } = await import('./official-models.ts')
      assertPublicDeepseek(cfg)
    }
    if (!cfg) {
      console.log('no model config (pit model --set --provider deepseek --model deepseek-flash --api-key)')
      return
    }
    const envState = (n?: string) => (n ? `${n} (${process.env[n]?.trim() ? 'set' : 'MISSING'})` : '-')
    console.log(`api:       ${cfg.runtime}${cfg.provider ? ` (preset ${cfg.provider})` : ''}`)
    console.log(`family:    ${cfg.family}`)
    console.log(`model:     ${cfg.model}${cfg.cheapModel ? ` (economy nodes: ${cfg.cheapModel})` : ''}`)
    console.log(`tier:      ${cfg.tier}`)
    console.log(`base url:  ${cfg.baseUrl ?? `env ${envState(cfg.baseUrlEnv)}`}`)
    console.log(`key:       ${cfg.keyFile ? `file ${cfg.keyFile} (${modelKeyPresent() ? 'set' : 'MISSING'})` : `env ${envState(cfg.keyEnv)}`}`)
    console.log(`limits:    maxTokens ${cfg.maxTokens} (cap ${cfg.maxTokensCap}), input ${cfg.maxInputChars} chars, timeout ${cfg.timeoutSec}s, retries ${cfg.retries}, daily budget ${cfg.dailyTokenBudget || 'none'} tokens`)
    if (cfg.reasoningEffort || cfg.thinking) console.log(`reasoning: ${[cfg.reasoningEffort ? `effort ${cfg.reasoningEffort}` : '', cfg.thinking ? `thinking ${cfg.thinking}` : ''].filter(Boolean).join(', ')}`)
    if (has(args, '--test')) {
      const r = await chatComplete(cfg, [{ role: 'user', content: 'Reply with exactly: OK' }], { maxTokens: 400 })
      logUsage({ at: Math.floor(Date.now() / 1000), seatId: loadConfig().seatId, family: cfg.family, model: r.model, skill: 'ping', leaseId: null, jobId: null, promptTokens: r.usage.promptTokens, completionTokens: r.usage.completionTokens, totalTokens: r.usage.totalTokens, reasoningTokens: r.usage.reasoningTokens, cachedTokens: r.usage.cachedTokens, ms: r.ms, ok: true })
      console.log(`test:      ${r.model} answered ${JSON.stringify(r.text.trim().slice(0, 20))} · ${r.usage.promptTokens}+${r.usage.completionTokens} tokens · ${r.ms} ms`)
    }
    return
  }

  if (cmd === 'runtime') {
    const ac = await import('./agent-cli.ts')
    if (!officialSeats()) {
      for (const flag of ['--claude-provider', '--claude-base-url', '--claude-key-env', '--kimi-model', '--set-command', '--accept-command-terms']) {
        if (has(args, flag) || args.some((a) => a.startsWith(`${flag}=`))) throw new Error(`${flag} is not a public worker option. Use a Codex or Claude subscription, or the official DeepSeek API. This needs PIT_OFFICIAL=1.`)
      }
      const def = argVal(args, '--default')
      if (def === 'kimi' || def === 'command' || def === 'local') throw new Error(`--default ${def} is not a public worker option. Use codex or claude.`)
    }
    if (has(args, '--accept-terms')) {
      console.log(ac.TERMS_NOTICE)
      const prev = ac.loadAgentConfig()
      prev.termsAcceptedAt = Math.floor(Date.now() / 1000)
      ac.saveAgentConfig(prev)
      console.log(`\naccepted; recorded in ${ac.agentConfigPath()}`)
    }
    if (has(args, '--accept-command-terms')) {
      console.log(ac.COMMAND_TERMS_NOTICE)
      const prev = ac.loadAgentConfig()
      prev.commandTermsAcceptedAt = Math.floor(Date.now() / 1000)
      ac.saveAgentConfig(prev)
      console.log(`\ncommand adapter accepted; recorded in ${ac.agentConfigPath()}`)
    }
    if (has(args, '--models')) {
      const { CODEX_MODELS, CLAUDE_MODELS, modelList } = await import('./official-models.ts')
      console.log('Codex:')
      console.log(modelList(CODEX_MODELS))
      console.log('Claude Code:')
      console.log(modelList(CLAUDE_MODELS))
      return
    }
    if (has(args, '--set')) {
      const prev = ac.loadAgentConfig() as unknown as Record<string, unknown>
      const pick = (flag: string, key: string, numeric = false) => {
        const v = argVal(args, flag)
        if (v !== undefined) prev[key] = numeric ? Number(v) : v
      }
      pick('--default', 'default')
      pick('--tier', 'tier')
      pick('--timeout', 'timeoutSec', true)
      pick('--max-turns', 'maxTurns', true)
      pick('--repairs', 'repairs', true)
      pick('--max-input-chars', 'maxInputChars', true)
      pick('--daily-budget', 'dailyTokenBudget', true)
      pick('--codex-model', 'codexModel')
      pick('--codex-effort', 'codexEffort')
      pick('--claude-model', 'claudeModel')
      pick('--claude-effort', 'claudeEffort')
      pick('--claude-key-env', 'claudeKeyEnv')
      pick('--claude-base-url', 'claudeBaseUrl')
      pick('--kimi-model', 'kimiModel')
      const cp = argVal(args, '--claude-provider')
      if (cp !== undefined) {
        if (!officialSeats()) throw new Error('--claude-provider points Claude Code at an API key. Public workers use the Claude subscription (omit this flag).')
        if (cp === 'none' || cp === '') for (const k of ['claudeProvider', 'claudeKeyEnv', 'claudeBaseUrl']) delete prev[k]
        else prev.claudeProvider = cp
      }
      const sc = argVal(args, '--set-command')
      if (sc !== undefined) {
        try {
          prev.command = JSON.parse(sc)
        } catch {
          throw new Error('--set-command needs a JSON object (see pit help)')
        }
      }
      if (has(args, '--clear-command')) delete prev.command
      const net = argVal(args, '--network')
      if (net !== undefined) {
        if (net !== 'on' && net !== 'off') throw new Error('--network must be on or off')
        prev.network = net === 'on'
      }
      ac.saveAgentConfig(ac.normalizeAgentConfig(prev))
      console.log(`saved ${ac.agentConfigPath()}`)
    }
    const cfg = ac.loadAgentConfig()
    const shown = officialSeats() ? ac.AGENT_KINDS : (['codex', 'claude'] as const)
    for (const k of shown) {
      if (k === 'command' && !cfg.command) {
        console.log(`${k.padEnd(8)}not configured (pit runtime --set --set-command '<json>')`)
        continue
      }
      let fam = '?'
      try {
        fam = ac.harnessFamily(k, cfg)
      } catch (e) {
        fam = `invalid: ${(e as Error).message}`
      }
      console.log(`${k.padEnd(8)}${ac.agentBin(k, process.env, cfg) ?? 'not installed'} (${ac.harnessLabel(k, cfg)}, family ${fam}, model ${ac.configuredModel(k, cfg) ?? 'cli default'})`)
    }
    console.log(`default: ${cfg.default ?? `first installed of ${ac.LOCAL_ORDER.join(', ')} (not set)`}`)
    console.log(`tier:    ${cfg.tier}`)
    console.log(`limits:  timeout ${cfg.timeoutSec}s per lease, max turns ${cfg.maxTurns} (claude), repairs ${cfg.repairs}, input ${cfg.maxInputChars} chars, daily budget ${cfg.dailyTokenBudget || 'none'} tokens`)
    console.log(`network: ${cfg.network ? 'on' : 'off'} for sandboxed commands`)
    if (cfg.codexEffort || cfg.claudeEffort) console.log(`effort:  ${[cfg.codexEffort ? `codex ${cfg.codexEffort}` : '', cfg.claudeEffort ? `claude ${cfg.claudeEffort}` : ''].filter(Boolean).join(', ')}`)
    if (cfg.claudeProvider) {
      const keyEnv = cfg.claudeKeyEnv ?? (await import('./providers.ts')).PROVIDERS[cfg.claudeProvider]!.keyEnv
      console.log(`claude:  via ${cfg.claudeProvider}${cfg.claudeBaseUrl ? ` (${cfg.claudeBaseUrl})` : ''}, key env ${keyEnv} (${process.env[keyEnv]?.trim() ? 'set' : 'MISSING'})`)
    }
    if (cfg.command) console.log(`command: ${cfg.command.name}: ${cfg.command.bin} ${cfg.command.args.join(' ')} (prompt ${cfg.command.prompt}, output ${cfg.command.output}${cfg.command.passEnv?.length ? `, env ${cfg.command.passEnv.join(',')}` : ''})`)
    console.log(`terms:   ${ac.termsAccepted(cfg) ? `accepted ${new Date(cfg.termsAcceptedAt! * 1000).toISOString()}` : 'NOT accepted (pit runtime --accept-terms)'}`)
    return
  }

  if (cmd === 'usage') {
    const { readUsage, usageTotals } = await import('./model.ts')
    const since = Number(argVal(args, '--since') ?? 0) || 0
    const totals = usageTotals(readUsage(), since)
    if (!Object.keys(totals).length) console.log('no model usage recorded')
    for (const [m, t] of Object.entries(totals)) console.log(`${m.padEnd(22)} calls=${t.calls} prompt=${t.promptTokens} completion=${t.completionTokens} total=${t.totalTokens}${t.reasoningTokens ? ` reasoning=${t.reasoningTokens}` : ''}${t.cachedTokens ? ` cached=${t.cachedTokens}` : ''}`)
    return
  }

  if (cmd === 'init') {
    if (has(args, '--network') && !argVal(args, '--network')) throw new Error('--network needs a value (name or chain id)')
    const { device, created, config } = await initDevice(has(args, '--force'), {
      network: argVal(args, '--network'),
      envChainId: process.env.PIT_CHAIN_ID,
      envSeatContract: process.env.PIT_SEAT_CONTRACT,
    })
    console.log(created ? 'device key created' : 'device key already present')
    console.log(`home:    ${paths.home()}`)
    console.log(`public:  ${device.publicKey}`)
    console.log(`api:     ${config.apiUrl}`)
    console.log(`chain:   ${config.chainId}`)
    console.log(`seat:    ${config.seatContract}`)
    console.log('(private key written with mode 0600 — never share it)')
    return
  }

  if (cmd === 'doctor') {
    requireDevice()
    const report = runDoctor()
    for (const r of report.runtimes) {
      console.log(
        `${r.id.padEnd(8)} available=${r.available} smoke=${r.smoke} premium=${r.premiumModel ? `${r.premiumModel.model}/${r.premiumModel.effort}` : '-'} version=${r.version ?? '-'}`,
      )
    }
    for (const n of report.notes) console.log(`note: ${n}`)
    const ac = await import('./agent-cli.ts')
    const acfg = ac.loadAgentConfig()
    const only = argVal(args, '--runtime')
    const doctorKinds = officialSeats() ? ac.AGENT_KINDS : (['codex', 'claude'] as const)
    if (only !== undefined && only !== 'model' && !(doctorKinds as readonly string[]).includes(only)) {
      throw new Error(officialSeats() ? '--runtime must be codex, claude, kimi, command or model' : '--runtime must be codex, claude or model')
    }
    const live = has(args, '--live')
    if (live) console.log('live check: sending "Reply with the single word OK" through each configured runtime (spends a few tokens of your subscription / API credit)')
    let bad = false
    const line = (ok: boolean | null, name: string, what: string, fix?: string) => console.log(`${ok === null ? '-' : ok ? 'ok' : 'FAIL'}  ${name.padEnd(9)} ${what}${fix ? `  fix: ${fix}` : ''}`)
    for (const k of doctorKinds) {
      if (only && k !== only) continue
      if (k === 'command' && !acfg.command) {
        if (only) {
          line(false, k, 'not configured', "pit runtime --set --set-command '<json>'")
          bad = true
        }
        continue
      }
      const p = await ac.probeAgent(k, { live, cfg: acfg })
      if (!p.bin) {
        line(only ? false : null, p.name, 'not installed', p.hints[0])
        if (only) bad = true
        continue
      }
      line(Boolean(p.version), p.name, `${p.bin} version ${p.version ?? '?'} (family ${p.family}, model ${p.model ?? 'cli default'})`)
      if (p.missingFlags.length) line(false, p.name, `flags missing: ${p.missingFlags.join(', ')}`, p.hints.find((h) => h.includes('lacks')))
      else if (k !== 'command') line(true, p.name, 'required flags present')
      if (p.loggedIn !== null || p.loginDetail) line(p.loggedIn, p.name, `login ${p.loggedIn === null ? 'unknown' : p.loggedIn ? 'yes' : 'NO'}${p.loginDetail ? ` (${p.loginDetail})` : ''}`, p.loggedIn === false ? ac.fixHint(k, 'auth', acfg) : undefined)
      if (p.live) line(p.live.ok, p.name, p.live.ok ? `live test answered ${JSON.stringify(p.live.answer)} (${p.live.tokens} tokens, model ${p.live.model ?? 'cli default'}, ${p.live.ms} ms)` : `live test FAILED${p.live.failKind ? ` (${p.live.failKind})` : ''}: ${p.live.error ?? `answer ${JSON.stringify(p.live.answer)}`}`, p.live.ok ? undefined : p.live.failKind ? ac.fixHint(k, p.live.failKind, acfg) : 'check its model settings')
      for (const h of p.hints.filter((h) => h.startsWith('configured model'))) line(false, p.name, h)
      if (p.missingFlags.length || p.loggedIn === false || (p.live && !p.live.ok) || !p.version) bad = true
    }
    if (!only || only === 'model') {
      const { loadModelConfig, resolveEndpoint, chatComplete } = await import('./model.ts')
      let mc: import('./model.ts').ModelConfig | null = null
      try {
        mc = loadModelConfig()
      } catch (e) {
        line(false, 'model', `model.json invalid: ${(e as Error).message}`, 'pit model --set ...')
        bad = true
      }
      if (mc) {
        let endpointOk = false
        try {
          if (!officialSeats()) {
            const { assertPublicDeepseek } = await import('./official-models.ts')
            assertPublicDeepseek(mc)
          }
          const ep = resolveEndpoint(mc)
          endpointOk = true
          line(true, 'model', `${mc.runtime} ${new URL(ep.baseUrl).host} model ${mc.model} (family ${mc.family}), ${mc.keyFile ? 'key file ' + mc.keyFile : 'key env ' + mc.keyEnv} set`)
        } catch (e) {
          line(false, 'model', (e as Error).message, `export ${mc.keyEnv} (and the base URL env if used) in the daemon's environment`)
          bad = true
        }
        if (live && endpointOk) {
          try {
            const r = await chatComplete(mc, [{ role: 'user', content: 'Reply with the single word OK' }], { maxTokens: 400 })
            const ok = /\bOK\b/i.test(r.text)
            line(ok, 'model', `live test answered ${JSON.stringify(r.text.trim().slice(0, 40))} (${r.usage.totalTokens} tokens, model ${r.model}, ${r.ms} ms)`, ok ? undefined : 'check the model id')
            if (r.model && !r.model.toLowerCase().includes(mc.model.toLowerCase().split('/').at(-1)!)) line(false, 'model', `asked for ${mc.model} but the provider answered as ${r.model}`, 'use an exact model id from the provider (Pit claims what it asked for)')
            if (!ok) bad = true
          } catch (e) {
            const st = (e as { status?: number }).status
            line(false, 'model', `live test FAILED: ${(e as Error).message}`, st === 401 || st === 403 ? `check the key in ${mc.keyEnv}` : st === 404 ? 'check the model id and base URL' : st === 429 ? 'rate limited or out of credit; retry later' : 'check the base URL and network')
            bad = true
          }
        }
      } else if (only === 'model') {
        line(false, 'model', 'no model config', 'pit model --set --provider <id> (pit model --providers)')
        bad = true
      }
    }
    line(ac.termsAccepted(acfg), 'terms', ac.termsAccepted(acfg) ? 'subscription / risk notice accepted' : 'subscription / risk notice not accepted (agent CLIs will not start)', ac.termsAccepted(acfg) ? undefined : 'pit runtime --accept-terms')
    line(ac.commandTermsAccepted(acfg) || !acfg.command, 'command', acfg.command ? (ac.commandTermsAccepted(acfg) ? 'unsandboxed command adapter acknowledged' : 'command adapter configured but its extra notice is not accepted') : 'not configured', acfg.command && !ac.commandTermsAccepted(acfg) ? 'pit runtime --accept-command-terms' : undefined)
    {
      const { sandboxHidesHome, OPS_BOX_WARNING } = await import('./sandbox.ts')
      const sb = sandboxHidesHome()
      line(sb.ok, 'sandbox', sb.detail, sb.ok ? undefined : 'install bubblewrap (apt install bubblewrap) or run on macOS with sandbox-exec')
      line(true, 'forge', 'harness children get FOUNDRY_FFI=false and FOUNDRY_FS_PERMISSIONS=read; a foundry.toml with ffi = true is not collected')
      console.log(`note: ${OPS_BOX_WARNING}`)
      if (!sb.ok) bad = true
    }
    if (!live) console.log('note: login and quota are only proven by a real prompt: pit doctor --live')
    if (bad) process.exitCode = 1
    return
  }

  if (cmd === 'update') {
    if (has(args, '--check')) {
      const version = argVal(args, '--version')
      const hash = argVal(args, '--hash')
      const sig = argVal(args, '--sig')
      if (!version || !hash || !sig) throw new Error('update --check needs --version --hash --sig')
      console.log(await cmdUpdate({ check: { version, archiveHash: hash, signature: sig } }))
    } else {
      console.log(await cmdUpdate({}))
    }
    return
  }

  if (cmd === 'pair') {
    const cfg = loadConfig()
    requireDevice()

    if (has(args, '--status')) {
      const code = argVal(args, '--code')
      console.log(JSON.stringify(await pairStatus(cfg, { code }), null, 2))
      return
    }

    if (has(args, '--watch')) {
      const code = argVal(args, '--code')
      if (!code) throw new Error('--watch needs --code')
      const ok = await pairWatch(cfg, code)
      console.log(ok ? 'paired' : 'not paired (timeout or expired)')
      return
    }

    if (has(args, '--complete')) {
      const code = argVal(args, '--code')
      const seat = Number(argVal(args, '--seat'))
      const sig = argVal(args, '--sig') as Hex
      const expires = Number(argVal(args, '--expires'))
      if (!code || !seat || !sig || !expires) throw new Error('--complete needs --code --seat --sig --expires')
      const out = await pairComplete(cfg, { pairCode: code, seatId: seat, signature: sig, expiresAt: expires })
      console.log(JSON.stringify(out, null, 2))
      return
    }

    if (has(args, '--sign')) {
      const seat = Number(argVal(args, '--seat'))
      if (!Number.isInteger(seat) || seat < 1) throw new Error('--sign needs --seat <id>')
      const pk = walletPkFromEnv()
      if (!pk) throw new Error('set PIT_WALLET_PK (or SEPOLIA_DEPLOYER_PK) for --sign')
      const started = await pairStart(cfg)
      console.log(printPairInstructions(started, seat))
      const signature = await signAuthorization({
        walletPk: pk,
        chainId: started.chainId,
        seatId: seat,
        devicePubKey: started.devicePubKey as Hex,
        nonce: started.nonce,
        expiresAt: started.expiresAt,
        domain: started.eip712.domain,
        types: started.eip712.types,
      })
      const out = await pairComplete(cfg, {
        pairCode: started.pairCode,
        seatId: seat,
        signature,
        expiresAt: started.expiresAt,
      })
      console.log('paired', JSON.stringify(out))
      return
    }

    // default: print the browser link and wait. The page posts the signature; this process only polls status.
    const started = await pairStart(cfg)
    const seatHint = Number(argVal(args, '--seat')) || cfg.seatId || undefined
    console.log(printPairInstructions(started, seatHint ?? undefined))
    const waitSec = Math.max(1, started.expiresAt - Math.floor(Date.now() / 1000))
    const ok = await pairWatch(cfg, started.pairCode, waitSec)
    console.log(ok ? 'paired' : 'not paired (timeout or expired)')
    if (!ok) process.exitCode = 1
    return
  }

  if (cmd === 'start') {
    {
      const runtimeEarly = argVal(args, '--runtime') || 'stub'
      const earlyOk = officialSeats()
        ? ['stub', 'model', 'codex', 'claude', 'kimi', 'command', 'local']
        : ['stub', 'codex', 'claude', 'model']
      if (!earlyOk.includes(runtimeEarly)) {
        throw new Error(
          officialSeats()
            ? '--runtime must be stub, model, codex, claude, kimi, command or local'
            : `--runtime ${runtimeEarly} is not a public worker option. Use stub, codex, claude (subscription, no provider) or model (official DeepSeek API only).`,
        )
      }
    }
    {
      // Refuse to run against a config written for an unsupported chain or with no seat address (older CLI versions).
      const c = loadConfig()
      assertSupportedChain(c.chainId, 'config.json chainId')
      if (!c.seatContract) throw new Error('config.json has no seatContract: re-run pit init --network <name|chainId> --force')
    }
    const seat = argVal(args, '--seat') ? Number(argVal(args, '--seat')) : undefined
    const duration = argVal(args, '--duration') ? Number(argVal(args, '--duration')) : 0
    const stub = has(args, '--no-stub') ? false : true
    const families = (argVal(args, '--family') || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
    const tier = argVal(args, '--tier') || undefined
    const runtime = argVal(args, '--runtime') || 'stub'
    const harnesses = officialSeats() ? ['codex', 'claude', 'kimi', 'command', 'local'] : ['codex', 'claude']
    const allowed = officialSeats() ? ['stub', 'model', ...harnesses] : ['stub', 'codex', 'claude', 'model']
    if (!allowed.includes(runtime)) {
      throw new Error(
        officialSeats()
          ? '--runtime must be stub, model, codex, claude, kimi, command or local'
          : `--runtime ${runtime} is not a public worker option. Use stub, codex, claude (subscription, no provider) or model (official DeepSeek API only).`,
      )
    }
    let agent: import('./start.ts').StartOptions['agent']
    if (harnesses.includes(runtime)) {
      const ac = await import('./agent-cli.ts')
      const cfg = ac.loadAgentConfig()
      if (!officialSeats() && (cfg.claudeProvider || cfg.claudeBaseUrl || cfg.claudeKeyEnv || cfg.kimiModel || cfg.command)) {
        throw new Error('runtime.json sets a provider, kimi model, or command adapter. Public claude is the Claude subscription only (no claudeProvider). Remove those fields or set PIT_OFFICIAL=1.')
      }
      if (!ac.termsAccepted(cfg)) throw new Error(`${ac.TERMS_NOTICE}\n\nRun pit runtime --accept-terms once to continue.`)
      const kind = runtime === 'local' ? ac.pickAgent(cfg) : (runtime as import('./agent-cli.ts').AgentKind)
      if (kind === 'command' && !ac.commandTermsAccepted(cfg)) throw new Error(`${ac.COMMAND_TERMS_NOTICE}`)
      if (kind !== 'command') {
        const { sandboxProgram, OPS_BOX_WARNING } = await import('./sandbox.ts')
        if (!sandboxProgram()) throw new Error(`no OS sandbox (bwrap on Linux, sandbox-exec on macOS); refusing to start ${kind}. ${OPS_BOX_WARNING}`)
        console.error(OPS_BOX_WARNING)
      }
      const bin = ac.agentBin(kind, process.env, cfg)
      if (!bin) throw new Error(`${kind} not found: ${ac.fixHint(kind, 'missing')}`)
      const fam = ac.harnessFamily(kind, cfg)
      if (families.length && (families.length !== 1 || families[0] !== fam)) throw new Error(`--family must match the ${kind} family (${fam}) or be omitted`)
      if (tier) throw new Error('--tier is set with pit runtime --set --tier for agent CLIs')
      agent = { kind, bin, cfg, sandbox: kind !== 'command' }
    }
    let model: import('./model.ts').ModelConfig | undefined
    if (runtime === 'model') {
      const { loadModelConfig, resolveEndpoint } = await import('./model.ts')
      const cfg = loadModelConfig()
      if (!cfg) throw new Error('--runtime model needs a model config (pit model --set --provider deepseek --api-key)')
      if (!officialSeats()) {
        const { assertPublicDeepseek } = await import('./official-models.ts')
        assertPublicDeepseek(cfg)
      }
      resolveEndpoint(cfg) // fail fast when the key is missing (the value is never printed)
      if (families.length && (families.length !== 1 || families[0] !== cfg.family)) throw new Error(`--family must match the model family (${cfg.family}) or be omitted`)
      const { loadAgentConfig, termsAccepted, TERMS_NOTICE } = await import('./agent-cli.ts')
      if (!termsAccepted(loadAgentConfig())) console.error(`${TERMS_NOTICE}\n(accept once with pit runtime --accept-terms to hide this)\n`)
      model = cfg
    }
    const res = await startDaemon({ seatId: seat, durationSec: duration, probe: !has(args, '--no-probe'), stub, families, maxTier: tier, reconnect: !has(args, '--no-reconnect'), model, agent })
    console.log(`daemon stopped after ${res.sessions} session(s): ${res.reason}`)
    // A fatal disconnect (revoked, duplicate session, ...) or exhausted retries is an error exit; signal / duration is not.
    if (res.reason !== 'stopped' && res.reason !== 'duration') process.exit(2)
    return
  }

  throw new Error(`unknown command: ${cmd}\n\n${usage()}`)
}

const argv = process.argv.slice(2)
main(argv).catch((err) => {
  console.error(`pit: ${(err as Error).message}`)
  process.exit(1)
})
