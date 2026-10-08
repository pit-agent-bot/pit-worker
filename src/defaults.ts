import { seatContractFor } from './networks.ts'

/** Default Sepolia rehearsal targets (PIT-SYSTEM-DESIGN / go-live). Override via env or config. */
export const DAEMON_VERSION = '0.1.0+t11b'
export const DEFAULT_API_URL = 'https://api.pitagent.fun'
export const DEFAULT_CHAIN_ID = 11155111
/** Seat contract for DEFAULT_CHAIN_ID, read from the per-chain table in networks.ts. */
export const DEFAULT_SEAT_CONTRACT = seatContractFor(DEFAULT_CHAIN_ID)
export const HEARTBEAT_SEC = 30
export const PROTOCOL_V = 1
export const PROTOCOL_NAME = 'pit.v1'

/** Approved premium model ids (routing only; self-reported). */
export const PREMIUM_MODELS = [
  { runtime: 'claude', model: 'claude-fable-5-1', effort: 'high' },
  { runtime: 'codex', model: 'gpt-6-astra', effort: 'xhigh' },
] as const

export const RUNTIME_IDS = ['claude', 'codex', 'gemini'] as const
export type RuntimeId = (typeof RUNTIME_IDS)[number]
