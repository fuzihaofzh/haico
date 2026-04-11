import Database from 'better-sqlite3';
import { initDatabase } from '../src/models/schema';
import { ReservationEngine } from '../src/services/reservation-engine';
import { Product } from '../src/models/types';

function createTestDb(): Database.Database {
  return initDatabase(':memory:');
}

function seedProduct(db: Database.Database, overrides: Partial<Product> = {}): Product {
  const product: Product = {
    id: overrides.id ?? 'prod-001',
    sku: overrides.sku ?? 'FLASH-SHOE-001',
    name: overrides.name ?? 'Limited Edition Sneaker',
    total_stock: overrides.total_stock ?? 100,
    available_stock: overrides.available_stock ?? 100,
    reserved_stock: overrides.reserved_stock ?? 0,
    max_per_customer: overrides.max_per_customer ?? 2,
    flash_sale_active: overrides.flash_sale_active ?? 1,
    version: overrides.version ?? 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  db.prepare(`
    INSERT INTO products (id, sku, name, total_stock, available_stock, reserved_stock, max_per_customer, flash_sale_active, version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(product.id, product.sku, product.name, product.total_stock, product.available_stock,
    product.reserved_stock, product.max_per_customer, product.flash_sale_active, product.version);

  return product;
}

describe('ReservationEngine', () => {
  let db: Database.Database;
  let engine: ReservationEngine;

  beforeEach(() => {
    db = createTestDb();
    engine = new ReservationEngine(db, {
      reservation_ttl_seconds: 5,
      global_rate_limit: { max_tokens: 10000, refill_rate: 10000, refill_interval_ms: 1000 },
      per_customer_rate_limit: { max_tokens: 100, refill_rate: 100, refill_interval_ms: 1000 },
      per_product_rate_limit: { max_tokens: 10000, refill_rate: 10000, refill_interval_ms: 1000 },
      cleanup_interval_ms: 60000,
    });
    seedProduct(db);
  });

  afterEach(() => {
    engine.stopCleanupTimer();
    db.close();
  });

  describe('reserve()', () => {
    test('should successfully reserve stock', () => {
      const result = engine.reserve({ product_id: 'prod-001', customer_id: 'cust-1', quantity: 1 });
      expect(result.success).toBe(true);
      expect(result.reservation_id).toBeDefined();
      expect(result.expires_at).toBeDefined();
    });

    test('should deduct available_stock and increment reserved_stock', () => {
      engine.reserve({ product_id: 'prod-001', customer_id: 'cust-1', quantity: 2 });
      const snapshot = engine.getInventory('prod-001')!;
      expect(snapshot.available_stock).toBe(98);
      expect(snapshot.reserved_stock).toBe(2);
    });

    test('should reject when stock is insufficient', () => {
      seedProduct(db, { id: 'prod-low', sku: 'LOW-001', available_stock: 1, total_stock: 1, max_per_customer: 5 });
      const result = engine.reserve({ product_id: 'prod-low', customer_id: 'cust-1', quantity: 2 });
      expect(result.success).toBe(false);
      expect(result.code).toBe('OUT_OF_STOCK');
    });

    test('should enforce per-customer limit', () => {
      // max_per_customer is 2
      engine.reserve({ product_id: 'prod-001', customer_id: 'cust-1', quantity: 2 });
      const result = engine.reserve({ product_id: 'prod-001', customer_id: 'cust-1', quantity: 1 });
      expect(result.success).toBe(false);
      expect(result.code).toBe('CUSTOMER_LIMIT');
    });

    test('should allow different customers to reserve independently', () => {
      const r1 = engine.reserve({ product_id: 'prod-001', customer_id: 'cust-1', quantity: 2 });
      const r2 = engine.reserve({ product_id: 'prod-001', customer_id: 'cust-2', quantity: 2 });
      expect(r1.success).toBe(true);
      expect(r2.success).toBe(true);
      const snapshot = engine.getInventory('prod-001')!;
      expect(snapshot.available_stock).toBe(96);
      expect(snapshot.reserved_stock).toBe(4);
    });

    test('should reject invalid quantity', () => {
      const result = engine.reserve({ product_id: 'prod-001', customer_id: 'cust-1', quantity: 0 });
      expect(result.success).toBe(false);
      expect(result.code).toBe('INVALID_REQUEST');
    });

    test('should reject unknown product', () => {
      const result = engine.reserve({ product_id: 'nonexistent', customer_id: 'cust-1', quantity: 1 });
      expect(result.success).toBe(false);
      expect(result.code).toBe('INVALID_REQUEST');
    });
  });

  describe('confirm()', () => {
    test('should confirm an active reservation', () => {
      const reserve = engine.reserve({ product_id: 'prod-001', customer_id: 'cust-1', quantity: 1 });
      const result = engine.confirm(reserve.reservation_id!);
      expect(result.success).toBe(true);

      const snapshot = engine.getInventory('prod-001')!;
      expect(snapshot.total_stock).toBe(99);
      expect(snapshot.reserved_stock).toBe(0);
      expect(snapshot.available_stock).toBe(99);
    });

    test('should not confirm an already confirmed reservation', () => {
      const reserve = engine.reserve({ product_id: 'prod-001', customer_id: 'cust-1', quantity: 1 });
      engine.confirm(reserve.reservation_id!);
      const result = engine.confirm(reserve.reservation_id!);
      expect(result.success).toBe(false);
    });

    test('should not confirm a released reservation', () => {
      const reserve = engine.reserve({ product_id: 'prod-001', customer_id: 'cust-1', quantity: 1 });
      engine.release(reserve.reservation_id!);
      const result = engine.confirm(reserve.reservation_id!);
      expect(result.success).toBe(false);
    });

    test('should return error for nonexistent reservation', () => {
      const result = engine.confirm('nonexistent-id');
      expect(result.success).toBe(false);
    });
  });

  describe('release()', () => {
    test('should release reservation and restore stock', () => {
      const reserve = engine.reserve({ product_id: 'prod-001', customer_id: 'cust-1', quantity: 2 });
      const result = engine.release(reserve.reservation_id!);
      expect(result.success).toBe(true);
      expect(result.released_quantity).toBe(2);

      const snapshot = engine.getInventory('prod-001')!;
      expect(snapshot.available_stock).toBe(100);
      expect(snapshot.reserved_stock).toBe(0);
    });

    test('should not release an already confirmed reservation', () => {
      const reserve = engine.reserve({ product_id: 'prod-001', customer_id: 'cust-1', quantity: 1 });
      engine.confirm(reserve.reservation_id!);
      const result = engine.release(reserve.reservation_id!);
      expect(result.success).toBe(false);
    });
  });

  describe('cleanupExpired()', () => {
    test('should expire reservations past their TTL', () => {
      // Create reservation with 1 second TTL
      const reserve = engine.reserve({
        product_id: 'prod-001', customer_id: 'cust-1', quantity: 1, ttl_seconds: -1,
      });
      expect(reserve.success).toBe(true);

      const count = engine.cleanupExpired();
      expect(count).toBe(1);

      const reservation = engine.getReservation(reserve.reservation_id!);
      expect(reservation?.status).toBe('expired');

      const snapshot = engine.getInventory('prod-001')!;
      expect(snapshot.available_stock).toBe(100);
      expect(snapshot.reserved_stock).toBe(0);
    });

    test('should not expire active reservations within TTL', () => {
      engine.reserve({ product_id: 'prod-001', customer_id: 'cust-1', quantity: 1, ttl_seconds: 3600 });
      const count = engine.cleanupExpired();
      expect(count).toBe(0);
    });
  });

  describe('concurrent reservations (simulated)', () => {
    test('should correctly handle sequential high-volume reservations', () => {
      seedProduct(db, { id: 'prod-flash', sku: 'FLASH-002', total_stock: 10, available_stock: 10, max_per_customer: 1 });

      const results = [];
      for (let i = 0; i < 20; i++) {
        results.push(engine.reserve({
          product_id: 'prod-flash', customer_id: `cust-${i}`, quantity: 1,
        }));
      }

      const successes = results.filter(r => r.success);
      const failures = results.filter(r => !r.success);

      expect(successes.length).toBe(10);
      expect(failures.length).toBe(10);
      failures.forEach(f => expect(f.code).toBe('OUT_OF_STOCK'));

      const snapshot = engine.getInventory('prod-flash')!;
      expect(snapshot.available_stock).toBe(0);
      expect(snapshot.reserved_stock).toBe(10);
    });

    test('stock should remain consistent after mixed reserve/release/confirm', () => {
      seedProduct(db, { id: 'prod-mix', sku: 'MIX-001', total_stock: 50, available_stock: 50, max_per_customer: 5 });

      const reservations: string[] = [];
      for (let i = 0; i < 10; i++) {
        const r = engine.reserve({ product_id: 'prod-mix', customer_id: `cust-${i}`, quantity: 3 });
        if (r.success) reservations.push(r.reservation_id!);
      }
      expect(reservations.length).toBe(10);

      // Confirm first 5, release next 5
      for (let i = 0; i < 5; i++) engine.confirm(reservations[i]);
      for (let i = 5; i < 10; i++) engine.release(reservations[i]);

      const snapshot = engine.getInventory('prod-mix')!;
      // 50 total - 15 confirmed = 35 total_stock
      // 50 available - 30 reserved + 15 released = 35 available
      expect(snapshot.total_stock).toBe(35);
      expect(snapshot.available_stock).toBe(35);
      expect(snapshot.reserved_stock).toBe(0);
    });
  });

  describe('rate limiting', () => {
    test('should rate-limit a customer exceeding request rate', () => {
      const limitedEngine = new ReservationEngine(db, {
        reservation_ttl_seconds: 300,
        global_rate_limit: { max_tokens: 10000, refill_rate: 10000, refill_interval_ms: 1000 },
        per_customer_rate_limit: { max_tokens: 3, refill_rate: 1, refill_interval_ms: 1000 },
        per_product_rate_limit: { max_tokens: 10000, refill_rate: 10000, refill_interval_ms: 1000 },
        cleanup_interval_ms: 60000,
      });
      seedProduct(db, { id: 'prod-rate', sku: 'RATE-001', total_stock: 1000, available_stock: 1000, max_per_customer: 1000 });

      const results = [];
      for (let i = 0; i < 6; i++) {
        results.push(limitedEngine.reserve({ product_id: 'prod-rate', customer_id: 'spam-cust', quantity: 1 }));
      }

      const rateLimited = results.filter(r => r.code === 'RATE_LIMITED');
      expect(rateLimited.length).toBeGreaterThan(0);
      expect(rateLimited[0].retry_after_ms).toBeDefined();

      limitedEngine.stopCleanupTimer();
    });
  });

  describe('getInventory()', () => {
    test('should return inventory snapshot', () => {
      const snapshot = engine.getInventory('prod-001');
      expect(snapshot).not.toBeNull();
      expect(snapshot!.product_id).toBe('prod-001');
      expect(snapshot!.sku).toBe('FLASH-SHOE-001');
      expect(snapshot!.total_stock).toBe(100);
      expect(snapshot!.flash_sale_active).toBe(true);
    });

    test('should return null for nonexistent product', () => {
      expect(engine.getInventory('nope')).toBeNull();
    });
  });
});
