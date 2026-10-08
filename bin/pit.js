#!/usr/bin/env node
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const src = join(here, '..', 'src', 'index.ts')
const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', src, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
})
process.exit(r.status ?? 1)
