import { describe, it, expect, beforeEach } from 'vitest'
import { PluginRegistry } from '../registry.js'
import type { Plugin } from '../types.js'

function makePlugin(name: string): Plugin {
  return { manifest: { name, version: '1.0.0', description: `Test plugin ${name}` } }
}

describe('PluginRegistry', () => {
  let registry: PluginRegistry

  beforeEach(() => {
    registry = new PluginRegistry()
  })

  describe('register', () => {
    it('registers a plugin and returns its instance', () => {
      const plugin = makePlugin('test-plugin')
      const instance = registry.register(plugin)

      expect(instance.id).toBe('test-plugin')
      expect(instance.manifest.name).toBe('test-plugin')
      expect(instance.status).toBe('idle')
    })

    it('uses custom instance ID if provided', () => {
      const plugin = makePlugin('test-plugin')
      const instance = registry.register(plugin, 'custom-id')

      expect(instance.id).toBe('custom-id')
    })
  })

  describe('get', () => {
    it('returns the entry for a registered plugin', () => {
      const plugin = makePlugin('test-plugin')
      registry.register(plugin)

      const entry = registry.get('test-plugin')
      expect(entry).toBeDefined()
      expect(entry!.instance.manifest.name).toBe('test-plugin')
      expect(entry!.plugin).toBe(plugin)
    })

    it('returns undefined for an unregistered plugin', () => {
      expect(registry.get('nonexistent')).toBeUndefined()
    })
  })

  describe('getAll', () => {
    it('returns all registered instances', () => {
      registry.register(makePlugin('a'))
      registry.register(makePlugin('b'))
      registry.register(makePlugin('c'))

      const all = registry.getAll()
      expect(all).toHaveLength(3)
      expect(all.map((i) => i.id)).toEqual(['a', 'b', 'c'])
    })

    it('returns empty array when no plugins registered', () => {
      expect(registry.getAll()).toEqual([])
    })
  })

  describe('unregister', () => {
    it('removes a plugin by ID', () => {
      registry.register(makePlugin('test-plugin'))
      expect(registry.unregister('test-plugin')).toBe(true)
      expect(registry.get('test-plugin')).toBeUndefined()
    })

    it('returns false for nonexistent plugin', () => {
      expect(registry.unregister('nonexistent')).toBe(false)
    })
  })

  describe('unregisterWhere', () => {
    it('removes plugins matching predicate', () => {
      registry.register(makePlugin('keep-a'))
      registry.register(makePlugin('remove-b'))
      registry.register(makePlugin('remove-c'))
      registry.register(makePlugin('keep-d'))

      const removed = registry.unregisterWhere((i) => i.manifest.name.startsWith('remove'))
      expect(removed).toBe(2)
      expect(registry.getAll()).toHaveLength(2)
      expect(registry.getAll().map((i) => i.id)).toEqual(['keep-a', 'keep-d'])
    })

    it('returns 0 when no plugins match', () => {
      registry.register(makePlugin('test'))
      expect(registry.unregisterWhere(() => false)).toBe(0)
    })
  })

  describe('updateStatus', () => {
    it('updates plugin status', () => {
      registry.register(makePlugin('test'))
      registry.updateStatus('test', 'running')
      expect(registry.get('test')!.instance.status).toBe('running')
    })

    it('sets startedAt when status is running', () => {
      registry.register(makePlugin('test'))
      registry.updateStatus('test', 'running')
      expect(registry.get('test')!.instance.startedAt).toBeInstanceOf(Date)
    })

    it('sets stoppedAt when status is stopped', () => {
      registry.register(makePlugin('test'))
      registry.updateStatus('test', 'stopped')
      expect(registry.get('test')!.instance.stoppedAt).toBeInstanceOf(Date)
    })

    it('sets error message when provided', () => {
      registry.register(makePlugin('test'))
      registry.updateStatus('test', 'error', 'Something broke')
      expect(registry.get('test')!.instance.error).toBe('Something broke')
    })

    it('does nothing for nonexistent plugin', () => {
      // Should not throw
      registry.updateStatus('nonexistent', 'running')
    })
  })
})
