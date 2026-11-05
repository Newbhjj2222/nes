import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";

export interface ReconciliationReport {
  ok: boolean;
  trialBalance: { debit: string; credit: string; balanced: boolean };
  walletMismatches: { walletId: string; field: "available" | "pending"; cached: string; ledger: string }[];
  merchantMismatches: { merchantAccountId: string; cached: string; ledger: string }[];
}

/**
 * Verifies that (1) total debits equal total credits across the whole ledger and
 * (2) every cached wallet / merchant balance equals the balance derived from ledger entries.
 * Read-only. Any mismatch is a P1 incident: stop money movement and investigate.
 */
export async function reconcile(): Promise<ReconciliationReport> {
  const sums = await prisma.ledgerEntry.groupBy({ by: ["direction"], _sum: { amountNes: true } });
  const debit = sums.find((s) => s.direction === "DEBIT")?._sum.amountNes ?? 0n;
  const credit = sums.find((s) => s.direction === "CREDIT")?._sum.amountNes ?? 0n;

  const walletLedger = await prisma.$queryRaw<{ walletId: string; type: string; balance: bigint }[]>(Prisma.sql`
    SELECT la."walletId" AS "walletId", la.type::text AS type,
           COALESCE(SUM(CASE WHEN le.direction = 'CREDIT' THEN le."amountNes" ELSE -le."amountNes" END), 0)::bigint AS balance
      FROM ledger_accounts la
      LEFT JOIN ledger_entries le ON le."accountId" = la.id
     WHERE la.type IN ('USER_WALLET', 'USER_PENDING')
     GROUP BY la."walletId", la.type`);
  const ledgerByKey = new Map(walletLedger.map((r) => [`${r.walletId}:${r.type}`, r.balance]));

  const walletMismatches: ReconciliationReport["walletMismatches"] = [];
  for (const w of await prisma.wallet.findMany({ select: { id: true, availableNes: true, pendingNes: true } })) {
    const a = ledgerByKey.get(`${w.id}:USER_WALLET`) ?? 0n;
    const p = ledgerByKey.get(`${w.id}:USER_PENDING`) ?? 0n;
    if (a !== w.availableNes) walletMismatches.push({ walletId: w.id, field: "available", cached: w.availableNes.toString(), ledger: a.toString() });
    if (p !== w.pendingNes) walletMismatches.push({ walletId: w.id, field: "pending", cached: w.pendingNes.toString(), ledger: p.toString() });
  }

  const merchantLedger = await prisma.$queryRaw<{ merchantAccountId: string; balance: bigint }[]>(Prisma.sql`
    SELECT la."merchantAccountId" AS "merchantAccountId",
           COALESCE(SUM(CASE WHEN le.direction = 'CREDIT' THEN le."amountNes" ELSE -le."amountNes" END), 0)::bigint AS balance
      FROM ledger_accounts la
      LEFT JOIN ledger_entries le ON le."accountId" = la.id
     WHERE la.type = 'MERCHANT_SETTLEMENT'
     GROUP BY la."merchantAccountId"`);
  const merchantByKey = new Map(merchantLedger.map((r) => [r.merchantAccountId, r.balance]));
  const merchantMismatches: ReconciliationReport["merchantMismatches"] = [];
  for (const m of await prisma.merchantAccount.findMany({ select: { id: true, settlementNes: true } })) {
    const l = merchantByKey.get(m.id) ?? 0n;
    if (l !== m.settlementNes) merchantMismatches.push({ merchantAccountId: m.id, cached: m.settlementNes.toString(), ledger: l.toString() });
  }

  const balanced = debit === credit;
  return {
    ok: balanced && walletMismatches.length === 0 && merchantMismatches.length === 0,
    trialBalance: { debit: debit.toString(), credit: credit.toString(), balanced },
    walletMismatches,
    merchantMismatches,
  };
}
