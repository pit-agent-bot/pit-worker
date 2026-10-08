import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NETWORKS, resolveNetwork } from '../src/networks.ts'

const SEPOLIA = 11155111
const BIN = join(import.meta.dirname, '..', 'bin', 'pit.js')

function pit(args: string[], env: Record<string, string | undefined>, home: string) {
  const e: Record<string, string | undefined> = { ...process.env, PIT_HOME: home, PIT_CHAIN_ID: undefined, PIT_SEAT_CONTRACT: undefined, ...env }
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k]
  return spawnSync(process.execPath, [BIN, ...args], { env: e as NodeJS.ProcessEnv, encoding: 'utf8' })
}

describe('resolveNetwork', () => {
  it('accepts a supported chain by name or id, from --network or PIT_CHAIN_ID', () => {
    const want = { chainId: SEPOLIA, seatContract: NETWORKS[SEPOLIA].seatContract }
    expect(resolveNetwork({ network: 'sepolia' })).toEqual(want)
    expect(resolveNetwork({ network: String(SEPOLIA) })).toEqual(want)
    expect(resolveNetwork({ envChainId: String(SEPOLIA) })).toEqual(want)
    expect(resolveNetwork({ network: 'Sepolia', envChainId: String(SEPOLIA) })).toEqual(want)
  })
  it('requires an explicit network', () => {
    expect(() => resolveNetwork({})).toThrow(/no network selected/)
  })
  it('rejects unsupported chain ids', () => {
    expect(() => resolveNetwork({ envChainId: '1' })).toThrow(/unsupported chain 1 /)
    expect(() => resolveNetwork({ network: '999' })).toThrow(/unsupported chain 999 /)
  })
  it('rejects non-numeric, unknown values', () => {
    expect(() => resolveNetwork({ envChainId: 'abc' })).toThrow(/invalid PIT_CHAIN_ID "abc"/)
    expect(() => resolveNetwork({ network: 'mainnet' })).toThrow(/invalid --network "mainnet"/)
  })
  it('rejects a flag/env mismatch and a malformed seat override', () => {
    expect(() => resolveNetwork({ network: 'sepolia', envChainId: '1' })).toThrow(/disagree/)
    expect(() => resolveNetwork({ network: 'sepolia', envSeatContract: '0x1234' })).toThrow(/invalid PIT_SEAT_CONTRACT/)
    const seat = '0x' + 'ab'.repeat(20)
    expect(resolveNetwork({ network: 'sepolia', envSeatContract: seat }).seatContract).toBe(seat)
  })
})

describe('pit init (CLI process)', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'pit-net-'))
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it.each([
    [['init'], {}, /no network selected/],
    [['init'], { PIT_CHAIN_ID: '1' }, /unsupported chain 1 /],
    [['init'], { PIT_CHAIN_ID: '999' }, /unsupported chain 999 /],
    [['init'], { PIT_CHAIN_ID: 'abc' }, /invalid PIT_CHAIN_ID "abc"/],
    [['init', '--network', '1'], {}, /unsupported chain 1 /],
    [['init', '--network'], {}, /--network needs a value/],
  ] as const)('%j with %j exits non-zero and writes nothing', (args, env, msg) => {
    const r = pit([...args], env, home)
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(msg)
    expect(existsSync(join(home, 'config.json'))).toBe(false)
    expect(existsSync(join(home, 'device.json'))).toBe(false)
  })

  it('init --network sepolia writes the Sepolia seat contract', () => {
    const r = pit(['init', '--network', 'sepolia'], {}, home)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain(`chain:   ${SEPOLIA}`)
    const cfg = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))
    expect(cfg.chainId).toBe(SEPOLIA)
    expect(cfg.seatContract).toBe(NETWORKS[SEPOLIA].seatContract)
  })
})
