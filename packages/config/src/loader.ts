import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname } from 'path'
import { OpenBridgeConfigSchema, type OpenBridgeConfig } from './schema.js'

export async function loadConfig(configPath: string): Promise<OpenBridgeConfig> {
  if (!existsSync(configPath)) {
    return OpenBridgeConfigSchema.parse({})
  }

  const raw = await readFile(configPath, 'utf-8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`Invalid JSON in config file: ${configPath}`)
  }

  const result = OpenBridgeConfigSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(`Config validation failed: ${result.error.message}`)
  }

  return result.data
}

export async function saveConfig(configPath: string, config: OpenBridgeConfig): Promise<void> {
  const dir = dirname(configPath)
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true })
  }
  await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8')
}

export function defaultConfigPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '.'
  return `${home}/.openbridge/config.json`
}
