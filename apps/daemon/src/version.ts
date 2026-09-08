/**
 * Version resolution, kept in its own module so that `openbridge --help` and
 * `--version` can answer without importing the server (and with it Fastify,
 * hap-nodejs and the whole plugin surface).
 *
 * Order of preference: the volume's version.json (written by the container
 * entrypoint or by self-update), then OPENBRIDGE_VERSION, then our package.json.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { createRequire } from 'module'

const _req = createRequire(import.meta.url)
const _ownPkg = _req('../package.json') as { version: string }

export const APP_VOLUME = '/opt/openbridge'
export const VERSION_FILE = join(APP_VOLUME, 'version.json')

function resolveVersion(): string {
  try {
    const vf = JSON.parse(readFileSync(VERSION_FILE, 'utf8'))
    if (vf.version) return vf.version
  } catch {
    /* not on volume */
  }
  return process.env.OPENBRIDGE_VERSION ?? _ownPkg.version
}

export const OPENBRIDGE_VERSION: string = resolveVersion()
