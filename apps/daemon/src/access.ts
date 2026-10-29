/**
 * Who may use the MCP endpoint: personal tokens and OAuth grants.
 *
 * OpenBridge has no database, so this is one JSON file, `access.json` in the
 * state directory, written atomically with mode 600. Only hashes of secrets are
 * stored. The file is re-read whenever it changes on disk, so a token made with
 * `openbridge token create` on the host works without restarting the daemon.
 *
 * Two scopes, and they are the whole permission model of the endpoint:
 *
 *   - `openbridge:read` sees devices, history, events, observations and logs.
 *   - `openbridge:control` also runs device controls and writes HomeKit
 *     characteristics, which move physical things (a gate, a heat pump).
 *
 * Control implies read. Nothing here reaches plugin installs, config, the
 * shell or updates: those stay behind the dashboard.
 *
 * The OAuth half follows Tally's (tally/apps/api/src/services/oauth.service.ts):
 * public clients only, S256 PKCE only, exact redirect matching, codes single
 * use for five minutes, access tokens for an hour, refresh tokens rotating on
 * every use.
 */

import { createHash, randomBytes, randomUUID } from 'crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs'
import { dirname } from 'path'

export const READ_SCOPE = 'openbridge:read'
export const CONTROL_SCOPE = 'openbridge:control'
export const SCOPES = [READ_SCOPE, CONTROL_SCOPE] as const
export type Scope = (typeof SCOPES)[number]
export type Access = 'read' | 'control'

/** Every OpenBridge credential starts with this, so a leaked one is recognisable on sight. */
export const TOKEN_PREFIX = 'obt_'
const PERSONAL_PREFIX = `${TOKEN_PREFIX}pat_`
const ACCESS_PREFIX = `${TOKEN_PREFIX}mcp_`
const REFRESH_PREFIX = `${TOKEN_PREFIX}ref_`
const CODE_PREFIX = `${TOKEN_PREFIX}code_`

const CODE_TTL_MS = 5 * 60 * 1000
const ACCESS_TTL_MS = 60 * 60 * 1000
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** A client that registered and was never approved is dropped after this. */
const UNUSED_CLIENT_TTL_MS = 3 * 24 * 60 * 60 * 1000
/** The most never-approved clients held at once. Registration is unauthenticated by design. */
export const MAX_UNUSED_CLIENTS = 100
/** lastUsedAt is written at most this often, so a busy agent does not rewrite the file per call. */
const LAST_USED_GRANULARITY_MS = 60 * 1000

export function scopesFor(access: Access): Scope[] {
  return access === 'control' ? [READ_SCOPE, CONTROL_SCOPE] : [READ_SCOPE]
}

export function accessOf(scopes: readonly string[]): Access {
  return scopes.includes(CONTROL_SCOPE) ? 'control' : 'read'
}

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

function randomSecret(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`
}

/** PKCE: base64url(SHA-256(verifier)), unpadded, per RFC 7636. */
export function s256Challenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

/** https for the world, plain http only for loopback tooling (Claude Code listens on localhost). */
export function acceptableRedirect(uri: string): boolean {
  try {
    const u = new URL(uri)
    if (u.protocol === 'https:') return true
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')
  } catch {
    return false
  }
}

/** Who made a token or approved a connector: the signed-in person, or `local` when sign-in is off. */
export interface Owner {
  id: string
  email: string | null
}

interface TokenRow {
  id: string
  name: string
  hash: string
  scopes: Scope[]
  owner: Owner
  createdAt: string
  lastUsedAt: string | null
}

interface ClientRow {
  id: string
  name: string
  redirectUris: string[]
  createdAt: string
  usedAt: string | null
}

interface CodeRow {
  hash: string
  clientId: string
  owner: Owner
  redirectUri: string
  challenge: string
  scopes: Scope[]
  expiresAt: string
  usedAt: string | null
}

interface GrantRow {
  id: string
  clientId: string
  owner: Owner
  accessHash: string
  refreshHash: string
  scopes: Scope[]
  accessExpiresAt: string
  refreshExpiresAt: string
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}

interface AccessFile {
  tokens: TokenRow[]
  clients: ClientRow[]
  codes: CodeRow[]
  grants: GrantRow[]
}

/** What a credential resolves to. The MCP endpoint needs nothing else. */
export interface Credential {
  kind: 'personal' | 'oauth'
  name: string
  scopes: Scope[]
  owner: Owner
  /** Stable across refreshes, so a retried write op is recognised as the same caller. */
  id: string
}

export interface TokenPair {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
  refresh_token: string
  scope: string
}

export type TokenResult = { ok: true; pair: TokenPair } | { ok: false; error: string }

const empty = (): AccessFile => ({ tokens: [], clients: [], codes: [], grants: [] })
const iso = (ms: number) => new Date(ms).toISOString()
const past = (at: string | null, now: number) => at !== null && Date.parse(at) <= now

export class AccessStore {
  private data: AccessFile = empty()
  private mtimeMs = -1

  constructor(private readonly path: string) {}

  /** Re-reads the file when it changed on disk, which is how the CLI's writes arrive. */
  private load(): AccessFile {
    let mtime = -1
    try {
      mtime = statSync(this.path).mtimeMs
    } catch {
      this.data = empty()
      this.mtimeMs = -1
      return this.data
    }
    if (mtime !== this.mtimeMs) {
      try {
        const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<AccessFile>
        this.data = { ...empty(), ...parsed }
      } catch {
        // A torn or hand-broken file grants nothing rather than crashing the daemon.
        this.data = empty()
      }
      this.mtimeMs = mtime
    }
    return this.data
  }

  /** Read, change, write. The file is replaced by rename, so a reader never sees half of it. */
  private mutate<T>(fn: (d: AccessFile, now: number) => T): T {
    const d = this.load()
    const now = Date.now()
    const out = fn(d, now)
    this.prune(d, now)
    const dir = dirname(this.path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const tmp = `${this.path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(d, null, 2), { mode: 0o600 })
    try {
      chmodSync(tmp, 0o600)
    } catch {
      // best effort: chmod fails on non-POSIX volumes
    }
    renameSync(tmp, this.path)
    this.mtimeMs = statSync(this.path).mtimeMs
    return out
  }

  private prune(d: AccessFile, now: number): void {
    d.codes = d.codes.filter((c) => !c.usedAt && !past(c.expiresAt, now))
    d.grants = d.grants.filter((g) => !g.revokedAt && !past(g.refreshExpiresAt, now))
    const live = new Set([...d.codes.map((c) => c.clientId), ...d.grants.map((g) => g.clientId)])
    d.clients = d.clients.filter(
      (c) => c.usedAt !== null || live.has(c.id) || now - Date.parse(c.createdAt) < UNUSED_CLIENT_TTL_MS,
    )
  }

  // ── Personal tokens ────────────────────────────────────────────────────────

  /** Creates a token and returns the raw value, the only time it exists outside the caller. */
  createToken(name: string, access: Access, owner: Owner): { id: string; token: string } {
    const token = randomSecret(PERSONAL_PREFIX)
    const id = randomUUID()
    this.mutate((d, now) => {
      d.tokens.push({
        id,
        name: name.trim().slice(0, 120) || 'Unnamed token',
        hash: hashToken(token),
        scopes: scopesFor(access),
        owner,
        createdAt: iso(now),
        lastUsedAt: null,
      })
    })
    return { id, token }
  }

  /**
   * Every token on this bridge. A bridge is one household's: whoever can sign in
   * to the dashboard can already open its shell, so nobody's tokens are hidden
   * from another person who manages it.
   */
  listTokens() {
    return this.load().tokens.map((t) => ({
      id: t.id,
      name: t.name,
      access: accessOf(t.scopes),
      owner: t.owner.email,
      createdAt: t.createdAt,
      lastUsedAt: t.lastUsedAt,
    }))
  }

  /** Deleted outright: a personal token has no refresh to refuse later. */
  revokeToken(id: string): boolean {
    if (!this.load().tokens.some((t) => t.id === id)) return false
    return this.mutate((d) => {
      const before = d.tokens.length
      d.tokens = d.tokens.filter((t) => t.id !== id)
      return d.tokens.length < before
    })
  }

  // ── Resolving a bearer ─────────────────────────────────────────────────────

  verify(raw: string): Credential | null {
    if (!raw.startsWith(TOKEN_PREFIX)) return null
    const hash = hashToken(raw)
    const d = this.load()
    const now = Date.now()

    const token = d.tokens.find((t) => t.hash === hash)
    if (token) {
      this.touch('tokens', token.id, token.lastUsedAt, now)
      return { kind: 'personal', name: token.name, scopes: token.scopes, owner: token.owner, id: `token:${token.id}` }
    }

    if (!raw.startsWith(ACCESS_PREFIX)) return null
    const grant = d.grants.find((g) => g.accessHash === hash)
    if (!grant || grant.revokedAt || past(grant.accessExpiresAt, now)) return null
    this.touch('grants', grant.id, grant.lastUsedAt, now)
    const client = d.clients.find((c) => c.id === grant.clientId)
    return {
      kind: 'oauth',
      name: client?.name ?? 'Connector',
      scopes: grant.scopes,
      owner: grant.owner,
      id: `oauth:${grant.id}`,
    }
  }

  private touch(kind: 'tokens' | 'grants', id: string, last: string | null, now: number): void {
    if (last && now - Date.parse(last) < LAST_USED_GRANULARITY_MS) return
    this.mutate((d) => {
      const row = (d[kind] as Array<{ id: string; lastUsedAt: string | null }>).find((r) => r.id === id)
      if (row) row.lastUsedAt = iso(now)
    })
  }

  // ── OAuth: registration ────────────────────────────────────────────────────

  registerClient(body: {
    redirect_uris?: unknown
    client_name?: unknown
  }): { ok: true; id: string; name: string; uris: string[] } | { ok: false; error: string; description: string } {
    const uris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter((u): u is string => typeof u === 'string')
      : []
    if (uris.length === 0 || !uris.every(acceptableRedirect)) {
      return {
        ok: false,
        error: 'invalid_redirect_uri',
        description: 'redirect_uris must be https URLs, or http on localhost',
      }
    }
    const name = ((typeof body.client_name === 'string' && body.client_name.trim()) || 'Unnamed client').slice(0, 120)
    return this.mutate((d, now) => {
      this.prune(d, now)
      if (d.clients.filter((c) => c.usedAt === null).length >= MAX_UNUSED_CLIENTS) {
        return {
          ok: false as const,
          error: 'temporarily_unavailable',
          description: 'Registration is paused. Try again later.',
        }
      }
      const id = randomUUID()
      d.clients.push({ id, name, redirectUris: uris, createdAt: iso(now), usedAt: null })
      return { ok: true as const, id, name, uris }
    })
  }

  /**
   * The client, when this exact redirect is one it registered. Exact match,
   * never a prefix: "starts with" is the classic open redirect.
   */
  client(clientId: string, redirectUri: string): { id: string; name: string } | null {
    const c = this.load().clients.find((x) => x.id === clientId)
    if (!c || !c.redirectUris.includes(redirectUri)) return null
    return { id: c.id, name: c.name }
  }

  // ── OAuth: code and token ──────────────────────────────────────────────────

  issueCode(p: { clientId: string; redirectUri: string; codeChallenge: string; access: Access }, owner: Owner): string {
    const code = randomSecret(CODE_PREFIX)
    this.mutate((d, now) => {
      d.codes.push({
        hash: hashToken(code),
        clientId: p.clientId,
        owner,
        redirectUri: p.redirectUri,
        challenge: p.codeChallenge,
        scopes: scopesFor(p.access),
        expiresAt: iso(now + CODE_TTL_MS),
        usedAt: null,
      })
      // A person approved this client, so it is in use and is never pruned.
      const client = d.clients.find((c) => c.id === p.clientId)
      if (client && !client.usedAt) client.usedAt = iso(now)
    })
    return code
  }

  private pair(scopes: Scope[]): { access: string; refresh: string; pair: TokenPair } {
    const access = randomSecret(ACCESS_PREFIX)
    const refresh = randomSecret(REFRESH_PREFIX)
    return {
      access,
      refresh,
      pair: {
        access_token: access,
        token_type: 'Bearer',
        expires_in: Math.floor(ACCESS_TTL_MS / 1000),
        refresh_token: refresh,
        scope: scopes.join(' '),
      },
    }
  }

  /** grant_type=authorization_code. Every check here fails open if omitted. */
  exchangeCode(get: (k: string) => string): TokenResult {
    const hash = hashToken(get('code'))
    return this.mutate((d, now): TokenResult => {
      const row = d.codes.find((c) => c.hash === hash)
      if (!row || row.usedAt || past(row.expiresAt, now)) return { ok: false, error: 'invalid_grant' }
      if (row.clientId !== get('client_id')) return { ok: false, error: 'invalid_grant' }
      // Repeated here so a code minted for one target cannot be redeemed while claiming another.
      if (row.redirectUri !== get('redirect_uri')) return { ok: false, error: 'invalid_grant' }
      // The proof. Without it the code alone is enough, which is why PKCE exists for public clients.
      if (s256Challenge(get('code_verifier')) !== row.challenge) return { ok: false, error: 'invalid_grant' }
      // Single use. The whole read-change-write runs synchronously, so two
      // requests racing with one code cannot both get past this line.
      row.usedAt = iso(now)

      const { access, refresh, pair } = this.pair(row.scopes)
      d.grants.push({
        id: randomUUID(),
        clientId: row.clientId,
        owner: row.owner,
        accessHash: hashToken(access),
        refreshHash: hashToken(refresh),
        scopes: row.scopes,
        accessExpiresAt: iso(now + ACCESS_TTL_MS),
        refreshExpiresAt: iso(now + REFRESH_TTL_MS),
        createdAt: iso(now),
        lastUsedAt: null,
        revokedAt: null,
      })
      return { ok: true, pair }
    })
  }

  /** grant_type=refresh_token. Rotates, so the presented token dies here. */
  refresh(get: (k: string) => string): TokenResult {
    const hash = hashToken(get('refresh_token'))
    return this.mutate((d, now): TokenResult => {
      const row = d.grants.find((g) => g.refreshHash === hash)
      if (!row || row.revokedAt || past(row.refreshExpiresAt, now)) return { ok: false, error: 'invalid_grant' }
      if (get('client_id') && get('client_id') !== row.clientId) return { ok: false, error: 'invalid_grant' }
      const { access, refresh, pair } = this.pair(row.scopes)
      row.accessHash = hashToken(access)
      row.refreshHash = hashToken(refresh)
      row.accessExpiresAt = iso(now + ACCESS_TTL_MS)
      row.refreshExpiresAt = iso(now + REFRESH_TTL_MS)
      return { ok: true, pair }
    })
  }

  // ── Connected applications ─────────────────────────────────────────────────

  /**
   * One row per client rather than per grant: authorising Claude twice makes
   * two grants for what the person thinks of as one connection, and a revoke
   * that left the sibling alive would be a revoke that did not work.
   */
  listConnections() {
    const d = this.load()
    const now = Date.now()
    const byClient = new Map<
      string,
      {
        clientId: string
        name: string
        scopes: Set<Scope>
        owners: Set<string>
        connectedAt: string
        lastUsedAt: string | null
      }
    >()
    for (const g of d.grants) {
      if (g.revokedAt || past(g.refreshExpiresAt, now)) continue
      const app = byClient.get(g.clientId) ?? {
        clientId: g.clientId,
        name: d.clients.find((c) => c.id === g.clientId)?.name ?? 'Connector',
        scopes: new Set<Scope>(),
        owners: new Set<string>(),
        connectedAt: g.createdAt,
        lastUsedAt: null,
      }
      for (const s of g.scopes) app.scopes.add(s)
      if (g.owner.email) app.owners.add(g.owner.email)
      if (g.createdAt < app.connectedAt) app.connectedAt = g.createdAt
      if (g.lastUsedAt && (!app.lastUsedAt || g.lastUsedAt > app.lastUsedAt)) app.lastUsedAt = g.lastUsedAt
      byClient.set(g.clientId, app)
    }
    return [...byClient.values()]
      .sort((a, b) => b.connectedAt.localeCompare(a.connectedAt))
      .map((a) => ({
        clientId: a.clientId,
        name: a.name,
        access: accessOf([...a.scopes]),
        owners: [...a.owners],
        connectedAt: a.connectedAt,
        lastUsedAt: a.lastUsedAt,
      }))
  }

  /** Revokes every live grant of one client, including its refresh tokens. */
  revokeConnection(clientId: string): boolean {
    if (!this.load().grants.some((g) => g.clientId === clientId && !g.revokedAt)) return false
    return this.mutate((d, now) => {
      let n = 0
      for (const g of d.grants) {
        if (g.clientId === clientId && !g.revokedAt) {
          g.revokedAt = iso(now)
          n++
        }
      }
      return n > 0
    })
  }
}

export function extractBearer(header: string | undefined): string | null {
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header)
  return match ? match[1]!.trim() : null
}
