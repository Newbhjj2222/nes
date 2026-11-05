/**
 * Ledger integration tests. Need Postgres with migrations AND prisma/sql/ledger_guards.sql applied.
 * Use a throwaway test database. Skipped unless RUN_DB_TESTS=true.
 */
import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";

const run = process.env.RUN_DB_TESTS === "true";

describe.skipIf(!run)("ledger engine", () => {
  let prisma: typeof import("../src/lib/prisma").prisma;
  let ops: typeof import("../src/modules/ledger/ledger.operations");
  let svc: typeof import("../src/modules/ledger/ledger.service");
  let recon: typeof import("../src/modules/ledger/reconciliation.service");
  let h: typeof import("./helpers");

  const balance = async (userId: string) => (await prisma.wallet.findUniqueOrThrow({ where: { userId } })).availableNes;

  beforeAll(async () => {
    ({ prisma } = await import("../src/lib/prisma"));
    ops = await import("../src/modules/ledger/ledger.operations");
    svc = await import("../src/modules/ledger/ledger.service");
    recon = await import("../src/modules/ledger/reconciliation.service");
    h = await import("./helpers");
    await svc.ensureSystemAccounts();
  });

  it("deposit of 5,000 RWF credits 250 NeS and ledger matches cache", async () => {
    const { rwfToNes } = await import("../src/config/currency");
    const u = await h.createTestUser();
    const nes = rwfToNes(5000n)!;
    await h.fundUser(u.id, nes);
    expect(await balance(u.id)).toBe(250n);
    const acct = await prisma.ledgerAccount.findFirstOrThrow({ where: { type: "USER_WALLET", wallet: { userId: u.id } } });
    expect(await svc.getLedgerBalance(prisma, acct.id)).toBe(250n);
    const tx = await prisma.ledgerTransaction.findFirstOrThrow({ where: { entries: { some: { accountId: acct.id } } } });
    expect(tx.conversionRate).toBe(20);
  });

  it("merchant payment: 500 NeS user pays 50, ends with 450, merchant gets 50", async () => {
    const u = await h.createTestUser();
    const m = await h.createTestMerchant();
    await h.fundUser(u.id, 500n);
    await prisma.$transaction((tx) =>
      ops.payMerchant(tx, { userId: u.id, merchantAccountId: m.id, amountNes: 50n, reference: h.ref(), idempotencyKey: `p-${h.ref()}` }),
    );
    expect(await balance(u.id)).toBe(450n);
    expect((await prisma.merchantAccount.findUniqueOrThrow({ where: { id: m.id } })).settlementNes).toBe(50n);
  });

  it("rejects insufficient balance and leaves everything unchanged", async () => {
    const u = await h.createTestUser();
    const m = await h.createTestMerchant();
    await h.fundUser(u.id, 40n);
    await expect(
      prisma.$transaction((tx) =>
        ops.payMerchant(tx, { userId: u.id, merchantAccountId: m.id, amountNes: 50n, reference: h.ref(), idempotencyKey: `p-${h.ref()}` }),
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_FUNDS" });
    expect(await balance(u.id)).toBe(40n);
  });

  it("idempotent replay does not double-apply; a different payload with the same key is rejected", async () => {
    const u = await h.createTestUser();
    const m = await h.createTestMerchant();
    await h.fundUser(u.id, 100n);
    const p = { userId: u.id, merchantAccountId: m.id, amountNes: 30n, reference: h.ref(), idempotencyKey: `same-${h.ref()}` };
    const first = await prisma.$transaction((tx) => ops.payMerchant(tx, p));
    const second = await prisma.$transaction((tx) => ops.payMerchant(tx, { ...p, reference: h.ref() }));
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.transaction.id).toBe(first.transaction.id);
    expect(await balance(u.id)).toBe(70n);
    await expect(prisma.$transaction((tx) => ops.payMerchant(tx, { ...p, amountNes: 31n }))).rejects.toMatchObject({
      code: "IDEMPOTENCY_MISMATCH",
    });
  });

  it("concurrent payments cannot overspend: 10 x 50 against 250 -> exactly 5 succeed", async () => {
    const u = await h.createTestUser();
    const m = await h.createTestMerchant();
    await h.fundUser(u.id, 250n);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        prisma.$transaction((tx) =>
          ops.payMerchant(tx, { userId: u.id, merchantAccountId: m.id, amountNes: 50n, reference: h.ref(), idempotencyKey: `c-${i}-${h.ref()}` }),
        ),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    expect(await balance(u.id)).toBe(0n);
    expect((await prisma.merchantAccount.findUniqueOrThrow({ where: { id: m.id } })).settlementNes).toBe(250n);
  });

  it("concurrent retries with the SAME key apply exactly once", async () => {
    const u = await h.createTestUser();
    const m = await h.createTestMerchant();
    await h.fundUser(u.id, 100n);
    const key = `race-${h.ref()}`;
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        prisma.$transaction((tx) =>
          ops.payMerchant(tx, { userId: u.id, merchantAccountId: m.id, amountNes: 10n, reference: h.ref(), idempotencyKey: key }),
        ),
      ),
    );
    // Losers of the race may surface a unique-constraint error (callers retry via postLedgerTransaction);
    // what matters is that money moved once.
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    expect(await balance(u.id)).toBe(90n);
  });

  it("withdrawal: reserve holds credits, failure releases them, completion burns them", async () => {
    const u = await h.createTestUser();
    await h.fundUser(u.id, 100n);
    const k = h.ref();
    await prisma.$transaction((tx) => ops.reserveWithdrawal(tx, { userId: u.id, amountNes: 100n, reference: h.ref(), idempotencyKey: `r-${k}` }));
    expect(await balance(u.id)).toBe(0n);
    await prisma.$transaction((tx) => ops.reverseWithdrawal(tx, { userId: u.id, amountNes: 100n, reference: h.ref(), idempotencyKey: `x-${k}` }));
    expect(await balance(u.id)).toBe(100n);

    const k2 = h.ref();
    await prisma.$transaction((tx) => ops.reserveWithdrawal(tx, { userId: u.id, amountNes: 100n, reference: h.ref(), idempotencyKey: `r-${k2}` }));
    await prisma.$transaction((tx) => ops.completeWithdrawal(tx, { amountNes: 100n, reference: h.ref(), idempotencyKey: `c-${k2}` }));
    expect(await balance(u.id)).toBe(0n);
    // 100 NeS is 2,000 RWF leaving the platform
    const { nesToRwf } = await import("../src/config/currency");
    expect(nesToRwf(100n)).toBe(2000n);
  });

  it("refund returns credits to the user and cannot exceed the merchant balance", async () => {
    const u = await h.createTestUser();
    const m = await h.createTestMerchant();
    await h.fundUser(u.id, 100n);
    await prisma.$transaction((tx) =>
      ops.payMerchant(tx, { userId: u.id, merchantAccountId: m.id, amountNes: 60n, reference: h.ref(), idempotencyKey: `p-${h.ref()}` }),
    );
    await prisma.$transaction((tx) =>
      ops.refundToUser(tx, { userId: u.id, merchantAccountId: m.id, amountNes: 60n, reference: h.ref(), idempotencyKey: `f-${h.ref()}` }),
    );
    expect(await balance(u.id)).toBe(100n);
    await expect(
      prisma.$transaction((tx) =>
        ops.refundToUser(tx, { userId: u.id, merchantAccountId: m.id, amountNes: 1n, reference: h.ref(), idempotencyKey: `f2-${h.ref()}` }),
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_FUNDS" });
  });

  it("suspended or blocked cards cannot spend or withdraw", async () => {
    const u = await h.createTestUser();
    const m = await h.createTestMerchant();
    await h.fundUser(u.id, 100n);
    await prisma.readerCard.update({ where: { userId: u.id }, data: { status: "BLOCKED" } });
    await expect(
      prisma.$transaction((tx) =>
        ops.payMerchant(tx, { userId: u.id, merchantAccountId: m.id, amountNes: 10n, reference: h.ref(), idempotencyKey: `b-${h.ref()}` }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(await balance(u.id)).toBe(100n);
  });

  it("admin adjustment requires an admin, a reason, and writes an audit log", async () => {
    const u = await h.createTestUser();
    const normal = await h.createTestUser();
    const admin = await h.createTestUser("ADMIN");
    const base = { userId: u.id, direction: "CREDIT" as const, amountNes: 25n };
    await expect(
      prisma.$transaction((tx) => ops.adminAdjustment(tx, { ...base, adminId: normal.id, reason: "goodwill credit for outage", idempotencyKey: h.ref() })),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      prisma.$transaction((tx) => ops.adminAdjustment(tx, { ...base, adminId: admin.id, reason: "short", idempotencyKey: h.ref() })),
    ).rejects.toMatchObject({ code: "REASON_REQUIRED" });
    const key = h.ref();
    await prisma.$transaction((tx) => ops.adminAdjustment(tx, { ...base, adminId: admin.id, reason: "goodwill credit for outage", idempotencyKey: key }));
    expect(await balance(u.id)).toBe(25n);
    expect(await prisma.auditLog.count({ where: { actorId: admin.id, action: "LEDGER_ADJUSTMENT" } })).toBe(1);
  });

  it("ledger rows are immutable at the database level", async () => {
    const u = await h.createTestUser();
    await h.fundUser(u.id, 10n);
    await expect(prisma.$executeRaw`UPDATE ledger_entries SET "amountNes" = 999`).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRaw`DELETE FROM ledger_transactions`).rejects.toThrow(/append-only/);
  });

  it("the database itself rejects an unbalanced transaction", async () => {
    const u = await h.createTestUser();
    const acct = await prisma.ledgerAccount.findFirstOrThrow({ where: { type: "USER_WALLET", wallet: { userId: u.id } } });
    await expect(
      prisma.ledgerTransaction.create({
        data: { reference: h.ref(), type: "ADJUSTMENT", conversionRate: 20, entries: { create: [{ accountId: acct.id, direction: "CREDIT", amountNes: 5n }] } },
      }),
    ).rejects.toThrow(/unbalanced/);
  });

  it("reconciliation is clean after all of the above", async () => {
    const report = await recon.reconcile();
    expect(report.walletMismatches).toEqual([]);
    expect(report.merchantMismatches).toEqual([]);
    expect(report.trialBalance.balanced).toBe(true);
    expect(report.ok).toBe(true);
  });

  it("wallet API shows NeS only and isolates users", async () => {
    const { createApp } = await import("../src/app");
    const app = createApp();
    const a = await h.createTestUser();
    const b = await h.createTestUser();
    await h.fundUser(a.id, 80n);
    await h.fundUser(b.id, 5n);
    const ag = request.agent(app);
    const email = (await prisma.user.findUniqueOrThrow({ where: { id: a.id } })).email!;
    await ag.post("/api/v1/auth/login").send({ identifier: email, password: "Str0ngPassword" });
    const bal = await ag.get("/api/v1/wallet/balance");
    expect(bal.body.wallet).toEqual({ currency: "NES", availableNes: "80", pendingNes: "0" });
    const txs = await ag.get("/api/v1/wallet/transactions");
    expect(txs.body.transactions).toHaveLength(1);
    expect(txs.body.transactions[0].signedAmountNes).toBe("80");
    expect((await request(app).get("/api/v1/wallet/balance")).status).toBe(401);
  });
});
