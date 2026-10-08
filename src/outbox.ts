/**
 * Saved results (outbox). The upload + receipt is written here (mode 0600, directory 0700) before it is sent, and
 * removed after the backend accepts it. On the next session the daemon uploads and submits anything still here, so a
 * dropped socket does not throw away finished work. The backend still requires a live lease until its own PR accepts a
 * late submit; this only makes the resend possible.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pitHome } from './paths.ts'

export interface OutboxItem {
  leaseId: string
  uploadUrl: string
  content: string
  artifactHash: string
  treeHash: string
  receipt: Record<string, unknown>
  durationMs: number
}

const dir = () => join(pitHome(), 'outbox')

export function saveOutbox(item: OutboxItem): void {
  const d = dir()
  mkdirSync(d, { recursive: true, mode: 0o700 })
  try {
    chmodSync(d, 0o700)
  } catch {
    /* ignore */
  }
  const p = join(d, `${item.leaseId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`)
  writeFileSync(p, JSON.stringify(item), { mode: 0o600 })
}

export function listOutbox(): OutboxItem[] {
  const d = dir()
  if (!existsSync(d)) return []
  const out: OutboxItem[] = []
  for (const name of readdirSync(d)) {
    if (!name.endsWith('.json')) continue
    try {
      out.push(JSON.parse(readFileSync(join(d, name), 'utf8')) as OutboxItem)
    } catch {
      /* skip a torn write */
    }
  }
  return out
}

export function dropOutbox(leaseId: string): void {
  const p = join(dir(), `${leaseId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`)
  rmSync(p, { force: true })
}
