import type { Deposit, Withdrawal } from "@prisma/client";
import { type RequestHandler, Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { env } from "../../config/env";
import { badRequest, notFound } from "../../lib/errors";
import { prisma } from "../../lib/prisma";
import { requireAuth } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { createDeposit, handleDepositCallback, refreshDeposit } from "../deposits/deposit.service";
import { allowedProviders, publicFailure } from "../pawapay/pawapay.utils";
import { createWithdrawal, handlePayoutCallback, refreshWithdrawal } from "../withdrawals/withdrawal.service";

const phone = z.string().regex(/^\+\d{8,15}$/, "Phone must be in international format, e.g. +250788123456");

/** Required on money-moving POSTs so client retries can never double-charge. */
const idempotencyKey: RequestHandler = (req, res, next) => {
  const v = req.header("Idempotency-Key");
  if (!v || !/^[A-Za-z0-9_-]{8,64}$/.test(v)) {
    return next(badRequest("IDEMPOTENCY_KEY_REQUIRED", "Send an Idempotency-Key header (8-64 chars: letters, digits, - or _)"));
  }
  res.locals.idempotencyKey = v;
  next();
};

// Amounts are shown in RWF only here, in deposit/withdrawal confirmations (spec section 2).
const depositDto = (d: Deposit) => ({
  id: d.id,
  reference: d.reference,
  status: d.status,
  amountRwf: d.amountRwf.toString(),
  amountNes: d.amountNes.toString(),
  provider: d.provider,
  environment: d.environment,
  failure: publicFailure(d.failureReason),
  createdAt: d.createdAt,
  completedAt: d.completedAt,
});

const withdrawalDto = (w: Withdrawal) => ({
  id: w.id,
  reference: w.reference,
  status: w.status,
  amountNes: w.amountNes.toString(),
  amountRwf: w.amountRwf.toString(),
  provider: w.provider,
  environment: w.environment,
  failure: publicFailure(w.failureReason),
  createdAt: w.createdAt,
  completedAt: w.completedAt,
});

const moneyLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: env.NODE_ENV === "test" ? 10_000 : 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Too many requests" } },
});

// ───────── Deposits ─────────
export const depositsRouter = Router();
depositsRouter.use(requireAuth, moneyLimiter);

depositsRouter.get("/providers", (_req, res) => res.json({ providers: allowedProviders(), currency: "RWF" }));

const depositBody = z.object({
  amountRwf: z.number().int().positive().max(1_000_000_000),
  provider: z.string().min(2).max(40),
  phoneNumber: phone,
});

depositsRouter.post("/", idempotencyKey, validateBody(depositBody), async (req, res, next) => {
  try {
    const { deposit, replayed } = await createDeposit(req.user!.id, {
      amountRwf: BigInt(req.body.amountRwf),
      provider: req.body.provider,
      phoneNumber: req.body.phoneNumber,
      idempotencyKey: res.locals.idempotencyKey,
    });
    res.status(replayed ? 200 : 201).json({ deposit: depositDto(deposit) });
  } catch (e) {
    next(e);
  }
});

depositsRouter.get("/:id", async (req, res, next) => {
  try {
    const id = z.string().uuid().safeParse(req.params.id);
    // Ownership enforced in the query itself: other users' deposits look like they don't exist.
    const found = id.success ? await prisma.deposit.findFirst({ where: { id: id.data, userId: req.user!.id } }) : null;
    if (!found) throw notFound("Deposit not found");
    // Non-final deposits are re-verified with PawaPay; the client's view is never trusted.
    const fresh = found.status === "PENDING" || found.status === "PROCESSING" ? await refreshDeposit(found.id).catch(() => found) : found;
    res.json({ deposit: depositDto(fresh) });
  } catch (e) {
    next(e);
  }
});

// ───────── Withdrawals ─────────
export const withdrawalsRouter = Router();
withdrawalsRouter.use(requireAuth, moneyLimiter);

const withdrawalBody = z.object({
  amountNes: z.number().int().positive().max(1_000_000_000),
  provider: z.string().min(2).max(40),
  phoneNumber: phone,
});

withdrawalsRouter.post("/", idempotencyKey, validateBody(withdrawalBody), async (req, res, next) => {
  try {
    const { withdrawal, replayed } = await createWithdrawal(req.user!.id, {
      amountNes: BigInt(req.body.amountNes),
      provider: req.body.provider,
      phoneNumber: req.body.phoneNumber,
      idempotencyKey: res.locals.idempotencyKey,
    });
    res.status(replayed ? 200 : 201).json({ withdrawal: withdrawalDto(withdrawal) });
  } catch (e) {
    next(e);
  }
});

withdrawalsRouter.get("/:id", async (req, res, next) => {
  try {
    const id = z.string().uuid().safeParse(req.params.id);
    const found = id.success ? await prisma.withdrawal.findFirst({ where: { id: id.data, userId: req.user!.id } }) : null;
    if (!found) throw notFound("Withdrawal not found");
    const fresh = found.status === "PENDING" || found.status === "PROCESSING" ? await refreshWithdrawal(found.id).catch(() => found) : found;
    res.json({ withdrawal: withdrawalDto(fresh) });
  } catch (e) {
    next(e);
  }
});

// ───────── PawaPay callbacks (no user auth) ─────────
/**
 * Configure these URLs in the PawaPay dashboard:
 *   deposits: {PAWAPAY_CALLBACK_BASE_URL}/callbacks/pawapay/deposits
 *   payouts:  {PAWAPAY_CALLBACK_BASE_URL}/callbacks/pawapay/payouts
 *
 * Trust model: the callback body is NEVER used to move money. We read only the id from it, then ask
 * PawaPay's status API for the real state. A forged callback therefore cannot credit anyone.
 * (Optional RFC 9421 callback-signature verification is a defence-in-depth item still to be added.)
 */
export const callbacksRouter = Router();
callbacksRouter.use(
  rateLimit({ windowMs: 60 * 1000, limit: env.NODE_ENV === "test" ? 10_000 : 300, standardHeaders: true, legacyHeaders: false }),
);

callbacksRouter.post("/pawapay/deposits", async (req, res, next) => {
  try {
    const id = z.object({ depositId: z.string().uuid() }).safeParse(req.body);
    if (id.success) await handleDepositCallback(id.data.depositId);
    res.status(200).json({ received: true });
  } catch (e) {
    next(e); // 500 so PawaPay can retry if we could not verify right now
  }
});

callbacksRouter.post("/pawapay/payouts", async (req, res, next) => {
  try {
    const id = z.object({ payoutId: z.string().uuid() }).safeParse(req.body);
    if (id.success) await handlePayoutCallback(id.data.payoutId);
    res.status(200).json({ received: true });
  } catch (e) {
    next(e);
  }
});
