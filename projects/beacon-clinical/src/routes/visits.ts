import { FastifyInstance } from 'fastify';
import { VisitSummaryService } from '../services/visit-summaries';

export function registerVisitRoutes(
  app: FastifyInstance,
  service: VisitSummaryService,
) {
  /** GET /api/sites/:siteId/visit-summaries?from=YYYY-MM-DD&to=YYYY-MM-DD */
  app.get<{
    Params: { siteId: string };
    Querystring: { from?: string; to?: string };
  }>('/api/sites/:siteId/visit-summaries', (req, reply) => {
    const { siteId } = req.params;
    const today = new Date().toISOString().slice(0, 10);
    const fromDate = req.query.from || today;
    // Default to 7-day look-ahead
    const toDate =
      req.query.to ||
      new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

    const summaries = service.getUpcomingSummaries(siteId, fromDate, toDate);
    return reply.send({
      site_id: siteId,
      date_range: { from: fromDate, to: toDate },
      count: summaries.length,
      summaries,
    });
  });

  /** GET /api/visits/:visitId/preparation-summary */
  app.get<{ Params: { visitId: string } }>(
    '/api/visits/:visitId/preparation-summary',
    (req, reply) => {
      const summary = service.getSummaryById(req.params.visitId);
      if (!summary) {
        return reply.status(404).send({ error: 'Visit not found' });
      }
      return reply.send(summary);
    },
  );
}
