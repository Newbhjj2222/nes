/**
 * Integration tests. Require a running Postgres with migrations applied
 * (DATABASE_URL pointing at a TEST database, never a real one).
 * Skipped automatically when RUN_DB_TESTS is not set.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = process.env.RUN_DB_TESTS === "true";

describe.skipIf(!run)("registration, cards and sessions", () => {
  let app: import("express").Express;
  let prisma: typeof import("../src/lib/prisma").prisma;
  const email = `user-${Date.now()}@example.com`;
  const password = "Str0ngPassword";

  beforeAll(async () => {
    ({ prisma } = await import("../src/lib/prisma"));
    app = (await import("../src/app")).createApp();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("registers and provisions card, wallet (NES, zero balance) and ledger account", async () => {
    const res = await request(app).post("/api/v1/auth/register").send({ fullName: "Test User", email, password });
    expect(res.status).toBe(201);
    expect(res.body.user.passwordHash).toBeUndefined();

    const user = await prisma.user.findUniqueOrThrow({
      where: { email },
      include: { card: true, wallet: { include: { ledgerAccounts: true } }, profile: true },
    });
    expect(user.card?.cardNumber).toMatch(/^NES-\d{4}-\d{4}-\d{4}$/);
    expect(user.card?.status).toBe("ACTIVE");
    expect(user.wallet?.currency).toBe("NES");
    expect(user.wallet?.availableNes).toBe(0n);
    expect(user.wallet?.ledgerAccounts.map((a) => a.type).sort()).toEqual(["USER_PENDING", "USER_WALLET"]);
    expect(user.passwordHash).not.toBe(password);
  });

  it("rejects duplicate registration", async () => {
    const res = await request(app).post("/api/v1/auth/register").send({ fullName: "Test User", email, password });
    expect(res.status).toBe(409);
  });

  it("logs in, serves /cards/me in NeS, and logout revokes the session", async () => {
    const agent = request.agent(app);
    const login = await agent.post("/api/v1/auth/login").send({ identifier: email, password });
    expect(login.status).toBe(200);
    expect(login.headers["set-cookie"]?.[0]).toMatch(/HttpOnly/i);

    const card = await agent.get("/api/v1/cards/me");
    expect(card.status).toBe(200);
    expect(card.body.card.availableNes).toBe("0");
    expect(card.body.card.availableRwf).toBeUndefined();

    const cookie = login.headers["set-cookie"]![0]!.split(";")[0]!;
    expect((await agent.post("/api/v1/auth/logout")).status).toBe(204);
    const replay = await request(app).get("/api/v1/cards/me").set("Cookie", cookie);
    expect(replay.status).toBe(401);
  });

  it("rejects wrong passwords and unauthenticated access", async () => {
    const bad = await request(app).post("/api/v1/auth/login").send({ identifier: email, password: "WrongPassword1" });
    expect(bad.status).toBe(401);
    expect((await request(app).get("/api/v1/cards/me")).status).toBe(401);
  });

  it("card lookup leaks no private data", async () => {
    const agent = request.agent(app);
    await agent.post("/api/v1/auth/login").send({ identifier: email, password });
    const mine = (await agent.get("/api/v1/cards/me")).body.card.cardNumber as string;
    const res = await agent.get(`/api/v1/cards/${mine}`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.card).sort()).toEqual(["cardNumber", "status", "valid"]);
  });
});
