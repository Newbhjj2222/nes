/**
 * PawaPay Merchant API V2 client (sandbox-first).
 *
 * Endpoints, bodies and statuses below come from the official V2 docs:
 *   POST /v2/deposits            body: depositId, amount (string), currency, payer{type:"MMO", accountDetails{phoneNumber, provider}}
 *   GET  /v2/deposits/{id}       -> { status: "FOUND"|"NOT_FOUND", data? }
 *   POST /v2/payouts             body: payoutId, amount (string), currency, recipient{type:"MMO", accountDetails{phoneNumber, provider}}
 *   GET  /v2/payouts/{id}        -> { status: "FOUND"|"NOT_FOUND", data? }
 * Auth: Authorization: Bearer <API token>. Server-side only; the token never reaches the frontend.
 *
 * Outcome rules (from the docs' retry guidance):
 *  - HTTP 200 ACCEPTED / REJECTED / DUPLICATE_IGNORED are definitive.
 *  - A 4xx means the request was not processed (definitive rejection).
 *  - Timeouts, network errors, 5xx (e.g. UNKNOWN_ERROR with no status) are UNKNOWN: never assume failure.
 *
 * NOT implemented yet: RFC 9421 request signing (optional, enabled per account in the PawaPay dashboard).
 */
import { z } from "zod";
import { env } from "../../config/env";

export type InitResult =
  | { kind: "accepted" }
  | { kind: "duplicate" }
  | { kind: "rejected"; failureCode: string; failureMessage?: string }
  | { kind: "unknown"; reason: string };

export type LookupResult<T> =
  | { kind: "found"; data: T }
  | { kind: "not_found" }
  | { kind: "unknown"; reason: string };

const failureReason = z.object({ failureCode: z.string().optional(), failureMessage: z.string().optional() }).passthrough();

// `status` stays a plain string so unrecognised provider statuses are handled explicitly, not rejected.
export const transactionData = z
  .object({
    status: z.string(),
    amount: z.string(),
    currency: z.string(),
    failureReason: failureReason.optional(),
  })
  .passthrough();
export type TransactionData = z.infer<typeof transactionData>;

const initBody = z
  .object({
    status: z.string().optional(),
    failureCode: z.string().optional(),
    failureMessage: z.string().optional(),
    failureReason: failureReason.optional(),
  })
  .passthrough();

const lookupBody = z.object({ status: z.string(), data: z.unknown().optional() }).passthrough();

export interface MoneyRequest {
  id: string; // depositId / payoutId (UUIDv4, stored by us BEFORE calling)
  amount: string; // integer RWF as string, e.g. "5000"
  currency: "RWF";
  phoneNumber: string; // MSISDN, e.g. 250783456789
  provider: string; // e.g. MTN_MOMO_RWA
}

export interface PawaPayClient {
  readonly environment: "SANDBOX" | "PRODUCTION";
  initiateDeposit(r: MoneyRequest): Promise<InitResult>;
  getDeposit(id: string): Promise<LookupResult<TransactionData>>;
  initiatePayout(r: MoneyRequest): Promise<InitResult>;
  getPayout(id: string): Promise<LookupResult<TransactionData>>;
}

interface ClientConfig {
  baseUrl: string;
  token: string;
  liveEnabled: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createPawaPayClient(cfg: ClientConfig): PawaPayClient {
  const isSandbox = new URL(cfg.baseUrl).hostname.includes("sandbox");
  if (!isSandbox && !cfg.liveEnabled) {
    // Hard stop: live money movement needs merchant authorization, legal review and compliance sign-off.
    throw new Error("Live PawaPay URL configured while LIVE_PAYMENTS_ENABLED=false");
  }
  const doFetch = cfg.fetchImpl ?? fetch;

  async function call(method: "GET" | "POST", path: string, body?: unknown) {
    try {
      const res = await doFetch(`${cfg.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(cfg.timeoutMs ?? 15_000),
      });
      let json: unknown = null;
      try {
        json = await res.json();
      } catch {
        /* non-JSON body */
      }
      return { ok: true as const, status: res.status, json };
    } catch (e) {
      return { ok: false as const, reason: e instanceof Error ? e.message : "network error" };
    }
  }

  function classifyInit(r: Awaited<ReturnType<typeof call>>): InitResult {
    if (!r.ok) return { kind: "unknown", reason: r.reason };
    const parsed = initBody.safeParse(r.json);
    const body = parsed.success ? parsed.data : {};
    const code = body.failureReason?.failureCode ?? body.failureCode;
    const message = body.failureReason?.failureMessage ?? body.failureMessage;

    if (r.status === 200) {
      if (body.status === "ACCEPTED") return { kind: "accepted" };
      if (body.status === "DUPLICATE_IGNORED") return { kind: "duplicate" };
      if (body.status === "REJECTED") return { kind: "rejected", failureCode: code ?? "REJECTED", failureMessage: message };
      return { kind: "unknown", reason: `unexpected status ${String(body.status)}` };
    }
    // Retryable / ambiguous client-side statuses are treated as unknown.
    if (r.status === 408 || r.status === 429) return { kind: "unknown", reason: `HTTP ${r.status}` };
    if (r.status >= 400 && r.status < 500) {
      return { kind: "rejected", failureCode: code ?? `HTTP_${r.status}`, failureMessage: message };
    }
    return { kind: "unknown", reason: `HTTP ${r.status}${code ? ` ${code}` : ""}` };
  }

  function classifyLookup(r: Awaited<ReturnType<typeof call>>): LookupResult<TransactionData> {
    if (!r.ok) return { kind: "unknown", reason: r.reason };
    if (r.status !== 200) return { kind: "unknown", reason: `HTTP ${r.status}` };
    const parsed = lookupBody.safeParse(r.json);
    if (!parsed.success) return { kind: "unknown", reason: "unparseable response" };
    if (parsed.data.status === "NOT_FOUND") return { kind: "not_found" };
    if (parsed.data.status === "FOUND") {
      const data = transactionData.safeParse(parsed.data.data);
      return data.success ? { kind: "found", data: data.data } : { kind: "unknown", reason: "unparseable data" };
    }
    return { kind: "unknown", reason: `unexpected lookup status ${parsed.data.status}` };
  }

  const account = (r: MoneyRequest) => ({ type: "MMO", accountDetails: { phoneNumber: r.phoneNumber, provider: r.provider } });

  return {
    environment: isSandbox ? "SANDBOX" : "PRODUCTION",
    async initiateDeposit(r) {
      return classifyInit(
        await call("POST", "/v2/deposits", { depositId: r.id, amount: r.amount, currency: r.currency, payer: account(r) }),
      );
    },
    async getDeposit(id) {
      return classifyLookup(await call("GET", `/v2/deposits/${encodeURIComponent(id)}`));
    },
    async initiatePayout(r) {
      return classifyInit(
        await call("POST", "/v2/payouts", { payoutId: r.id, amount: r.amount, currency: r.currency, recipient: account(r) }),
      );
    },
    async getPayout(id) {
      return classifyLookup(await call("GET", `/v2/payouts/${encodeURIComponent(id)}`));
    },
  };
}

let current: PawaPayClient | undefined;

export function getPawaPayClient(): PawaPayClient {
  current ??= createPawaPayClient({
    baseUrl: env.PAWAPAY_BASE_URL,
    token: env.PAWAPAY_API_TOKEN,
    liveEnabled: env.LIVE_PAYMENTS_ENABLED,
  });
  return current;
}

/** Test seam: inject a fake client. */
export function setPawaPayClient(c: PawaPayClient | undefined) {
  current = c;
}
