import { createHash, randomBytes, randomInt } from "node:crypto";

/** Luhn check digit for a numeric string (without the check digit). */
export function luhnCheckDigit(digits: string): number {
  let sum = 0;
  let double = true; // rightmost payload digit is doubled
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return (10 - (sum % 10)) % 10;
}

export function isValidCardNumber(cardNumber: string): boolean {
  const m = /^NES-(\d{4})-(\d{4})-(\d{4})$/.exec(cardNumber);
  if (!m) return false;
  const digits = `${m[1]}${m[2]}${m[3]}`;
  return luhnCheckDigit(digits.slice(0, -1)) === Number(digits.slice(-1));
}

/** Format: NES-XXXX-XXXX-XXXX, 12 digits, last one is a Luhn check digit. */
export function generateCardNumber(): string {
  let payload = "";
  for (let i = 0; i < 11; i++) payload += String(randomInt(0, 10));
  const digits = payload + String(luhnCheckDigit(payload));
  return `NES-${digits.slice(0, 4)}-${digits.slice(4, 8)}-${digits.slice(8, 12)}`;
}

export const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

export const randomToken = () => randomBytes(32).toString("hex");

/** 6-digit numeric code for phone verification. */
export const randomOtp = () => String(randomInt(0, 1_000_000)).padStart(6, "0");
