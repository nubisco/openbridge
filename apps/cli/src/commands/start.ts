import { spawn } from 'child_process'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import chalk from 'chalk'

const __dirname = dirname(fileURLToPath(import.meta.url))

export async function startCommand(options: { config?: string; port?: string; detach?: boolean }) {
  console.log(chalk.cyan('Starting OpenBridge daemon...'))

  // Find daemon bin
  const daemonPath = resolve(__dirname, '../../../daemon/dist/index.js')

  const args = ['--experimental-vm-modules', daemonPath]
  const env: Record<string, string> = { ...(process.env as Record<string, string>) }

  if (options.config) env.OPENBRIDGE_CONFIG = options.config
  if (options.port) env.OPENBRIDGE_PORT = options.port

  const proc = spawn('node', args, {
    stdio: 'inherit',
    detached: options.detach ?? false,
    env,
  })

  if (options.detach) {
    proc.unref()
    console.log(chalk.green(`Daemon started in background (PID: ${proc.pid})`))
  } else {
    proc.on('exit', (code) => {
      if (code !== 0) {
        console.error(chalk.red(`Daemon exited with code ${code}`))
        process.exit(code ?? 1)
      }
    })
  }
}
