import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/prisma";
import { register } from "../src/modules/auth/auth.service";
import { ensureSystemAccounts } from "../src/modules/ledger/ledger.service";
import { creditDeposit } from "../src/modules/ledger/ledger.operations";

export async function createTestUser(role: "USER" | "ADMIN" = "USER") {
  const user = await register({
    fullName: "Test User",
    email: `u-${randomUUID()}@example.com`,
    password: "Str0ngPassword",
  });
  if (role !== "USER") await prisma.user.update({ where: { id: user.id }, data: { role } });
  return user;
}

/** Gives a user NeS through a real ledger deposit posting. */
export async function fundUser(userId: string, nes: bigint) {
  await ensureSystemAccounts();
  await prisma.$transaction((tx) =>
    creditDeposit(tx, { userId, amountNes: nes, reference: `T-${randomUUID()}`, idempotencyKey: `fund-${randomUUID()}` }),
  );
}

/** Minimal approved merchant with a settlement ledger account. */
export async function createTestMerchant() {
  const owner = await createTestUser();
  const developer = await prisma.developer.create({ data: { userId: owner.id } });
  const app = await prisma.developerApp.create({
    data: { developerId: developer.id, name: `app-${randomUUID()}`, permissions: ["payments:create"] },
  });
  const application = await prisma.merchantApplication.create({
    data: { userId: owner.id, appId: app.id, businessName: "Test Merchant", contactEmail: "m@example.com", status: "APPROVED" },
  });
  const merchant = await prisma.merchantAccount.create({
    data: { applicationId: application.id, appId: app.id, name: "Test Merchant" },
  });
  await prisma.ledgerAccount.create({
    data: { type: "MERCHANT_SETTLEMENT", merchantAccountId: merchant.id, name: `merchant:${merchant.id}` },
  });
  return merchant;
}

export const ref = () => `T-${randomUUID()}`;
