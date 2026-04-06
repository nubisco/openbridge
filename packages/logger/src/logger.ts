import { format } from 'util'
import type { LogLevel, LogEntry, LogListener } from './types.js'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

export class Logger {
  private static listeners: LogListener[] = []
  private static minLevel: LogLevel = 'info'
  private static maxEntries = 1000
  private static entries: LogEntry[] = []

  static setLevel(level: LogLevel) {
    this.minLevel = level
  }

  static subscribe(listener: LogListener) {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener)
    }
  }

  static getEntries(plugin?: string, limit = 200): LogEntry[] {
    const filtered = plugin ? this.entries.filter((e) => e.plugin === plugin) : this.entries
    return filtered.slice(-limit)
  }

  static clear() {
    this.entries = []
  }

  static create(plugin: string) {
    const log = (level: LogLevel, message: string, args: unknown[]) => {
      if (LEVEL_ORDER[level] < LEVEL_ORDER[Logger.minLevel]) return

      // Resolve printf-style placeholders (%s, %d, %o) used by Homebridge plugins
      const formatted = args.length > 0 ? format(message, ...args) : message

      const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        level,
        plugin,
        message: formatted,
      }

      Logger.entries.push(entry)
      if (Logger.entries.length > Logger.maxEntries) {
        Logger.entries.shift()
      }

      Logger.listeners.forEach((l) => l(entry))

      // Also write to stdout with color
      const color = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' }[level]
      const reset = '\x1b[0m'
      const pluginTag = plugin !== 'system' ? `\x1b[35m[${plugin}]\x1b[0m ` : ''
      const levelTag = `${color}[${level.toUpperCase()}]${reset}`
      console.log(`${entry.timestamp} ${levelTag} ${pluginTag}${formatted}`)
    }

    return {
      debug: (message: string, ...args: unknown[]) => log('debug', message, args),
      info: (message: string, ...args: unknown[]) => log('info', message, args),
      warn: (message: string, ...args: unknown[]) => log('warn', message, args),
      error: (message: string, ...args: unknown[]) => log('error', message, args),
    }
  }
}
