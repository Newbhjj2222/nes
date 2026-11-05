# PawaPay V2 integration notes (sandbox)

Sources read for this implementation (official V2 docs):
- Deposits guide: https://docs.pawapay.io/v2/docs/deposits.md
- Payouts guide: https://docs.pawapay.io/v2/docs/payouts.md
- Signatures guide: https://docs.pawapay.io/v2/docs/signatures.md
- OpenAPI spec: https://docs.pawapay.io/v2/api-reference/openapi_v2.yaml
- Public keys: https://docs.pawapay.io/v2/api-reference/toolkit/public-keys.md

## Implemented (see `src/modules/pawapay/pawapay.client.ts`)
| Purpose | Call |
|---|---|
| Initiate deposit | `POST /v2/deposits` (`depositId`, `amount` string, `currency`, `payer{type:"MMO", accountDetails{phoneNumber, provider}}`) |
| Check deposit | `GET /v2/deposits/{depositId}` -> `FOUND` / `NOT_FOUND` |
| Initiate payout | `POST /v2/payouts` (`payoutId`, `amount`, `currency`, `recipient{type:"MMO", accountDetails{phoneNumber, provider}}`) |
| Check payout | `GET /v2/payouts/{payoutId}` -> `FOUND` / `NOT_FOUND` |

Auth: `Authorization: Bearer <PAWAPAY_API_TOKEN>`, server-side only.

## Callback URLs to configure in the PawaPay sandbox dashboard
- Deposits: `{PAWAPAY_CALLBACK_BASE_URL}/callbacks/pawapay/deposits`
- Payouts: `{PAWAPAY_CALLBACK_BASE_URL}/callbacks/pawapay/payouts`

Callbacks are only a trigger. The handler reads the id, then verifies the real state with the status API.

## Things to verify in your sandbox before trusting them
1. **Payout recipient field.** The payouts guide has one example using `payer` instead of `recipient`; the OpenAPI response schema and the main examples use `recipient`. We send `recipient`. Confirm with a sandbox payout.
2. **Provider codes.** Only `MTN_MOMO_RWA` appears in the docs we read. Set `PAWAPAY_PROVIDERS` from your account's active configuration (`GET /v2/active-conf?country=RWA&operationType=DEPOSIT`).
3. **Min/max amounts and decimals** per provider (active configuration). Our limits in `config/limits.ts` are placeholders.
4. **Sandbox test numbers/behaviours** for success, failure and timeout scenarios.

## Not implemented yet
- **Callback signature verification (RFC 9421)** and **signed financial requests**: both optional, enabled in the dashboard. Public keys come from `GET /v2/public-key/http`. Not needed for correctness today because callbacks never move money by themselves; recommended before going live.
- Refund/reversal of completed deposits through PawaPay (a separate API we have not read yet).
- Provider availability checks (`GET /v2/availability`) and active-conf-driven limits.
- Local `EXPIRED` status for deposits: the docs only allow marking failure on `NOT_FOUND`, and `IN_RECONCILIATION` resolves on PawaPay's side, so we don't invent an expiry.

## Live activation
`LIVE_PAYMENTS_ENABLED=false` and a sandbox base URL are enforced at client creation (the process refuses to start with a live URL otherwise). `WITHDRAWALS_ENABLED=false` by default. Fees, limits and withdrawal eligibility in this code are placeholders pending compliance approval.
