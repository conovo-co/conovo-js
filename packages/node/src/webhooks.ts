import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stripe-style webhook signatures (ARCHITECTURE §3): HMAC-SHA256 over
 * `${timestamp}.${payload}` with the per-account signing secret, delivered as
 * `t=<unix>,v1=<hex>`. Verification enforces a freshness tolerance so a
 * captured request can't be replayed later.
 */

export function signWebhook(
  payload: string,
  secret: string,
  timestamp: number = Math.floor(Date.now() / 1000),
): string {
  const mac = createHmac("sha256", secret)
    .update(`${timestamp}.${payload}`)
    .digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

export function verifyWebhook(
  payload: string,
  header: string,
  secret: string,
  opts: { toleranceSeconds?: number; now?: number } = {},
): boolean {
  const tolerance = opts.toleranceSeconds ?? 300;
  const now = opts.now ?? Math.floor(Date.now() / 1000);

  const parts = new Map(
    header.split(",").map((p) => p.split("=", 2) as [string, string]),
  );
  const t = Number(parts.get("t"));
  const v1 = parts.get("v1");
  if (!Number.isFinite(t) || !v1) return false;
  if (Math.abs(now - t) > tolerance) return false;

  const expected = createHmac("sha256", secret)
    .update(`${t}.${payload}`)
    .digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(v1, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
