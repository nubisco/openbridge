#!/usr/bin/env node
import { Daemon } from './daemon.js'
import { Logger } from '@openbridge/logger'

const log = Logger.create('system')

// Prevent plugin errors from crashing the daemon
process.on('uncaughtException', (err) => {
  log.error(`Uncaught exception: ${err?.message ?? err}`)
})
process.on('unhandledRejection', (reason) => {
  log.error(`Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`)
})

const portEnv = process.env.OPENBRIDGE_PORT ? parseInt(process.env.OPENBRIDGE_PORT, 10) : undefined

const daemon = new Daemon()
daemon.start({ port: portEnv }).catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
