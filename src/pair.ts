/**
 * Pair flow: start challenge → owner signs PitWorkerAuthorization → complete → poll status.
 */
import { privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'
import { apiJson, withBackoff, type BackoffOptions } from './api.ts'
import { loadConfig, requireDevice, saveConfig, type PitConfig } from './store.ts'

export interface StartResult {
  pairCode: string
  url: string
  nonce: Hex
  expiresAt: number
  chainId: number
  seatContract: string | null
  eip712: {
    domain: { name: string; version: string; chainId: number }
    types: Record<string, { name: string; type: string }[]>
    primaryType: string
  }
}

/** Pair calls are rate limited per IP on the server; on 429 they wait (Retry-After or capped exponential backoff). */
const pairBackoff = (o?: BackoffOptions): BackoffOptions => ({
  onWait: (ms, n) => console.error(`rate limited (HTTP 429); retry ${n} in ${Math.ceil(ms / 1000)} s`),
  ...o,
})

export async function pairStart(cfg: PitConfig = loadConfig(), backoff?: BackoffOptions): Promise<StartResult & { devicePubKey: string }> {
  const device = requireDevice()
  const body = await withBackoff(
    () =>
      apiJson<StartResult>(cfg, '/api/pair/start', {
        method: 'POST',
        body: JSON.stringify({ devicePubKey: device.publicKey, daemonVersion: cfg.daemonVersion }),
      }),
    pairBackoff(backoff),
  )
  return { ...body, devicePubKey: device.publicKey }
}

export async function pairComplete(
  cfg: PitConfig,
  args: { pairCode: string; seatId: number; signature: Hex; expiresAt: number },
  backoff?: BackoffOptions,
) {
  // Safe to retry: a 429 is answered by the limiter before the handler runs, so nothing was consumed.
  const out = await withBackoff(
    () =>
      apiJson<{ ok: true; seatId: number; pairedAt: number }>(cfg, '/api/pair/complete', {
        method: 'POST',
        body: JSON.stringify(args),
      }),
    pairBackoff(backoff),
  )
  const next = { ...cfg, seatId: out.seatId, pairedAt: out.pairedAt }
  saveConfig(next)
  return out
}

export async function pairStatus(cfg: PitConfig, query: { code?: string; devicePubKey?: string }, backoff?: BackoffOptions) {
  const q = query.code
    ? `code=${encodeURIComponent(query.code)}`
    : `devicePubKey=${encodeURIComponent(query.devicePubKey || requireDevice().publicKey)}`
  return withBackoff(() => apiJson<Record<string, unknown>>(cfg, `/api/pair/status?${q}`), pairBackoff(backoff))
}

/** Sign PitWorkerAuthorization with a wallet private key (test / owner automation only). */
export async function signAuthorization(args: {
  walletPk: Hex
  chainId: number
  seatId: number
  devicePubKey: Hex
  nonce: Hex
  expiresAt: number
  domain: StartResult['eip712']['domain']
  types: StartResult['eip712']['types']
}): Promise<Hex> {
  const account = privateKeyToAccount(args.walletPk)
  return account.signTypedData({
    domain: args.domain,
    types: args.types,
    primaryType: 'PitWorkerAuthorization',
    message: {
      seatId: BigInt(args.seatId),
      devicePubKey: args.devicePubKey,
      nonce: args.nonce,
      expiresAt: BigInt(args.expiresAt),
      chainId: BigInt(args.chainId),
    },
  })
}

export function printPairInstructions(started: StartResult & { devicePubKey: string }, seatId?: number) {
  const lines = [
    '',
    `Pair code: ${started.pairCode} (expires unix ${started.expiresAt})`,
    `Browser:   ${started.url}`,
    `Device:    ${started.devicePubKey.slice(0, 12)}…`,
    '',
    'Open that link and sign with the wallet that owns the seat.',
    'This terminal waits until the signature is accepted.',
    '',
    'If the browser cannot finish it, the owner can still sign EIP-712 PitWorkerAuthorization (domain "Pit Worker"), then:',
    `  pit pair --complete --code ${started.pairCode} --seat ${seatId ?? '<seatId>'} --sig 0x… --expires ${started.expiresAt}`,
    '',
  ]
  return lines.join('\n')
}

export async function pairWatch(cfg: PitConfig, code: string, timeoutSec = 600): Promise<boolean> {
  const deadline = Date.now() + timeoutSec * 1000
  while (Date.now() < deadline) {
    const st = await pairStatus(cfg, { code })
    if (st.paired === true || st.status === 'paired') {
      if (typeof st.seatId === 'number') {
        saveConfig({ ...cfg, seatId: st.seatId, pairedAt: Math.floor(Date.now() / 1000) })
      }
      return true
    }
    if (st.status === 'expired' || st.status === 'used') return st.paired === true
    await new Promise((r) => setTimeout(r, 2000))
  }
  return false
}
