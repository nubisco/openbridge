import { describe, it, expect, vi } from 'vitest'
import net from 'net'
import type { AddressInfo } from 'net'
import { waitForFreePort } from '../port.js'

/** Occupy a port the way a lingering previous instance does. */
async function occupy(): Promise<{ port: number; release: () => Promise<void> }> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    release: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

describe('waitForFreePort', () => {
  it('returns at once when nothing holds the port', async () => {
    const { port, release } = await occupy()
    await release()

    const onWait = vi.fn()
    await expect(waitForFreePort(port, { onWait, timeoutMs: 2000 })).resolves.toBeUndefined()
    // Nothing to wait for, so nothing should have been announced.
    expect(onWait).not.toHaveBeenCalled()
  })

  it('waits for a held port and continues once it is released', async () => {
    const { port, release } = await occupy()
    const onWait = vi.fn()

    const waiting = waitForFreePort(port, { onWait, timeoutMs: 5000, intervalMs: 50 })
    // This is the restart race: the previous instance lets go a moment later.
    setTimeout(() => void release(), 150)

    await expect(waiting).resolves.toBeUndefined()
    expect(onWait).toHaveBeenCalledTimes(1)
  })

  it('gives up when the port stays held', async () => {
    const { port, release } = await occupy()
    try {
      await expect(waitForFreePort(port, { timeoutMs: 300, intervalMs: 50 })).rejects.toThrow(/still in use/)
    } finally {
      await release()
    }
  })

  it('announces the wait exactly once, however long it lasts', async () => {
    const { port, release } = await occupy()
    const onWait = vi.fn()
    try {
      await waitForFreePort(port, { onWait, timeoutMs: 300, intervalMs: 50 }).catch(() => {})
      expect(onWait).toHaveBeenCalledTimes(1)
    } finally {
      await release()
    }
  })

  it('sees a port held on the IPv6 wildcard, which is where hap-nodejs listens', async () => {
    // The bug being guarded against showed as ":::51829" in netstat. A probe
    // that only checked IPv4 would call that port free and bind straight into
    // the same conflict.
    const server = net.createServer()
    await new Promise<void>((resolve) => server.listen({ port: 0, host: '::' }, resolve))
    const port = (server.address() as AddressInfo).port
    try {
      await expect(waitForFreePort(port, { timeoutMs: 200, intervalMs: 50 })).rejects.toThrow(/still in use/)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
