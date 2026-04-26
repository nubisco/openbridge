import { z } from 'zod'

export const PluginConfigSchema = z.record(z.unknown())

export const PlatformConfigSchema = z
  .object({
    platform: z.string(),
    plugin: z.string().optional(), // path to the plugin's main JS file
    enabled: z.boolean().default(true),
  })
  .and(z.record(z.unknown()))

export const BridgeConfigSchema = z.object({
  name: z.string().default('OpenBridge'),
  port: z.number().int().min(1024).max(65535).default(8582),
  hapPort: z.number().int().min(1024).max(65535).default(51829),
  pincode: z.string().default('031-45-154'),
  username: z.string().optional(),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
})

export const OpenBridgeConfigSchema = z.object({
  bridge: BridgeConfigSchema.default({}),
  plugins: z
    .array(
      z.object({
        name: z.string(),
        path: z.string().optional(),
        enabled: z.boolean().default(true),
        config: PluginConfigSchema.optional().default({}),
      }),
    )
    .default([]),
  platforms: z.array(PlatformConfigSchema).default([]),
  localPluginSources: z.array(z.string()).default([]),
})

export type OpenBridgeConfig = z.infer<typeof OpenBridgeConfigSchema>
export type BridgeConfig = z.infer<typeof BridgeConfigSchema>
export type PluginEntry = OpenBridgeConfig['plugins'][number]
export type PlatformConfig = z.infer<typeof PlatformConfigSchema>
