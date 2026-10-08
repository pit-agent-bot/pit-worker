/**
 * Minimal pit.v1 client crypto (clean-room; matches backend/src/protocol.ts wire format).
 */
import * as ed25519 from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha512'
import { keccak256, toBytes, type Hex } from 'viem'
import { PROTOCOL_NAME, PROTOCOL_V } from './defaults.ts'

ed25519.etc.sha512Sync ??= (...m: Uint8Array[]) => sha512(ed25519.etc.concatBytes(...m))

export type Hex32 = Hex

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new Error('bad hex')
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return out
}

export function bytesToHex(b: Uint8Array): Hex {
  return `0x${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}` as Hex
}

export async function ed25519Keygen(): Promise<{ privateKey: Uint8Array; publicKey: Hex; privateKeyHex: Hex }> {
  const privateKey = ed25519.utils.randomPrivateKey()
  const publicKey = bytesToHex(await ed25519.getPublicKeyAsync(privateKey))
  return { privateKey, publicKey, privateKeyHex: bytesToHex(privateKey) }
}

export async function ed25519Sign(privateKey: Uint8Array, message: string): Promise<Hex> {
  return bytesToHex(await ed25519.signAsync(new TextEncoder().encode(message), privateKey))
}

export async function ed25519Verify(publicKeyHex: string, message: string, signatureHex: string): Promise<boolean> {
  try {
    const pub = hexToBytes(publicKeyHex)
    const sig = hexToBytes(signatureHex)
    if (pub.length !== 32 || sig.length !== 64) return false
    return await ed25519.verifyAsync(sig, new TextEncoder().encode(message), pub)
  } catch {
    return false
  }
}

export function challengeSignString(nonceHex: string): string {
  return `${PROTOCOL_NAME}\nchallenge\n${nonceHex.toLowerCase()}`
}

export function signString(kind: string, seq: number | string, payloadHash: string): string {
  return `${PROTOCOL_NAME}\n${kind}\n${seq}\n${payloadHash}`
}

function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  const o = v as Record<string, unknown>
  const keys = Object.keys(o).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`
}

export function hashPayload(payload: unknown): Hex {
  return keccak256(toBytes(canonicalJson(payload ?? {})))
}

export interface AgentFrame {
  v: number
  kind: string
  seatId?: number
  deviceKey?: string
  seq?: number
  ts?: number
  payloadHash?: string
  sig?: string
  payload?: Record<string, unknown>
}

export function parseFrame(raw: string): AgentFrame | null {
  try {
    const o = JSON.parse(raw) as AgentFrame
    if (!o || typeof o !== 'object' || typeof o.kind !== 'string') return null
    if (o.v !== undefined && Number(o.v) !== PROTOCOL_V) return null
    return o
  } catch {
    return null
  }
}

export async function buildSignedFrame(
  privateKey: Uint8Array,
  kind: string,
  seatId: number,
  deviceKey: string,
  seq: number,
  payload: Record<string, unknown>,
  ts = Math.floor(Date.now() / 1000),
): Promise<AgentFrame> {
  const payloadHash = hashPayload(payload)
  const sig = await ed25519Sign(privateKey, signString(kind, seq, payloadHash))
  return { v: PROTOCOL_V, kind, seatId, deviceKey: deviceKey.toLowerCase(), seq, ts, payloadHash, sig, payload }
}
