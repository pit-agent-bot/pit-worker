import { homedir } from 'node:os'
import { join } from 'node:path'

/** Config root: PIT_HOME or ~/.config/pit (matches admin_secret layout on the box). */
export function pitHome(): string {
  const env = process.env.PIT_HOME?.trim()
  if (env) return env
  return join(homedir(), '.config', 'pit')
}

export const paths = {
  home: () => pitHome(),
  config: () => join(pitHome(), 'config.json'),
  device: () => join(pitHome(), 'device.json'),
  updateTrust: () => join(pitHome(), 'update-trust.json'),
}
