import net from 'net'

/**
 * Waiting for a TCP port to become bindable.
 *
 * This exists because of how the daemon restarts. A stopping instance can still
 * hold its listening sockets for a moment after the supervisor has started the
 * replacement, and the replacement then fails to bind. For the HTTP port that
 * failure is loud, because Fastify rejects a promise and the process exits. For
 * the HAP port it is not: hap-nodejs listens asynchronously, well after
 * `publish()` has returned, so the error arrives as an uncaught exception and
 * the daemon carries on with no HomeKit bridge at all, looking healthy from
 * every other angle.
 *
 * Waiting for the port first turns that race into a pause of a few seconds.
 */

export interface WaitForFreePortOptions {
  /** Give up after this long. */
  timeoutMs?: number
  /** Gap between attempts. */
  intervalMs?: number
  /** Called once, when the port is found busy and waiting begins. */
  onWait?: () => void
}

/**
 * Resolve once nothing is listening on `port`, or reject if it stays busy.
 *
 * Inherently advisory: the port is free when checked and could be taken again
 * before the caller binds it. That is acceptable here, where the contended
 * party is a previous instance of this same process, which is going away rather
 * than arriving.
 */
export async function waitForFreePort(port: number, options: WaitForFreePortOptions = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 30_000
  const intervalMs = options.intervalMs ?? 500
  const deadline = Date.now() + timeoutMs
  let notified = false

  for (;;) {
    if (await isFree(port)) return

    if (!notified) {
      notified = true
      options.onWait?.()
    }
    if (Date.now() + intervalMs > deadline) {
      throw new Error(`Port ${port} is still in use after ${Math.round(timeoutMs / 1000)}s`)
    }
    await delay(intervalMs)
  }
}

/**
 * True when a server can bind `port`.
 *
 * Bound without a host so the probe covers the same dual-stack wildcard
 * hap-nodejs itself listens on. Probing only IPv4 would miss exactly the
 * conflict this is meant to catch.
 */
function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(port, () => {
      server.close(() => resolve(true))
    })
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
