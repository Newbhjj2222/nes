import { describe, expect, it } from "vitest";
import { createPawaPayClient } from "../src/modules/pawapay/pawapay.client";
import { parseProviderAmount, toRwandaMsisdn } from "../src/modules/pawapay/pawapay.utils";

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function fakeFetch(status: number, json: unknown, calls: Call[] = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? "GET", headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(init.body as string) : undefined });
    return new Response(JSON.stringify(json), { status });
  }) as unknown as typeof fetch;
}

const client = (f: typeof fetch) =>
  createPawaPayClient({ baseUrl: "https://api.sandbox.pawapay.io", token: "tok_test", liveEnabled: false, fetchImpl: f });

const req = { id: "11111111-1111-4111-8111-111111111111", amount: "5000", currency: "RWF" as const, phoneNumber: "250788123456", provider: "MTN_MOMO_RWA" };

describe("PawaPay V2 client request shapes", () => {
  it("POST /v2/deposits with the documented body and Bearer auth", async () => {
    const calls: Call[] = [];
    await client(fakeFetch(200, { depositId: req.id, status: "ACCEPTED" }, calls)).initiateDeposit(req);
    expect(calls[0]).toMatchObject({ url: "https://api.sandbox.pawapay.io/v2/deposits", method: "POST" });
    expect(calls[0]!.headers.Authorization).toBe("Bearer tok_test");
    expect(calls[0]!.body).toEqual({
      depositId: req.id,
      amount: "5000",
      currency: "RWF",
      payer: { type: "MMO", accountDetails: { phoneNumber: "250788123456", provider: "MTN_MOMO_RWA" } },
    });
  });

  it("POST /v2/payouts with recipient and payoutId", async () => {
    const calls: Call[] = [];
    await client(fakeFetch(200, { payoutId: req.id, status: "ACCEPTED" }, calls)).initiatePayout(req);
    expect(calls[0]).toMatchObject({ url: "https://api.sandbox.pawapay.io/v2/payouts", method: "POST" });
    expect(calls[0]!.body).toEqual({
      payoutId: req.id,
      amount: "5000",
      currency: "RWF",
      recipient: { type: "MMO", accountDetails: { phoneNumber: "250788123456", provider: "MTN_MOMO_RWA" } },
    });
  });

  it("GETs status endpoints by id", async () => {
    const calls: Call[] = [];
    const c = client(fakeFetch(200, { status: "NOT_FOUND" }, calls));
    await c.getDeposit(req.id);
    await c.getPayout(req.id);
    expect(calls.map((x) => `${x.method} ${x.url}`)).toEqual([
      `GET https://api.sandbox.pawapay.io/v2/deposits/${req.id}`,
      `GET https://api.sandbox.pawapay.io/v2/payouts/${req.id}`,
    ]);
  });
});

describe("PawaPay outcome classification", () => {
  it("maps definitive initiation outcomes", async () => {
    expect(await client(fakeFetch(200, { status: "ACCEPTED" })).initiateDeposit(req)).toEqual({ kind: "accepted" });
    expect(await client(fakeFetch(200, { status: "DUPLICATE_IGNORED" })).initiateDeposit(req)).toEqual({ kind: "duplicate" });
    expect(
      await client(fakeFetch(200, { status: "REJECTED", failureReason: { failureCode: "AMOUNT_OUT_OF_BOUNDS", failureMessage: "x" } })).initiateDeposit(req),
    ).toMatchObject({ kind: "rejected", failureCode: "AMOUNT_OUT_OF_BOUNDS" });
    expect(await client(fakeFetch(400, { failureReason: { failureCode: "INVALID_PHONE_NUMBER" } })).initiateDeposit(req)).toMatchObject({
      kind: "rejected",
      failureCode: "INVALID_PHONE_NUMBER",
    });
  });

  it("never treats 5xx, 429 or network errors as failures", async () => {
    expect((await client(fakeFetch(500, { failureCode: "UNKNOWN_ERROR" })).initiateDeposit(req)).kind).toBe("unknown");
    expect((await client(fakeFetch(429, {})).initiateDeposit(req)).kind).toBe("unknown");
    const boom = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    expect((await client(boom).initiatePayout(req)).kind).toBe("unknown");
  });

  it("parses FOUND data and treats unrecognised lookups as unknown", async () => {
    const found = await client(fakeFetch(200, { status: "FOUND", data: { status: "COMPLETED", amount: "5000", currency: "RWF" } })).getDeposit(req.id);
    expect(found).toMatchObject({ kind: "found", data: { status: "COMPLETED", amount: "5000" } });
    expect((await client(fakeFetch(200, { status: "WEIRD" })).getDeposit(req.id)).kind).toBe("unknown");
    expect((await client(fakeFetch(502, {})).getDeposit(req.id)).kind).toBe("unknown");
  });
});

describe("safety guards", () => {
  it("refuses a live URL while live payments are disabled", () => {
    expect(() => createPawaPayClient({ baseUrl: "https://api.pawapay.io", token: "x", liveEnabled: false })).toThrow(/LIVE_PAYMENTS_ENABLED/);
    expect(createPawaPayClient({ baseUrl: "https://api.sandbox.pawapay.io", token: "x", liveEnabled: false }).environment).toBe("SANDBOX");
  });
  it("parses provider amounts strictly", () => {
    expect(parseProviderAmount("5000")).toBe(5000n);
    expect(parseProviderAmount("5000.00")).toBe(5000n);
    expect(parseProviderAmount("5000.50")).toBeNull();
    expect(parseProviderAmount("abc")).toBeNull();
  });
  it("converts E.164 to Rwandan MSISDN", () => {
    expect(toRwandaMsisdn("+250788123456")).toBe("250788123456");
    expect(toRwandaMsisdn("+254712345678")).toBeNull();
    expect(toRwandaMsisdn("0788123456")).toBeNull();
  });
});
