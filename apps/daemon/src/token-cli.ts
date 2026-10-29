/**
 * `openbridge token ...`: manage MCP tokens from the host.
 *
 * The way in for a bridge whose dashboard sign-in is off, and a way back in
 * for any bridge: whoever has a shell on the host already owns the bridge, so
 * no further proof is asked. Writes the same access.json the daemon reads, and
 * the daemon picks the change up without a restart.
 */

import os from 'os'
import { join, resolve } from 'path'
import { AccessStore, type Access } from './access.js'

const USAGE = `Usage:
  openbridge token create <name> [--control]   Create a token (read-only unless --control)
  openbridge token list                         List tokens
  openbridge token revoke <id>                  Revoke a token

A token opens the MCP endpoint at /mcp and nothing else. Read-only tokens see
devices, history, events, observations and logs. --control also lets the agent
operate devices.`

function flagValue(args: string[], ...names: string[]): boolean {
  return args.some((a) => names.includes(a))
}

export function runTokenCommand(args: string[], home = resolve(os.homedir(), '.openbridge')): number {
  const store = new AccessStore(join(home, 'access.json'))
  const [sub, ...rest] = args
  const positional = rest.filter((a) => !a.startsWith('-'))

  switch (sub) {
    case 'create': {
      const name = positional.join(' ').trim()
      if (!name) {
        console.error('A name is required, e.g. openbridge token create "Claude on my laptop"\n')
        console.error(USAGE)
        return 1
      }
      const access: Access = flagValue(rest, '--control') ? 'control' : 'read'
      const { token } = store.createToken(name, access, { id: 'local', email: null })
      console.log(`Created "${name}" with ${access === 'control' ? 'read and control' : 'read-only'} access.`)
      console.log('It works once the daemon runs with OPENBRIDGE_MCP=on, which is off by default.')
      console.log('Copy it now, it is not shown again:\n')
      console.log(`  ${token}\n`)
      console.log('Connect Claude Code with:\n')
      console.log(`  claude mcp add --transport http openbridge http://<this-host>:8582/mcp \\`)
      console.log(`    --header "Authorization: Bearer ${token}"`)
      return 0
    }
    case 'list': {
      const tokens = store.listTokens()
      if (tokens.length === 0) {
        console.log('No tokens.')
        return 0
      }
      for (const t of tokens) {
        const used = t.lastUsedAt ? `last used ${t.lastUsedAt}` : 'never used'
        console.log(`${t.id}  ${t.access.padEnd(7)}  ${t.name}  (${used})`)
      }
      return 0
    }
    case 'revoke': {
      const id = positional[0]
      if (!id) {
        console.error(USAGE)
        return 1
      }
      if (!store.revokeToken(id)) {
        console.error(`No token with id ${id}`)
        return 1
      }
      console.log('Revoked.')
      return 0
    }
    default:
      console.log(USAGE)
      return sub === undefined || sub === 'help' || sub === '--help' ? 0 : 1
  }
}
