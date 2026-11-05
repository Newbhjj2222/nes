/**
 * NeS double-entry ledger engine.
 *
 * Rules enforced here (and backed by DB guards in prisma/sql/ledger_guards.sql):
 *  - Every posting has >= 2 entries, all amounts are positive integers (bigint NeS).
 *  - Total DEBIT == total CREDIT in every transaction.
 *  - Wallet / merchant balance caches change ONLY here, in the same DB transaction
 *    that inserts the ledger entries, under row locks taken in a fixed order.
 *  - A user wallet can never go negative.
 *  - Idempotency keys make retries safe: same key + same entries returns the original
 *    result; same key + different entries is rejected.
 *
 * Sign convention: every account is credit-normal (balance = credits - debits) EXCEPT
 * PLATFORM_FLOAT, which is the asset side (balance = debits - credits) representing
 * the RWF the platform holds against issued credits.
 */
import { Prisma } from "@prisma/client";
import type { EntryDirection, LedgerAccountType, LedgerTxType } from "@prisma/client";
import { RWF_PER_NES } from "../../config/currency";
import { AppError, conflict } from "../../lib/errors";
import { prisma } from "../../lib/prisma";

export interface LedgerEntryInput {
  accountId: string;
  direction: EntryDirection;
  amountNes: bigint;
}

export interface PostInput {
  reference: string;
  idempotencyKey?: string;
  type: LedgerTxType;
  description?: string;
  metadata?: Prisma.InputJsonValue;
  actorId?: string;
  entries: LedgerEntryInput[];
}

type StoredTx = Prisma.LedgerTransactionGetPayload<{ include: { entries: true } }>;
export interface PostResult {
  transaction: StoredTx;
  replayed: boolean;
}

export class LedgerInvariantError extends Error {}

export const isCreditNormal = (t: LedgerAccountType) => t !== "PLATFORM_FLOAT";

export function validateEntries(entries: LedgerEntryInput[]): void {
  if (entries.length < 2) throw new LedgerInvariantError("A ledger transaction needs at least two entries");
  let debit = 0n;
  let credit = 0n;
  for (const e of entries) {
    if (typeof e.amountNes !== "bigint" || e.amountNes <= 0n) {
      throw new LedgerInvariantError("Ledger amounts must be positive integers");
    }
    if (e.direction === "DEBIT") debit += e.amountNes;
    else credit += e.amountNes;
  }
  if (debit !== credit) throw new LedgerInvariantError(`Unbalanced ledger transaction: debit ${debit}, credit ${credit}`);
}

const signature = (entries: LedgerEntryInput[]) =>
  entries
    .map((e) => `${e.accountId}:${e.direction}:${e.amountNes}`)
    .sort()
    .join("|");

function replay(existing: StoredTx, input: PostInput): PostResult {
  if (signature(existing.entries) !== signature(input.entries) || existing.type !== input.type) {
    throw conflict("IDEMPOTENCY_MISMATCH", "Idempotency key was already used with a different request");
  }
  return { transaction: existing, replayed: true };
}

/**
 * Posts a transaction inside the caller's DB transaction (so deposit/withdrawal status
 * updates and the ledger write commit or roll back together).
 */
export async function postInTx(tx: Prisma.TransactionClient, input: PostInput): Promise<PostResult> {
  validateEntries(input.entries);

  if (input.idempotencyKey) {
    const existing = await tx.ledgerTransaction.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      include: { entries: true },
    });
    if (existing) return replay(existing, input);
  }

  const accountIds = [...new Set(input.entries.map((e) => e.accountId))];
  const accounts = await tx.ledgerAccount.findMany({ where: { id: { in: accountIds } } });
  if (accounts.length !== accountIds.length) throw new LedgerInvariantError("Unknown ledger account");
  const byId = new Map(accounts.map((a) => [a.id, a]));

  // Net effect of this posting on each cached balance.
  const walletDelta = new Map<string, { available: bigint; pending: bigint }>();
  const merchantDelta = new Map<string, bigint>();
  for (const e of input.entries) {
    const acct = byId.get(e.accountId)!;
    const increases = isCreditNormal(acct.type) ? e.direction === "CREDIT" : e.direction === "DEBIT";
    const signed = increases ? e.amountNes : -e.amountNes;

    if (acct.type === "USER_WALLET" || acct.type === "USER_PENDING") {
      if (!acct.walletId) throw new LedgerInvariantError("Wallet account without wallet");
      const d = walletDelta.get(acct.walletId) ?? { available: 0n, pending: 0n };
      if (acct.type === "USER_WALLET") d.available += signed;
      else d.pending += signed;
      walletDelta.set(acct.walletId, d);
    } else if (acct.type === "MERCHANT_SETTLEMENT") {
      if (!acct.merchantAccountId) throw new LedgerInvariantError("Settlement account without merchant account");
      merchantDelta.set(acct.merchantAccountId, (merchantDelta.get(acct.merchantAccountId) ?? 0n) + signed);
    }
  }

  // Lock in a fixed global order (wallets by id, then merchant accounts by id) to avoid deadlocks.
  const walletIds = [...walletDelta.keys()].sort();
  if (walletIds.length) {
    await tx.$queryRaw`SELECT id FROM wallets WHERE id IN (${Prisma.join(walletIds)}) ORDER BY id FOR UPDATE`;
    const rows = await tx.wallet.findMany({ where: { id: { in: walletIds } } });
    for (const w of rows) {
      const d = walletDelta.get(w.id)!;
      if (w.availableNes + d.available < 0n || w.pendingNes + d.pending < 0n) {
        throw new AppError(422, "INSUFFICIENT_FUNDS", "Insufficient NeS balance");
      }
    }
  }
  const merchantIds = [...merchantDelta.keys()].sort();
  if (merchantIds.length) {
    await tx.$queryRaw`SELECT id FROM merchant_accounts WHERE id IN (${Prisma.join(merchantIds)}) ORDER BY id FOR UPDATE`;
    const rows = await tx.merchantAccount.findMany({ where: { id: { in: merchantIds } } });
    for (const m of rows) {
      if (m.settlementNes + merchantDelta.get(m.id)! < 0n) {
        throw new AppError(422, "INSUFFICIENT_FUNDS", "Insufficient merchant settlement balance");
      }
    }
  }

  const created = await tx.ledgerTransaction.create({
    data: {
      reference: input.reference,
      idempotencyKey: input.idempotencyKey ?? null,
      type: input.type,
      description: input.description,
      conversionRate: Number(RWF_PER_NES),
      metadata: input.metadata,
      createdByActor: input.actorId,
      entries: {
        create: input.entries.map((e) => ({ accountId: e.accountId, direction: e.direction, amountNes: e.amountNes })),
      },
    },
    include: { entries: true },
  });

  for (const [walletId, d] of walletDelta) {
    await tx.wallet.update({
      where: { id: walletId },
      data: { availableNes: { increment: d.available }, pendingNes: { increment: d.pending }, version: { increment: 1 } },
    });
  }
  for (const [id, delta] of merchantDelta) {
    await tx.merchantAccount.update({
      where: { id },
      data: { settlementNes: { increment: delta }, version: { increment: 1 } },
    });
  }

  return { transaction: created, replayed: false };
}

/** Standalone posting in its own DB transaction, safe against idempotency-key races. */
export async function postLedgerTransaction(input: PostInput): Promise<PostResult> {
  try {
    return await prisma.$transaction((tx) => postInTx(tx, input));
  } catch (e) {
    if ((e as { code?: string }).code === "P2002" && input.idempotencyKey) {
      const existing = await prisma.ledgerTransaction.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        include: { entries: true },
      });
      if (existing) return replay(existing, input);
    }
    throw e;
  }
}

/** Balance of one account as derived purely from ledger entries. */
export async function getLedgerBalance(client: Prisma.TransactionClient | typeof prisma, accountId: string) {
  const account = await client.ledgerAccount.findUniqueOrThrow({ where: { id: accountId } });
  const sums = await client.ledgerEntry.groupBy({ by: ["direction"], where: { accountId }, _sum: { amountNes: true } });
  const debit = sums.find((s) => s.direction === "DEBIT")?._sum.amountNes ?? 0n;
  const credit = sums.find((s) => s.direction === "CREDIT")?._sum.amountNes ?? 0n;
  return isCreditNormal(account.type) ? credit - debit : debit - credit;
}

export const SYSTEM_ACCOUNTS = {
  float: { key: "platform:float", type: "PLATFORM_FLOAT", name: "Platform float (RWF-backed)" },
  fees: { key: "platform:fees", type: "PLATFORM_FEES", name: "Platform fees" },
  adjustments: { key: "platform:adjustments", type: "PLATFORM_ADJUSTMENT", name: "Administrative adjustments" },
  withdrawalReserve: { key: "platform:withdrawal-reserve", type: "RESERVE_WITHDRAWAL", name: "Withdrawal reserve" },
} as const satisfies Record<string, { key: string; type: LedgerAccountType; name: string }>;

/** Idempotent. Run at startup/seed and in test setup. */
export async function ensureSystemAccounts(client: Prisma.TransactionClient | typeof prisma = prisma) {
  for (const a of Object.values(SYSTEM_ACCOUNTS)) {
    await client.ledgerAccount.upsert({
      where: { systemKey: a.key },
      update: {},
      create: { systemKey: a.key, type: a.type, name: a.name },
    });
  }
}
