import chalk from 'chalk'
import { apiGet, checkDaemon } from '../api.js'
import type { PluginInstance } from '@nubisco/openbridge-core'

export async function pluginsListCommand() {
  const alive = await checkDaemon()
  if (!alive) {
    console.error(chalk.red('Daemon is not running. Start it with: openbridge start'))
    process.exit(1)
  }

  const { plugins } = await apiGet<{ plugins: PluginInstance[] }>('/api/plugins')

  if (plugins.length === 0) {
    console.log(chalk.yellow('No plugins loaded.'))
    return
  }

  console.log(chalk.bold('\nLoaded plugins:\n'))
  for (const plugin of plugins) {
    const statusColorMap: Record<string, typeof chalk.green> = {
      running: chalk.green,
      stopped: chalk.gray,
      error: chalk.red,
      loading: chalk.yellow,
      idle: chalk.gray,
    }
    const statusColor = statusColorMap[plugin.status] ?? chalk.white

    console.log(`  ${chalk.cyan(plugin.manifest.name)} ${chalk.gray('v' + plugin.manifest.version)}`)
    console.log(`    Status: ${statusColor(plugin.status)}`)
    if (plugin.manifest.description) {
      console.log(`    ${chalk.gray(plugin.manifest.description)}`)
    }
    console.log()
  }
}

export async function pluginsInstallCommand(name: string) {
  console.log(chalk.yellow(`Plugin installation via npm coming soon.`))
  console.log(`To install manually: npm install ${name}`)
}
