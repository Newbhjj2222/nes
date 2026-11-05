/**
 * Deposit / withdrawal workflow tests against a fake PawaPay. Need Postgres with migrations and
 * prisma/sql/ledger_guards.sql applied (throwaway test DB). Skipped unless RUN_DB_TESTS=true.
 * No real provider or customer funds are involved.
 */
import { randomUUID } from "node:crypto";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { InitResult, LookupResult, PawaPayClient, TransactionData } from "../src/modules/pawapay/pawapay.client";

const run = process.env.RUN_DB_TESTS === "true";

class FakePawaPay implements PawaPayClient {
  environment = "SANDBOX" as const;
  initCalls = 0;
  nextInit: InitResult = { kind: "accepted" };
  deposits = new Map<string, LookupResult<TransactionData>>();
  payouts = new Map<string, LookupResult<TransactionData>>();
  async initiateDeposit() {
    this.initCalls++;
    return this.nextInit;
  }
  async initiatePayout() {
    this.initCalls++;
    return this.nextInit;
  }
  async getDeposit(id: string) {
    return this.deposits.get(id) ?? ({ kind: "not_found" } as const);
  }
  async getPayout(id: string) {
    return this.payouts.get(id) ?? ({ kind: "not_found" } as const);
  }
}
const found = (status: string, amount: string, extra: Partial<TransactionData> = {}): LookupResult<TransactionData> => ({
  kind: "found",
  data: { status, amount, currency: "RWF", ...extra },
});

describe.skipIf(!run)("deposit and withdrawal workflows", () => {
  let prisma: typeof import("../src/lib/prisma").prisma;
  let dep: typeof import("../src/modules/deposits/deposit.service");
  let wd: typeof import("../src/modules/withdrawals/withdrawal.service");
  let job: typeof import("../src/modules/payments/reconcile.job");
  let recon: typeof import("../src/modules/ledger/reconciliation.service");
  let h: typeof import("./helpers");
  let fake: FakePawaPay;

  const balance = async (userId: string) => (await prisma.wallet.findUniqueOrThrow({ where: { userId } })).availableNes;
  const phone = "+250788123456";
  const body = (amountRwf: number) => ({ amountRwf, provider: "MTN_MOMO_RWA", phoneNumber: phone });

  beforeAll(async () => {
    ({ prisma } = await import("../src/lib/prisma"));
    dep = await import("../src/modules/deposits/deposit.service");
    wd = await import("../src/modules/withdrawals/withdrawal.service");
    job = await import("../src/modules/payments/reconcile.job");
    recon = await import("../src/modules/ledger/reconciliation.service");
    h = await import("./helpers");
    await (await import("../src/modules/ledger/ledger.service")).ensureSystemAccounts();
  });
  beforeEach(async () => {
    fake = new FakePawaPay();
    (await import("../src/modules/pawapay/pawapay.client")).setPawaPayClient(fake);
  });

  const newDeposit = async (userId: string, rwf = 5000) =>
    (await dep.createDeposit(userId, { amountRwf: BigInt(rwf), provider: "MTN_MOMO_RWA", phoneNumber: phone, idempotencyKey: randomUUID() })).deposit;

  it("5,000 RWF deposit credits 250 NeS only after PawaPay confirms", async () => {
    const u = await h.createTestUser();
    const d = await newDeposit(u.id);
    expect(d.amountNes).toBe(250n);
    expect(d.conversionRate).toBe(20);
    expect(d.status).toBe("PROCESSING");
    expect(await balance(u.id)).toBe(0n); // accepted != paid

    fake.deposits.set(d.providerDepositId, found("PROCESSING", "5000"));
    await dep.refreshDeposit(d.id);
    expect(await balance(u.id)).toBe(0n);

    fake.deposits.set(d.providerDepositId, found("COMPLETED", "5000"));
    const done = await dep.refreshDeposit(d.id);
    expect(done.status).toBe("COMPLETED");
    expect(await balance(u.id)).toBe(250n);
    expect(done.ledgerTransactionId).toBeTruthy();
  });

  it("duplicate and concurrent callbacks credit exactly once", async () => {
    const u = await h.createTestUser();
    const d = await newDeposit(u.id, 2000);
    fake.deposits.set(d.providerDepositId, found("COMPLETED", "2000.00"));
    await Promise.all(Array.from({ length: 6 }, () => dep.handleDepositCallback(d.providerDepositId)));
    await dep.handleDepositCallback(d.providerDepositId);
    expect(await balance(u.id)).toBe(100n);
    expect(await prisma.ledgerTransaction.count({ where: { idempotencyKey: `deposit:${d.id}` } })).toBe(1);
  });

  it("a forged callback cannot credit: PawaPay does not know the deposit", async () => {
    const u = await h.createTestUser();
    const d = await newDeposit(u.id);
    await dep.handleDepositCallback(d.providerDepositId); // fake says NOT_FOUND
    expect(await balance(u.id)).toBe(0n);
    await dep.handleDepositCallback(randomUUID()); // unknown id is ignored
  });

  it("amount or currency mismatch is not credited and is audited", async () => {
    const u = await h.createTestUser();
    const d = await newDeposit(u.id, 5000);
    fake.deposits.set(d.providerDepositId, found("COMPLETED", "100"));
    const r = await dep.refreshDeposit(d.id);
    expect(r.status).not.toBe("COMPLETED");
    expect(r.failureReason).toBe("AMOUNT_MISMATCH");
    expect(await balance(u.id)).toBe(0n);
    expect(await prisma.auditLog.count({ where: { action: "DEPOSIT_AMOUNT_MISMATCH", entityId: d.id } })).toBe(1);
  });

  it("failed and rejected deposits never touch the wallet", async () => {
    const u = await h.createTestUser();
    const d = await newDeposit(u.id);
    fake.deposits.set(d.providerDepositId, found("FAILED", "5000", { failureReason: { failureCode: "PAYMENT_NOT_APPROVED" } }));
    const r = await dep.refreshDeposit(d.id);
    expect(r).toMatchObject({ status: "FAILED", failureReason: "PAYMENT_NOT_APPROVED" });

    fake.nextInit = { kind: "rejected", failureCode: "PROVIDER_TEMPORARILY_UNAVAILABLE" };
    const rej = await newDeposit(u.id);
    expect(rej.status).toBe("FAILED");
    expect(await balance(u.id)).toBe(0n);
  });

  it("unknown initiation outcome stays PENDING; reconciliation resolves it", async () => {
    const u = await h.createTestUser();
    fake.nextInit = { kind: "unknown", reason: "HTTP 500" };
    const d = await newDeposit(u.id);
    expect(d.status).toBe("PENDING");
    await dep.refreshDeposit(d.id); // NOT_FOUND but inside the grace window: stay pending
    expect((await prisma.deposit.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("PENDING");

    await prisma.$executeRaw`UPDATE deposits SET "createdAt" = now() - interval '30 minutes' WHERE id = ${d.id}`;
    fake.deposits.set(d.providerDepositId, found("COMPLETED", "5000"));
    const r = await job.reconcilePending();
    expect(r.errors).toBe(0);
    expect(await balance(u.id)).toBe(250n);
  });

  it("NOT_FOUND after the grace period marks the deposit failed", async () => {
    const u = await h.createTestUser();
    fake.nextInit = { kind: "unknown", reason: "timeout" };
    const d = await newDeposit(u.id);
    await prisma.$executeRaw`UPDATE deposits SET "createdAt" = now() - interval '30 minutes' WHERE id = ${d.id}`;
    expect((await dep.refreshDeposit(d.id)).status).toBe("FAILED");
    expect(await balance(u.id)).toBe(0n);
  });

  it("deposit idempotency: same key returns the same deposit with one provider call", async () => {
    const u = await h.createTestUser();
    const input = { amountRwf: 5000n, provider: "MTN_MOMO_RWA", phoneNumber: phone, idempotencyKey: "idem-key-12345" };
    const a = await dep.createDeposit(u.id, input);
    const b = await dep.createDeposit(u.id, input);
    expect(b.replayed).toBe(true);
    expect(b.deposit.id).toBe(a.deposit.id);
    expect(fake.initCalls).toBe(1);
    await expect(dep.createDeposit(u.id, { ...input, amountRwf: 6000n })).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
  });

  it("validates amounts, phones and providers", async () => {
    const u = await h.createTestUser();
    const k = () => randomUUID();
    await expect(dep.createDeposit(u.id, { amountRwf: 5010n, provider: "MTN_MOMO_RWA", phoneNumber: phone, idempotencyKey: k() })).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
    await expect(dep.createDeposit(u.id, { amountRwf: 20n, provider: "MTN_MOMO_RWA", phoneNumber: phone, idempotencyKey: k() })).rejects.toMatchObject({ code: "AMOUNT_OUT_OF_BOUNDS" });
    await expect(dep.createDeposit(u.id, { amountRwf: 5000n, provider: "NOPE", phoneNumber: phone, idempotencyKey: k() })).rejects.toMatchObject({ code: "UNSUPPORTED_PROVIDER" });
    await expect(dep.createDeposit(u.id, { amountRwf: 5000n, provider: "MTN_MOMO_RWA", phoneNumber: "+254712345678", idempotencyKey: k() })).rejects.toMatchObject({ code: "INVALID_PHONE" });
  });

  // ───── withdrawals ─────
  const fundedUser = async (rwf = 10000) => {
    const u = await h.createTestUser();
    const d = await newDeposit(u.id, rwf);
    fake.deposits.set(d.providerDepositId, found("COMPLETED", String(rwf)));
    await dep.refreshDeposit(d.id);
    return u;
  };
  const newWithdrawal = async (userId: string, nes: bigint, key = randomUUID()) =>
    wd.createWithdrawal(userId, { amountNes: nes, provider: "MTN_MOMO_RWA", phoneNumber: phone, idempotencyKey: key });

  it("withdrawal: 100 NeS reserves, then pays out 2,000 RWF on confirmation", async () => {
    const u = await fundedUser(10000); // 500 NeS
    const { withdrawal: w } = await newWithdrawal(u.id, 100n);
    expect(w.amountRwf).toBe(2000n);
    expect(w.status).toBe("PROCESSING");
    expect(await balance(u.id)).toBe(400n); // reserved immediately

    fake.payouts.set(w.providerPayoutId, found("COMPLETED", "2000"));
    expect((await wd.refreshWithdrawal(w.id)).status).toBe("COMPLETED");
    expect(await balance(u.id)).toBe(400n);
    await wd.refreshWithdrawal(w.id); // idempotent
    expect(await prisma.ledgerTransaction.count({ where: { idempotencyKey: `withdrawal-final:${w.id}` } })).toBe(1);
  });

  it("failed payout returns the reserved NeS exactly once", async () => {
    const u = await fundedUser(10000);
    const { withdrawal: w } = await newWithdrawal(u.id, 100n);
    fake.payouts.set(w.providerPayoutId, found("FAILED", "2000", { failureReason: { failureCode: "RECIPIENT_NOT_FOUND" } }));
    await Promise.all([wd.refreshWithdrawal(w.id), wd.refreshWithdrawal(w.id), wd.handlePayoutCallback(w.providerPayoutId)]);
    expect(await balance(u.id)).toBe(500n);
    expect((await prisma.withdrawal.findUniqueOrThrow({ where: { id: w.id } })).status).toBe("FAILED");
  });

  it("rejected initiation releases the reservation; unknown outcome keeps it", async () => {
    const u = await fundedUser(10000);
    fake.nextInit = { kind: "rejected", failureCode: "PROVIDER_TEMPORARILY_UNAVAILABLE" };
    const { withdrawal: r } = await newWithdrawal(u.id, 100n);
    expect(r.status).toBe("FAILED");
    expect(await balance(u.id)).toBe(500n);

    fake.nextInit = { kind: "unknown", reason: "timeout" };
    const { withdrawal: p } = await newWithdrawal(u.id, 100n);
    expect(p.status).toBe("PENDING");
    expect(await balance(u.id)).toBe(400n); // still held: we do not guess
  });

  it("enforces eligibility: matching destination, withdrawable cap, funds", async () => {
    const u = await fundedUser(10000); // 500 NeS from deposits
    await expect(
      wd.createWithdrawal(u.id, { amountNes: 10n, provider: "MTN_MOMO_RWA", phoneNumber: "+250799999999", idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: "DESTINATION_NOT_ELIGIBLE" });
    await expect(newWithdrawal(u.id, 501n)).rejects.toMatchObject({ code: "INSUFFICIENT_WITHDRAWABLE" });

    // credits that did not come from deposits are not withdrawable
    const admin = await h.createTestUser("ADMIN");
    const ops = await import("../src/modules/ledger/ledger.operations");
    await prisma.$transaction((tx) => ops.adminAdjustment(tx, { adminId: admin.id, userId: u.id, direction: "CREDIT", amountNes: 100n, reason: "goodwill credit for outage", idempotencyKey: randomUUID() }));
    expect(await balance(u.id)).toBe(600n);
    await expect(newWithdrawal(u.id, 600n)).rejects.toMatchObject({ code: "INSUFFICIENT_WITHDRAWABLE" });
    await newWithdrawal(u.id, 500n);
  });

  it("concurrent withdrawals cannot exceed the withdrawable amount", async () => {
    const u = await fundedUser(10000); // 500 NeS
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => newWithdrawal(u.id, 100n)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    expect(await balance(u.id)).toBe(0n);
  });

  it("withdrawal idempotency: replay returns the same withdrawal and reserves once", async () => {
    const u = await fundedUser(10000);
    const a = await newWithdrawal(u.id, 100n, "wd-key-123456");
    const b = await newWithdrawal(u.id, 100n, "wd-key-123456");
    expect(b.replayed).toBe(true);
    expect(b.withdrawal.id).toBe(a.withdrawal.id);
    expect(await balance(u.id)).toBe(400n);
  });

  // ───── HTTP layer ─────
  it("HTTP: requires Idempotency-Key, enforces ownership, shows RWF only on confirmations", async () => {
    const { createApp } = await import("../src/app");
    const app = createApp();
    const a = await h.createTestUser();
    const b = await h.createTestUser();
    const email = async (id: string) => (await prisma.user.findUniqueOrThrow({ where: { id } })).email!;
    const ag = request.agent(app);
    const bg = request.agent(app);
    await ag.post("/api/v1/auth/login").send({ identifier: await email(a.id), password: "Str0ngPassword" });
    await bg.post("/api/v1/auth/login").send({ identifier: await email(b.id), password: "Str0ngPassword" });

    expect((await ag.post("/api/v1/deposits").send(body(5000))).status).toBe(400);
    const created = await ag.post("/api/v1/deposits").set("Idempotency-Key", "http-key-12345").send(body(5000));
    expect(created.status).toBe(201);
    expect(created.body.deposit).toMatchObject({ amountRwf: "5000", amountNes: "250", status: "PROCESSING" });

    expect((await bg.get(`/api/v1/deposits/${created.body.deposit.id}`)).status).toBe(404); // not b's
    expect((await ag.get(`/api/v1/deposits/${created.body.deposit.id}`)).status).toBe(200);
    expect((await request(app).get(`/api/v1/deposits/${created.body.deposit.id}`)).status).toBe(401);

    const bal = await ag.get("/api/v1/wallet/balance");
    expect(bal.body.wallet.availableNes).toBe("0");
    expect(JSON.stringify(bal.body)).not.toMatch(/rwf/i);

    // the callback endpoint answers 200 and credits only via verification
    fake.deposits.set((await prisma.deposit.findUniqueOrThrow({ where: { id: created.body.deposit.id } })).providerDepositId, found("COMPLETED", "5000"));
    const cb = await request(app).post("/callbacks/pawapay/deposits").send({
      depositId: (await prisma.deposit.findUniqueOrThrow({ where: { id: created.body.deposit.id } })).providerDepositId,
      status: "COMPLETED",
    });
    expect(cb.status).toBe(200);
    expect((await ag.get("/api/v1/wallet/balance")).body.wallet.availableNes).toBe("250");
  });

  it("reconciliation is clean after all money movement", async () => {
    const report = await recon.reconcile();
    expect(report.ok).toBe(true);
  });
});
