/**
 * Per-chain address table (the only place contract addresses live in cli/src).
 * Mainnet is intentionally absent until it is deployed. PIT_SEAT_CONTRACT can override the seat address on a
 * supported chain, but an unsupported chain is always an error.
 */
export interface NetworkConfig {
  name: string
  seatContract: `0x${string}`
}

export const NETWORKS: Record<number, NetworkConfig> = {
  11155111: { name: 'sepolia', seatContract: '0x276F3d2EDE3Ae023eaA83d3fE50C3F99a06B3b3C' },
}

/** PitSeat address for a chain, or '' when the chain has no known deployment. */
export const seatContractFor = (chainId: number): string => NETWORKS[chainId]?.seatContract ?? ''

export const supportedNetworks = (): string =>
  Object.entries(NETWORKS)
    .map(([id, n]) => `${n.name} (${id})`)
    .join(', ')

/** Parse a network given as a name ("sepolia") or a numeric chain id ("11155111"). Throws on anything else. */
export function parseNetwork(value: string, source: string): number {
  const v = value.trim().toLowerCase()
  if (/^\d+$/.test(v)) return Number(v)
  const hit = Object.entries(NETWORKS).find(([, n]) => n.name === v)
  if (hit) return Number(hit[0])
  throw new Error(`invalid ${source} "${value}": expected a network name or a numeric chain id. Supported: ${supportedNetworks()}`)
}

/** Throw unless the chain id is in the table. */
export function assertSupportedChain(chainId: number, source: string): void {
  if (!NETWORKS[chainId]) {
    throw new Error(`unsupported chain ${chainId} (${source}): no known seat contract. Use a supported network: ${supportedNetworks()}`)
  }
}

export interface NetworkInput {
  /** --network flag value */
  network?: string
  /** PIT_CHAIN_ID env value */
  envChainId?: string
  /** PIT_SEAT_CONTRACT env value */
  envSeatContract?: string
}

/**
 * Resolve the chain for `pit init`. The network must be explicit (--network or PIT_CHAIN_ID); the two must agree
 * when both are set; the chain must be supported; a PIT_SEAT_CONTRACT override must be a 0x + 40 hex address.
 */
export function resolveNetwork(input: NetworkInput): { chainId: number; seatContract: string } {
  const flag = input.network?.trim() ? parseNetwork(input.network, '--network') : undefined
  const env = input.envChainId?.trim() ? parseNetwork(input.envChainId, 'PIT_CHAIN_ID') : undefined
  if (flag === undefined && env === undefined) {
    throw new Error(`no network selected: pass --network <name|chainId> (or set PIT_CHAIN_ID). Supported: ${supportedNetworks()}`)
  }
  if (flag !== undefined && env !== undefined && flag !== env) {
    throw new Error(`--network (${flag}) and PIT_CHAIN_ID (${env}) disagree: set only one, or make them match`)
  }
  const chainId = (flag ?? env) as number
  assertSupportedChain(chainId, flag !== undefined ? '--network' : 'PIT_CHAIN_ID')
  const override = input.envSeatContract?.trim()
  if (override && !/^0x[0-9a-fA-F]{40}$/.test(override)) {
    throw new Error('invalid PIT_SEAT_CONTRACT: expected 0x followed by 40 hex characters')
  }
  return { chainId, seatContract: override || seatContractFor(chainId) }
}
