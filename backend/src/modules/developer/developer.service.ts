import { Prisma } from "@prisma/client";
import type { ApiKey, Developer, DeveloperApp, Environment } from "@prisma/client";
import { env } from "../../config/env";
import { AppError, conflict, forbidden, notFound } from "../../lib/errors";
import { prisma } from "../../lib/prisma";
import { type ApiPermission, generateApiKey } from "./apikey.service";

const MAX_APPS = 10;
const MAX_ACTIVE_KEYS = 5;

export const appDto = (a: DeveloperApp) => ({
  id: a.id,
  name: a.name,
  description: a.description,
  status: a.status,
  permissions: a.permissions,
  productionAccess: a.productionAccess,
  createdAt: a.createdAt,
});

/** Never includes secretHash. */
export const keyDto = (k: ApiKey) => ({
  id: k.id,
  appId: k.appId,
  name: k.name,
  prefix: k.prefix,
  environment: k.environment,
  status: k.status,
  lastUsedAt: k.lastUsedAt,
  createdAt: k.createdAt,
  revokedAt: k.revokedAt,
});

export const developerDto = (d: Developer) => ({ id: d.id, companyName: d.companyName, websiteUrl: d.websiteUrl, createdAt: d.createdAt });

export async function registerDeveloper(userId: string, input: { companyName?: string; websiteUrl?: string }) {
  try {
    return await prisma.$transaction(async (tx) => {
      if (await tx.developer.findUnique({ where: { userId }, select: { id: true } })) {
        throw conflict("ALREADY_DEVELOPER", "Developer account already exists");
      }
      const dev = await tx.developer.create({ data: { userId, companyName: input.companyName ?? null, websiteUrl: input.websiteUrl ?? null } });
      // Only ever upgrades plain users; never touches admin roles.
      await tx.user.updateMany({ where: { id: userId, role: "USER" }, data: { role: "DEVELOPER" } });
      await tx.auditLog.create({ data: { actorId: userId, action: "DEVELOPER_REGISTERED", entityType: "Developer", entityId: dev.id } });
      return dev;
    });
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") throw conflict("ALREADY_DEVELOPER", "Developer account already exists");
    throw e;
  }
}

/** Ownership check lives in the query: other developers' apps simply don't exist. */
export async function getOwnedApp(developerId: string, appId: string) {
  const app = await prisma.developerApp.findFirst({ where: { id: appId, developerId } });
  if (!app) throw notFound("Application not found");
  return app;
}

export async function createDeveloperApp(
  developerId: string,
  actorId: string,
  input: { name: string; description?: string; permissions: ApiPermission[] },
) {
  const count = await prisma.developerApp.count({ where: { developerId, status: { not: "REVOKED" } } });
  if (count >= MAX_APPS) throw conflict("APP_LIMIT", `You can have at most ${MAX_APPS} applications`);
  return prisma.$transaction(async (tx) => {
    const app = await tx.developerApp.create({
      data: {
        developerId,
        name: input.name,
        description: input.description ?? null,
        environment: "SANDBOX", // every app starts in sandbox
        permissions: [...new Set(input.permissions)],
      },
    });
    await tx.auditLog.create({ data: { actorId, action: "APP_CREATED", entityType: "DeveloperApp", entityId: app.id } });
    return app;
  });
}

export const listDeveloperApps = (developerId: string) =>
  prisma.developerApp.findMany({ where: { developerId }, orderBy: { createdAt: "desc" } });

/** Returns the full key ONCE. Only its hash is stored. */
export async function createApiKey(developerId: string, actorId: string, appId: string, name: string, environment: Environment) {
  const app = await getOwnedApp(developerId, appId);
  if (app.status !== "ACTIVE") throw forbidden("Application is not active");

  if (environment === "PRODUCTION") {
    if (!env.LIVE_PAYMENTS_ENABLED) throw new AppError(403, "LIVE_DISABLED", "Production keys cannot be issued until live payments are enabled");
    if (app.productionAccess !== "APPROVED") throw forbidden("Production access has not been approved");
    const merchant = await prisma.merchantAccount.findUnique({ where: { appId } });
    if (!merchant || merchant.status !== "APPROVED") throw forbidden("Merchant account is not approved");
  }
  if ((await prisma.apiKey.count({ where: { appId, status: "ACTIVE" } })) >= MAX_ACTIVE_KEYS) {
    throw conflict("KEY_LIMIT", `An application can have at most ${MAX_ACTIVE_KEYS} active keys; revoke one first`);
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const gen = generateApiKey(environment);
    try {
      const row = await prisma.$transaction(async (tx) => {
        const k = await tx.apiKey.create({ data: { appId, name, prefix: gen.prefix, secretHash: gen.secretHash, environment } });
        await tx.auditLog.create({ data: { actorId, action: "API_KEY_CREATED", entityType: "ApiKey", entityId: k.id, after: { appId, environment } } });
        return k;
      });
      return { key: row, secret: gen.key };
    } catch (e) {
      if ((e as { code?: string }).code !== "P2002") throw e; // prefix collision: try again
    }
  }
  throw new Error("Could not allocate a unique API key prefix");
}

export const listApiKeys = async (developerId: string, appId: string) => {
  await getOwnedApp(developerId, appId);
  return prisma.apiKey.findMany({ where: { appId }, orderBy: { createdAt: "desc" } });
};

export async function revokeApiKey(developerId: string, actorId: string, keyId: string) {
  const key = await prisma.apiKey.findFirst({ where: { id: keyId, app: { developerId } } });
  if (!key) throw notFound("API key not found");
  if (key.status === "REVOKED") return key;
  return prisma.$transaction(async (tx) => {
    const k = await tx.apiKey.update({ where: { id: keyId }, data: { status: "REVOKED", revokedAt: new Date() } });
    await tx.auditLog.create({ data: { actorId, action: "API_KEY_REVOKED", entityType: "ApiKey", entityId: keyId } });
    return k;
  });
}

export interface BusinessDetails {
  businessName: string;
  businessType?: string;
  registrationNumber?: string;
  contactEmail: string;
  websiteUrl?: string;
}

/** Starts merchant onboarding: records business details and queues the app for admin review. */
export async function requestProductionAccess(userId: string, developerId: string, appId: string, details: BusinessDetails) {
  const app = await getOwnedApp(developerId, appId);
  if (app.productionAccess === "REQUESTED" || app.productionAccess === "APPROVED") {
    throw conflict("ALREADY_REQUESTED", `Production access is already ${app.productionAccess.toLowerCase()}`);
  }
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { emailVerifiedAt: true, phoneVerifiedAt: true } });
  if (!user.emailVerifiedAt && !user.phoneVerifiedAt) throw forbidden("Verify your email or phone before requesting production access");

  return prisma.$transaction(async (tx) => {
    const application = await tx.merchantApplication.create({
      data: {
        userId,
        appId,
        businessName: details.businessName,
        businessType: details.businessType ?? null,
        registrationNumber: details.registrationNumber ?? null,
        contactEmail: details.contactEmail,
        websiteUrl: details.websiteUrl ?? null,
      },
    });
    await tx.developerApp.update({ where: { id: appId }, data: { productionAccess: "REQUESTED" } });
    await tx.auditLog.create({ data: { actorId: userId, action: "PRODUCTION_ACCESS_REQUESTED", entityType: "MerchantApplication", entityId: application.id } });
    return application;
  });
}

export async function getUsage(developerId: string, appId: string, days: number) {
  await getOwnedApp(developerId, appId);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await prisma.$queryRaw<{ day: Date; total: number; errors: number; avg_ms: number }[]>(Prisma.sql`
    SELECT date_trunc('day', "createdAt") AS day,
           COUNT(*)::int AS total,
           (COUNT(*) FILTER (WHERE "statusCode" >= 400))::int AS errors,
           COALESCE(AVG("durationMs"), 0)::int AS avg_ms
      FROM api_logs
     WHERE "appId" = ${appId} AND "createdAt" >= ${since}
     GROUP BY 1 ORDER BY 1`);
  const totalRequests = rows.reduce((s, r) => s + r.total, 0);
  const totalErrors = rows.reduce((s, r) => s + r.errors, 0);
  return {
    days,
    totalRequests,
    totalErrors,
    errorRate: totalRequests ? totalErrors / totalRequests : 0,
    daily: rows.map((r) => ({ day: r.day, requests: r.total, errors: r.errors, avgDurationMs: r.avg_ms })),
  };
}

export async function getLogs(developerId: string, appId: string, opts: { limit: number; cursor?: string; errorsOnly: boolean }) {
  await getOwnedApp(developerId, appId);
  const rows = await prisma.apiLog.findMany({
    where: { appId, ...(opts.errorsOnly ? { statusCode: { gte: 400 } } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: opts.limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });
  const page = rows.slice(0, opts.limit);
  return {
    logs: page.map((l) => ({
      id: l.id, method: l.method, path: l.path, statusCode: l.statusCode, durationMs: l.durationMs, errorCode: l.errorCode, createdAt: l.createdAt,
    })),
    nextCursor: rows.length > opts.limit ? page[page.length - 1]!.id : null,
  };
}
