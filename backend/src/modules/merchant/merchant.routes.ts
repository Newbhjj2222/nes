import { Router } from "express";
import { ah } from "../../lib/async";
import { apiIpLimiter, apiKeyLimiter, apiLogger, requireApiKey } from "../../middleware/apiKeyAuth";
import { getMerchantStatusForApp } from "./merchant.service";

/** Public merchant API, authenticated with API keys (Bearer nes_...). Payment routes join this router in Phase 6. */
export const merchantRouter = Router();
merchantRouter.use(apiLogger, apiIpLimiter, requireApiKey(), apiKeyLimiter);

merchantRouter.get(
  "/me",
  ah(async (req, res) => {
    const c = req.apiClient!;
    const merchant = await getMerchantStatusForApp(c.appId);
    res.json({
      app: { id: c.appId, name: c.appName },
      environment: c.environment,
      permissions: c.permissions,
      merchant,
      canCollectPayments: c.environment === "SANDBOX" || merchant.approved,
    });
  }),
);
