import { describe, it, expect } from 'vitest'
import { acceptPictureClaim } from '../auth.js'

const ISSUER = 'https://platform.nubisco.io'
const GOOD = `${ISSUER}/api/avatars/3f9c0a1e5b7d4c2a8e6f1b0d9c3a7e52`

describe('acceptPictureClaim', () => {
  it('keeps an avatar served by the issuer', () => {
    expect(acceptPictureClaim(ISSUER, GOOD)).toBe(GOOD)
  })

  it('keeps it when the issuer was configured with a trailing slash', () => {
    expect(acceptPictureClaim(`${ISSUER}/`, GOOD)).toBe(GOOD)
  })

  it('refuses a URL on another origin', () => {
    // The value becomes an <img src> on every page, so a foreign host would
    // have this app announce the viewer to whoever controls it.
    expect(acceptPictureClaim(ISSUER, 'https://evil.example/api/avatars/abc')).toBeUndefined()
    expect(acceptPictureClaim(ISSUER, 'http://platform.nubisco.io/api/avatars/abc')).toBeUndefined()
    expect(acceptPictureClaim(ISSUER, 'https://platform.nubisco.io.evil.example/api/avatars/abc')).toBeUndefined()
  })

  it('refuses a path outside the avatar service', () => {
    expect(acceptPictureClaim(ISSUER, `${ISSUER}/api/tokens/abc`)).toBeUndefined()
    expect(acceptPictureClaim(ISSUER, `${ISSUER}/`)).toBeUndefined()
    expect(acceptPictureClaim(ISSUER, `${ISSUER}/api/avatars`)).toBeUndefined()
  })

  it('refuses credentials in the URL', () => {
    // No business in an image source, and a sign the value was not built by
    // the platform.
    expect(acceptPictureClaim(ISSUER, 'https://user:pw@platform.nubisco.io/api/avatars/abc')).toBeUndefined()
    expect(acceptPictureClaim(ISSUER, 'https://user@platform.nubisco.io/api/avatars/abc')).toBeUndefined()
  })

  it('treats an absent or empty claim as no avatar', () => {
    // The platform omits the claim entirely for someone with no avatar, so
    // absent means "no avatar" and must clear anything stored, never be read
    // as "unchanged".
    expect(acceptPictureClaim(ISSUER, undefined)).toBeUndefined()
    expect(acceptPictureClaim(ISSUER, '')).toBeUndefined()
    expect(acceptPictureClaim(ISSUER, null)).toBeUndefined()
    expect(acceptPictureClaim(ISSUER, 42)).toBeUndefined()
  })

  it('refuses anything when no issuer is configured', () => {
    expect(acceptPictureClaim(null, GOOD)).toBeUndefined()
  })

  it('refuses a value that is not a URL at all', () => {
    expect(acceptPictureClaim(ISSUER, '/api/avatars/abc')).toBeUndefined()
    expect(acceptPictureClaim(ISSUER, 'not a url')).toBeUndefined()
  })
})
