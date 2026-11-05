import { randomBytes } from "node:crypto";
import type { Webhook } from "@prisma/client";
import { conflict, notFound } from "../../lib/errors";
import { prisma } from "../../lib/prisma";
import { seal } from "../../lib/secretbox";
import { sha256 } from "../../lib/crypto";
import { validateWebhookUrl } from "./urlguard";

export const WEBHOOK_EVENTS = ["payment.completed", "payment.failed", "payment.refunded"] as const;
const MAX_WEBHOOKS_PER_APP = 5;

/** Never includes secretHash or signingKeyEnc. */
export const webhookDto = (w: Webhook) => ({
  id: w.id, appId: w.appId, url: w.url, events: w.events, active: w.active, createdAt: w.createdAt,
});

/** The signing secret is returned ONCE here; afterwards only an encrypted copy exists (needed to sign deliveries). */
export async function createWebhook(appId: string, actorId: string, input: { url: string; events: string[] }) {
  const url = validateWebhookUrl(input.url).toString();
  if ((await prisma.webhook.count({ where: { appId, active: true } })) >= MAX_WEBHOOKS_PER_APP) {
    throw conflict("WEBHOOK_LIMIT", `An application can have at most ${MAX_WEBHOOKS_PER_APP} active webhooks`);
  }
  const secret = `whsec_${randomBytes(24).toString("hex")}`;
  const webhook = await prisma.$transaction(async (tx) => {
    const w = await tx.webhook.create({
      data: { appId, url, events: [...new Set(input.events)], secretHash: sha256(secret), signingKeyEnc: seal(secret) },
    });
    await tx.auditLog.create({ data: { actorId, action: "WEBHOOK_CREATED", entityType: "Webhook", entityId: w.id, after: { appId, url } } });
    return w;
  });
  return { webhook, secret };
}

export const listWebhooks = (appId: string) => prisma.webhook.findMany({ where: { appId }, orderBy: { createdAt: "desc" } });

export async function deactivateWebhook(appId: string, actorId: string, webhookId: string) {
  const w = await prisma.webhook.findFirst({ where: { id: webhookId, appId } });
  if (!w) throw notFound("Webhook not found");
  if (!w.active) return w;
  return prisma.$transaction(async (tx) => {
    const updated = await tx.webhook.update({ where: { id: w.id }, data: { active: false } });
    await tx.auditLog.create({ data: { actorId, action: "WEBHOOK_DEACTIVATED", entityType: "Webhook", entityId: w.id } });
    return updated;
  });
}

export async function listDeliveries(appId: string, webhookId: string, limit: number) {
  const w = await prisma.webhook.findFirst({ where: { id: webhookId, appId }, select: { id: true } });
  if (!w) throw notFound("Webhook not found");
  const rows = await prisma.webhookDelivery.findMany({ where: { webhookId }, orderBy: { createdAt: "desc" }, take: limit });
  return rows.map((d) => ({
    id: d.id, event: d.event, status: d.status, attempts: d.attempts, lastStatusCode: d.lastStatusCode,
    lastError: d.lastError, nextAttemptAt: d.nextAttemptAt, deliveredAt: d.deliveredAt, createdAt: d.createdAt,
  }));
}
