import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "../config/env";

/**
 * AES-256-GCM encryption for secrets we must be able to read back (e.g. webhook signing keys).
 * The key is derived from WEBHOOK_SIGNING_SECRET, so rotating that env var invalidates stored secrets.
 * Format: "v1:" + base64(iv[12] | authTag[16] | ciphertext)
 */
const key = () => createHash("sha256").update(`nes-secretbox:v1:${env.WEBHOOK_SIGNING_SECRET}`).digest();

export function seal(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64")}`;
}

export function unseal(sealed: string): string {
  if (!sealed.startsWith("v1:")) throw new Error("Unsupported sealed secret format");
  const raw = Buffer.from(sealed.slice(3), "base64");
  const decipher = createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}
