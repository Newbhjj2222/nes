import type { MerchantStatus } from "@prisma/client";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors";
import { prisma } from "../../lib/prisma";

async function assertAdmin(tx: Pick<typeof prisma, "user">, adminId: string) {
  const a = await tx.user.findUnique({ where: { id: adminId }, select: { role: true, status: true } });
  if (!a || a.status !== "ACTIVE" || (a.role !== "ADMIN" && a.role !== "SUPER_ADMIN")) throw forbidden("Administrator authorization required");
}

export const listApplications = (status?: MerchantStatus) =>
  prisma.merchantApplication.findMany({
    where: status ? { status } : {},
    orderBy: { createdAt: "asc" },
    take: 200,
    include: { user: { select: { id: true, email: true, phone: true } } },
  });

/**
 * Approval creates the merchant's settlement account (MerchantAccount + its ledger account) and marks the
 * app's production access APPROVED. Rejection requires a written note. Both are audited, and an admin can
 * never review an application they submitted themselves.
 */
export async function reviewApplication(adminId: string, applicationId: string, decision: "APPROVE" | "REJECT", note?: string) {
  return prisma.$transaction(async (tx) => {
    await assertAdmin(tx, adminId);
    await tx.$queryRaw`SELECT id FROM merchant_applications WHERE id = ${applicationId} FOR UPDATE`;
    const app = await tx.merchantApplication.findUnique({ where: { id: applicationId } });
    if (!app) throw notFound("Application not found");
    if (app.status !== "PENDING") throw conflict("ALREADY_REVIEWED", `Application is already ${app.status.toLowerCase()}`);
    if (app.userId === adminId) throw forbidden("You cannot review your own application");
    if (!app.appId) throw badRequest("NO_APP", "Application is not linked to an app");

    if (decision === "REJECT") {
      if (!note || note.trim().length < 5) throw badRequest("NOTE_REQUIRED", "A rejection reason is required");
      const updated = await tx.merchantApplication.update({
        where: { id: applicationId },
        data: { status: "REJECTED", reviewedById: adminId, reviewNote: note.trim(), reviewedAt: new Date() },
      });
      await tx.developerApp.update({ where: { id: app.appId }, data: { productionAccess: "REJECTED" } });
      await tx.auditLog.create({ data: { actorId: adminId, action: "MERCHANT_REJECTED", entityType: "MerchantApplication", entityId: applicationId, after: { note: note.trim() } } });
      return { application: updated, merchantAccount: null };
    }

    const merchantAccount = await tx.merchantAccount.create({
      data: { applicationId, appId: app.appId, name: app.businessName, status: "APPROVED" },
    });
    await tx.ledgerAccount.create({
      data: { type: "MERCHANT_SETTLEMENT", merchantAccountId: merchantAccount.id, name: `merchant:${merchantAccount.id}` },
    });
    const updated = await tx.merchantApplication.update({
      where: { id: applicationId },
      data: { status: "APPROVED", reviewedById: adminId, reviewNote: note?.trim() ?? null, reviewedAt: new Date() },
    });
    await tx.developerApp.update({ where: { id: app.appId }, data: { productionAccess: "APPROVED" } });
    await tx.auditLog.create({ data: { actorId: adminId, action: "MERCHANT_APPROVED", entityType: "MerchantAccount", entityId: merchantAccount.id, after: { applicationId } } });
    return { application: updated, merchantAccount };
  });
}

/** Payments (Phase 6) must refuse any merchant whose status is not APPROVED. */
export async function suspendMerchant(adminId: string, merchantAccountId: string, reason: string) {
  if (reason.trim().length < 5) throw badRequest("REASON_REQUIRED", "A reason is required");
  return prisma.$transaction(async (tx) => {
    await assertAdmin(tx, adminId);
    const m = await tx.merchantAccount.findUnique({ where: { id: merchantAccountId } });
    if (!m) throw notFound("Merchant not found");
    if (m.status === "SUSPENDED") return m;
    const updated = await tx.merchantAccount.update({ where: { id: m.id }, data: { status: "SUSPENDED" } });
    await tx.merchantApplication.update({ where: { id: m.applicationId }, data: { status: "SUSPENDED" } });
    await tx.auditLog.create({ data: { actorId: adminId, action: "MERCHANT_SUSPENDED", entityType: "MerchantAccount", entityId: m.id, after: { reason: reason.trim() } } });
    return updated;
  });
}

export async function getMerchantStatusForApp(appId: string) {
  const m = await prisma.merchantAccount.findUnique({ where: { appId }, select: { id: true, status: true } });
  return { approved: m?.status === "APPROVED", status: m?.status ?? "NONE" };
}
