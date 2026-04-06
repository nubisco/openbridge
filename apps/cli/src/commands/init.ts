import { existsSync } from 'fs'
import { writeFile, mkdir } from 'fs/promises'
import { resolve } from 'path'
import chalk from 'chalk'

export async function initCommand(dir: string = '.') {
  const targetDir = resolve(dir)

  console.log(chalk.cyan(`Initializing OpenBridge in ${targetDir}...`))

  // Create config
  const configDir = resolve(targetDir, '.openbridge')
  const configPath = resolve(configDir, 'config.json')

  if (!existsSync(configDir)) {
    await mkdir(configDir, { recursive: true })
  }

  if (existsSync(configPath)) {
    console.log(chalk.yellow('Config already exists, skipping.'))
  } else {
    const defaultConfig = {
      bridge: {
        name: 'My OpenBridge',
        port: 8582,
        logLevel: 'info',
      },
      plugins: [],
    }
    await writeFile(configPath, JSON.stringify(defaultConfig, null, 2))
    console.log(chalk.green(`Created config: ${configPath}`))
  }

  // Create plugins dir
  const pluginsDir = resolve(targetDir, '.openbridge', 'plugins')
  if (!existsSync(pluginsDir)) {
    await mkdir(pluginsDir, { recursive: true })
    console.log(chalk.green(`Created plugins dir: ${pluginsDir}`))
  }

  console.log(chalk.bold('\nOpenBridge initialized!'))
  console.log(`\nNext steps:`)
  console.log(`  ${chalk.cyan('openbridge start')}  - Start the daemon`)
  console.log(`  ${chalk.cyan('openbridge plugins:list')}  - List loaded plugins`)
}
