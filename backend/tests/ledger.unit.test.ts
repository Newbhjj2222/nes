import { describe, expect, it } from "vitest";
import { LedgerInvariantError, isCreditNormal, validateEntries } from "../src/modules/ledger/ledger.service";

const e = (direction: "DEBIT" | "CREDIT", amountNes: bigint, accountId = "a") => ({ accountId, direction, amountNes });

describe("ledger entry validation", () => {
  it("accepts a balanced posting", () => {
    expect(() => validateEntries([e("DEBIT", 250n, "float"), e("CREDIT", 250n, "wallet")])).not.toThrow();
  });
  it("rejects unbalanced postings", () => {
    expect(() => validateEntries([e("DEBIT", 250n), e("CREDIT", 249n)])).toThrow(LedgerInvariantError);
  });
  it("rejects single-entry postings", () => {
    expect(() => validateEntries([e("DEBIT", 10n)])).toThrow(LedgerInvariantError);
  });
  it("rejects zero, negative and non-bigint amounts", () => {
    expect(() => validateEntries([e("DEBIT", 0n), e("CREDIT", 0n)])).toThrow(LedgerInvariantError);
    expect(() => validateEntries([e("DEBIT", -5n), e("CREDIT", -5n)])).toThrow(LedgerInvariantError);
    expect(() => validateEntries([{ accountId: "a", direction: "DEBIT", amountNes: 5 as unknown as bigint }, e("CREDIT", 5n)])).toThrow(
      LedgerInvariantError,
    );
  });
  it("treats only the platform float as debit-normal", () => {
    expect(isCreditNormal("PLATFORM_FLOAT")).toBe(false);
    for (const t of ["USER_WALLET", "USER_PENDING", "MERCHANT_SETTLEMENT", "PLATFORM_FEES", "PLATFORM_ADJUSTMENT", "RESERVE_WITHDRAWAL"] as const) {
      expect(isCreditNormal(t)).toBe(true);
    }
  });
});
