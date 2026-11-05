import { describe, expect, it } from "vitest";
import { nesToRwf, rwfToNes } from "../src/config/currency";
import { generateCardNumber, isValidCardNumber, luhnCheckDigit } from "../src/lib/crypto";
import { registerSchema, resetPasswordSchema } from "../src/modules/auth/auth.schemas";

describe("conversion", () => {
  it("converts deposits: 5,000 RWF = 250 NeS", () => {
    expect(rwfToNes(5000n)).toBe(250n);
  });
  it("converts withdrawals: 100 NeS = 2,000 RWF", () => {
    expect(nesToRwf(100n)).toBe(2000n);
  });
  it("matches the spec table", () => {
    for (const [nes, rwf] of [[10n, 200n], [50n, 1000n], [500n, 10000n], [1000n, 20000n]] as const) {
      expect(nesToRwf(nes)).toBe(rwf);
      expect(rwfToNes(rwf)).toBe(nes);
    }
  });
  it("rejects amounts that are not exact multiples or not positive", () => {
    expect(rwfToNes(5010n)).toBeNull();
    expect(rwfToNes(0n)).toBeNull();
    expect(rwfToNes(-20n)).toBeNull();
    expect(() => nesToRwf(0n)).toThrow();
  });
});

describe("card numbers", () => {
  it("generates valid, well-formed, unique-looking numbers", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const n = generateCardNumber();
      expect(n).toMatch(/^NES-\d{4}-\d{4}-\d{4}$/);
      expect(isValidCardNumber(n)).toBe(true);
      seen.add(n);
    }
    expect(seen.size).toBe(500);
  });
  it("detects a corrupted check digit", () => {
    expect(isValidCardNumber("NES-1234-5678-9012")).toBe(luhnCheckDigit("12345678901") === 2);
    const n = generateCardNumber();
    const last = Number(n.slice(-1));
    const bad = n.slice(0, -1) + String((last + 1) % 10);
    expect(isValidCardNumber(bad)).toBe(false);
  });
});

describe("auth schemas", () => {
  const base = { fullName: "Aline Uwase", password: "Str0ngPassword" };
  it("requires email or phone", () => {
    expect(registerSchema.safeParse(base).success).toBe(false);
    expect(registerSchema.safeParse({ ...base, email: "a@b.com" }).success).toBe(true);
    expect(registerSchema.safeParse({ ...base, phone: "+250788123456" }).success).toBe(true);
  });
  it("rejects bad phones and weak passwords", () => {
    expect(registerSchema.safeParse({ ...base, phone: "0788123456" }).success).toBe(false);
    expect(registerSchema.safeParse({ ...base, email: "a@b.com", password: "short" }).success).toBe(false);
    expect(registerSchema.safeParse({ ...base, email: "a@b.com", password: "alllowercase1" }).success).toBe(false);
  });
  it("applies the password policy to resets", () => {
    expect(resetPasswordSchema.safeParse({ token: "x".repeat(32), newPassword: "weak" }).success).toBe(false);
  });
});
