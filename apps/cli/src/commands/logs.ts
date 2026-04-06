import chalk from 'chalk'
import { apiGet, checkDaemon } from '../api.js'
import type { LogEntry } from '@openbridge/logger'

export async function logsCommand(options: { plugin?: string; follow?: boolean }) {
  const alive = await checkDaemon()
  if (!alive) {
    console.error(chalk.red('Daemon is not running. Start it with: openbridge start'))
    process.exit(1)
  }

  // Fetch existing logs
  const query = new URLSearchParams()
  if (options.plugin) query.set('plugin', options.plugin)
  query.set('limit', '100')

  const { entries } = await apiGet<{ entries: LogEntry[] }>(`/api/logs?${query}`)

  for (const entry of entries) {
    printEntry(entry)
  }

  if (options.follow) {
    console.log(chalk.gray('\n--- Following live logs (Ctrl+C to stop) ---\n'))
    const ws = new WebSocket('ws://localhost:8581/ws/logs')
    ws.onmessage = (event) => {
      const entry = JSON.parse(event.data as string) as LogEntry
      if (!options.plugin || entry.plugin === options.plugin) {
        printEntry(entry)
      }
    }
    ws.onerror = () => {
      console.error(chalk.red('WebSocket error. Is the daemon running?'))
      process.exit(1)
    }
    // Keep alive
    await new Promise(() => {})
  }
}

function printEntry(entry: LogEntry) {
  const color =
    { debug: chalk.gray, info: chalk.cyan, warn: chalk.yellow, error: chalk.red }[entry.level] ?? chalk.white
  const pluginTag = entry.plugin !== 'system' ? chalk.magenta(`[${entry.plugin}] `) : ''
  const time = new Date(entry.timestamp).toLocaleTimeString()
  console.log(`${chalk.gray(time)} ${color(`[${entry.level.toUpperCase()}]`)} ${pluginTag}${entry.message}`)
}
