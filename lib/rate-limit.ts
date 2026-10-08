/**
 * Small in-memory sliding-window limiter. On serverless platforms each
 * instance has its own window, so this is a best-effort brake against
 * hammering (login brute force, runaway autosave loops), layered on top of
 * Supabase Auth's own rate limits — not a hard global guarantee.
 */
const buckets = new Map<string, number[]>();

export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const recent = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    buckets.set(key, recent);
    return false;
  }
  recent.push(now);
  buckets.set(key, recent);
  if (buckets.size > 10_000) {
    for (const [k, times] of buckets) if (times.every((t) => now - t >= windowMs)) buckets.delete(k);
  }
  return true;
}
