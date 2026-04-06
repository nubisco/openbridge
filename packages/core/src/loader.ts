import { pathToFileURL } from 'url'
import { join, resolve } from 'path'
import { existsSync } from 'fs'
import type { Plugin } from './types.js'

export async function loadPlugin(pluginPath: string): Promise<Plugin> {
  const absolutePath = resolve(pluginPath)

  // Try to load as ES module
  let mod: unknown
  try {
    const fileUrl = pathToFileURL(absolutePath).href
    mod = await import(fileUrl)
  } catch (err) {
    throw new Error(`Failed to load plugin at ${pluginPath}: ${err}`)
  }

  // Handle both default export and named export
  const plugin = (mod as Record<string, unknown>).default ?? mod

  if (!plugin || typeof plugin !== 'object') {
    throw new Error(`Plugin at ${pluginPath} must export a plugin object`)
  }

  const p = plugin as Record<string, unknown>
  if (!p.manifest || typeof p.manifest !== 'object') {
    throw new Error(`Plugin at ${pluginPath} must have a manifest`)
  }

  return plugin as Plugin
}

export async function loadPluginsFromDirectory(dir: string): Promise<Plugin[]> {
  if (!existsSync(dir)) return []

  const { readdir } = await import('fs/promises')
  const entries = await readdir(dir, { withFileTypes: true })
  const plugins: Plugin[] = []

  for (const entry of entries) {
    // Accept both real directories and symlinks to directories
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const pluginDir = join(dir, entry.name)

    // Try index.js first, then index.ts, then package.json main
    const candidates = [join(pluginDir, 'dist', 'index.js'), join(pluginDir, 'index.js')]

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        try {
          const plugin = await loadPlugin(candidate)
          plugins.push(plugin)
          break
        } catch (err) {
          console.warn(`Failed to load plugin from ${candidate}:`, err)
        }
      }
    }
  }

  return plugins
}
