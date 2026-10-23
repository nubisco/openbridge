import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { MINIMUM_NODE_VERSION, nodeVersionWarning } from '../node-version.js'

describe('nodeVersionWarning', () => {
  it.each(['v20.19.0', 'v22.0.0', 'v22.23.3', 'v21.9.9', 'v18.20.4'])('warns on %s', (version) => {
    const warning = nodeVersionWarning(version)
    expect(warning).toContain(version)
    expect(warning).toContain(MINIMUM_NODE_VERSION)
    // The message must say why, not only that the version is old.
    expect(warning).toMatch(/end of life/)
    expect(warning).toMatch(/security release/)
  })

  it.each(['v22.23.4', 'v22.23.10', 'v22.24.0', 'v23.0.0', 'v24.0.0', 'v26.1.2'])('accepts %s', (version) => {
    expect(nodeVersionWarning(version)).toBeNull()
  })

  it('stays quiet on a version string it cannot read', () => {
    expect(nodeVersionWarning('nightly')).toBeNull()
  })

  it('matches engines.node in the published package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
    expect(pkg.engines.node).toBe(`>=${MINIMUM_NODE_VERSION}`)
  })
})
