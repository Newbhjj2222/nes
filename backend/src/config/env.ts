import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default("15m"),
  COOKIE_SECRET: z.string().min(32),
  CORS_ORIGINS: z.string().default("http://localhost:5173"),
  API_KEY_PEPPER: z.string().min(32),
  WEBHOOK_SIGNING_SECRET: z.string().min(32),
  PAWAPAY_BASE_URL: z.string().url().default("https://api.sandbox.pawapay.io"),
  PAWAPAY_API_TOKEN: z.string().default(""),
  PAWAPAY_CALLBACK_BASE_URL: z.string().default("http://localhost:4000"),
  // Comma-separated provider codes users may choose. Only codes seen in the V2 docs by default.
  PAWAPAY_PROVIDERS: z.string().default("MTN_MOMO_RWA"),
  // Withdrawals stay off until eligibility, fees and limits are approved by compliance.
  WITHDRAWALS_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  RECONCILE_INTERVAL_MS: z.coerce.number().default(5 * 60 * 1000),
  // Live money movement stays OFF until legal/compliance sign-off.
  LIVE_PAYMENTS_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

export const env = schema.parse(process.env);
