import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Environment } from "@prisma/client";
import { env } from "../../config/env";
import { AppError, unauthorized } from "../../lib/errors";
import { prisma } from "../../lib/prisma";

export const API_PERMISSIONS = ["payments:create", "payments:read", "refunds:create", "webhooks:manage"] as const;
export type ApiPermission = (typeof API_PERMISSIONS)[number];

/**
 * Key format: nes_<test|live>_<8 hex id>_<48 hex secret>
 *  - "nes_test_ab12cd34" is the public prefix (unique, stored in the clear, safe to show).
 *  - the 48-hex secret is shown exactly once and only a peppered HMAC-SHA256 of it is stored.
 * 192 bits of random secret means a fast keyed hash is sufficient (no need for bcrypt).
 */
const KEY_RE = /^nes_(test|live)_([0-9a-f]{8})_([0-9a-f]{48})$/;

export const hashSecret = (secret: string) => createHmac("sha256", env.API_KEY_PEPPER).update(secret).digest("hex");

export function generateApiKey(environment: Environment) {
  const mode = environment === "SANDBOX" ? "test" : "live";
  const prefix = `nes_${mode}_${randomBytes(4).toString("hex")}`;
  const secret = randomBytes(24).toString("hex");
  return { key: `${prefix}_${secret}`, prefix, secretHash: hashSecret(secret) };
}

export function parseApiKey(raw: string) {
  const m = KEY_RE.exec(raw);
  if (!m) return null;
  return {
    prefix: `nes_${m[1]}_${m[2]}`,
    secret: m[3]!,
    environment: (m[1] === "test" ? "SANDBOX" : "PRODUCTION") as Environment,
  };
}

export interface ApiClient {
  keyId: string;
  appId: string;
  appName: string;
  environment: Environment;
  permissions: string[];
  developerUserId: string;
}

const DUMMY_HASH = hashSecret("dummy-secret-for-constant-time-path");

export async function authenticateApiKey(raw: string): Promise<ApiClient> {
  const parsed = parseApiKey(raw);
  const presented = Buffer.from(hashSecret(parsed?.secret ?? "invalid"), "hex");
  const row = parsed
    ? await prisma.apiKey.findUnique({
        where: { prefix: parsed.prefix },
        include: { app: { include: { developer: { include: { user: { select: { id: true, status: true } } } } } } },
      })
    : null;
  // Always compare, even for unknown keys, so timing does not reveal which prefixes exist.
  const stored = Buffer.from(row?.secretHash ?? DUMMY_HASH, "hex");
  const ok = stored.length === presented.length && timingSafeEqual(stored, presented);
  if (!row || !ok || !parsed || row.environment !== parsed.environment) throw unauthorized("Invalid API key");
  if (row.status !== "ACTIVE") throw unauthorized("API key has been revoked");
  if (row.app.status !== "ACTIVE" || row.app.developer.user.status !== "ACTIVE") throw unauthorized("Application is not active");
  if (row.environment === "PRODUCTION" && !env.LIVE_PAYMENTS_ENABLED) {
    throw new AppError(403, "LIVE_DISABLED", "The production API is not enabled");
  }
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000) {
    void prisma.apiKey.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  }
  return {
    keyId: row.id,
    appId: row.appId,
    appName: row.app.name,
    environment: row.environment,
    permissions: row.app.permissions,
    developerUserId: row.app.developer.user.id,
  };
}
