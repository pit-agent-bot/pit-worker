import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initDevice, loadConfig, loadDevice, requireDevice } from '../src/store.ts'

describe('store', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'pit-cli-'))
    process.env.PIT_HOME = home
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    delete process.env.PIT_HOME
  })

  it('init creates device + config without printing the private key path contents in errors', async () => {
    const { device, created } = await initDevice(false, { network: 'sepolia' })
    expect(created).toBe(true)
    expect(device.publicKey).toMatch(/^0x[0-9a-f]{64}$/)
    expect(loadDevice()?.publicKey).toBe(device.publicKey)
    expect(loadConfig().apiUrl).toContain('api.pitagent.fun')
    expect(loadConfig().autoUpdate).toBe(false)
    await expect(initDevice(false, { network: 'sepolia' })).rejects.toThrow(/already exists/)
  })

  it('missing device key points at pit init with an explicit network', () => {
    expect(() => requireDevice()).toThrow(/run: pit init --network sepolia/)
  })
})
