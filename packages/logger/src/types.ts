export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  timestamp: string
  level: LogLevel
  plugin: string
  message: string
  args?: unknown[]
}

export type LogListener = (entry: LogEntry) => void
