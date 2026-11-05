import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { env } from "./config/env";
import { logger } from "./lib/logger";
import { errorHandler, notFoundHandler } from "./middleware/error";
import { authRouter } from "./modules/auth/auth.routes";
import { cardsRouter } from "./modules/cards/cards.routes";
import { walletRouter } from "./modules/wallet/wallet.routes";
import { callbacksRouter, depositsRouter, withdrawalsRouter } from "./modules/payments/money.routes";
import { adminRouter } from "./modules/admin/admin.routes";
import { developerRouter } from "./modules/developer/developer.routes";
import { merchantRouter } from "./modules/merchant/merchant.routes";
import { webhooksRouter } from "./modules/webhooks/webhooks.routes";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGINS.split(",").map((s) => s.trim()), credentials: true }));
  app.use(pinoHttp({ logger }));
  app.use(express.json({ limit: "100kb" }));
  app.use(cookieParser(env.COOKIE_SECRET));

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  app.use("/api/v1/auth", authRouter);
  app.use("/api/v1/cards", cardsRouter);
  app.use("/api/v1/wallet", walletRouter);
  app.use("/api/v1/deposits", depositsRouter);
  app.use("/api/v1/withdrawals", withdrawalsRouter);
  app.use("/callbacks", callbacksRouter);
  app.use("/api/v1/developer", developerRouter);
  app.use("/api/v1/merchant", merchantRouter);
  app.use("/api/v1/webhooks", webhooksRouter);
  app.use("/api/v1/admin", adminRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
