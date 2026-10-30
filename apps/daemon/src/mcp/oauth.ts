/**
 * The OAuth surface for MCP connectors, after Tally's (tally/apps/api/src/routes/oauth.ts):
 * discovery, registration, consent and token. Plus the dashboard's own routes
 * for managing tokens and connections.
 *
 * The consent screen is a page of the dashboard (OAuthConsentView.vue), built
 * from the design system. Every decision stays here: /oauth/context says
 * whether a request is well formed and who would approve it, and the approval
 * posts back to POST /oauth/authorize, which revalidates from scratch.
 *
 * Who may approve: the signed-in person when dashboard sign-in is on. When it
 * is off, the dashboard is open to the network and so is this screen, exactly
 * as anyone who can open the dashboard can already create a token in Settings.
 * Either way the approval must come from the dashboard itself (see
 * sameOrigin), so a web page elsewhere cannot approve on someone's behalf.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { SCOPES, type Access, type AccessStore, type Owner } from '../access.js'
import { readSession, type TAuthConfig } from '../auth.js'
import { publicOrigin } from './index.js'

const AUTHORIZE_FIELDS = [
  'client_id',
  'redirect_uri',
  'response_type',
  'scope',
  'state',
  'code_challenge',
  'code_challenge_method',
] as const

/** Reads a field from a query string or a parsed form, as a string. */
function getter(source: unknown): (k: string) => string {
  const record = (source ?? {}) as Record<string, unknown>
  return (k) => {
    const v = record[k]
    return typeof v === 'string' ? v : ''
  }
}

/**
 * Whether a state-changing request came from this bridge's own pages.
 *
 * With sign-in off the dashboard has no cookie to protect it, and CORS here
 * reflects any origin, so without this check any web page a person on the
 * home network opens could mint a token and read it back. Browsers send
 * Sec-Fetch-Site and Origin on every POST; a request with neither is not from
 * a browser, and a non-browser caller cannot ride on anyone's visit.
 */
export function sameOrigin(req: FastifyRequest): boolean {
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== '') {
    let host: string
    try {
      host = new URL(origin).host
    } catch {
      return false
    }
    const allowed = new Set([req.host])
    try {
      allowed.add(new URL(publicOrigin(req)).host)
    } catch {
      // A malformed OPENBRIDGE_PUBLIC_URL only narrows what is accepted.
    }
    if (!allowed.has(host)) return false
  }
  return true
}

interface AuthorizeParams {
  clientId: string
  clientName: string
  redirectUri: string
  state: string
  codeChallenge: string
}

type AuthorizeCheck =
  | { ok: true; p: AuthorizeParams }
  /** Refuse in place: the redirect target is not proven, so following it is unsafe. */
  | { ok: false; kind: 'refuse'; message: string }
  /** Safe to report at the client's registered redirect. */
  | { ok: false; kind: 'redirect'; to: string }

function validateAuthorize(store: AccessStore, get: (k: string) => string): AuthorizeCheck {
  const redirectUri = get('redirect_uri')
  const client = store.client(get('client_id'), redirectUri)
  if (!client) return { ok: false, kind: 'refuse', message: 'Unknown client, or a redirect_uri it did not register' }
  const fail = (error: string): AuthorizeCheck => {
    const to = new URL(redirectUri)
    to.searchParams.set('error', error)
    if (get('state')) to.searchParams.set('state', get('state'))
    return { ok: false, kind: 'redirect', to: to.href }
  }
  if (get('response_type') !== 'code') return fail('unsupported_response_type')
  if (!get('code_challenge') || get('code_challenge_method') !== 'S256') return fail('invalid_request')
  return {
    ok: true,
    p: {
      clientId: client.id,
      clientName: client.name,
      redirectUri,
      state: get('state'),
      codeChallenge: get('code_challenge'),
    },
  }
}

/** Registration is unauthenticated by design (RFC 7591), so it is limited per address. */
const REGISTER_WINDOW_MS = 60 * 60 * 1000
const REGISTER_LIMIT = 20
const registrations = new Map<string, number[]>()

function registrationAllowed(ip: string, now = Date.now()): boolean {
  const recent = (registrations.get(ip) ?? []).filter((t) => now - t < REGISTER_WINDOW_MS)
  if (recent.length >= REGISTER_LIMIT) {
    registrations.set(ip, recent)
    return false
  }
  recent.push(now)
  registrations.set(ip, recent)
  return true
}

const LOCAL_OWNER: Owner = { id: 'local', email: null }

export interface OauthDeps {
  store: AccessStore
  authConfig: TAuthConfig
}

export async function registerOauthRoutes(app: FastifyInstance, deps: OauthDeps): Promise<void> {
  const { store, authConfig } = deps
  const signInOn = authConfig.enabled && !!authConfig.issuer

  /** The person acting, or null when sign-in is on and nobody is signed in. */
  function ownerOf(req: FastifyRequest): Owner | null {
    if (!signInOn) return LOCAL_OWNER
    const session = readSession(authConfig, req)
    return session ? { id: session.userId, email: session.email } : null
  }

  // Encapsulated so the form parser below applies to these routes only.
  await app.register(async (scope) => {
    // The token endpoint and the consent form both post
    // application/x-www-form-urlencoded, which Fastify does not parse by default.
    scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)))
    })

    // ── Discovery ──
    //
    // Both the plain and the path-inserted spellings: RFC 8414 inserts
    // .well-known between host and path, so a client discovering /mcp asks for
    // /.well-known/oauth-authorization-server/mcp too, and tries the OpenID
    // spelling of both. Answering only the bare path broke claude.ai on Acta.
    const asMeta = async (req: FastifyRequest) => {
      const origin = publicOrigin(req)
      return {
        issuer: origin,
        authorization_endpoint: `${origin}/oauth/authorize`,
        token_endpoint: `${origin}/oauth/token`,
        registration_endpoint: `${origin}/oauth/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: [...SCOPES],
      }
    }
    const prMeta = async (req: FastifyRequest) => {
      const origin = publicOrigin(req)
      return {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        bearer_methods_supported: ['header'],
        scopes_supported: [...SCOPES],
      }
    }
    for (const path of [
      '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-authorization-server/*',
      '/.well-known/openid-configuration',
      '/.well-known/openid-configuration/*',
      '/mcp/.well-known/oauth-authorization-server',
    ]) {
      scope.get(path, asMeta)
    }
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/*',
      '/mcp/.well-known/oauth-protected-resource',
    ]) {
      scope.get(path, prMeta)
    }

    // ── Registration ──
    scope.post('/oauth/register', async (req, reply) => {
      // Behind a Cloudflare tunnel every request arrives from the tunnel's
      // host, so the caller is the one Cloudflare names, or the whole
      // internet would share one allowance.
      const caller = req.headers['cf-connecting-ip']
      if (!registrationAllowed(typeof caller === 'string' && caller ? caller : req.ip)) {
        return reply.status(429).send({ error: 'slow_down', error_description: 'Too many registrations. Try later.' })
      }
      const body = req.body
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return reply.status(400).send({ error: 'invalid_client_metadata', error_description: 'Body must be JSON' })
      }
      const out = store.registerClient(body as Record<string, unknown>)
      if (!out.ok) {
        return reply
          .status(out.error === 'temporarily_unavailable' ? 503 : 400)
          .send({ error: out.error, error_description: out.description })
      }
      return reply.status(201).send({
        client_id: out.id,
        client_name: out.name,
        redirect_uris: out.uris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      })
    })

    // ── Consent ──

    /** Hands the request to the dashboard's consent screen, or reports a malformed one to the client. */
    scope.get('/oauth/authorize', async (req, reply) => {
      const get = getter(req.query)
      const check = validateAuthorize(store, get)
      if (!check.ok && check.kind === 'redirect') return reply.redirect(check.to, 302)
      const qs = new URLSearchParams()
      for (const k of AUTHORIZE_FIELDS) if (get(k)) qs.set(k, get(k))
      return reply.redirect(`/oauth/consent?${qs.toString()}`, 302)
    })

    /** What the consent screen needs to render honestly. */
    scope.get('/oauth/context', async (req) => {
      const check = validateAuthorize(store, getter(req.query))
      if (!check.ok) {
        return { ok: false, reason: check.kind === 'refuse' ? check.message : 'That request cannot be approved' }
      }
      const owner = ownerOf(req)
      return {
        ok: true,
        clientName: check.p.clientName,
        redirectHost: new URL(check.p.redirectUri).host,
        signInRequired: signInOn,
        email: owner?.email ?? null,
        signedIn: owner !== null,
      }
    })

    /** The decision, a real form post so the browser follows the redirect back to the client. */
    scope.post('/oauth/authorize', async (req, reply: FastifyReply) => {
      if (!sameOrigin(req)) return reply.status(403).type('text/plain').send('Approve from the OpenBridge dashboard')
      const get = getter(req.body)
      const check = validateAuthorize(store, get)
      if (!check.ok) {
        if (check.kind === 'redirect') return reply.redirect(check.to, 302)
        return reply.status(400).type('text/plain').send(check.message)
      }

      const owner = ownerOf(req)
      if (!owner) {
        const qs = new URLSearchParams()
        for (const k of AUTHORIZE_FIELDS) if (get(k)) qs.set(k, get(k))
        return reply.redirect(`/oauth/consent?${qs.toString()}`, 302)
      }

      if (get('decision') !== 'approve') {
        const to = new URL(check.p.redirectUri)
        if (check.p.state) to.searchParams.set('state', check.p.state)
        to.searchParams.set('error', 'access_denied')
        return reply.redirect(to.href, 302)
      }

      const access: Access = get('access') === 'control' ? 'control' : 'read'
      const code = store.issueCode({ ...check.p, access }, owner)
      const to = new URL(check.p.redirectUri)
      if (check.p.state) to.searchParams.set('state', check.p.state)
      to.searchParams.set('code', code)
      return reply.redirect(to.href, 302)
    })

    // ── Token ──
    scope.post('/oauth/token', async (req, reply) => {
      const get = getter(req.body)
      const grant = get('grant_type')
      const out =
        grant === 'authorization_code'
          ? store.exchangeCode(get)
          : grant === 'refresh_token'
            ? store.refresh(get)
            : ({ ok: false, error: 'unsupported_grant_type' } as const)
      reply.header('Cache-Control', 'no-store')
      if (!out.ok) return reply.status(400).send({ error: out.error })
      return out.pair
    })
  })

  // ── Dashboard: tokens and connections ──
  //
  // Under /api, so the session gate in auth.ts covers them when sign-in is on.
  // Never reachable with a token: a bearer opens /mcp and nothing else, so a
  // leaked token cannot mint another one or revoke the person's own.

  app.get('/api/access', async (req) => ({
    enabled: true,
    endpoint: `${publicOrigin(req)}/mcp`,
    tokens: store.listTokens(),
    connections: store.listConnections(),
  }))

  app.post('/api/access/tokens', async (req, reply) => {
    if (!sameOrigin(req)) return reply.status(403).send({ error: 'Create tokens from the OpenBridge dashboard' })
    const owner = ownerOf(req)
    if (!owner) return reply.status(401).send({ error: 'unauthenticated' })
    const { name, access } = (req.body ?? {}) as { name?: unknown; access?: unknown }
    if (typeof name !== 'string' || !name.trim()) return reply.status(400).send({ error: 'name is required' })
    if (access !== 'read' && access !== 'control') {
      return reply.status(400).send({ error: "access must be 'read' or 'control'" })
    }
    return store.createToken(name, access, owner)
  })

  app.delete('/api/access/tokens/:id', async (req, reply) => {
    if (!sameOrigin(req)) return reply.status(403).send({ error: 'Revoke tokens from the OpenBridge dashboard' })
    const { id } = req.params as { id: string }
    if (!store.revokeToken(id)) return reply.status(404).send({ error: 'token not found' })
    return { ok: true }
  })

  app.delete('/api/access/connections/:clientId', async (req, reply) => {
    if (!sameOrigin(req)) return reply.status(403).send({ error: 'Disconnect from the OpenBridge dashboard' })
    const { clientId } = req.params as { clientId: string }
    if (!store.revokeConnection(clientId)) return reply.status(404).send({ error: 'connection not found' })
    return { ok: true }
  })
}
