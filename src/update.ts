/**
 * Update-package gate (upgrade proposal item 18 / T3).
 * Refuse silent auto-update. Only accept packages with a valid Ed25519 signature over the archive hash
 * when a trusted public key is configured; otherwise refuse.
 */
import { existsSync, readFileSync } from 'node:fs'
import { ed25519Verify } from './protocol.ts'
import { paths } from './paths.ts'

export interface UpdateTrust {
  /** Hex Ed25519 public keys allowed to sign releases. Empty = updates disabled. */
  publisherKeys: string[]
  autoUpdate: false
}

export interface UpdatePackageMeta {
  version: string
  /** keccak256 or sha256 hex of the package bytes */
  archiveHash: string
  /** Ed25519 signature over `pit.update.v1\n{version}\n{archiveHash}` */
  signature: string
}

export function loadUpdateTrust(): UpdateTrust {
  if (!existsSync(paths.updateTrust())) return { publisherKeys: [], autoUpdate: false }
  const raw = JSON.parse(readFileSync(paths.updateTrust(), 'utf8')) as Partial<UpdateTrust>
  return { publisherKeys: Array.isArray(raw.publisherKeys) ? raw.publisherKeys.map(String) : [], autoUpdate: false }
}

export function updateSignString(version: string, archiveHash: string): string {
  return `pit.update.v1\n${version}\n${archiveHash.toLowerCase()}`
}

/**
 * Verify an update package. Throws if unsigned / untrusted / auto-update would apply.
 * Never downloads or installs — caller must pass metadata already fetched out-of-band.
 */
export async function verifyUpdatePackage(meta: UpdatePackageMeta, trust = loadUpdateTrust()): Promise<{ ok: true }> {
  if (trust.autoUpdate) throw new Error('auto-update is disabled by policy')
  if (!trust.publisherKeys.length) {
    throw new Error('refusing update: no publisher keys configured (create update-trust.json with publisherKeys)')
  }
  if (!meta.signature || !meta.archiveHash || !meta.version) throw new Error('refusing update: incomplete package metadata')
  const msg = updateSignString(meta.version, meta.archiveHash)
  for (const key of trust.publisherKeys) {
    if (await ed25519Verify(key, msg, meta.signature)) return { ok: true }
  }
  throw new Error('refusing update: signature not valid under any trusted publisher key')
}

/** CLI `pit update` — always refuses applying anything in T3; verification-only path. */
export async function cmdUpdate(args: { check?: UpdatePackageMeta }): Promise<string> {
  if (!args.check) {
    return 'Updates are manual and signature-gated. Auto-update is off. Pass --check with version, hash, and signature to verify a package (does not install).'
  }
  await verifyUpdatePackage(args.check)
  return `Signature OK for version ${args.check.version} (not installed; apply manually after review).`
}
