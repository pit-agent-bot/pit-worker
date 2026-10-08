import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { DEFAULT_API_URL, DEFAULT_CHAIN_ID, DAEMON_VERSION } from './defaults.ts'
import { resolveNetwork, seatContractFor, type NetworkInput } from './networks.ts'
import { paths } from './paths.ts'
import { ed25519Keygen, hexToBytes, type Hex32 } from './protocol.ts'

export interface PitConfig {
  apiUrl: string
  chainId: number
  seatContract: string
  seatId: number | null
  pairedAt: number | null
  daemonVersion: string
  autoUpdate: false
}

export interface DeviceFile {
  version: 1
  /** Ed25519 public key 0x + 64 hex */
  publicKey: Hex32
  /** Ed25519 private key 0x + 64 hex — never print, mode 0600 */
  privateKey: Hex32
  createdAt: string
}

/** Defaults for a missing config file. The network is only chosen explicitly, by `pit init --network` (see initDevice). */
const defaultConfig = (): PitConfig => ({
  apiUrl: process.env.PIT_API_URL?.trim() || DEFAULT_API_URL,
  chainId: DEFAULT_CHAIN_ID,
  seatContract: seatContractFor(DEFAULT_CHAIN_ID),
  seatId: null,
  pairedAt: null,
  daemonVersion: DAEMON_VERSION,
  autoUpdate: false,
})

function ensureHome() {
  const home = paths.home()
  if (!existsSync(home)) mkdirSync(home, { recursive: true, mode: 0o700 })
  try {
    chmodSync(home, 0o700)
  } catch {
    /* ignore on platforms that ignore mode */
  }
}

export function loadConfig(): PitConfig {
  ensureHome()
  if (!existsSync(paths.config())) return defaultConfig()
  const raw = JSON.parse(readFileSync(paths.config(), 'utf8')) as Partial<PitConfig>
  return { ...defaultConfig(), ...raw, autoUpdate: false }
}

export function saveConfig(cfg: PitConfig) {
  ensureHome()
  writeFileSync(paths.config(), JSON.stringify({ ...cfg, autoUpdate: false }, null, 2) + '\n', { mode: 0o600 })
  try {
    chmodSync(paths.config(), 0o600)
  } catch {
    /* ignore */
  }
}

export function loadDevice(): DeviceFile | null {
  if (!existsSync(paths.device())) return null
  return JSON.parse(readFileSync(paths.device(), 'utf8')) as DeviceFile
}

export function requireDevice(): DeviceFile {
  const d = loadDevice()
  if (!d?.publicKey || !d?.privateKey) throw new Error('no device key — run: pit init --network sepolia')
  return d
}

export function devicePrivateKeyBytes(d: DeviceFile): Uint8Array {
  return hexToBytes(d.privateKey)
}

/**
 * Create the device key and write config for an explicitly chosen network. The network is resolved first, so an
 * unknown / unsupported / malformed chain fails before anything is written.
 */
export async function initDevice(
  force = false,
  net: NetworkInput = { envChainId: process.env.PIT_CHAIN_ID, envSeatContract: process.env.PIT_SEAT_CONTRACT },
): Promise<{ config: PitConfig; device: DeviceFile; created: boolean }> {
  const { chainId, seatContract } = resolveNetwork(net)
  ensureHome()
  let created = false
  let device = loadDevice()
  if (device && !force) throw new Error('device already exists (pass --force to rotate)')
  if (!device || force) {
    const kg = await ed25519Keygen()
    device = {
      version: 1,
      publicKey: kg.publicKey,
      privateKey: kg.privateKeyHex,
      createdAt: new Date().toISOString(),
    }
    writeFileSync(paths.device(), JSON.stringify(device, null, 2) + '\n', { mode: 0o600 })
    try {
      chmodSync(paths.device(), 0o600)
    } catch {
      /* ignore */
    }
    created = true
  }
  const config: PitConfig = { ...loadConfig(), chainId, seatContract }
  saveConfig(config)
  return { config, device, created }
}
