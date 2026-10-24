import { describe, it, expect } from 'vitest'
import { acceptNameClaim } from '../auth.js'

describe('acceptNameClaim', () => {
  it('keeps a display name, trimmed', () => {
    expect(acceptNameClaim('  Ada Lovelace ')).toBe('Ada Lovelace')
  })

  it('drops an absent, empty or non-string claim', () => {
    expect(acceptNameClaim(undefined)).toBeUndefined()
    expect(acceptNameClaim('')).toBeUndefined()
    expect(acceptNameClaim('   ')).toBeUndefined()
    expect(acceptNameClaim(42)).toBeUndefined()
  })

  it('drops a name long enough to bloat the session cookie', () => {
    expect(acceptNameClaim('a'.repeat(201))).toBeUndefined()
  })
})
