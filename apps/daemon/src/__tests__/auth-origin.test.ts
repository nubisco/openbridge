import { describe, it, expect } from 'vitest'
import { resolveAuthOrigin } from '../auth.js'

describe('resolveAuthOrigin', () => {
  it('uses PLATFORM_AUTH_ORIGIN when it is set, without a trailing slash', () => {
    expect(resolveAuthOrigin('https://platform.nubisco.io', 'https://auth.example/')).toBe('https://auth.example')
  })

  it("sends Nubisco's issuer to Accord's auth host", () => {
    expect(resolveAuthOrigin('https://platform.nubisco.io', undefined)).toBe('https://auth.nubisco.io')
  })

  it('falls back to any other issuer', () => {
    expect(resolveAuthOrigin('https://id.example', undefined)).toBe('https://id.example')
    expect(resolveAuthOrigin('https://id.example', '  ')).toBe('https://id.example')
  })

  it('is null when no issuer is configured', () => {
    expect(resolveAuthOrigin(null, undefined)).toBeNull()
  })
})
