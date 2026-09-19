import { describe, it, expect, afterEach } from 'vitest'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { rotateIfLarge } from '../log-rotation.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs.length = 0
})

function makeLog(bytes: number): { fd: number; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ob-log-'))
  dirs.push(dir)
  const path = join(dir, 'openbridge.log')
  // 'a' so the descriptor is append-mode, the way a supervisor's redirect is.
  const fd = openSync(path, 'a')
  if (bytes > 0) writeSync(fd, Buffer.alloc(bytes, 0x61))
  return { fd, path }
}

describe('rotateIfLarge', () => {
  it('leaves a log that is still small alone', () => {
    const { fd, path } = makeLog(1024)
    expect(rotateIfLarge(fd, { maxBytes: 8192 })).toBe('not-needed')
    expect(statSync(path).size).toBe(1024)
    closeSync(fd)
  })

  it('truncates one that has grown past the limit', () => {
    // The real case: 102 MB on an SD card, nothing rotating it.
    const { fd, path } = makeLog(16384)
    expect(rotateIfLarge(fd, { maxBytes: 8192, keepBytes: 1024 })).toBe('rotated')
    expect(statSync(path).size).toBe(0)
    closeSync(fd)
  })

  it('carries the tail over, so an incident in progress is not thrown away', () => {
    const { fd, path } = makeLog(0)
    writeSync(fd, Buffer.alloc(8192, 0x61))
    writeSync(fd, Buffer.from('THE-INTERESTING-PART'))

    rotateIfLarge(fd, { maxBytes: 4096, keepBytes: 2048, path })

    expect(existsSync(`${path}.1`)).toBe(true)
    expect(readFileSync(`${path}.1`, 'utf8')).toContain('THE-INTERESTING-PART')
    closeSync(fd)
  })

  it('keeps writing to the same descriptor afterwards', () => {
    // The whole reason for truncating rather than renaming: a rename leaves
    // every holder of the descriptor writing to an unlinked inode, so the
    // visible log stops growing while the disk keeps filling.
    const { fd, path } = makeLog(16384)
    rotateIfLarge(fd, { maxBytes: 8192, keepBytes: 512, path })
    writeSync(fd, Buffer.from('after rotation\n'))

    expect(readFileSync(path, 'utf8')).toBe('after rotation\n')
    closeSync(fd)
  })

  it('refuses to touch something that is not a regular file', () => {
    // Under systemd this is the journal, which rotates itself.
    expect(rotateIfLarge(1, { maxBytes: 0 })).toBe('not-a-file')
  })

  it('says what it did, for the line written just before the truncation', () => {
    const { fd } = makeLog(16384)
    let said = ''
    rotateIfLarge(fd, { maxBytes: 8192, keepBytes: 1024, onRotate: (m) => (said = m) })
    expect(said).toMatch(/truncated/)
    closeSync(fd)
  })
})
