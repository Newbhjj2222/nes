import type { RequestHandler } from "express";
import rateLimit from "express-rate-limit";
import { env } from "../config/env";
import { forbidden, unauthorized } from "../lib/errors";
import { prisma } from "../lib/prisma";
import { type ApiClient, type ApiPermission, authenticateApiKey } from "../modules/developer/apikey.service";

declare module "express-serve-static-core" {
  interface Request {
    apiClient?: ApiClient;
  }
}

/** Authenticates `Authorization: Bearer nes_...` and enforces the app's permissions. */
export const requireApiKey =
  (...required: ApiPermission[]): RequestHandler =>
  async (req, _res, next) => {
    try {
      const h = req.headers.authorization;
      const raw = h?.startsWith("Bearer ") ? h.slice(7).trim() : "";
      if (!raw) throw unauthorized("API key required");
      const client = await authenticateApiKey(raw);
      for (const p of required) {
        if (!client.permissions.includes(p)) throw forbidden(`Missing permission: ${p}`);
      }
      req.apiClient = client;
      next();
    } catch (e) {
      next(e);
    }
  };

/** Records each API-key request (including rejected ones) for the developer's logs and usage stats. */
export const apiLogger: RequestHandler = (req, res, next) => {
  if (!req.headers.authorization?.startsWith("Bearer nes_")) return next();
  const started = Date.now();
  const path = req.originalUrl.split("?")[0]!.slice(0, 200); // captured now: req.baseUrl resets after routing
  res.on("finish", () => {
    prisma.apiLog
      .create({
        data: {
          appId: req.apiClient?.appId ?? null,
          apiKeyId: req.apiClient?.keyId ?? null,
          method: req.method,
          path,
          statusCode: res.statusCode,
          durationMs: Date.now() - started,
          ip: req.ip ?? null,
          errorCode: (res.locals.errorCode as string | undefined) ?? null,
        },
      })
      .catch(() => undefined); // logging must never break a request
  });
  next();
};

const high = env.NODE_ENV === "test" ? 100_000 : undefined;

/** Coarse per-IP limit that also covers unauthenticated key guessing. */
export const apiIpLimiter = rateLimit({
  windowMs: 60_000,
  limit: high ?? 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Too many requests" } },
});

/** Per-key limit; must run after requireApiKey. */
export const apiKeyLimiter = rateLimit({
  windowMs: 60_000,
  limit: high ?? 300,
  keyGenerator: (req) => req.apiClient?.keyId ?? "unauthenticated",
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "API key rate limit exceeded" } },
});
