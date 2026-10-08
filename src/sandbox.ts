/**
 * OS sandbox for harness CLIs (C1). The agent runs in a bubblewrap (Linux) or seatbelt (macOS) jail whose HOME is a
 * fresh directory containing only that CLI's own login files — never the real home, so device.json, ~/.ssh and
 * ~/.config/pit are unreachable. The jail allows outbound network, because a subscription CLI cannot finish a job
 * without reaching its provider. Tool network stays off unless the holder opts in (Codex network_access, no WebFetch,
 * FOUNDRY_OFFLINE). The generic `command` adapter is not wrapped: it is text-only and reported as unsandboxed.
 *
 * Harness seats must never run on the ops box: relayer / admin / wallet keys live in ~/.config/pit there (H4).
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AgentKind } from './agent-cli.ts'

export const OPS_BOX_WARNING =
  'Never run a harness seat (codex / claude / kimi / command) on a machine that holds relayer, admin or wallet keys. On the Pit ops box those keys live in ~/.config/pit; a harness there could read them. Use a dedicated user or machine.'

/** Login directories copied into the jail HOME (nothing else from the real home is visible). */
const AUTH_DIRS: Record<AgentKind, string[]> = {
  codex: ['.codex'],
  claude: ['.claude'],
  kimi: ['.kimi-code'],
  command: [],
}

export function sandboxProgram(): { bin: string; kind: 'bwrap' | 'seatbelt' } | null {
  const name = process.platform === 'darwin' ? 'sandbox-exec' : process.platform === 'linux' ? 'bwrap' : ''
  if (!name) return null
  const found = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim()
  return found ? { bin: found, kind: name === 'bwrap' ? 'bwrap' : 'seatbelt' } : null
}

/** Copy the CLI's own login dir into `jailHome`. Returns the path of the copy (or null). */
export function seedJailHome(kind: AgentKind, realHome: string, jailHome: string): void {
  mkdirSync(jailHome, { recursive: true, mode: 0o700 })
  for (const rel of AUTH_DIRS[kind]) {
    const src = join(realHome, rel)
    if (!existsSync(src)) continue
    cpSync(src, join(jailHome, rel), { recursive: true, errorOnExist: false })
  }
}

const RO_ROOTS = ['/usr', '/bin', '/lib', '/lib64', '/etc/ssl', '/etc/ca-certificates', '/etc/pki']

function roBind(path: string): string[] | null {
  if (!existsSync(path)) return null
  let real = path
  try {
    real = realpathSync(path)
  } catch {
    /* keep */
  }
  if (RO_ROOTS.some((r) => real === r || real.startsWith(`${r}/`))) return null
  return ['--ro-bind', real, real]
}

/** Bubblewrap argv. The allowlisted env is the bwrap process env; HOME is forced to the jail. */
export function bwrapArgs(o: { bin: string; args: string[]; cwd: string; jailHome: string; network: boolean }): string[] {
  const a = ['--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--die-with-parent', '--new-session']
  if (!o.network) a.push('--unshare-net')
  for (const r of RO_ROOTS) if (existsSync(r)) a.push('--ro-bind', r, r)
  if (existsSync('/etc/resolv.conf') && o.network) a.push('--ro-bind', '/etc/resolv.conf', '/etc/resolv.conf')
  a.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp')
  for (const p of [dirname(o.bin), dirname(process.execPath)]) {
    const b = roBind(p)
    if (b) a.push(...b)
  }
  a.push('--bind', o.cwd, o.cwd, '--bind', o.jailHome, o.jailHome, '--chdir', o.cwd, '--setenv', 'HOME', o.jailHome)
  a.push('--', o.bin, ...o.args)
  return a
}

/** Seatbelt profile: write the work dir and the jail, read the toolchain, deny the real home outright. */
export function seatbeltProfile(o: { cwd: string; jailHome: string; realHome: string; network: boolean }): string {
  const allowNet = o.network ? '(allow network*)' : ''
  return `(version 1)
(deny default)
(allow process-exec) (allow process-fork) (allow signal) (allow sysctl-read) (allow ipc-posix*)
(allow file-read* file-write* (subpath ${JSON.stringify(o.cwd)}))
(allow file-read* file-write* (subpath ${JSON.stringify(o.jailHome)}))
(allow file-read* (subpath "/usr") (subpath "/bin") (subpath "/lib") (subpath "/opt") (subpath "/System") (subpath "/Library") (subpath "/Applications") (subpath "/private/var") (subpath "/dev"))
(deny file-read* (subpath ${JSON.stringify(o.realHome)}))
${allowNet}
`
}

export interface Launch {
  bin: string
  args: string[]
  /** HOME the child must see. */
  home: string
  sandboxed: boolean
}

/**
 * How to spawn the CLI. Sandboxed when the OS tool exists and `enable` is not false. `command` is never sandboxed
 * (H5: text-only, reported unsandboxed, separate terms).
 */
export function planLaunch(o: { kind: AgentKind; bin: string; args: string[]; cwd: string; realHome: string; network: boolean; enable: boolean }): Launch {
  const prog = o.enable && o.kind !== 'command' ? sandboxProgram() : null
  if (!prog) return { bin: o.bin, args: o.args, home: o.realHome, sandboxed: false }
  const jailHome = join(o.cwd, '.pit-jail')
  seedJailHome(o.kind, o.realHome, jailHome)
  // Provider API must be reachable. `o.network` is only the tool-network opt-in, applied by the CLI flags, not here.
  void o.network
  if (prog.kind === 'bwrap') return { bin: prog.bin, args: bwrapArgs({ bin: o.bin, args: o.args, cwd: o.cwd, jailHome, network: true }), home: jailHome, sandboxed: true }
  const profile = join(o.cwd, '.pit-seatbelt.sb')
  writeFileSync(profile, seatbeltProfile({ cwd: o.cwd, jailHome, realHome: o.realHome, network: true }), { mode: 0o600 })
  return { bin: prog.bin, args: ['-f', profile, o.bin, ...o.args], home: jailHome, sandboxed: true }
}

/** Doctor: a canary file in the real home must be unreadable from inside the sandbox. */
export function sandboxHidesHome(realHome = process.env.HOME || tmpdir()): { ok: boolean; detail: string } {
  const prog = sandboxProgram()
  if (!prog) return { ok: false, detail: 'UNSANDBOXED: no bwrap (Linux) or sandbox-exec (macOS); harness seats will not start' }
  if (prog.kind !== 'bwrap') return { ok: true, detail: 'seatbelt available (not self-tested on this platform)' }
  const work = mkdtempSync(join(tmpdir(), 'pit-sbx-'))
  const canaryName = `.pit-canary-${process.pid}`
  const canary = join(realHome, canaryName)
  try {
    writeFileSync(canary, 'SECRET-CANARY', { mode: 0o600 })
    const jail = join(work, 'jail')
    mkdirSync(jail, { recursive: true })
    const args = bwrapArgs({ bin: process.execPath, args: ['-e', `try{require('fs').readFileSync(${JSON.stringify(canary)},'utf8');process.exit(0)}catch(e){process.exit(2)}`], cwd: work, jailHome: jail, network: false })
    const r = spawnSync(prog.bin, args, { encoding: 'utf8', timeout: 20_000, env: { PATH: process.env.PATH || '', HOME: realHome } })
    if (r.status === 0) return { ok: false, detail: 'UNSANDBOXED: the jail could read a file in the real home' }
    return { ok: true, detail: `bwrap hides ${realHome} (canary unreadable)` }
  } catch (e) {
    return { ok: false, detail: `sandbox self-test failed: ${(e as Error).message}` }
  } finally {
    try {
      rmSync(canary, { force: true })
    } catch {
      /* ignore */
    }
    rmSync(work, { recursive: true, force: true })
  }
}
