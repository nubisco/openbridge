import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PluginLifecycle } from '../lifecycle.js'
import { PluginRegistry } from '../registry.js'
import type { Plugin, PluginContext } from '../types.js'

function makePlugin(name: string, overrides: Partial<Plugin> = {}): Plugin {
  return {
    manifest: { name, version: '1.0.0' },
    setup: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    ...overrides,
  }
}

function makeContext(): PluginContext {
  return {
    config: {},
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    reportTelemetry: vi.fn(),
    registerDevice: vi.fn(),
    registerControl: vi.fn(),
    registerHapBridge: vi.fn(),
    restrictControl: vi.fn(),
  }
}

describe('PluginLifecycle', () => {
  let registry: PluginRegistry
  let lifecycle: PluginLifecycle

  beforeEach(() => {
    registry = new PluginRegistry()
    lifecycle = new PluginLifecycle(registry)
  })

  describe('setup', () => {
    it('calls plugin.setup and sets status to loading', async () => {
      const plugin = makePlugin('test')
      registry.register(plugin)
      const ctx = makeContext()

      await lifecycle.setup(plugin, ctx)

      expect(plugin.setup).toHaveBeenCalledWith(ctx)
    })

    it('sets status to error if setup throws', async () => {
      const plugin = makePlugin('test', {
        setup: vi.fn().mockRejectedValue(new Error('setup failed')),
      })
      registry.register(plugin)

      await expect(lifecycle.setup(plugin, makeContext())).rejects.toThrow('setup failed')
      expect(registry.get('test')!.instance.status).toBe('error')
      expect(registry.get('test')!.instance.error).toBe('Error: setup failed')
    })
  })

  describe('start', () => {
    it('calls plugin.start and sets status to running', async () => {
      const plugin = makePlugin('test')
      registry.register(plugin)
      const ctx = makeContext()

      await lifecycle.start(plugin, ctx)

      expect(plugin.start).toHaveBeenCalledWith(ctx)
      expect(registry.get('test')!.instance.status).toBe('running')
    })

    it('sets status to error if start throws', async () => {
      const plugin = makePlugin('test', {
        start: vi.fn().mockRejectedValue(new Error('start failed')),
      })
      registry.register(plugin)

      await expect(lifecycle.start(plugin, makeContext())).rejects.toThrow('start failed')
      expect(registry.get('test')!.instance.status).toBe('error')
    })
  })

  describe('stop', () => {
    it('calls plugin.stop and sets status to stopped', async () => {
      const plugin = makePlugin('test')
      registry.register(plugin)

      await lifecycle.stop(plugin, makeContext())

      expect(plugin.stop).toHaveBeenCalled()
      expect(registry.get('test')!.instance.status).toBe('stopped')
    })
  })

  describe('startAll', () => {
    it('calls setup and start for each plugin', async () => {
      const a = makePlugin('a')
      const b = makePlugin('b')
      registry.register(a)
      registry.register(b)

      await lifecycle.startAll([a, b], () => makeContext())

      expect(a.setup).toHaveBeenCalled()
      expect(a.start).toHaveBeenCalled()
      expect(b.setup).toHaveBeenCalled()
      expect(b.start).toHaveBeenCalled()
      expect(registry.get('a')!.instance.status).toBe('running')
      expect(registry.get('b')!.instance.status).toBe('running')
    })
  })

  describe('stopAll', () => {
    it('stops all plugins in reverse order', async () => {
      const order: string[] = []
      const a = makePlugin('a', {
        stop: vi.fn(async () => {
          order.push('a')
        }),
      })
      const b = makePlugin('b', {
        stop: vi.fn(async () => {
          order.push('b')
        }),
      })
      registry.register(a)
      registry.register(b)

      await lifecycle.stopAll([a, b], () => makeContext())

      expect(order).toEqual(['b', 'a'])
    })
  })
})
