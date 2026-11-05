import { type Request, type RequestHandler, Router } from "express";
import { z } from "zod";
import { ah } from "../../lib/async";
import { forbidden, notFound } from "../../lib/errors";
import { prisma } from "../../lib/prisma";
import { requireAuth } from "../../middleware/auth";
import { apiIpLimiter, apiKeyLimiter, apiLogger, requireApiKey } from "../../middleware/apiKeyAuth";
import { validateBody } from "../../middleware/validate";
import { WEBHOOK_EVENTS, createWebhook, deactivateWebhook, listDeliveries, listWebhooks, webhookDto } from "./webhook.service";

const uuid = z.string().uuid();

/**
 * Webhook management works two ways:
 *  - API key with `webhooks:manage` (scoped to that key's app), or
 *  - developer session (cookie), where `appId` identifies an app the developer owns.
 */
const authenticate: RequestHandler = (req, res, next) => {
  if (req.headers.authorization?.startsWith("Bearer nes_")) {
    return requireApiKey("webhooks:manage")(req, res, (err?: unknown) => (err ? next(err) : apiKeyLimiter(req, res, next)));
  }
  return requireAuth(req, res, next);
};

async function resolveAppId(req: Request, requested?: string): Promise<string> {
  if (req.apiClient) {
    if (requested && requested !== req.apiClient.appId) throw forbidden("This API key cannot manage another application");
    return req.apiClient.appId;
  }
  if (!requested) throw notFound("appId is required");
  const app = await prisma.developerApp.findFirst({ where: { id: requested, developer: { userId: req.user!.id } }, select: { id: true } });
  if (!app) throw notFound("Application not found");
  return app.id;
}

const createSchema = z.object({
  appId: z.string().uuid().optional(),
  url: z.string().trim().min(8).max(500),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length),
});
const appQuery = z.object({ appId: z.string().uuid().optional() });

export const webhooksRouter = Router();
webhooksRouter.use(apiLogger, apiIpLimiter, authenticate);

webhooksRouter.post(
  "/",
  validateBody(createSchema),
  ah(async (req, res) => {
    const appId = await resolveAppId(req, req.body.appId);
    const actorId = req.apiClient?.developerUserId ?? req.user!.id;
    const { webhook, secret } = await createWebhook(appId, actorId, { url: req.body.url, events: req.body.events });
    res.status(201).json({ webhook: webhookDto(webhook), signingSecret: secret, notice: "Store this signing secret now. It will not be shown again." });
  }),
);

webhooksRouter.get(
  "/",
  ah(async (req, res) => {
    const appId = await resolveAppId(req, appQuery.parse(req.query).appId);
    res.json({ webhooks: (await listWebhooks(appId)).map(webhookDto) });
  }),
);

webhooksRouter.get(
  "/:id/deliveries",
  ah(async (req, res) => {
    const id = uuid.safeParse(req.params.id);
    if (!id.success) throw notFound();
    const appId = await resolveAppId(req, appQuery.parse(req.query).appId);
    res.json({ deliveries: await listDeliveries(appId, id.data, 50) });
  }),
);

webhooksRouter.delete(
  "/:id",
  ah(async (req, res) => {
    const id = uuid.safeParse(req.params.id);
    if (!id.success) throw notFound();
    const appId = await resolveAppId(req, appQuery.parse(req.query).appId);
    const actorId = req.apiClient?.developerUserId ?? req.user!.id;
    res.json({ webhook: webhookDto(await deactivateWebhook(appId, actorId, id.data)) });
  }),
);
