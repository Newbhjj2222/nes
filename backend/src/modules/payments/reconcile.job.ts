import { PENDING_RECHECK_MS } from "../../config/limits";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { refreshDeposit } from "../deposits/deposit.service";
import { refreshWithdrawal } from "../withdrawals/withdrawal.service";

/**
 * Re-checks deposits/withdrawals still pending after 15 minutes against PawaPay (per the docs'
 * reconciliation guidance). Safe to run on several instances at once: every update is row-locked
 * and the ledger postings are idempotent.
 */
export async function reconcilePending(now = new Date()) {
  const cutoff = new Date(now.getTime() - PENDING_RECHECK_MS);
  const where = { status: { in: ["PENDING", "PROCESSING"] as ("PENDING" | "PROCESSING")[] }, createdAt: { lt: cutoff } };
  const deposits = await prisma.deposit.findMany({ where, orderBy: { createdAt: "asc" }, take: 200, select: { id: true } });
  const withdrawals = await prisma.withdrawal.findMany({ where, orderBy: { createdAt: "asc" }, take: 200, select: { id: true } });

  let errors = 0;
  for (const d of deposits) await refreshDeposit(d.id).catch((e) => (errors++, logger.error({ err: e, id: d.id }, "deposit reconcile failed")));
  for (const w of withdrawals) await refreshWithdrawal(w.id).catch((e) => (errors++, logger.error({ err: e, id: w.id }, "withdrawal reconcile failed")));
  return { deposits: deposits.length, withdrawals: withdrawals.length, errors };
}

export function startReconciliationJob(intervalMs: number) {
  const timer = setInterval(() => {
    reconcilePending().catch((e) => logger.error({ err: e }, "reconciliation run failed"));
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
