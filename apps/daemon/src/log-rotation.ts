import { closeSync, fstatSync, ftruncateSync, openSync, readFileSync, readSync, readlinkSync, writeFileSync } from 'fs'

/**
 * Keeping the daemon's own log from filling the disk.
 *
 * OpenBridge does not open this file. Whatever starts it redirects stdout,
 * which on the reference Raspberry Pi is OpenRC's `--stdout /var/log/openbridge.log`,
 * so the daemon inherits a descriptor and writes to it forever. Nothing rotates
 * it. One install reached 102 MB and 343,446 lines on an SD card with no
 * logrotate and no cron installed, which is the normal state of a minimal
 * Alpine image rather than a misconfiguration.
 *
 * Shipping a logrotate config would not have helped there: it would have needed
 * logrotate and a cron daemon that are not present, on a host whose packages
 * are not ours to add. So the daemon looks after its own output instead, which
 * works wherever it is started from and needs nothing installed.
 *
 * The mechanism is copytruncate, for the reason copytruncate exists: renaming
 * the file would leave every holder of the descriptor writing to an unlinked
 * inode, and the visible log would stop growing while the disk kept filling.
 * Truncating in place keeps the descriptor valid. It relies on the redirect
 * being append-mode, which is what a shell `>` redirect and every supervisor
 * use, and is verified before truncating rather than assumed: without O_APPEND
 * the file offset survives the truncation and the next write lands at the old
 * position, producing a sparse file that reports its old size.
 */

/** Rotate when the log passes this. */
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024
/** How much of the tail to carry into the .1 file. */
const DEFAULT_KEEP_BYTES = 4 * 1024 * 1024

/**
 * What a rotation attempt did. `skipped` means the descriptor is a regular file
 * that grew past the limit, but truncating it would not reclaim anything.
 */
export type RotateResult = 'rotated' | 'not-needed' | 'not-a-file' | 'skipped'

export interface RotateOptions {
  maxBytes?: number
  keepBytes?: number
  /**
   * Where the descriptor points, when the caller already knows. Otherwise it is
   * read from procfs, which not every host has. Only the tail copy needs it:
   * the truncation itself works on the descriptor alone.
   */
  path?: string
  /** Called with what happened, for the log that is about to be truncated. */
  onRotate?: (message: string) => void
}

/**
 * Rotate the file behind a descriptor, if it has grown past the limit.
 *
 * Returns what it did, so a caller can report it and a test can assert it
 * without reaching into the filesystem.
 */
export function rotateIfLarge(fd: number, options: RotateOptions = {}): RotateResult {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const keepBytes = options.keepBytes ?? DEFAULT_KEEP_BYTES

  let stat
  try {
    stat = fstatSync(fd)
  } catch {
    return 'not-a-file'
  }
  // A pipe, a socket or a tty. Under systemd this is the journal, which does
  // its own rotation and must not be truncated.
  if (!stat.isFile()) return 'not-a-file'
  if (stat.size <= maxBytes) return 'not-needed'

  const path = options.path ?? descriptorPath(fd)

  // Carry the tail over, so a rotation triggered in the middle of an incident
  // does not throw away the part someone is about to need.
  if (path && keepBytes > 0) {
    try {
      const start = Math.max(0, stat.size - keepBytes)
      const buffer = Buffer.alloc(Math.min(keepBytes, stat.size))
      const source = openSync(path, 'r')
      try {
        readSync(source, buffer, 0, buffer.length, start)
      } finally {
        closeSync(source)
      }
      writeFileSync(`${path}.1`, buffer)
    } catch {
      // Losing the tail is a worse log, not a worse outcome than a full disk.
    }
  }

  // Without O_APPEND the offset survives the truncation and the next write
  // lands past the end, so nothing is reclaimed and the file reports its old
  // size. Refuse on positive evidence of that, and only that: procfs is how
  // the flags are read, and a host without it (macOS, BSD) would otherwise
  // never rotate at all, which is the problem this exists to solve.
  const flags = descriptorFlags(fd)
  if (flags !== null && (flags & 0o2000) === 0) return 'skipped'

  ftruncateSync(fd, 0)
  options.onRotate?.(
    `Log reached ${Math.round(stat.size / 1024 / 1024)} MB and was truncated` +
      (path ? `; the last ${Math.round(keepBytes / 1024 / 1024)} MB are in ${path}.1` : ''),
  )
  return 'rotated'
}

/** Where a descriptor points, on a host that exposes it. Null elsewhere. */
export function descriptorPath(fd: number): string | null {
  try {
    return readlinkSync(`/proc/self/fd/${fd}`)
  } catch {
    return null
  }
}

/**
 * True when the descriptor was opened append-only.
 *
 * Without it, truncating leaves the file offset where it was and the next write
 * lands past the end, so the file reports its old size and nothing is reclaimed.
 */
export function isAppendMode(fd: number): boolean {
  const flags = descriptorFlags(fd)
  return flags !== null && (flags & 0o2000) !== 0
}

/** The open flags of a descriptor, from procfs. Null where that is unavailable. */
function descriptorFlags(fd: number): number | null {
  try {
    const text = readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8')
    const flags = /flags:\s*(\d+)/.exec(text)?.[1]
    return flags ? parseInt(flags, 8) : null
  } catch {
    return null
  }
}
