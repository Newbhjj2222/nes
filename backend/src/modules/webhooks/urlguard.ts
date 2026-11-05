import { env } from "../../config/env";
import { badRequest } from "../../lib/errors";

/** Literal-host SSRF guard. Delivery (Phase 6) must ALSO re-check the resolved IP to stop DNS rebinding. */
export function isBlockedHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a = 0, b = 0] = host.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (host.includes(":")) return true; // IPv6 literals are not accepted
  return !host.includes("."); // single-label hostnames
}

export function validateWebhookUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw badRequest("INVALID_URL", "Webhook URL is not valid");
  }
  if (u.username || u.password) throw badRequest("INVALID_URL", "Webhook URL must not contain credentials");
  const host = u.hostname.toLowerCase();
  // Plain-HTTP localhost is allowed only outside production, for local development.
  const devLocal = env.NODE_ENV !== "production" && (host === "localhost" || host === "127.0.0.1");
  if (u.protocol !== "https:" && !(devLocal && u.protocol === "http:")) {
    throw badRequest("HTTPS_REQUIRED", "Webhook URL must use https");
  }
  if (!devLocal && isBlockedHost(host)) throw badRequest("URL_NOT_ALLOWED", "Webhook URL host is not allowed");
  return u;
}
