import { createHmac, timingSafeEqual } from "node:crypto";

export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function signBody(secret: string, timestamp: string, body: string) {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/**
 * Verifies `x-signature: sha256=<hex>` over `${x-timestamp}.${rawBody}`,
 * rejecting stale timestamps (replay window) — mirrored in the Apps Script.
 */
export function verifySignedRequest(
  secret: string,
  body: string,
  timestamp: string | null,
  signature: string | null,
  now = Date.now(),
  maxSkewMs = 10 * 60_000,
): boolean {
  if (!timestamp || !signature?.startsWith("sha256=")) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > maxSkewMs) return false;
  return safeEqual(signature.slice(7), signBody(secret, timestamp, body));
}
