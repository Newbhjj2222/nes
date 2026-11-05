import { randomUUID } from "node:crypto";
import type { Prisma, Withdrawal } from "@prisma/client";
import { RWF_PER_NES, nesToRwf } from "../../config/currency";
import { env } from "../../config/env";
import { MAX_WITHDRAWAL_NES, MIN_WITHDRAWAL_NES, PENDING_RECHECK_MS, WITHDRAWAL_FEE_NES } from "../../config/limits";
import { AppError, badRequest, conflict } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { completeWithdrawal, newReference, reserveWithdrawal, reverseWithdrawal } from "../ledger/ledger.operations";
import { type InitResult, type TransactionData, getPawaPayClient } from "../pawapay/pawapay.client";
import { allowedProviders, parseProviderAmount, toRwandaMsisdn } from "../pawapay/pawapay.utils";

export interface CreateWithdrawalInput {
  amountNes: bigint;
  provider: string;
  phoneNumber: string; // E.164
  idempotencyKey: string;
}

const NOT_FOUND_REASON = "NOT_FOUND_AT_PROVIDER";
type Tx = Prisma.TransactionClient;

/**
 * PLACEHOLDER eligibility rules, pending compliance sign-off:
 *  1. WITHDRAWALS_ENABLED must be on.
 *  2. The destination number+provider must match one the user has already completed a deposit from.
 *  3. Only credits bought through completed deposits are withdrawable
 *     (completed deposits minus non-failed withdrawals), capped by the available balance.
 *     Refund-, adjustment- or merchant-sourced credits are not withdrawable.
 */
async function withdrawableNes(tx: Tx, userId: string): Promise<bigint> {
  const [wallet, deposited, withdrawn] = await Promise.all([
    tx.wallet.findUniqueOrThrow({ where: { userId } }),
    tx.deposit.aggregate({ where: { userId, status: "COMPLETED" }, _sum: { amountNes: true } }),
    tx.withdrawal.aggregate({ where: { userId, status: { in: ["PENDING", "PROCESSING", "COMPLETED"] } }, _sum: { amountNes: true } }),
  ]);
  const byHistory = (deposited._sum.amountNes ?? 0n) - (withdrawn._sum.amountNes ?? 0n);
  const cap = byHistory < 0n ? 0n : byHistory;
  return wallet.availableNes < cap ? wallet.availableNes : cap;
}

export async function createWithdrawal(userId: string, input: CreateWithdrawalInput) {
  if (!env.WITHDRAWALS_ENABLED) throw new AppError(403, "WITHDRAWALS_DISABLED", "Withdrawals are not available yet");

  const msisdn = toRwandaMsisdn(input.phoneNumber);
  if (!msisdn) throw badRequest("INVALID_PHONE", "Enter a valid Rwandan mobile money number");
  if (!allowedProviders().includes(input.provider)) throw badRequest("UNSUPPORTED_PROVIDER", "Unsupported mobile money provider");
  if (input.amountNes < MIN_WITHDRAWAL_NES || input.amountNes > MAX_WITHDRAWAL_NES) {
    throw badRequest("AMOUNT_OUT_OF_BOUNDS", `Withdrawal must be between ${MIN_WITHDRAWAL_NES} and ${MAX_WITHDRAWAL_NES} NeS`);
  }

  const key = `${userId}:${input.idempotencyKey}`;
  const same = (w: Withdrawal) => w.amountNes === input.amountNes && w.provider === input.provider && w.phoneNumber === msisdn;
  const existing = await prisma.withdrawal.findUnique({ where: { idempotencyKey: key } });
  if (existing) {
    if (!same(existing)) throw conflict("IDEMPOTENCY_MISMATCH", "Idempotency key was already used with a different request");
    return { withdrawal: existing, replayed: true };
  }

  const client = getPawaPayClient();
  const amountRwf = nesToRwf(input.amountNes);
  let withdrawal: Withdrawal;
  try {
    withdrawal = await prisma.$transaction(async (tx) => {
      // Serialise this user's withdrawals so the eligibility cap cannot be raced.
      await tx.$queryRaw`SELECT id FROM wallets WHERE "userId" = ${userId} FOR UPDATE`;

      const matched = await tx.deposit.findFirst({
        where: { userId, status: "COMPLETED", phoneNumber: msisdn, provider: input.provider },
        select: { id: true },
      });
      if (!matched) throw new AppError(403, "DESTINATION_NOT_ELIGIBLE", "Withdrawals can only go to a number you have deposited from");
      if ((await withdrawableNes(tx, userId)) < input.amountNes) {
        throw new AppError(422, "INSUFFICIENT_WITHDRAWABLE", "Amount exceeds your withdrawable NeS balance");
      }

      const reference = newReference("WDR");
      const reserve = await reserveWithdrawal(tx, {
        userId,
        amountNes: input.amountNes,
        reference: `${reference}-RSV`,
        idempotencyKey: `withdrawal-reserve:${key}`,
      });
      return tx.withdrawal.create({
        data: {
          userId,
          reference,
          idempotencyKey: key,
          amountNes: input.amountNes,
          amountRwf,
          feeNes: WITHDRAWAL_FEE_NES,
          conversionRate: Number(RWF_PER_NES),
          provider: input.provider,
          phoneNumber: msisdn,
          status: "PENDING",
          environment: client.environment,
          providerPayoutId: randomUUID(),
          reserveLedgerTxId: reserve.transaction.id,
        },
      });
    });
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") {
      const raced = await prisma.withdrawal.findUnique({ where: { idempotencyKey: key } });
      if (raced && same(raced)) return { withdrawal: raced, replayed: true };
    }
    throw e;
  }

  // Credits are reserved and the payout id is stored; only now do we talk to PawaPay.
  const result = await client.initiatePayout({
    id: withdrawal.providerPayoutId,
    amount: amountRwf.toString(),
    currency: "RWF",
    phoneNumber: msisdn,
    provider: input.provider,
  });
  return { withdrawal: await applyInitResult(withdrawal, result), replayed: false };
}

async function applyInitResult(w: Withdrawal, r: InitResult): Promise<Withdrawal> {
  if (r.kind === "accepted") {
    await prisma.withdrawal.updateMany({ where: { id: w.id, status: "PENDING" }, data: { status: "PROCESSING", providerStatus: "ACCEPTED" } });
  } else if (r.kind === "rejected") {
    // Definitive: the payout was not created, so release the reservation.
    await failAndRelease(w.id, "REJECTED", r.failureCode);
  } else if (r.kind === "duplicate") {
    await prisma.withdrawal.updateMany({ where: { id: w.id, status: "PENDING" }, data: { providerStatus: "DUPLICATE_IGNORED" } });
  } else {
    // Unknown outcome: KEEP the credits reserved. The status check decides; never release on a guess.
    logger.warn({ withdrawalId: w.id, reason: r.reason }, "payout initiation outcome unknown");
  }
  return prisma.withdrawal.findUniqueOrThrow({ where: { id: w.id } });
}

/** Marks a withdrawal FAILED and returns the reserved NeS to the wallet, exactly once. */
async function failAndRelease(id: string, providerStatus: string, failureCode: string): Promise<Withdrawal> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM withdrawals WHERE id = ${id} FOR UPDATE`;
    const w = await tx.withdrawal.findUniqueOrThrow({ where: { id } });
    if (w.status !== "PENDING" && w.status !== "PROCESSING") return w;
    const rev = await reverseWithdrawal(tx, {
      userId: w.userId,
      amountNes: w.amountNes,
      reference: `${w.reference}-REV`,
      idempotencyKey: `withdrawal-reverse:${w.id}`,
    });
    await tx.notification.create({
      data: { userId: w.userId, type: "WITHDRAWAL_FAILED", title: "Withdrawal failed", body: `${w.amountNes} NeS were returned to your wallet.` },
    });
    return tx.withdrawal.update({
      where: { id },
      data: { status: "FAILED", providerStatus, failureReason: failureCode, finalLedgerTxId: rev.transaction.id },
    });
  });
}

export async function refreshWithdrawal(id: string): Promise<Withdrawal> {
  const w = await prisma.withdrawal.findUniqueOrThrow({ where: { id } });
  if (w.status === "COMPLETED" || w.status === "FAILED") return w;

  const r = await getPawaPayClient().getPayout(w.providerPayoutId);
  if (r.kind === "unknown") {
    logger.warn({ withdrawalId: id, reason: r.reason }, "payout status check inconclusive");
    return w;
  }
  if (r.kind === "not_found") {
    if (Date.now() - w.createdAt.getTime() < PENDING_RECHECK_MS) return w;
    return failAndRelease(id, "NOT_FOUND", NOT_FOUND_REASON); // docs: NOT_FOUND means it never reached PawaPay
  }
  return applyVerifiedWithdrawal(id, r.data);
}

/** The only place a payout is finalised. `data` must come from PawaPay's status API. */
export async function applyVerifiedWithdrawal(id: string, data: TransactionData): Promise<Withdrawal> {
  switch (data.status) {
    case "COMPLETED":
      return prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM withdrawals WHERE id = ${id} FOR UPDATE`;
        const w = await tx.withdrawal.findUniqueOrThrow({ where: { id } });
        if (w.status === "COMPLETED") return w;
        if (w.status === "FAILED") {
          // We already returned the credits but PawaPay says it paid out: a human must resolve this.
          await tx.auditLog.create({ data: { action: "WITHDRAWAL_COMPLETED_AFTER_FAILED", entityType: "Withdrawal", entityId: w.id, after: { critical: true } } });
          logger.error({ withdrawalId: w.id }, "CRITICAL: payout completed after local failure/reversal");
          return w;
        }
        if (parseProviderAmount(data.amount) !== w.amountRwf || data.currency !== "RWF") {
          await tx.auditLog.create({
            data: { action: "WITHDRAWAL_AMOUNT_MISMATCH", entityType: "Withdrawal", entityId: w.id, after: { expectedRwf: w.amountRwf.toString(), providerAmount: data.amount } },
          });
          return tx.withdrawal.update({ where: { id }, data: { providerStatus: "COMPLETED", failureReason: "AMOUNT_MISMATCH" } });
        }
        const fin = await completeWithdrawal(tx, {
          amountNes: w.amountNes,
          reference: `${w.reference}-PAID`,
          idempotencyKey: `withdrawal-final:${w.id}`,
        });
        await tx.notification.create({
          data: { userId: w.userId, type: "WITHDRAWAL_COMPLETED", title: "Withdrawal sent", body: `${w.amountRwf} RWF were sent to your mobile money account.` },
        });
        return tx.withdrawal.update({
          where: { id },
          data: { status: "COMPLETED", providerStatus: "COMPLETED", failureReason: null, finalLedgerTxId: fin.transaction.id, completedAt: new Date() },
        });
      });
    case "FAILED":
      return failAndRelease(id, "FAILED", data.failureReason?.failureCode ?? "UNSPECIFIED_FAILURE");
    case "ACCEPTED":
    case "ENQUEUED":
    case "PROCESSING":
    case "IN_RECONCILIATION":
      await prisma.withdrawal.updateMany({
        where: { id, status: { in: ["PENDING", "PROCESSING"] } },
        data: { status: "PROCESSING", providerStatus: data.status },
      });
      return prisma.withdrawal.findUniqueOrThrow({ where: { id } });
    default:
      await prisma.auditLog.create({ data: { action: "UNKNOWN_PROVIDER_STATUS", entityType: "Withdrawal", entityId: id, after: { status: data.status } } });
      return prisma.withdrawal.findUniqueOrThrow({ where: { id } });
  }
}

export async function handlePayoutCallback(providerPayoutId: string): Promise<void> {
  const w = await prisma.withdrawal.findUnique({ where: { providerPayoutId }, select: { id: true } });
  if (!w) return;
  await refreshWithdrawal(w.id);
}
