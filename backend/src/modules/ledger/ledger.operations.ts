/**
 * Domain-level ledger operations. Each one maps a business event onto balanced entries.
 * They take the caller's transaction client so status changes (deposit COMPLETED, etc.)
 * and the ledger write commit atomically. Callers supply `reference` and `idempotencyKey`.
 *
 *   DEPOSIT              Dr PLATFORM_FLOAT        Cr user wallet
 *   WITHDRAWAL (reserve) Dr user wallet           Cr RESERVE_WITHDRAWAL
 *   WITHDRAWAL (final)   Dr RESERVE_WITHDRAWAL    Cr PLATFORM_FLOAT
 *   WITHDRAWAL_REVERSAL  Dr RESERVE_WITHDRAWAL    Cr user wallet
 *   MERCHANT_PAYMENT     Dr user wallet           Cr merchant settlement
 *   REFUND               Dr merchant settlement   Cr user wallet
 *   ADJUSTMENT           Dr/Cr user wallet        vs PLATFORM_ADJUSTMENT
 */
import { randomBytes } from "node:crypto";
import type { LedgerAccountType, Prisma } from "@prisma/client";
import { badRequest, forbidden } from "../../lib/errors";
import { type PostResult, SYSTEM_ACCOUNTS, postInTx } from "./ledger.service";

type Tx = Prisma.TransactionClient;

export const newReference = (prefix: string) => `${prefix}-${randomBytes(8).toString("hex").toUpperCase()}`;

async function userAccount(tx: Tx, userId: string, type: LedgerAccountType) {
  const a = await tx.ledgerAccount.findFirst({ where: { type, wallet: { userId } }, select: { id: true } });
  if (!a) throw badRequest("NO_WALLET", "Wallet not found");
  return a.id;
}

async function merchantAccount(tx: Tx, merchantAccountId: string) {
  const a = await tx.ledgerAccount.findUnique({ where: { merchantAccountId }, select: { id: true } });
  if (!a) throw badRequest("NO_MERCHANT_ACCOUNT", "Merchant settlement account not found");
  return a.id;
}

async function systemAccount(tx: Tx, key: string) {
  const a = await tx.ledgerAccount.findUnique({ where: { systemKey: key }, select: { id: true } });
  if (!a) throw new Error(`System ledger account missing: ${key} (run the seed / ensureSystemAccounts)`);
  return a.id;
}

/** Users whose account or card is not ACTIVE cannot spend or withdraw. */
async function assertCanSpend(tx: Tx, userId: string) {
  const user = await tx.user.findUnique({ where: { id: userId }, select: { status: true, card: { select: { status: true } } } });
  if (!user || user.status !== "ACTIVE") throw forbidden("Account is not active");
  if (!user.card || user.card.status !== "ACTIVE") throw forbidden("NeS card is not active");
}

interface Base {
  reference: string;
  idempotencyKey: string;
  amountNes: bigint;
  metadata?: Prisma.InputJsonValue;
}

/** Call ONLY after PawaPay has confirmed the deposit as completed (verified server-side). */
export async function creditDeposit(tx: Tx, p: Base & { userId: string }): Promise<PostResult> {
  return postInTx(tx, {
    reference: p.reference,
    idempotencyKey: p.idempotencyKey,
    type: "DEPOSIT",
    description: "Deposit",
    metadata: p.metadata,
    entries: [
      { accountId: await systemAccount(tx, SYSTEM_ACCOUNTS.float.key), direction: "DEBIT", amountNes: p.amountNes },
      { accountId: await userAccount(tx, p.userId, "USER_WALLET"), direction: "CREDIT", amountNes: p.amountNes },
    ],
  });
}

export async function reserveWithdrawal(tx: Tx, p: Base & { userId: string }): Promise<PostResult> {
  await assertCanSpend(tx, p.userId);
  return postInTx(tx, {
    reference: p.reference,
    idempotencyKey: p.idempotencyKey,
    type: "WITHDRAWAL",
    description: "Withdrawal reserved",
    metadata: p.metadata,
    entries: [
      { accountId: await userAccount(tx, p.userId, "USER_WALLET"), direction: "DEBIT", amountNes: p.amountNes },
      { accountId: await systemAccount(tx, SYSTEM_ACCOUNTS.withdrawalReserve.key), direction: "CREDIT", amountNes: p.amountNes },
    ],
  });
}

/** Call ONLY after PawaPay confirms the payout completed. */
export async function completeWithdrawal(tx: Tx, p: Base): Promise<PostResult> {
  return postInTx(tx, {
    reference: p.reference,
    idempotencyKey: p.idempotencyKey,
    type: "WITHDRAWAL",
    description: "Withdrawal paid out",
    metadata: p.metadata,
    entries: [
      { accountId: await systemAccount(tx, SYSTEM_ACCOUNTS.withdrawalReserve.key), direction: "DEBIT", amountNes: p.amountNes },
      { accountId: await systemAccount(tx, SYSTEM_ACCOUNTS.float.key), direction: "CREDIT", amountNes: p.amountNes },
    ],
  });
}

/** Payout failed/expired: release the reserved credits back to the user. */
export async function reverseWithdrawal(tx: Tx, p: Base & { userId: string }): Promise<PostResult> {
  return postInTx(tx, {
    reference: p.reference,
    idempotencyKey: p.idempotencyKey,
    type: "WITHDRAWAL_REVERSAL",
    description: "Withdrawal reversed",
    metadata: p.metadata,
    entries: [
      { accountId: await systemAccount(tx, SYSTEM_ACCOUNTS.withdrawalReserve.key), direction: "DEBIT", amountNes: p.amountNes },
      { accountId: await userAccount(tx, p.userId, "USER_WALLET"), direction: "CREDIT", amountNes: p.amountNes },
    ],
  });
}

export async function payMerchant(tx: Tx, p: Base & { userId: string; merchantAccountId: string }): Promise<PostResult> {
  await assertCanSpend(tx, p.userId);
  return postInTx(tx, {
    reference: p.reference,
    idempotencyKey: p.idempotencyKey,
    type: "MERCHANT_PAYMENT",
    description: "Merchant payment",
    metadata: p.metadata,
    entries: [
      { accountId: await userAccount(tx, p.userId, "USER_WALLET"), direction: "DEBIT", amountNes: p.amountNes },
      { accountId: await merchantAccount(tx, p.merchantAccountId), direction: "CREDIT", amountNes: p.amountNes },
    ],
  });
}

/** Fails with INSUFFICIENT_FUNDS if the merchant's settlement balance cannot cover it. */
export async function refundToUser(tx: Tx, p: Base & { userId: string; merchantAccountId: string }): Promise<PostResult> {
  return postInTx(tx, {
    reference: p.reference,
    idempotencyKey: p.idempotencyKey,
    type: "REFUND",
    description: "Refund",
    metadata: p.metadata,
    entries: [
      { accountId: await merchantAccount(tx, p.merchantAccountId), direction: "DEBIT", amountNes: p.amountNes },
      { accountId: await userAccount(tx, p.userId, "USER_WALLET"), direction: "CREDIT", amountNes: p.amountNes },
    ],
  });
}

/**
 * Administrative adjustment. Requires an ADMIN/SUPER_ADMIN actor, a written reason,
 * and an idempotency key; always writes an audit record in the same transaction.
 */
export async function adminAdjustment(
  tx: Tx,
  p: { adminId: string; userId: string; direction: "CREDIT" | "DEBIT"; amountNes: bigint; reason: string; idempotencyKey: string },
): Promise<PostResult> {
  const admin = await tx.user.findUnique({ where: { id: p.adminId }, select: { role: true, status: true } });
  if (!admin || admin.status !== "ACTIVE" || (admin.role !== "ADMIN" && admin.role !== "SUPER_ADMIN")) {
    throw forbidden("Administrator authorization required");
  }
  if (p.reason.trim().length < 10) throw badRequest("REASON_REQUIRED", "A written reason (10+ characters) is required");

  const adjustments = await systemAccount(tx, SYSTEM_ACCOUNTS.adjustments.key);
  const wallet = await userAccount(tx, p.userId, "USER_WALLET");
  const credit = p.direction === "CREDIT";
  const result = await postInTx(tx, {
    reference: newReference("ADJ"),
    idempotencyKey: p.idempotencyKey,
    type: "ADJUSTMENT",
    description: p.reason,
    actorId: p.adminId,
    entries: [
      { accountId: credit ? adjustments : wallet, direction: "DEBIT", amountNes: p.amountNes },
      { accountId: credit ? wallet : adjustments, direction: "CREDIT", amountNes: p.amountNes },
    ],
  });
  if (!result.replayed) {
    await tx.auditLog.create({
      data: {
        actorId: p.adminId,
        action: "LEDGER_ADJUSTMENT",
        entityType: "LedgerTransaction",
        entityId: result.transaction.id,
        after: { userId: p.userId, direction: p.direction, amountNes: p.amountNes.toString(), reason: p.reason },
      },
    });
  }
  return result;
}
