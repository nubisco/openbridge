#!/usr/bin/env node
import { Command } from 'commander'
import { startCommand } from './commands/start.js'
import { pluginsListCommand, pluginsInstallCommand } from './commands/plugins.js'
import { logsCommand } from './commands/logs.js'
import { initCommand } from './commands/init.js'

const program = new Command()

program.name('openbridge').description('OpenBridge - A modern, local-first home automation bridge').version('0.1.0')

program.command('init [dir]').description('Initialize an OpenBridge instance').action(initCommand)

program
  .command('start')
  .description('Start the OpenBridge daemon')
  .option('-c, --config <path>', 'Path to config file')
  .option('-p, --port <port>', 'HTTP API port')
  .option('-d, --detach', 'Run in background')
  .action(startCommand)

const plugins = program.command('plugins')
plugins.description('Manage plugins')

plugins.command('list').description('List loaded plugins').action(pluginsListCommand)

plugins.command('install <name>').description('Install a plugin').action(pluginsInstallCommand)

program
  .command('logs')
  .description('View logs')
  .option('-p, --plugin <name>', 'Filter by plugin name')
  .option('-f, --follow', 'Follow live logs')
  .action(logsCommand)

program.parse()
