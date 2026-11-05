import { env } from "../../config/env";

/** Provider amounts are strings like "5000" or "5000.00". Returns whole RWF, or null if fractional/invalid. */
export function parseProviderAmount(s: string): bigint | null {
  const m = /^(\d+)(?:\.(0{1,2}))?$/.exec(s.trim());
  return m ? BigInt(m[1]!) : null;
}

/** +250788123456 -> 250788123456 (MSISDN format PawaPay expects). Rwanda only for now. */
export function toRwandaMsisdn(e164: string): string | null {
  const digits = e164.replace(/^\+/, "");
  return /^250\d{9}$/.test(digits) ? digits : null;
}

export const allowedProviders = () =>
  env.PAWAPAY_PROVIDERS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** Provider failure codes are for operators; users get a generic reason. */
export const publicFailure = (code: string | null | undefined) =>
  code ? { code, message: "The payment could not be completed." } : null;
