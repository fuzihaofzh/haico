import { FastifyInstance } from 'fastify';
import { ReservationEngine } from '../services/reservation-engine';
import { ReserveRequest } from '../models/types';

export function registerInventoryRoutes(app: FastifyInstance, engine: ReservationEngine) {
  // Reserve stock
  app.post<{ Body: ReserveRequest }>('/api/inventory/reserve', async (request, reply) => {
    const { product_id, customer_id, quantity, ttl_seconds } = request.body;

    if (!product_id || !customer_id || !quantity) {
      return reply.status(400).send({ error: 'Missing required fields: product_id, customer_id, quantity' });
    }

    const result = engine.reserve({ product_id, customer_id, quantity, ttl_seconds });

    if (!result.success) {
      const statusMap: Record<string, number> = {
        OUT_OF_STOCK: 409,
        CUSTOMER_LIMIT: 429,
        RATE_LIMITED: 429,
        INVALID_REQUEST: 400,
      };
      const status = statusMap[result.code ?? ''] ?? 500;
      const headers: Record<string, string> = {};
      if (result.retry_after_ms) {
        headers['Retry-After'] = String(Math.ceil(result.retry_after_ms / 1000));
      }
      return reply.status(status).headers(headers).send(result);
    }

    return reply.status(201).send(result);
  });

  // Confirm reservation (checkout complete)
  app.post<{ Params: { id: string } }>('/api/inventory/reservations/:id/confirm', async (request, reply) => {
    const result = engine.confirm(request.params.id);
    if (!result.success) {
      return reply.status(409).send(result);
    }
    return reply.send(result);
  });

  // Release reservation (cancel / timeout)
  app.post<{ Params: { id: string } }>('/api/inventory/reservations/:id/release', async (request, reply) => {
    const result = engine.release(request.params.id);
    if (!result.success) {
      return reply.status(409).send(result);
    }
    return reply.send(result);
  });

  // Get reservation status
  app.get<{ Params: { id: string } }>('/api/inventory/reservations/:id', async (request, reply) => {
    const reservation = engine.getReservation(request.params.id);
    if (!reservation) {
      return reply.status(404).send({ error: 'Reservation not found' });
    }
    return reply.send(reservation);
  });

  // Get product inventory snapshot
  app.get<{ Params: { id: string } }>('/api/inventory/products/:id', async (request, reply) => {
    const snapshot = engine.getInventory(request.params.id);
    if (!snapshot) {
      return reply.status(404).send({ error: 'Product not found' });
    }
    return reply.send(snapshot);
  });

  // Admin: trigger expired reservation cleanup
  app.post('/api/inventory/cleanup', async (_request, reply) => {
    const count = engine.cleanupExpired();
    return reply.send({ expired_count: count });
  });
}
