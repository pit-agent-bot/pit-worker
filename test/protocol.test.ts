import { describe, expect, it } from 'vitest'
import { challengeSignString, ed25519Keygen, ed25519Sign, ed25519Verify, buildSignedFrame, signString } from '../src/protocol.ts'

describe('cli protocol', () => {
  it('signs challenge and heartbeat like the gateway expects', async () => {
    const { privateKey, publicKey } = await ed25519Keygen()
    const nonce = '0x' + 'cd'.repeat(32)
    const sig = await ed25519Sign(privateKey, challengeSignString(nonce))
    expect(await ed25519Verify(publicKey, challengeSignString(nonce), sig)).toBe(true)
    const frame = await buildSignedFrame(privateKey, 'heartbeat', 813, publicKey, 1, {})
    expect(await ed25519Verify(publicKey, signString('heartbeat', 1, frame.payloadHash!), frame.sig!)).toBe(true)
  })
})
