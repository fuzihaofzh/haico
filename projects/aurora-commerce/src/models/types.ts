export interface Product {
  id: string;
  sku: string;
  name: string;
  total_stock: number;
  available_stock: number;
  reserved_stock: number;
  max_per_customer: number;
  flash_sale_active: number;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface Reservation {
  id: string;
  product_id: string;
  customer_id: string;
  quantity: number;
  status: 'active' | 'confirmed' | 'released' | 'expired';
  expires_at: string;
  created_at: string;
  confirmed_at: string | null;
  released_at: string | null;
}

export interface ReservationLog {
  id: number;
  reservation_id: string;
  product_id: string;
  customer_id: string;
  action: 'reserve' | 'confirm' | 'release' | 'expire' | 'reject_stock' | 'reject_limit' | 'reject_rate';
  quantity: number;
  detail: string | null;
  created_at: string;
}

export interface ReserveRequest {
  product_id: string;
  customer_id: string;
  quantity: number;
  ttl_seconds?: number;
}

export interface ReserveResult {
  success: boolean;
  reservation_id?: string;
  expires_at?: string;
  error?: string;
  code?: 'OUT_OF_STOCK' | 'CUSTOMER_LIMIT' | 'RATE_LIMITED' | 'INVALID_REQUEST';
  retry_after_ms?: number;
}

export interface ConfirmResult {
  success: boolean;
  error?: string;
}

export interface ReleaseResult {
  success: boolean;
  released_quantity?: number;
  error?: string;
}

export interface InventorySnapshot {
  product_id: string;
  sku: string;
  name: string;
  total_stock: number;
  available_stock: number;
  reserved_stock: number;
  flash_sale_active: boolean;
}

export interface RateLimitConfig {
  max_tokens: number;
  refill_rate: number;       // tokens per second
  refill_interval_ms: number;
}

export interface FlashSaleConfig {
  reservation_ttl_seconds: number;
  global_rate_limit: RateLimitConfig;
  per_customer_rate_limit: RateLimitConfig;
  per_product_rate_limit: RateLimitConfig;
  cleanup_interval_ms: number;
}

export const DEFAULT_CONFIG: FlashSaleConfig = {
  reservation_ttl_seconds: 300, // 5 minutes
  global_rate_limit: {
    max_tokens: 1000,
    refill_rate: 200,
    refill_interval_ms: 1000,
  },
  per_customer_rate_limit: {
    max_tokens: 5,
    refill_rate: 1,
    refill_interval_ms: 1000,
  },
  per_product_rate_limit: {
    max_tokens: 500,
    refill_rate: 100,
    refill_interval_ms: 1000,
  },
  cleanup_interval_ms: 10_000,
};
