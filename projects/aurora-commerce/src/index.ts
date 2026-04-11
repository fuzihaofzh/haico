import Fastify from 'fastify';
import { initDatabase } from './models/schema';
import { ReservationEngine } from './services/reservation-engine';
import { registerInventoryRoutes } from './routes/inventory';
import { registerPromotionBuilderRoutes } from './routes/promotion-builder';

const PORT = parseInt(process.env.AURORA_PORT || '4580', 10);
const DB_PATH = process.env.AURORA_DB_PATH || undefined;

async function main() {
  const db = initDatabase(DB_PATH);
  const engine = new ReservationEngine(db);
  engine.startCleanupTimer();

  const app = Fastify({ logger: true });
  registerInventoryRoutes(app, engine);
  registerPromotionBuilderRoutes(app);

  app.addHook('onClose', () => {
    engine.stopCleanupTimer();
    db.close();
  });

  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`Aurora Commerce Inventory API running on port ${PORT}`);
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
