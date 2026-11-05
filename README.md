# NeS Digital Credits Platform (backend, Phases 1–5)

Status: **code written, NOT yet compiled or run end-to-end.** The authoring environment could not reach the npm registry,
so `npm install`, `prisma validate`, `prisma migrate` and the test suites have never been executed. A syntax-only parse of all
52 TypeScript files found no syntax errors. Expect to fix a few type errors on first compile.

1 NeS = 20 RWF (fixed, integer math, `backend/src/config/currency.ts`). Sandbox only: `LIVE_PAYMENTS_ENABLED=false`.

## Install and run

```bash
cd backend
npm install
cp ../.env.example ../.env                 # then replace every change-me value: openssl rand -hex 32
docker compose -f ../docker-compose.yml up -d postgres redis
npx prisma migrate dev --create-only --name init
cat prisma/sql/ledger_guards.sql >> prisma/migrations/*_init/migration.sql   # append-only ledger, balance checks, balanced-tx trigger
npx prisma migrate dev
npm run seed                               # system ledger accounts
npm run dev                                # http://localhost:4000/health
```

## Tests

```bash
npm test                                   # unit tests, no database
RUN_DB_TESTS=true DATABASE_URL=postgresql://nes:nes_password@localhost:5432/nes_test?schema=public npm test   # integration (throwaway DB only)
```

## What exists

| Phase | Area | Where |
|---|---|---|
| 1 | Schema (25 tables), Docker, env, conversion | `prisma/schema.prisma`, `docker-compose.yml`, `src/config` |
| 2 | Register/login/logout/reset/verify, digital card | `src/modules/auth`, `src/modules/cards` |
| 3 | Double-entry ledger, wallet API, reconciliation, DB guards | `src/modules/ledger`, `src/modules/wallet`, `prisma/sql/ledger_guards.sql` |
| 4 | PawaPay V2 sandbox deposits and withdrawals, callbacks, reconcile job | `src/modules/pawapay`, `deposits`, `withdrawals`, `payments`, `docs/pawapay-integration.md` |
| 5 | Developer accounts/apps/keys, API-key auth, merchant onboarding + admin review, webhook management and signing, API logs/usage | `src/modules/developer`, `merchant`, `admin`, `webhooks` |

## Not built yet

Phase 6 merchant payments and refunds API, webhook delivery worker; Phase 7 frontend (user dashboard, developer portal);
Phase 8 admin dashboard; Phase 9 hardening and remaining tests; Phase 10 OpenAPI, deployment and security docs.

## Open decisions before Phase 6

1. Sandbox API keys must not debit real wallets. Proposal: sandbox payments are simulated (test card numbers, no ledger movement).
2. Webhook delivery must re-check the resolved IP of the target host (DNS rebinding), see `webhooks/urlguard.ts`.
3. Fees, limits, withdrawal eligibility, KYC/AML and refund/dispute policy need compliance sign-off (placeholders in `src/config/limits.ts`).
4. PawaPay callback signature verification and signed requests (optional, recommended before live).
5. Real email/SMS delivery for verification and reset tokens (`src/lib/notifier.ts` is a dev-only stub).
