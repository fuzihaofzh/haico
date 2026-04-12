import Database from 'better-sqlite3';
import Fastify, { FastifyInstance } from 'fastify';
import { initDatabase } from './models/schema';
import { VisitSummaryService } from './services/visit-summaries';
import { AEEscalationService } from './services/ae-escalation';
import { registerVisitRoutes } from './routes/visits';
import { registerEscalationRoutes } from './routes/escalations';
import { registerUIRoutes } from './routes/ui';

const PORT = parseInt(process.env.BEACON_PORT || '4590', 10);
const DB_PATH = process.env.BEACON_DB_PATH || undefined;

export function buildApp(options?: {
  db?: Database.Database;
  dbPath?: string;
}): FastifyInstance {
  const db = options?.db ?? initDatabase(options?.dbPath ?? DB_PATH);
  const ownsDatabase = !options?.db;
  const visitService = new VisitSummaryService(db);
  const escalationService = new AEEscalationService(db);

  const app = Fastify({ logger: true });

  registerVisitRoutes(app, visitService);
  registerEscalationRoutes(app, escalationService);
  registerUIRoutes(app, db, visitService, escalationService);

  app.get('/api/health', (_req, reply) => {
    reply.send({ status: 'ok', service: 'beacon-clinical-ops' });
  });

  if (ownsDatabase) {
    app.addHook('onClose', () => {
      db.close();
    });
  }

  return app;
}

async function main() {
  const app = buildApp();
  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`Beacon Clinical Operations API running on port ${PORT}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Failed to start:', err);
    process.exit(1);
  });
}
