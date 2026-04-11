import { FastifyInstance } from 'fastify';
import { AEEscalationService } from '../services/ae-escalation';

export function registerEscalationRoutes(
  app: FastifyInstance,
  service: AEEscalationService,
) {
  /** GET /api/escalation-inbox?escalated_to=&site_id=&priority=&acknowledged=&limit=&offset= */
  app.get<{
    Querystring: {
      escalated_to?: string;
      site_id?: string;
      priority?: string;
      acknowledged?: string;
      limit?: string;
      offset?: string;
    };
  }>('/api/escalation-inbox', (req, reply) => {
    const q = req.query;
    const acknowledged =
      q.acknowledged === 'true' ? true : q.acknowledged === 'false' ? false : undefined;

    const summary = service.getInbox({
      escalatedTo: q.escalated_to,
      siteId: q.site_id,
      priority: q.priority,
      acknowledged,
      limit: q.limit ? parseInt(q.limit, 10) : undefined,
      offset: q.offset ? parseInt(q.offset, 10) : undefined,
    });

    return reply.send(summary);
  });

  /** POST /api/escalations — create a new escalation */
  app.post<{
    Body: {
      adverse_event_id: string;
      escalated_by: string;
      escalated_to: string;
      priority: 'standard' | 'urgent' | 'critical';
      reason: string;
      action_required?: string;
    };
  }>('/api/escalations', (req, reply) => {
    const b = req.body;
    if (!b.adverse_event_id || !b.escalated_by || !b.escalated_to || !b.reason) {
      return reply.status(400).send({ error: 'Missing required fields' });
    }
    const esc = service.createEscalation({
      adverseEventId: b.adverse_event_id,
      escalatedBy: b.escalated_by,
      escalatedTo: b.escalated_to,
      priority: b.priority || 'standard',
      reason: b.reason,
      actionRequired: b.action_required,
    });
    return reply.status(201).send(esc);
  });

  /** POST /api/escalations/:id/acknowledge */
  app.post<{ Params: { id: string } }>(
    '/api/escalations/:id/acknowledge',
    (req, reply) => {
      const result = service.acknowledge(req.params.id);
      if (!result) {
        return reply
          .status(404)
          .send({ error: 'Escalation not found or already acknowledged' });
      }
      return reply.send(result);
    },
  );

  /** POST /api/escalations/:id/resolve */
  app.post<{ Params: { id: string }; Body: { resolution_note: string } }>(
    '/api/escalations/:id/resolve',
    (req, reply) => {
      if (!req.body.resolution_note) {
        return reply.status(400).send({ error: 'resolution_note is required' });
      }
      const result = service.resolve(req.params.id, req.body.resolution_note);
      if (!result) {
        return reply.status(404).send({ error: 'Escalation not found' });
      }
      return reply.send(result);
    },
  );
}
