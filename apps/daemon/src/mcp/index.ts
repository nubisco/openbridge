/**
 * MCP over Streamable HTTP, stateless: POST /mcp with JSON-RPC 2.0, after
 * Acta's and Tally's (acta/server/src/mcp/index.ts, tally/apps/api/src/mcp/).
 * No sessions, no SSE, no server-initiated messages, tools only.
 *
 * A token is always required here, even when dashboard sign-in is off and the
 * rest of the API is open on the network: an agent driving physical devices
 * must never reach an unauthenticated endpoint. Tokens come from Settings, from
 * `openbridge token create` on the host, or from the OAuth flow in oauth.ts.
 *
 * Error convention, as in the sibling Nubisco servers: a bad argument, a
 * missing scope or a refusal from the service is a SUCCESSFUL JSON-RPC result
 * with `isError: true`, because the model must read it. Only an unknown method
 * or tool is a JSON-RPC error.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { extractBearer, type AccessStore, type Credential } from '../access.js'
import { OPENBRIDGE_VERSION } from '../version.js'
import type { BridgeContext } from '../services/bridge.js'
import { MCP_TOOLS, isRefusal, toolInputSchema, type McpContext, type McpTool } from './tools.js'

const PROTOCOL_VERSION = '2025-06-18'

export function mcpInstructions(origin: string): string {
  return [
    'OpenBridge is a home automation bridge: it runs the plugins that talk to the devices in this home and records what they report.',
    'Start with `overview`: one call gives every device with its current readings and health, and the ids the other tools take.',
    '`device_history` answers questions over time (energy used this week, the lowest temperature last night) and returns the summary already computed: quote it rather than recomputing.',
    '`device_events` says what happened and what caused it, `logs` says what the plugins reported.',
    '`device_control` moves physical things: confirm with the person before opening, unlocking or switching anything they did not explicitly ask for.',
    `A device page is ${origin}/devices/{id}.`,
  ].join(' ')
}

interface JsonRpcRequest {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  params?: Record<string, unknown>
}

const rpcResult = (id: number | string | null, result: unknown) => ({ jsonrpc: '2.0' as const, id, result })
const rpcError = (id: number | string | null, code: number, message: string) => ({
  jsonrpc: '2.0' as const,
  id,
  error: { code, message },
})
const toolError = (text: string) => ({ content: [{ type: 'text', text }], isError: true })
const toolOk = (result: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(result ?? null) }] })

export async function handleMcpRequest(
  ctx: McpContext,
  req: JsonRpcRequest,
  tools: McpTool[] = MCP_TOOLS,
): Promise<unknown> {
  const id = req.id ?? null
  switch (req.method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: {
          name: 'openbridge',
          title: 'OpenBridge',
          version: OPENBRIDGE_VERSION,
          websiteUrl: 'https://docs.nubisco.io/openbridge/',
          icons: [
            { src: `${ctx.origin}/logo.svg`, mimeType: 'image/svg+xml' },
            { src: `${ctx.origin}/android-chrome-192x192.png`, mimeType: 'image/png', sizes: ['192x192'] },
            { src: `${ctx.origin}/android-chrome-512x512.png`, mimeType: 'image/png', sizes: ['512x512'] },
          ],
        },
        instructions: mcpInstructions(ctx.origin),
      })
    case 'ping':
      return rpcResult(id, {})
    case 'tools/list':
      return rpcResult(id, {
        // Every tool is listed, whatever the token carries: a read-only token
        // that calls device_control is told why, which beats a tool that is
        // silently missing.
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: toolInputSchema(t),
          ...(t.write ? {} : { annotations: { readOnlyHint: true } }),
        })),
      })
    case 'tools/call':
      return handleToolCall(ctx, tools, req, id)
    default:
      if (req.method?.startsWith('notifications/')) return undefined
      return rpcError(id, -32601, `method not found: ${String(req.method)}`)
  }
}

async function handleToolCall(
  ctx: McpContext,
  tools: McpTool[],
  req: JsonRpcRequest,
  id: number | string | null,
): Promise<unknown> {
  const name = req.params?.name as string | undefined
  const tool = tools.find((t) => t.name === name)
  if (!tool) return rpcError(id, -32602, `unknown tool ${String(name)}`)
  if (!ctx.credential.scopes.includes(tool.scope)) {
    return rpcResult(
      id,
      toolError(
        `This token is read-only, and ${tool.name} needs control access. ` +
          'Ask the person to create a token with control access under Settings, or to reconnect and allow control.',
      ),
    )
  }

  const parsed = tool.schema.safeParse(req.params?.arguments ?? {})
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(arguments)'}: ${i.message}`).join('; ')
    return rpcResult(id, toolError(`invalid arguments: ${issues}`))
  }

  try {
    return rpcResult(id, toolOk(await tool.handler(parsed.data as never, ctx)))
  } catch (err) {
    if (isRefusal(err)) return rpcResult(id, toolError(err.message))
    throw err
  }
}

/**
 * Whether this bridge serves the MCP endpoint at all. Off unless
 * OPENBRIDGE_MCP says otherwise: an agent that can operate a home is
 * something its owner turns on, not something an update turns on for them.
 * Off, none of /mcp, the OAuth routes or token management exist.
 */
export function isMcpEnabled(value: string | undefined): boolean {
  const flag = value?.toLowerCase().trim()
  return flag === 'on' || flag === 'true' || flag === '1' || flag === 'yes'
}

/**
 * This bridge as clients reach it. OPENBRIDGE_PUBLIC_URL when it sits behind a
 * proxy or a tunnel, otherwise the address the request came in on, which on a
 * home network is the one the client already used.
 */
export function publicOrigin(req: FastifyRequest): string {
  const configured = process.env.OPENBRIDGE_PUBLIC_URL?.trim().replace(/\/+$/, '')
  if (configured) return configured
  return `${req.protocol}://${req.host}`
}

export interface McpDeps {
  bridge: BridgeContext
  store: AccessStore
  bridgeName: () => string | null
}

export async function registerMcpRoutes(app: FastifyInstance, deps: McpDeps): Promise<void> {
  function credentialOf(req: FastifyRequest): Credential | null {
    const raw = extractBearer(req.headers.authorization)
    return raw ? deps.store.verify(raw) : null
  }

  /**
   * The 401 carries the RFC 9728 pointer, which is what turns a refusal into
   * an instruction: without it a connector cannot tell how to sign in.
   */
  function unauthorized(req: FastifyRequest, reply: FastifyReply) {
    return reply
      .status(401)
      .header(
        'WWW-Authenticate',
        `Bearer resource_metadata="${publicOrigin(req)}/.well-known/oauth-protected-resource/mcp"`,
      )
      .send({ error: 'Unauthorized: send an OpenBridge token as a Bearer header, or connect through OAuth' })
  }

  app.post('/mcp', async (req, reply) => {
    const credential = credentialOf(req)
    if (!credential) return unauthorized(req, reply)
    const ctx: McpContext = {
      bridge: deps.bridge,
      credential,
      origin: publicOrigin(req),
      bridgeName: deps.bridgeName,
    }
    const batch = Array.isArray(req.body)
    const messages = (batch ? req.body : [req.body]) as JsonRpcRequest[]
    const responses: unknown[] = []
    for (const message of messages) {
      if (typeof message !== 'object' || message === null) {
        responses.push(rpcError(null, -32600, 'invalid request'))
        continue
      }
      const response = await handleMcpRequest(ctx, message)
      if (response !== undefined && message.id !== undefined) responses.push(response)
    }
    if (responses.length === 0) return reply.status(202).send()
    return reply.send(batch ? responses : responses[0])
  })

  // Stateless: no server-initiated stream, and no session to delete.
  app.get('/mcp', async (req, reply) => {
    if (!credentialOf(req)) return unauthorized(req, reply)
    return reply.status(405).send({ error: 'stateless server; POST JSON-RPC' })
  })
  app.delete('/mcp', async (_req, reply) => reply.status(200).send())
}
