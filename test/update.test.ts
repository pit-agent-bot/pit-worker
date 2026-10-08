import { describe, expect, it } from 'vitest'
import { ed25519Keygen, ed25519Sign } from '../src/protocol.ts'
import { updateSignString, verifyUpdatePackage } from '../src/update.ts'

describe('update signature gate', () => {
  it('refuses when no publisher keys are configured', async () => {
    await expect(
      verifyUpdatePackage(
        { version: '0.1.1', archiveHash: '0x' + '11'.repeat(32), signature: '0x' + '22'.repeat(64) },
        { publisherKeys: [], autoUpdate: false },
      ),
    ).rejects.toThrow(/no publisher keys/)
  })

  it('accepts a valid publisher signature and rejects a bad one', async () => {
    const { privateKey, publicKey } = await ed25519Keygen()
    const version = '0.1.1'
    const archiveHash = '0x' + 'ab'.repeat(32)
    const signature = await ed25519Sign(privateKey, updateSignString(version, archiveHash))
    await expect(
      verifyUpdatePackage({ version, archiveHash, signature }, { publisherKeys: [publicKey], autoUpdate: false }),
    ).resolves.toEqual({ ok: true })
    await expect(
      verifyUpdatePackage(
        { version, archiveHash, signature: '0x' + '00'.repeat(64) },
        { publisherKeys: [publicKey], autoUpdate: false },
      ),
    ).rejects.toThrow(/not valid/)
  })
})
