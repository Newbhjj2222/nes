import { createApp } from "./app";
import { env } from "./config/env";
import { logger } from "./lib/logger";
import { ensureSystemAccounts } from "./modules/ledger/ledger.service";
import { startReconciliationJob } from "./modules/payments/reconcile.job";

async function main() {
  await ensureSystemAccounts();
  createApp().listen(env.PORT, () => {
    logger.info(`NeS API listening on :${env.PORT} (livePayments=${env.LIVE_PAYMENTS_ENABLED}, withdrawals=${env.WITHDRAWALS_ENABLED})`);
  });
  startReconciliationJob(env.RECONCILE_INTERVAL_MS);
}

main().catch((e) => {
  logger.error({ err: e }, "failed to start");
  process.exit(1);
});
