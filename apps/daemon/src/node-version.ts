/**
 * The oldest Node.js release OpenBridge supports, kept in step with `engines.node`
 * in every published package.json.
 *
 * Node 20 reached end of life in April 2026 and gets no security fixes. Node 22
 * releases before 22.23.4 are affected by the October 2026 Node.js security
 * release. A home bridge listens on the local network, so running it on either
 * leaves known holes open.
 */
export const MINIMUM_NODE_VERSION = '22.23.4'

function parse(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * Returns the warning to log when `version` (in `process.version` form) is older
 * than MINIMUM_NODE_VERSION, or null when it is supported or cannot be read.
 *
 * This warns rather than refusing to start. npm treats `engines` as advice, so a
 * Docker volume or a global install can be updated onto an older Node, and a
 * daemon that then refused to start would take the bridge, the dashboard and
 * the in-app rollback down with it.
 */
export function nodeVersionWarning(version: string): string | null {
  const current = parse(version)
  const minimum = parse(MINIMUM_NODE_VERSION)
  if (!current || !minimum) return null

  for (let i = 0; i < 3; i++) {
    if (current[i] > minimum[i]) return null
    if (current[i] < minimum[i]) {
      return (
        `Node.js ${version} is older than ${MINIMUM_NODE_VERSION}, the oldest release OpenBridge supports. ` +
        'Node 20 is end of life and gets no security fixes, and Node 22 releases before 22.23.4 are ' +
        'affected by the October 2026 Node.js security release. OpenBridge will keep running, but ' +
        `upgrade Node.js to ${MINIMUM_NODE_VERSION} or newer (under Docker, raise the image tag).`
      )
    }
  }
  return null
}
