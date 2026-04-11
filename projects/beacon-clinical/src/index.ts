import Fastify from 'fastify';
import { initDatabase } from './models/schema';
import { VisitSummaryService } from './services/visit-summaries';
import { AEEscalationService } from './services/ae-escalation';
import { registerVisitRoutes } from './routes/visits';
import { registerEscalationRoutes } from './routes/escalations';

const PORT = parseInt(process.env.BEACON_PORT || '4590', 10);
const DB_PATH = process.env.BEACON_DB_PATH || undefined;

async function main() {
  const db = initDatabase(DB_PATH);
  const visitService = new VisitSummaryService(db);
  const escalationService = new AEEscalationService(db);

  const app = Fastify({ logger: true });

  registerVisitRoutes(app, visitService);
  registerEscalationRoutes(app, escalationService);

  app.get('/api/health', (_req, reply) => {
    reply.send({ status: 'ok', service: 'beacon-clinical-ops' });
  });

  app.addHook('onClose', () => {
    db.close();
  });

  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`Beacon Clinical Operations API running on port ${PORT}`);
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
