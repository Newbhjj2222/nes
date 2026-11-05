/**
 * Developer / merchant onboarding / API-key / webhook tests.
 * Need Postgres with migrations applied (throwaway test DB). Skipped unless RUN_DB_TESTS=true.
 */
import request from "supertest";
import { beforeAll, describe, expect, it, vi } from "vitest";

const run = process.env.RUN_DB_TESTS === "true";
const PASSWORD = "Str0ngPassword";

describe.skipIf(!run)("developer platform", () => {
  let app: import("express").Express;
  let prisma: typeof import("../src/lib/prisma").prisma;
  let h: typeof import("./helpers");
  let unseal: typeof import("../src/lib/secretbox").unseal;

  const login = async (userId: string) => {
    const email = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).email!;
    const ag = request.agent(app);
    expect((await ag.post("/api/v1/auth/login").send({ identifier: email, password: PASSWORD })).status).toBe(200);
    return ag;
  };

  /** A developer with a sandbox app and one key. */
  const setupDeveloper = async (permissions: string[] = ["payments:create", "payments:read", "webhooks:manage"]) => {
    const user = await h.createTestUser();
    const ag = await login(user.id);
    expect((await ag.post("/api/v1/developer/register").send({ companyName: "Acme Reads" })).status).toBe(201);
    const appRes = await ag.post("/api/v1/developer/apps").send({ name: "Reading Platform", permissions });
    expect(appRes.status).toBe(201);
    const appId = appRes.body.app.id as string;
    const keyRes = await ag.post(`/api/v1/developer/apps/${appId}/keys`).send({ name: "default" });
    expect(keyRes.status).toBe(201);
    return { user, ag, appId, keyId: keyRes.body.key.id as string, secret: keyRes.body.secret as string };
  };

  beforeAll(async () => {
    ({ prisma } = await import("../src/lib/prisma"));
    h = await import("./helpers");
    ({ unseal } = await import("../src/lib/secretbox"));
    app = (await import("../src/app")).createApp();
  });

  it("registers a developer once and upgrades the role", async () => {
    const user = await h.createTestUser();
    const ag = await login(user.id);
    expect((await ag.post("/api/v1/developer/register").send({})).status).toBe(201);
    expect((await ag.post("/api/v1/developer/register").send({})).status).toBe(409);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).role).toBe("DEVELOPER");
    expect((await request(app).post("/api/v1/developer/register").send({})).status).toBe(401);
  });

  it("non-developers cannot use the developer API", async () => {
    const user = await h.createTestUser();
    const ag = await login(user.id);
    expect((await ag.get("/api/v1/developer/apps")).status).toBe(403);
  });

  it("validates app input (unknown permissions, empty permissions, short names)", async () => {
    const { ag } = await setupDeveloper();
    expect((await ag.post("/api/v1/developer/apps").send({ name: "Okay Name", permissions: ["admin:everything"] })).status).toBe(400);
    expect((await ag.post("/api/v1/developer/apps").send({ name: "Okay Name", permissions: [] })).status).toBe(400);
    expect((await ag.post("/api/v1/developer/apps").send({ name: "x", permissions: ["payments:read"] })).status).toBe(400);
  });

  it("shows the key once and stores only a hash", async () => {
    const { ag, appId, secret, keyId } = await setupDeveloper();
    expect(secret).toMatch(/^nes_test_[0-9a-f]{8}_[0-9a-f]{48}$/);

    const row = await prisma.apiKey.findUniqueOrThrow({ where: { id: keyId } });
    const rawSecret = secret.split("_")[3]!;
    expect(JSON.stringify(row)).not.toContain(rawSecret);
    expect(row.secretHash).toMatch(/^[0-9a-f]{64}$/);

    const list = await ag.get(`/api/v1/developer/apps/${appId}/keys`);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(rawSecret);
    expect(list.body.keys[0].secretHash).toBeUndefined();
    expect(list.body.keys[0].prefix).toBe(row.prefix);
  });

  it("authenticates with API keys and rejects bad, mixed-up, or missing credentials", async () => {
    const { ag, secret } = await setupDeveloper();
    const ok = await request(app).get("/api/v1/merchant/me").set("Authorization", `Bearer ${secret}`);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ environment: "SANDBOX", merchant: { approved: false, status: "NONE" } });

    expect((await request(app).get("/api/v1/merchant/me")).status).toBe(401);
    const tampered = secret.slice(0, -1) + (secret.endsWith("0") ? "1" : "0");
    expect((await request(app).get("/api/v1/merchant/me").set("Authorization", `Bearer ${tampered}`)).status).toBe(401);
    expect((await request(app).get("/api/v1/merchant/me").set("Authorization", "Bearer nes_test_deadbeef_" + "a".repeat(48))).status).toBe(401);

    // an API key is not a user session, and a user session is not an API key
    expect((await request(app).get("/api/v1/wallet/balance").set("Authorization", `Bearer ${secret}`)).status).toBe(401);
    const jwt = ag.get("/api/v1/merchant/me"); // cookie only, no Bearer key
    expect((await jwt).status).toBe(401);
  });

  it("revoked keys stop working immediately; other developers cannot see or revoke them", async () => {
    const a = await setupDeveloper();
    const b = await setupDeveloper();
    expect((await b.ag.delete(`/api/v1/developer/keys/${a.keyId}`)).status).toBe(404);
    expect((await b.ag.get(`/api/v1/developer/apps/${a.appId}`)).status).toBe(404);
    expect((await b.ag.get(`/api/v1/developer/apps/${a.appId}/keys`)).status).toBe(404);
    expect((await request(app).get("/api/v1/merchant/me").set("Authorization", `Bearer ${a.secret}`)).status).toBe(200);

    const rev = await a.ag.delete(`/api/v1/developer/keys/${a.keyId}`);
    expect(rev.status).toBe(200);
    expect(rev.body.key.status).toBe("REVOKED");
    expect((await request(app).get("/api/v1/merchant/me").set("Authorization", `Bearer ${a.secret}`)).status).toBe(401);
  });

  it("suspended developers and suspended apps lose API access", async () => {
    const a = await setupDeveloper();
    await prisma.developerApp.update({ where: { id: a.appId }, data: { status: "SUSPENDED" } });
    expect((await request(app).get("/api/v1/merchant/me").set("Authorization", `Bearer ${a.secret}`)).status).toBe(401);
    await prisma.developerApp.update({ where: { id: a.appId }, data: { status: "ACTIVE" } });
    await prisma.user.update({ where: { id: a.user.id }, data: { status: "SUSPENDED" } });
    expect((await request(app).get("/api/v1/merchant/me").set("Authorization", `Bearer ${a.secret}`)).status).toBe(401);
  });

  it("limits active keys per app", async () => {
    const { ag, appId } = await setupDeveloper();
    for (let i = 0; i < 4; i++) expect((await ag.post(`/api/v1/developer/apps/${appId}/keys`).send({ name: `k${i}` })).status).toBe(201);
    expect((await ag.post(`/api/v1/developer/apps/${appId}/keys`).send({ name: "one too many" })).status).toBe(409);
  });

  it("enforces API permissions on webhooks", async () => {
    const weak = await setupDeveloper(["payments:read"]);
    const res = await request(app)
      .post("/api/v1/webhooks")
      .set("Authorization", `Bearer ${weak.secret}`)
      .send({ url: "https://example.com/hook", events: ["payment.completed"] });
    expect(res.status).toBe(403);
    expect((await request(app).get("/api/v1/webhooks").set("Authorization", `Bearer ${weak.secret}`)).status).toBe(403);
  });

  it("creates webhooks: secret shown once, encrypted at rest, SSRF-safe, scoped to the app", async () => {
    const a = await setupDeveloper();
    const b = await setupDeveloper();
    const create = await request(app)
      .post("/api/v1/webhooks")
      .set("Authorization", `Bearer ${a.secret}`)
      .send({ url: "https://example.com/hooks/nes", events: ["payment.completed", "payment.refunded"] });
    expect(create.status).toBe(201);
    const secret = create.body.signingSecret as string;
    expect(secret).toMatch(/^whsec_[0-9a-f]{48}$/);

    const row = await prisma.webhook.findUniqueOrThrow({ where: { id: create.body.webhook.id } });
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(unseal(row.signingKeyEnc)).toBe(secret); // we can still sign deliveries

    const list = await request(app).get("/api/v1/webhooks").set("Authorization", `Bearer ${a.secret}`);
    expect(list.body.webhooks).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(secret);
    expect(list.body.webhooks[0].signingKeyEnc).toBeUndefined();

    for (const url of ["http://example.com/x", "https://10.0.0.5/x", "https://169.254.169.254/latest/meta-data", "https://user:pw@example.com/x"]) {
      const bad = await request(app).post("/api/v1/webhooks").set("Authorization", `Bearer ${a.secret}`).send({ url, events: ["payment.completed"] });
      expect(bad.status, url).toBe(400);
    }

    // another app can neither list, inspect, nor delete it
    expect((await request(app).get("/api/v1/webhooks").set("Authorization", `Bearer ${b.secret}`)).body.webhooks).toHaveLength(0);
    expect((await request(app).delete(`/api/v1/webhooks/${create.body.webhook.id}`).set("Authorization", `Bearer ${b.secret}`)).status).toBe(404);
    expect((await request(app).get(`/api/v1/webhooks/${create.body.webhook.id}/deliveries`).set("Authorization", `Bearer ${b.secret}`)).status).toBe(404);
    // a key cannot reach into another app by passing its id
    const cross = await request(app).get(`/api/v1/webhooks?appId=${a.appId}`).set("Authorization", `Bearer ${b.secret}`);
    expect(cross.status).toBe(403);

    const del = await request(app).delete(`/api/v1/webhooks/${create.body.webhook.id}`).set("Authorization", `Bearer ${a.secret}`);
    expect(del.body.webhook.active).toBe(false);
  });

  it("developers manage their own webhooks from the portal session", async () => {
    const a = await setupDeveloper();
    const other = await setupDeveloper();
    const body = { url: "https://example.com/portal", events: ["payment.failed"] };
    expect((await a.ag.post("/api/v1/webhooks").send(body)).status).toBe(404); // appId required
    expect((await other.ag.post("/api/v1/webhooks").send({ ...body, appId: a.appId })).status).toBe(404); // not theirs
    const ok = await a.ag.post("/api/v1/webhooks").send({ ...body, appId: a.appId });
    expect(ok.status).toBe(201);
    expect((await a.ag.get(`/api/v1/webhooks?appId=${a.appId}`)).body.webhooks).toHaveLength(1);
  });

  it("blocks production keys while live payments are disabled", async () => {
    const { ag, appId } = await setupDeveloper();
    const res = await ag.post(`/api/v1/developer/apps/${appId}/keys`).send({ name: "live", environment: "PRODUCTION" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("LIVE_DISABLED");
  });

  it("merchant onboarding: verified request, admin review, four-eyes, settlement account created", async () => {
    const { user, ag, appId, secret } = await setupDeveloper();
    const business = { businessName: "Acme Reads Ltd", contactEmail: "billing@acme.example", registrationNumber: "RW-12345" };

    // must verify email/phone first
    expect((await ag.post(`/api/v1/developer/apps/${appId}/production-access`).send(business)).status).toBe(403);
    await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
    const req1 = await ag.post(`/api/v1/developer/apps/${appId}/production-access`).send(business);
    expect(req1.status).toBe(201);
    expect(req1.body.application.status).toBe("PENDING");
    expect((await ag.post(`/api/v1/developer/apps/${appId}/production-access`).send(business)).status).toBe(409);
    expect((await prisma.developerApp.findUniqueOrThrow({ where: { id: appId } })).productionAccess).toBe("REQUESTED");

    // not collectable yet
    const me = await request(app).get("/api/v1/merchant/me").set("Authorization", `Bearer ${secret}`);
    expect(me.body.merchant.approved).toBe(false);

    // regular users and developers cannot review
    expect((await ag.post(`/api/v1/admin/merchant-applications/${req1.body.application.id}/approve`).send({})).status).toBe(403);

    // an admin cannot approve their own application
    const adminUser = await h.createTestUser("ADMIN");
    const adminAg = await login(adminUser.id);
    const adminDev = await prisma.developer.create({ data: { userId: adminUser.id } });
    const adminApp = await prisma.developerApp.create({ data: { developerId: adminDev.id, name: "Admin app", permissions: ["payments:read"] } });
    const own = await prisma.merchantApplication.create({
      data: { userId: adminUser.id, appId: adminApp.id, businessName: "Admin Co", contactEmail: "a@example.com" },
    });
    expect((await adminAg.post(`/api/v1/admin/merchant-applications/${own.id}/approve`).send({})).status).toBe(403);

    // rejection needs a reason
    expect((await adminAg.post(`/api/v1/admin/merchant-applications/${req1.body.application.id}/reject`).send({})).status).toBe(400);

    const list = await adminAg.get("/api/v1/admin/merchant-applications?status=PENDING");
    expect(list.body.applications.some((x: { id: string }) => x.id === req1.body.application.id)).toBe(true);

    const approve = await adminAg.post(`/api/v1/admin/merchant-applications/${req1.body.application.id}/approve`).send({ note: "KYB documents verified" });
    expect(approve.status).toBe(200);
    expect((await adminAg.post(`/api/v1/admin/merchant-applications/${req1.body.application.id}/approve`).send({})).status).toBe(409);

    const merchant = await prisma.merchantAccount.findUniqueOrThrow({ where: { appId }, include: { ledgerAccount: true } });
    expect(merchant.status).toBe("APPROVED");
    expect(merchant.settlementNes).toBe(0n);
    expect(merchant.ledgerAccount?.type).toBe("MERCHANT_SETTLEMENT");
    expect((await prisma.developerApp.findUniqueOrThrow({ where: { id: appId } })).productionAccess).toBe("APPROVED");
    expect(await prisma.auditLog.count({ where: { actorId: adminUser.id, action: "MERCHANT_APPROVED", entityId: merchant.id } })).toBe(1);

    const me2 = await request(app).get("/api/v1/merchant/me").set("Authorization", `Bearer ${secret}`);
    expect(me2.body.merchant).toEqual({ approved: true, status: "APPROVED" });

    const sus = await adminAg.post(`/api/v1/admin/merchants/${merchant.id}/suspend`).send({ reason: "chargeback investigation" });
    expect(sus.body.merchant.status).toBe("SUSPENDED");
    const me3 = await request(app).get("/api/v1/merchant/me").set("Authorization", `Bearer ${secret}`);
    expect(me3.body.merchant.approved).toBe(false);
  });

  it("rejected applications mark the app rejected", async () => {
    const { user, ag, appId } = await setupDeveloper();
    await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
    const r = await ag.post(`/api/v1/developer/apps/${appId}/production-access`).send({ businessName: "Dodgy Ltd", contactEmail: "d@example.com" });
    const adminAg = await login((await h.createTestUser("ADMIN")).id);
    const rej = await adminAg.post(`/api/v1/admin/merchant-applications/${r.body.application.id}/reject`).send({ note: "Unable to verify the business" });
    expect(rej.status).toBe(200);
    expect((await prisma.developerApp.findUniqueOrThrow({ where: { id: appId } })).productionAccess).toBe("REJECTED");
    expect(await prisma.merchantAccount.count({ where: { appId } })).toBe(0);
  });

  it("records API logs and usage statistics, including failures", async () => {
    const { ag, appId, secret } = await setupDeveloper();
    await request(app).get("/api/v1/merchant/me").set("Authorization", `Bearer ${secret}`);
    await request(app).get("/api/v1/merchant/me").set("Authorization", `Bearer ${secret}`);
    await request(app).post("/api/v1/webhooks").set("Authorization", `Bearer ${secret}`).send({ url: "http://example.com", events: ["payment.completed"] });

    await vi.waitFor(async () => {
      expect(await prisma.apiLog.count({ where: { appId } })).toBeGreaterThanOrEqual(3);
    });
    const logs = await ag.get(`/api/v1/developer/apps/${appId}/logs`);
    expect(logs.status).toBe(200);
    expect(logs.body.logs.length).toBeGreaterThanOrEqual(3);
    const errs = await ag.get(`/api/v1/developer/apps/${appId}/logs?errorsOnly=true`);
    expect(errs.body.logs.every((l: { statusCode: number }) => l.statusCode >= 400)).toBe(true);
    expect(errs.body.logs[0].errorCode).toBe("HTTPS_REQUIRED");

    const usage = await ag.get(`/api/v1/developer/apps/${appId}/usage?days=7`);
    expect(usage.status).toBe(200);
    expect(usage.body.usage.totalRequests).toBeGreaterThanOrEqual(3);
    expect(usage.body.usage.totalErrors).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(logs.body)).not.toContain(secret);
  });

  it("developers cannot read another developer's logs or usage", async () => {
    const a = await setupDeveloper();
    const b = await setupDeveloper();
    expect((await b.ag.get(`/api/v1/developer/apps/${a.appId}/logs`)).status).toBe(404);
    expect((await b.ag.get(`/api/v1/developer/apps/${a.appId}/usage`)).status).toBe(404);
  });
});
