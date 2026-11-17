import { describe, expect, it } from 'vitest'
import { packageAuthor } from '../package-author.js'

describe('packageAuthor', () => {
  it('reads an author object', () => {
    expect(packageAuthor({ author: { name: 'bwp91', email: 'x@y.z' } })).toBe('bwp91')
  })
  it('keeps only the name of an npm author string', () => {
    expect(packageAuthor({ author: 'Nubisco <hello@example.com> (https://example.com)' })).toBe('Nubisco')
    expect(packageAuthor({ author: 'Nubisco' })).toBe('Nubisco')
  })
  it('is empty when there is no author', () => {
    expect(packageAuthor({})).toBe('')
    expect(packageAuthor({ author: 42 })).toBe('')
  })
})
