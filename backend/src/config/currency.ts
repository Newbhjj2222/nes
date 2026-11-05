/**
 * Centralized NeS <-> RWF conversion.
 *
 * Fixed rate: 1 NeS = 20 RWF. All amounts are stored as integers
 * (NeS credits and RWF are both whole units here, so no floats are used).
 * The rate is a code/config constant: neither users nor developers can change it.
 * Every transaction records the rate used (see `conversionRate` columns).
 */
export const RWF_PER_NES = 20n;

/** Convert an RWF amount to NeS. Returns null when the amount is not an exact multiple. */
export function rwfToNes(rwf: bigint): bigint | null {
  if (rwf <= 0n) return null;
  if (rwf % RWF_PER_NES !== 0n) return null;
  return rwf / RWF_PER_NES;
}

/** Convert NeS to its RWF equivalent. */
export function nesToRwf(nes: bigint): bigint {
  if (nes <= 0n) throw new Error("NeS amount must be positive");
  return nes * RWF_PER_NES;
}
