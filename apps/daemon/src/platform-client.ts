/**
 * Inlined from @nubisco/platform-sdk/src/client.ts.
 * Copied directly to avoid pulling a private GitHub Packages dep into this
 * OSS image. Keep in sync with platform/shared/src/client.ts when the
 * platform SDK changes.
 *
 * Verifies RS256 JWTs issued by the Nubisco Platform using the platform's
 * /.well-known/jwks.json. No external dependency required: WebCrypto only.
 */

export interface TPlatformClientOptions {
  /** Base URL of the Nubisco Platform, e.g. https://platform.nubisco.io */
  issuer: string
  /** JWKS cache TTL in milliseconds. Defaults to 300 000 (5 min). */
  cacheTtlMs?: number
}

export interface TJwtClaims {
  sub: string
  email: string
  role: string
  plan?: string
  plan_status?: string
  iat: number
  exp: number
  iss: string
}

interface IJwkKey {
  kid: string
  kty: string
  alg: string
  use: string
  n: string
  e: string
}

interface IJwtHeader {
  alg: string
  kid?: string
}

function base64urlDecode(input: string): ArrayBuffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/')
  const padLen = (4 - (padded.length % 4)) % 4
  const b64 = padded + '='.repeat(padLen)
  const binary = atob(b64)
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  return bytes.buffer as ArrayBuffer
}

function base64urlToUtf8(input: string): string {
  return new TextDecoder().decode(new Uint8Array(base64urlDecode(input)))
}

export class PlatformClient {
  private readonly issuer: string
  private readonly cacheTtlMs: number
  private jwksCache: { keys: IJwkKey[]; fetchedAt: number } | null = null
  private importedKeys: Map<string, CryptoKey> = new Map()

  constructor(options: TPlatformClientOptions) {
    this.issuer = options.issuer.replace(/\/$/, '')
    this.cacheTtlMs = options.cacheTtlMs ?? 300_000
  }

  private async fetchJwks(): Promise<IJwkKey[]> {
    const now = Date.now()
    if (this.jwksCache && now - this.jwksCache.fetchedAt < this.cacheTtlMs) {
      return this.jwksCache.keys
    }
    const res = await fetch(`${this.issuer}/.well-known/jwks.json`)
    if (!res.ok) throw new Error(`Failed to fetch JWKS: ${res.status}`)
    const data = (await res.json()) as { keys: IJwkKey[] }
    this.jwksCache = { keys: data.keys, fetchedAt: now }
    this.importedKeys.clear()
    return data.keys
  }

  private async getVerifyKey(kid: string): Promise<CryptoKey> {
    const cached = this.importedKeys.get(kid)
    if (cached) return cached
    const keys = await this.fetchJwks()
    const jwk = keys.find((k) => k.kid === kid)
    if (!jwk) {
      // Force-refresh JWKS once on cache miss in case the platform rotated.
      this.jwksCache = null
      const refreshed = await this.fetchJwks()
      const retried = refreshed.find((k) => k.kid === kid)
      if (!retried) throw new Error(`No JWKS key found for kid: ${kid}`)
      return this.importKey(retried)
    }
    return this.importKey(jwk)
  }

  private async importKey(jwk: IJwkKey): Promise<CryptoKey> {
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, [
      'verify',
    ])
    this.importedKeys.set(jwk.kid, key)
    return key
  }

  async verify(token: string): Promise<TJwtClaims> {
    const parts = token.split('.')
    if (parts.length !== 3) throw new Error('Malformed JWT')
    const [headerB64, payloadB64, signatureB64] = parts as [string, string, string]

    const header = JSON.parse(base64urlToUtf8(headerB64)) as IJwtHeader
    if (header.alg !== 'RS256') throw new Error(`Unsupported algorithm: ${header.alg}`)
    if (!header.kid) throw new Error('JWT missing kid')

    const key = await this.getVerifyKey(header.kid)
    const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`)
    const signature = base64urlDecode(signatureB64)

    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signingInput)
    if (!valid) throw new Error('JWT signature verification failed')

    const claims = JSON.parse(base64urlToUtf8(payloadB64)) as TJwtClaims
    const now = Math.floor(Date.now() / 1000)
    if (claims.exp < now) throw new Error('JWT expired')
    if (claims.iss !== this.issuer) throw new Error(`JWT issuer mismatch: expected ${this.issuer}`)
    return claims
  }
}
