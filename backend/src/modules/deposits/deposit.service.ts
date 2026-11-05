import { randomUUID } from "node:crypto";
import type { Deposit } from "@prisma/client";
import { RWF_PER_NES, rwfToNes } from "../../config/currency";
import { MAX_DEPOSIT_RWF, MIN_DEPOSIT_RWF, PENDING_RECHECK_MS } from "../../config/limits";
import { badRequest, conflict, forbidden } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { creditDeposit, newReference } from "../ledger/ledger.operations";
import { type InitResult, type TransactionData, getPawaPayClient } from "../pawapay/pawapay.client";
import { allowedProviders, parseProviderAmount, toRwandaMsisdn } from "../pawapay/pawapay.utils";

export interface CreateDepositInput {
  amountRwf: bigint;
  provider: string;
  phoneNumber: string; // E.164
  idempotencyKey: string; // client-supplied, scoped per user
}

const NOT_FOUND_REASON = "NOT_FOUND_AT_PROVIDER";

/**
 * Steps 4-5 of the deposit workflow: create the order, persist it BEFORE calling PawaPay,
 * then initiate. The wallet is never touched here; only verified provider data can do that.
 */
export async function createDeposit(userId: string, input: CreateDepositInput) {
  const msisdn = toRwandaMsisdn(input.phoneNumber);
  if (!msisdn) throw badRequest("INVALID_PHONE", "Enter a valid Rwandan mobile money number");
  if (!allowedProviders().includes(input.provider)) throw badRequest("UNSUPPORTED_PROVIDER", "Unsupported mobile money provider");
  const amountNes = rwfToNes(input.amountRwf);
  if (amountNes === null) throw badRequest("INVALID_AMOUNT", `Amount must be a multiple of ${RWF_PER_NES} RWF`);
  if (input.amountRwf < MIN_DEPOSIT_RWF || input.amountRwf > MAX_DEPOSIT_RWF) {
    throw badRequest("AMOUNT_OUT_OF_BOUNDS", `Deposit must be between ${MIN_DEPOSIT_RWF} and ${MAX_DEPOSIT_RWF} RWF`);
  }

  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { status: true, card: { select: { status: true } } } });
  if (user.status !== "ACTIVE" || user.card?.status !== "ACTIVE") throw forbidden("Account or card is not active");

  const key = `${userId}:${input.idempotencyKey}`;
  const sameRequest = (d: Deposit) => d.amountRwf === input.amountRwf && d.provider === input.provider && d.phoneNumber === msisdn;
  const existing = await prisma.deposit.findUnique({ where: { idempotencyKey: key } });
  if (existing) {
    if (!sameRequest(existing)) throw conflict("IDEMPOTENCY_MISMATCH", "Idempotency key was already used with a different request");
    return { deposit: existing, replayed: true };
  }

  const client = getPawaPayClient();
  let deposit: Deposit;
  try {
    deposit = await prisma.deposit.create({
      data: {
        userId,
        reference: newReference("DEP"),
        idempotencyKey: key,
        amountRwf: input.amountRwf,
        amountNes,
        conversionRate: Number(RWF_PER_NES),
        provider: input.provider,
        phoneNumber: msisdn,
        status: "PENDING",
        environment: client.environment,
        providerDepositId: randomUUID(),
      },
    });
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") {
      const raced = await prisma.deposit.findUnique({ where: { idempotencyKey: key } });
      if (raced && sameRequest(raced)) return { deposit: raced, replayed: true };
    }
    throw e;
  }

  const result = await client.initiateDeposit({
    id: deposit.providerDepositId,
    amount: deposit.amountRwf.toString(),
    currency: "RWF",
    phoneNumber: msisdn,
    provider: input.provider,
  });
  return { deposit: await applyInitResult(deposit.id, result), replayed: false };
}

async function applyInitResult(id: string, r: InitResult): Promise<Deposit> {
  // updateMany + status guard: never overwrite a result a fast callback already applied.
  if (r.kind === "accepted") {
    await prisma.deposit.updateMany({ where: { id, status: "PENDING" }, data: { status: "PROCESSING", providerStatus: "ACCEPTED" } });
  } else if (r.kind === "rejected") {
    await prisma.deposit.updateMany({
      where: { id, status: "PENDING" },
      data: { status: "FAILED", providerStatus: "REJECTED", failureReason: r.failureCode },
    });
    if (r.failureCode.startsWith("AUTH")) logger.error({ depositId: id, code: r.failureCode }, "PawaPay rejected our credentials");
  } else if (r.kind === "duplicate") {
    await prisma.deposit.updateMany({ where: { id, status: "PENDING" }, data: { providerStatus: "DUPLICATE_IGNORED" } });
  } else {
    // Unknown outcome (timeout / 5xx): stay PENDING. The status check / reconciliation job decides.
    logger.warn({ depositId: id, reason: r.reason }, "deposit initiation outcome unknown");
  }
  return prisma.deposit.findUniqueOrThrow({ where: { id } });
}

/**
 * Re-checks a deposit with PawaPay and applies the verified result.
 * Used by callbacks, the user's status polling, and the reconciliation job.
 */
export async function refreshDeposit(id: string): Promise<Deposit> {
  const dep = await prisma.deposit.findUniqueOrThrow({ where: { id } });
  if (dep.status === "COMPLETED") return dep;
  if (dep.status === "FAILED" && dep.failureReason !== NOT_FOUND_REASON) return dep;

  const r = await getPawaPayClient().getDeposit(dep.providerDepositId);
  if (r.kind === "unknown") {
    logger.warn({ depositId: id, reason: r.reason }, "deposit status check inconclusive");
    return dep;
  }
  if (r.kind === "not_found") {
    // Only safe to call it failed after a grace period (the initiation call may still be in flight).
    if (dep.status === "FAILED" || Date.now() - dep.createdAt.getTime() < PENDING_RECHECK_MS) return dep;
    return prisma.deposit.update({
      where: { id },
      data: { status: "FAILED", providerStatus: "NOT_FOUND", failureReason: NOT_FOUND_REASON },
    });
  }
  return applyVerifiedDeposit(id, r.data);
}

/** The ONLY place a deposit credits a wallet. `data` must come from PawaPay's status API. */
export async function applyVerifiedDeposit(id: string, data: TransactionData): Promise<Deposit> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM deposits WHERE id = ${id} FOR UPDATE`;
    const dep = await tx.deposit.findUniqueOrThrow({ where: { id } });

    switch (data.status) {
      case "COMPLETED": {
        if (dep.status === "COMPLETED") return dep;
        if (parseProviderAmount(data.amount) !== dep.amountRwf || data.currency !== "RWF") {
          await tx.auditLog.create({
            data: {
              action: "DEPOSIT_AMOUNT_MISMATCH",
              entityType: "Deposit",
              entityId: dep.id,
              after: { expectedRwf: dep.amountRwf.toString(), providerAmount: data.amount, providerCurrency: data.currency },
            },
          });
          // Do NOT credit. Needs manual review.
          return tx.deposit.update({ where: { id }, data: { providerStatus: "COMPLETED", failureReason: "AMOUNT_MISMATCH" } });
        }
        if (dep.status === "FAILED") {
          await tx.auditLog.create({ data: { action: "DEPOSIT_COMPLETED_AFTER_FAILED", entityType: "Deposit", entityId: dep.id } });
        }
        const { transaction } = await creditDeposit(tx, {
          userId: dep.userId,
          amountNes: dep.amountNes,
          reference: dep.reference,
          idempotencyKey: `deposit:${dep.id}`,
          metadata: { depositId: dep.id, providerDepositId: dep.providerDepositId, amountRwf: dep.amountRwf.toString() },
        });
        await tx.notification.create({
          data: { userId: dep.userId, type: "DEPOSIT_COMPLETED", title: "Deposit received", body: `${dep.amountNes} NeS were added to your wallet.` },
        });
        return tx.deposit.update({
          where: { id },
          data: { status: "COMPLETED", providerStatus: "COMPLETED", failureReason: null, ledgerTransactionId: transaction.id, completedAt: new Date() },
        });
      }
      case "FAILED": {
        if (dep.status === "COMPLETED") {
          await tx.auditLog.create({ data: { action: "DEPOSIT_STATUS_CONFLICT", entityType: "Deposit", entityId: dep.id, after: { provider: "FAILED" } } });
          return dep;
        }
        if (dep.status === "FAILED") return dep;
        await tx.notification.create({
          data: { userId: dep.userId, type: "DEPOSIT_FAILED", title: "Deposit failed", body: "Your deposit could not be completed. You were not charged." },
        });
        return tx.deposit.update({
          where: { id },
          data: { status: "FAILED", providerStatus: "FAILED", failureReason: data.failureReason?.failureCode ?? "UNSPECIFIED_FAILURE" },
        });
      }
      case "ACCEPTED":
      case "PROCESSING":
      case "IN_RECONCILIATION": {
        if (dep.status !== "PENDING" && dep.status !== "PROCESSING") return dep;
        return tx.deposit.update({ where: { id }, data: { status: "PROCESSING", providerStatus: data.status } });
      }
      default: {
        // Unrecognised status: don't guess. Leave state alone and flag it.
        await tx.auditLog.create({
          data: { action: "UNKNOWN_PROVIDER_STATUS", entityType: "Deposit", entityId: dep.id, after: { status: data.status } },
        });
        return dep;
      }
    }
  });
}

/** Callback entry point. The callback body is only a hint: we look the deposit up and verify with PawaPay. */
export async function handleDepositCallback(providerDepositId: string): Promise<void> {
  const dep = await prisma.deposit.findUnique({ where: { providerDepositId }, select: { id: true } });
  if (!dep) return; // unknown id: ignore silently
  await refreshDeposit(dep.id);
}
