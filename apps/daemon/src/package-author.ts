/**
 * The author a package.json names, as a person reads it: the `name` of an
 * author object, or the name part of npm's "Name <email> (url)" string.
 */
export function packageAuthor(pkg: { author?: unknown }): string {
  const a = pkg.author
  if (a && typeof a === 'object' && typeof (a as { name?: unknown }).name === 'string') {
    return (a as { name: string }).name.trim()
  }
  if (typeof a === 'string') return a.replace(/<[^>]*>|\([^)]*\)/g, '').trim()
  return ''
}
