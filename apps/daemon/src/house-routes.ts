/**
 * The house plan's HTTP surface.
 *
 *   GET /api/house  { plan, rev, updatedAt }, with plan null until one is drawn
 *   PUT /api/house  { plan, rev } replaces the plan. `rev` is the revision the
 *                   caller read: 409 if somebody saved since, 400 if the plan
 *                   does not hold together. Answers with the new state.
 *
 * The auth hook in auth.ts gates both when sign-in is on.
 */
import type { FastifyInstance } from 'fastify'
import { HouseConflictError, HouseValidationError, type HouseStore } from './house.js'

export function registerHouseRoutes(app: FastifyInstance, store: HouseStore): void {
  app.get('/api/house', async () => store.get())

  app.put<{ Body: { plan?: unknown; rev?: unknown } | undefined }>(
    '/api/house',
    { bodyLimit: 2 * 1024 * 1024 },
    async (req, reply) => {
      const body = req.body
      if (!body || typeof body !== 'object' || !('plan' in body)) {
        return reply.code(400).send({ error: 'Send { plan, rev }' })
      }
      if (typeof body.rev !== 'number' || !Number.isInteger(body.rev)) {
        return reply.code(400).send({ error: 'rev must be the revision you read' })
      }
      try {
        return store.set(body.plan, body.rev)
      } catch (err) {
        if (err instanceof HouseValidationError) return reply.code(400).send({ error: err.message })
        if (err instanceof HouseConflictError) return reply.code(409).send({ error: err.message, ...store.get() })
        throw err
      }
    },
  )
}
