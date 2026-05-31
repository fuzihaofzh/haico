export { buildSqlPlaceholders } from '../issue/utils';

export function parseBoundedLimit(value: unknown, fallback: number, max: number, min = 1): number {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  const normalized = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(Math.max(normalized, min), max);
}

export function toFiniteNumber(value: unknown): number {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : 0;
}

export function buildTimeBucketKey(createdAt: string, period?: string): string {
  const date = createdAt.slice(0, 10);
  if (period === 'hour') return createdAt.slice(0, 13);
  if (period === 'week') {
    const d = new Date(date);
    d.setDate(d.getDate() - d.getDay());
    return d.toISOString().slice(0, 10);
  }
  if (period === 'month') return date.slice(0, 7);
  return date;
}

export function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw.trim() === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
