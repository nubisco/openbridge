#!/usr/bin/env node
import { OPENBRIDGE_VERSION } from './version.js'

// Argument handling runs before anything else: `openbridge --help` must never
// start a daemon or publish a HAP bridge on the local network as a side effect.
const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`openbridge ${OPENBRIDGE_VERSION}

Local-first home automation bridge. Starts the daemon, the HTTP API, and the
dashboard, and publishes a HomeKit (HAP) bridge on your local network.

Usage:
  openbridge [options]

Options:
  -p, --port <port>   HTTP API and dashboard port (default: 8582)
  -v, --version       Print the version and exit
  -h, --help          Print this help and exit

Environment:
  OPENBRIDGE_PORT     Same as --port
  OPENBRIDGE_HOME     State directory for config, plugins and HAP pairing
                      (default: ~/.openbridge)
  OPENBRIDGE_UI_PATH  Override the location of the built dashboard

Docs: https://github.com/nubisco/openbridge#readme`)
  process.exit(0)
}

if (argv.includes('--version') || argv.includes('-v')) {
  console.log(OPENBRIDGE_VERSION)
  process.exit(0)
}

function parsePort(): number | undefined {
  const i = argv.findIndex((a) => a === '--port' || a === '-p')
  const raw = i !== -1 ? argv[i + 1] : process.env.OPENBRIDGE_PORT
  if (!raw) return undefined
  const port = parseInt(raw, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`Invalid port: ${raw}`)
    process.exit(1)
  }
  return port
}

// Imported dynamically, and only once we know we are actually starting: pulling in
// the daemon loads Fastify, hap-nodejs and every plugin, which `--help` must not do.
const { Daemon } = await import('./daemon.js')
const { Logger } = await import('@nubisco/openbridge-logger')

const log = Logger.create('system')

// Prevent plugin errors from crashing the daemon
process.on('uncaughtException', (err) => {
  log.error(`Uncaught exception: ${err?.message ?? err}`)
})
process.on('unhandledRejection', (reason) => {
  log.error(`Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`)
})

const daemon = new Daemon()
daemon.start({ port: parsePort() }).catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
