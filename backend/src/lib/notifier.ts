import { env } from "../config/env";
import { logger } from "./logger";

/**
 * Delivery stub for verification / reset tokens.
 * No email or SMS provider is wired yet. In non-production the token is logged
 * so the flows can be exercised; in production nothing is logged and a real
 * provider MUST be plugged in here before launch.
 */
export async function deliverToken(channel: "email" | "sms", to: string, purpose: string, token: string) {
  if (env.NODE_ENV !== "production") {
    logger.info({ channel, to, purpose, token }, "DEV ONLY: token delivery stub");
  }
}
