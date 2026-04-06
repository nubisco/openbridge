#!/usr/bin/env node
/**
 * Fixes execute permission on node-pty's spawn-helper binary.
 * pnpm does not preserve +x on prebuild binaries, causing posix_spawnp to fail.
 */
import { existsSync, chmodSync } from 'fs'
import { createRequire } from 'module'
import { dirname, resolve, join } from 'path'

const req = createRequire(import.meta.url)
try {
  const nodePtyMain = req.resolve('node-pty')
  const nodePtyDir = resolve(dirname(nodePtyMain), '..')
  const arch = `${process.platform}-${process.arch}`
  const spawnHelper = join(nodePtyDir, 'prebuilds', arch, 'spawn-helper')
  if (existsSync(spawnHelper)) {
    chmodSync(spawnHelper, 0o755)
    console.log(`[postinstall] Fixed execute permission on ${spawnHelper}`)
  }
} catch (e) {
  // node-pty not installed yet or not needed on this platform
}
