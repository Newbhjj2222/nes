import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * NeS webhook signature scheme (what merchants verify):
 *
 *   NeS-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, `${t}.${rawBody}`)>
 *
 * Merchants must verify against the RAW request body, compare in constant time, and reject
 * timestamps older than their tolerance (default 5 minutes) to stop replays.
 */
export const SIGNATURE_HEADER = "NeS-Signature";

const mac = (secret: string, t: number, body: string) => createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");

export function signPayload(secret: string, body: string, nowSec = Math.floor(Date.now() / 1000)): string {
  return `t=${nowSec},v1=${mac(secret, nowSec, body)}`;
}

export function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  header: string | undefined,
  opts: { toleranceSec?: number; nowSec?: number } = {},
): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(",").map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()] as const;
    }),
  );
  const t = Number(parts.t);
  const sig = parts.v1;
  if (!Number.isInteger(t) || !sig || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (opts.toleranceSec ?? 300)) return false;
  const expected = Buffer.from(mac(secret, t, rawBody), "hex");
  const given = Buffer.from(sig, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}
