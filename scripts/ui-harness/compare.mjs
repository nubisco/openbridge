// Pixel-for-pixel comparison of two screenshot folders from shoot.mjs.
//
//   node compare.mjs <beforeDir> <afterDir> [diffDir]
//
// Writes a diff image for every screenshot that differs and exits non-zero if
// any does. The rail avatar's initials antialias differently from run to run
// (a few to about 13 px), so read small diffs before treating them as real.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'

const [before, after, diffDir = join(after, '..', 'diff')] = process.argv.slice(2)
if (!before || !after) {
  console.error('usage: node compare.mjs <beforeDir> <afterDir> [diffDir]')
  process.exit(2)
}
mkdirSync(diffDir, { recursive: true })

let differing = 0
for (const file of readdirSync(before).filter((f) => f.endsWith('.png'))) {
  const a = PNG.sync.read(readFileSync(join(before, file)))
  let b
  try {
    b = PNG.sync.read(readFileSync(join(after, file)))
  } catch {
    console.log('MISSING', file)
    differing++
    continue
  }
  if (a.width !== b.width || a.height !== b.height) {
    console.log('SIZE', file, `${a.width}x${a.height} -> ${b.width}x${b.height}`)
    differing++
    continue
  }
  const diff = new PNG({ width: a.width, height: a.height })
  const n = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0 })
  if (n) {
    differing++
    writeFileSync(join(diffDir, file), PNG.sync.write(diff))
    console.log('DIFF', file, n, 'px')
  }
}
console.log(differing ? `${differing} differ, diffs in ${diffDir}` : 'all identical')
process.exit(differing ? 1 : 0)
