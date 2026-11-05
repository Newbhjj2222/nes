/**
 * PLACEHOLDER limits for sandbox development. Real limits, fees and eligibility rules must be
 * set by the business operator after legal/compliance review (spec section 15).
 * They must also respect each provider's minAmount/maxAmount from PawaPay active-conf.
 */
export const MIN_DEPOSIT_RWF = 200n; // 10 NeS
export const MAX_DEPOSIT_RWF = 2_000_000n; // 100,000 NeS
export const MIN_WITHDRAWAL_NES = 10n; // 200 RWF
export const MAX_WITHDRAWAL_NES = 50_000n; // 1,000,000 RWF
export const WITHDRAWAL_FEE_NES = 0n; // fee model undefined; not charged yet

/** Docs: re-check payments still pending after this long. Also the grace before NOT_FOUND means failed. */
export const PENDING_RECHECK_MS = 15 * 60 * 1000;
