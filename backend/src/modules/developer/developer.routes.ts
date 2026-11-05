import type { Developer } from "@prisma/client";
import { type Request, type RequestHandler, Router } from "express";
import { z } from "zod";
import { ah } from "../../lib/async";
import { forbidden, notFound } from "../../lib/errors";
import { prisma } from "../../lib/prisma";
import { requireAuth } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { API_PERMISSIONS } from "./apikey.service";
import * as dev from "./developer.service";

const uuid = z.string().uuid();
const param = (req: Request, name: string) => {
  const v = uuid.safeParse(req.params[name]);
  if (!v.success) throw notFound();
  return v.data;
};
const developerOf = (req: Request) => req.res!.locals.developer as Developer;

const registerSchema = z.object({
  companyName: z.string().trim().min(2).max(100).optional(),
  websiteUrl: z.string().trim().url().max(200).optional(),
});
const appSchema = z.object({
  name: z.string().trim().min(3).max(60),
  description: z.string().trim().max(500).optional(),
  permissions: z.array(z.enum(API_PERMISSIONS)).min(1).max(API_PERMISSIONS.length),
});
const keySchema = z.object({
  name: z.string().trim().min(2).max(60),
  environment: z.enum(["SANDBOX", "PRODUCTION"]).default("SANDBOX"),
});
const businessSchema = z.object({
  businessName: z.string().trim().min(2).max(120),
  businessType: z.string().trim().max(60).optional(),
  registrationNumber: z.string().trim().max(60).optional(),
  contactEmail: z.string().trim().toLowerCase().email(),
  websiteUrl: z.string().trim().url().max(200).optional(),
});
const logsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().uuid().optional(),
  errorsOnly: z.enum(["true", "false"]).default("false"),
});
const usageQuery = z.object({ days: z.coerce.number().int().min(1).max(90).default(7) });

/** Developer portal API: browser session auth (cookie), never API keys. */
export const developerRouter = Router();
developerRouter.use(requireAuth);

developerRouter.post(
  "/register",
  validateBody(registerSchema),
  ah(async (req, res) => {
    res.status(201).json({ developer: dev.developerDto(await dev.registerDeveloper(req.user!.id, req.body)) });
  }),
);

const requireDeveloper: RequestHandler = ah(async (req, res, next) => {
  const d = await prisma.developer.findUnique({ where: { userId: req.user!.id } });
  if (!d) throw forbidden("Register as a developer first");
  res.locals.developer = d;
  next();
});
developerRouter.use(requireDeveloper);

developerRouter.get("/me", (req, res) => res.json({ developer: dev.developerDto(developerOf(req)) }));

developerRouter.post(
  "/apps",
  validateBody(appSchema),
  ah(async (req, res) => {
    const app = await dev.createDeveloperApp(developerOf(req).id, req.user!.id, req.body);
    res.status(201).json({ app: dev.appDto(app) });
  }),
);
developerRouter.get(
  "/apps",
  ah(async (req, res) => {
    res.json({ apps: (await dev.listDeveloperApps(developerOf(req).id)).map(dev.appDto) });
  }),
);
developerRouter.get(
  "/apps/:id",
  ah(async (req, res) => {
    res.json({ app: dev.appDto(await dev.getOwnedApp(developerOf(req).id, param(req, "id"))) });
  }),
);

developerRouter.post(
  "/apps/:id/keys",
  validateBody(keySchema),
  ah(async (req, res) => {
    const { key, secret } = await dev.createApiKey(developerOf(req).id, req.user!.id, param(req, "id"), req.body.name, req.body.environment);
    // The only response that ever contains the full key.
    res.status(201).json({ key: dev.keyDto(key), secret, notice: "Store this key now. It will not be shown again." });
  }),
);
developerRouter.get(
  "/apps/:id/keys",
  ah(async (req, res) => {
    res.json({ keys: (await dev.listApiKeys(developerOf(req).id, param(req, "id"))).map(dev.keyDto) });
  }),
);
developerRouter.delete(
  "/keys/:id",
  ah(async (req, res) => {
    res.json({ key: dev.keyDto(await dev.revokeApiKey(developerOf(req).id, req.user!.id, param(req, "id"))) });
  }),
);

developerRouter.post(
  "/apps/:id/production-access",
  validateBody(businessSchema),
  ah(async (req, res) => {
    const a = await dev.requestProductionAccess(req.user!.id, developerOf(req).id, param(req, "id"), req.body);
    res.status(201).json({ application: { id: a.id, status: a.status, businessName: a.businessName, createdAt: a.createdAt } });
  }),
);

developerRouter.get(
  "/apps/:id/usage",
  ah(async (req, res) => {
    const q = usageQuery.parse(req.query);
    res.json({ usage: await dev.getUsage(developerOf(req).id, param(req, "id"), q.days) });
  }),
);
developerRouter.get(
  "/apps/:id/logs",
  ah(async (req, res) => {
    const q = logsQuery.parse(req.query);
    res.json(await dev.getLogs(developerOf(req).id, param(req, "id"), { limit: q.limit, cursor: q.cursor, errorsOnly: q.errorsOnly === "true" }));
  }),
);
