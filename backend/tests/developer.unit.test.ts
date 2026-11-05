import { describe, expect, it } from "vitest";
import { seal, unseal } from "../src/lib/secretbox";
import { generateApiKey, hashSecret, parseApiKey } from "../src/modules/developer/apikey.service";
import { signPayload, verifyWebhookSignature } from "../src/modules/webhooks/signing";
import { isBlockedHost, validateWebhookUrl } from "../src/modules/webhooks/urlguard";

describe("API keys", () => {
  it("generates parseable keys whose hash matches and whose secret is not stored", () => {
    const g = generateApiKey("SANDBOX");
    expect(g.key).toMatch(/^nes_test_[0-9a-f]{8}_[0-9a-f]{48}$/);
    const p = parseApiKey(g.key)!;
    expect(p.prefix).toBe(g.prefix);
    expect(p.environment).toBe("SANDBOX");
    expect(hashSecret(p.secret)).toBe(g.secretHash);
    expect(g.secretHash).not.toContain(p.secret);
    expect(generateApiKey("PRODUCTION").key.startsWith("nes_live_")).toBe(true);
  });
  it("rejects malformed keys", () => {
    for (const bad of ["", "nes_test_abc", "sk_test_12345678_" + "a".repeat(48), `nes_test_ZZZZZZZZ_${"a".repeat(48)}`]) {
      expect(parseApiKey(bad)).toBeNull();
    }
  });
  it("generates unique keys", () => {
    expect(new Set(Array.from({ length: 200 }, () => generateApiKey("SANDBOX").key)).size).toBe(200);
  });
});

describe("secretbox", () => {
  it("round-trips and uses a fresh IV each time", () => {
    const a = seal("whsec_abc");
    expect(unseal(a)).toBe("whsec_abc");
    expect(seal("whsec_abc")).not.toBe(a);
    expect(a).not.toContain("whsec_abc");
  });
  it("detects tampering", () => {
    const s = seal("secret");
    const raw = Buffer.from(s.slice(3), "base64");
    raw[raw.length - 1]! ^= 1;
    expect(() => unseal(`v1:${raw.toString("base64")}`)).toThrow();
  });
});

describe("webhook signatures", () => {
  const secret = "whsec_test";
  const body = JSON.stringify({ event: "payment.completed", amountNes: "50" });
  const now = 1_800_000_000;
  const header = signPayload(secret, body, now);

  it("verifies a valid signature", () => {
    expect(verifyWebhookSignature(secret, body, header, { nowSec: now + 10 })).toBe(true);
  });
  it("rejects tampered body, wrong secret, and malformed headers", () => {
    expect(verifyWebhookSignature(secret, body + " ", header, { nowSec: now })).toBe(false);
    expect(verifyWebhookSignature("whsec_other", body, header, { nowSec: now })).toBe(false);
    for (const bad of [undefined, "", "garbage", "t=abc,v1=00", `t=${now},v1=zz`]) {
      expect(verifyWebhookSignature(secret, body, bad, { nowSec: now })).toBe(false);
    }
  });
  it("rejects replays outside the tolerance window", () => {
    expect(verifyWebhookSignature(secret, body, header, { nowSec: now + 301 })).toBe(false);
    expect(verifyWebhookSignature(secret, body, header, { nowSec: now - 301 })).toBe(false);
    expect(verifyWebhookSignature(secret, body, header, { nowSec: now + 301, toleranceSec: 600 })).toBe(true);
  });
});

describe("webhook URL guard", () => {
  it("accepts public https URLs", () => {
    expect(validateWebhookUrl("https://example.com/hooks/nes").hostname).toBe("example.com");
  });
  it("blocks private, loopback, link-local and metadata hosts", () => {
    for (const h of ["10.0.0.5", "127.0.0.1", "192.168.1.1", "172.16.0.1", "172.31.255.255", "169.254.169.254", "100.64.0.1", "localhost", "db.internal", "printer.local", "intranet", "[::1]".slice(1, -1) + ":1"]) {
      expect(isBlockedHost(h), h).toBe(true);
    }
    expect(isBlockedHost("172.32.0.1")).toBe(false);
    expect(isBlockedHost("example.com")).toBe(false);
  });
  it("rejects http, credentials, and blocked hosts", () => {
    expect(() => validateWebhookUrl("http://example.com/x")).toThrow();
    expect(() => validateWebhookUrl("https://user:pw@example.com/x")).toThrow();
    expect(() => validateWebhookUrl("https://10.0.0.5/x")).toThrow();
    expect(() => validateWebhookUrl("https://169.254.169.254/latest")).toThrow();
    expect(() => validateWebhookUrl("not a url")).toThrow();
  });
});
