import { Router } from "express";
import { z } from "zod";
import { ah } from "../../lib/async";
import { notFound } from "../../lib/errors";
import { requireAuth, requireRole } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { listApplications, reviewApplication, suspendMerchant } from "../merchant/merchant.service";

const uuid = z.string().uuid();
const id = (v: unknown) => {
  const p = uuid.safeParse(v);
  if (!p.success) throw notFound();
  return p.data;
};

/** Minimal admin API for merchant onboarding. The full admin dashboard API arrives in Phase 8. */
export const adminRouter = Router();
adminRouter.use(requireAuth, requireRole("ADMIN", "SUPER_ADMIN"));

adminRouter.get(
  "/merchant-applications",
  ah(async (req, res) => {
    const status = z.enum(["PENDING", "APPROVED", "REJECTED", "SUSPENDED"]).optional().parse(req.query.status);
    res.json({ applications: await listApplications(status) });
  }),
);

adminRouter.post(
  "/merchant-applications/:id/approve",
  validateBody(z.object({ note: z.string().trim().max(500).optional() })),
  ah(async (req, res) => {
    const r = await reviewApplication(req.user!.id, id(req.params.id), "APPROVE", req.body.note);
    res.json({ application: r.application, merchantAccountId: r.merchantAccount?.id });
  }),
);

adminRouter.post(
  "/merchant-applications/:id/reject",
  validateBody(z.object({ note: z.string().trim().min(5).max(500) })),
  ah(async (req, res) => {
    const r = await reviewApplication(req.user!.id, id(req.params.id), "REJECT", req.body.note);
    res.json({ application: r.application });
  }),
);

adminRouter.post(
  "/merchants/:id/suspend",
  validateBody(z.object({ reason: z.string().trim().min(5).max(500) })),
  ah(async (req, res) => {
    const m = await suspendMerchant(req.user!.id, id(req.params.id), req.body.reason);
    res.json({ merchant: { id: m.id, status: m.status } });
  }),
);
