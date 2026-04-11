import Database from 'better-sqlite3';
import crypto from 'crypto';
import {
  Product,
  Reservation,
  ReserveRequest,
  ReserveResult,
  ConfirmResult,
  ReleaseResult,
  InventorySnapshot,
  FlashSaleConfig,
  DEFAULT_CONFIG,
} from '../models/types';
import { TokenBucketRateLimiter } from './rate-limiter';

const MAX_OPTIMISTIC_RETRIES = 3;

export class ReservationEngine {
  private db: Database.Database;
  private config: FlashSaleConfig;
  private globalLimiter: TokenBucketRateLimiter;
  private customerLimiter: TokenBucketRateLimiter;
  private productLimiter: TokenBucketRateLimiter;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  // Prepared statements
  private getProductStmt: Database.Statement;
  private deductStockStmt: Database.Statement;
  private insertReservationStmt: Database.Statement;
  private logActionStmt: Database.Statement;
  private getActiveReservationsForCustomerStmt: Database.Statement;
  private getReservationStmt: Database.Statement;
  private confirmReservationStmt: Database.Statement;
  private releaseReservationStmt: Database.Statement;
  private restoreStockStmt: Database.Statement;
  private expireReservationsStmt: Database.Statement;
  private getExpiredReservationsStmt: Database.Statement;

  constructor(db: Database.Database, config?: Partial<FlashSaleConfig>) {
    this.db = db;
    this.config = { ...DEFAULT_CONFIG, ...config };

    this.globalLimiter = new TokenBucketRateLimiter(db, this.config.global_rate_limit);
    this.customerLimiter = new TokenBucketRateLimiter(db, this.config.per_customer_rate_limit);
    this.productLimiter = new TokenBucketRateLimiter(db, this.config.per_product_rate_limit);

    this.getProductStmt = db.prepare(
      `SELECT * FROM products WHERE id = ?`
    );

    // Optimistic locking: only deduct if version matches and stock is sufficient
    this.deductStockStmt = db.prepare(`
      UPDATE products
      SET available_stock = available_stock - ?,
          reserved_stock = reserved_stock + ?,
          version = version + 1,
          updated_at = datetime('now')
      WHERE id = ? AND version = ? AND available_stock >= ?
    `);

    this.insertReservationStmt = db.prepare(`
      INSERT INTO reservations (id, product_id, customer_id, quantity, status, expires_at, created_at)
      VALUES (?, ?, ?, ?, 'active', ?, datetime('now'))
    `);

    this.logActionStmt = db.prepare(`
      INSERT INTO reservation_log (reservation_id, product_id, customer_id, action, quantity, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    this.getActiveReservationsForCustomerStmt = db.prepare(`
      SELECT COALESCE(SUM(quantity), 0) as total
      FROM reservations
      WHERE product_id = ? AND customer_id = ? AND status = 'active'
    `);

    this.getReservationStmt = db.prepare(
      `SELECT * FROM reservations WHERE id = ?`
    );

    this.confirmReservationStmt = db.prepare(`
      UPDATE reservations
      SET status = 'confirmed', confirmed_at = datetime('now')
      WHERE id = ? AND status = 'active'
    `);

    this.releaseReservationStmt = db.prepare(`
      UPDATE reservations
      SET status = 'released', released_at = datetime('now')
      WHERE id = ? AND status = 'active'
    `);

    this.restoreStockStmt = db.prepare(`
      UPDATE products
      SET available_stock = available_stock + ?,
          reserved_stock = reserved_stock - ?,
          version = version + 1,
          updated_at = datetime('now')
      WHERE id = ?
    `);

    this.getExpiredReservationsStmt = db.prepare(`
      SELECT * FROM reservations
      WHERE status = 'active' AND expires_at <= datetime('now')
      LIMIT 100
    `);

    this.expireReservationsStmt = db.prepare(`
      UPDATE reservations
      SET status = 'expired', released_at = datetime('now')
      WHERE id = ? AND status = 'active'
    `);
  }

  reserve(req: ReserveRequest): ReserveResult {
    if (req.quantity <= 0) {
      return { success: false, error: 'Quantity must be positive', code: 'INVALID_REQUEST' };
    }

    // Rate limiting: global -> product -> customer
    const globalCheck = this.globalLimiter.tryConsume('global');
    if (!globalCheck.allowed) {
      this.logActionStmt.run(
        '', req.product_id, req.customer_id, 'reject_rate', req.quantity,
        'Global rate limit exceeded'
      );
      return {
        success: false,
        error: 'System is busy, please retry',
        code: 'RATE_LIMITED',
        retry_after_ms: globalCheck.retry_after_ms,
      };
    }

    const productCheck = this.productLimiter.tryConsume(`product:${req.product_id}`);
    if (!productCheck.allowed) {
      this.logActionStmt.run(
        '', req.product_id, req.customer_id, 'reject_rate', req.quantity,
        'Product rate limit exceeded'
      );
      return {
        success: false,
        error: 'Too many requests for this product, please retry',
        code: 'RATE_LIMITED',
        retry_after_ms: productCheck.retry_after_ms,
      };
    }

    const customerCheck = this.customerLimiter.tryConsume(`customer:${req.customer_id}`);
    if (!customerCheck.allowed) {
      this.logActionStmt.run(
        '', req.product_id, req.customer_id, 'reject_rate', req.quantity,
        'Customer rate limit exceeded'
      );
      return {
        success: false,
        error: 'Too many requests, please slow down',
        code: 'RATE_LIMITED',
        retry_after_ms: customerCheck.retry_after_ms,
      };
    }

    // Execute reservation in a transaction with optimistic locking
    const reserveTransaction = this.db.transaction(() => {
      const product = this.getProductStmt.get(req.product_id) as Product | undefined;
      if (!product) {
        return { success: false, error: 'Product not found', code: 'INVALID_REQUEST' as const };
      }

      // Check per-customer limit
      const { total } = this.getActiveReservationsForCustomerStmt.get(
        req.product_id, req.customer_id
      ) as { total: number };

      if (total + req.quantity > product.max_per_customer) {
        this.logActionStmt.run(
          '', req.product_id, req.customer_id, 'reject_limit', req.quantity,
          `Customer limit: ${total} reserved + ${req.quantity} requested > ${product.max_per_customer} max`
        );
        return {
          success: false,
          error: `Customer limit exceeded (max ${product.max_per_customer} per customer)`,
          code: 'CUSTOMER_LIMIT' as const,
        };
      }

      // Attempt stock deduction with optimistic locking (retry on version conflict)
      for (let attempt = 0; attempt < MAX_OPTIMISTIC_RETRIES; attempt++) {
        const currentProduct = attempt === 0 ? product : this.getProductStmt.get(req.product_id) as Product;
        if (!currentProduct || currentProduct.available_stock < req.quantity) {
          this.logActionStmt.run(
            '', req.product_id, req.customer_id, 'reject_stock', req.quantity,
            `Available: ${currentProduct?.available_stock ?? 0}, Requested: ${req.quantity}`
          );
          return { success: false, error: 'Insufficient stock', code: 'OUT_OF_STOCK' as const };
        }

        const result = this.deductStockStmt.run(
          req.quantity, req.quantity, req.product_id, currentProduct.version, req.quantity
        );

        if (result.changes === 1) {
          // Stock deducted successfully — create reservation
          const reservationId = crypto.randomUUID();
          const ttl = req.ttl_seconds ?? this.config.reservation_ttl_seconds;
          const expiresAt = new Date(Date.now() + ttl * 1000).toISOString().replace('T', ' ').replace('Z', '');

          this.insertReservationStmt.run(
            reservationId, req.product_id, req.customer_id, req.quantity, expiresAt
          );

          this.logActionStmt.run(
            reservationId, req.product_id, req.customer_id, 'reserve', req.quantity,
            `TTL: ${ttl}s, Expires: ${expiresAt}`
          );

          return {
            success: true,
            reservation_id: reservationId,
            expires_at: expiresAt,
          };
        }
        // Version conflict — retry
      }

      // All retries exhausted
      return { success: false, error: 'Concurrent conflict, please retry', code: 'OUT_OF_STOCK' as const };
    });

    return reserveTransaction() as ReserveResult;
  }

  confirm(reservationId: string): ConfirmResult {
    const txn = this.db.transaction(() => {
      const reservation = this.getReservationStmt.get(reservationId) as Reservation | undefined;
      if (!reservation) {
        return { success: false, error: 'Reservation not found' };
      }
      if (reservation.status !== 'active') {
        return { success: false, error: `Reservation is ${reservation.status}, cannot confirm` };
      }

      // Check if expired
      const expiresAt = new Date(reservation.expires_at + 'Z').getTime();
      if (Date.now() > expiresAt) {
        // Auto-expire and restore stock
        this.expireReservationsStmt.run(reservationId);
        this.restoreStockStmt.run(reservation.quantity, reservation.quantity, reservation.product_id);
        this.logActionStmt.run(
          reservationId, reservation.product_id, reservation.customer_id,
          'expire', reservation.quantity, 'Expired during confirm attempt'
        );
        return { success: false, error: 'Reservation has expired' };
      }

      const result = this.confirmReservationStmt.run(reservationId);
      if (result.changes === 1) {
        // Move from reserved to sold: decrease reserved_stock
        this.db.prepare(`
          UPDATE products
          SET reserved_stock = reserved_stock - ?,
              total_stock = total_stock - ?,
              version = version + 1,
              updated_at = datetime('now')
          WHERE id = ?
        `).run(reservation.quantity, reservation.quantity, reservation.product_id);

        this.logActionStmt.run(
          reservationId, reservation.product_id, reservation.customer_id,
          'confirm', reservation.quantity, null
        );
        return { success: true };
      }
      return { success: false, error: 'Failed to confirm reservation' };
    });

    return txn() as ConfirmResult;
  }

  release(reservationId: string): ReleaseResult {
    const txn = this.db.transaction(() => {
      const reservation = this.getReservationStmt.get(reservationId) as Reservation | undefined;
      if (!reservation) {
        return { success: false, error: 'Reservation not found' };
      }
      if (reservation.status !== 'active') {
        return { success: false, error: `Reservation is ${reservation.status}, cannot release` };
      }

      const result = this.releaseReservationStmt.run(reservationId);
      if (result.changes === 1) {
        this.restoreStockStmt.run(reservation.quantity, reservation.quantity, reservation.product_id);
        this.logActionStmt.run(
          reservationId, reservation.product_id, reservation.customer_id,
          'release', reservation.quantity, 'Manual release'
        );
        return { success: true, released_quantity: reservation.quantity };
      }
      return { success: false, error: 'Failed to release reservation' };
    });

    return txn() as ReleaseResult;
  }

  cleanupExpired(): number {
    const txn = this.db.transaction(() => {
      const expired = this.getExpiredReservationsStmt.all() as Reservation[];
      let count = 0;

      for (const reservation of expired) {
        const result = this.expireReservationsStmt.run(reservation.id);
        if (result.changes === 1) {
          this.restoreStockStmt.run(reservation.quantity, reservation.quantity, reservation.product_id);
          this.logActionStmt.run(
            reservation.id, reservation.product_id, reservation.customer_id,
            'expire', reservation.quantity, 'Cleanup sweep'
          );
          count++;
        }
      }

      return count;
    });

    return txn() as number;
  }

  startCleanupTimer(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpired();
    }, this.config.cleanup_interval_ms);
  }

  stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  getInventory(productId: string): InventorySnapshot | null {
    const product = this.getProductStmt.get(productId) as Product | undefined;
    if (!product) return null;
    return {
      product_id: product.id,
      sku: product.sku,
      name: product.name,
      total_stock: product.total_stock,
      available_stock: product.available_stock,
      reserved_stock: product.reserved_stock,
      flash_sale_active: product.flash_sale_active === 1,
    };
  }

  getReservation(reservationId: string): Reservation | null {
    return (this.getReservationStmt.get(reservationId) as Reservation) ?? null;
  }
}
