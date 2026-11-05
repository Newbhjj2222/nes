import bcrypt from "bcryptjs";
import type { AuthTokenType, Prisma } from "@prisma/client";
import { randomOtp, randomToken, sha256 } from "../../lib/crypto";
import { badRequest, conflict, unauthorized } from "../../lib/errors";
import { deliverToken } from "../../lib/notifier";
import { prisma } from "../../lib/prisma";
import { createCardForUser } from "../cards/card.service";
import type { RegisterInput } from "./auth.schemas";

const BCRYPT_COST = 12;
// Used to keep login timing similar when the account does not exist.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", BCRYPT_COST);

const TOKEN_TTL_MS: Record<AuthTokenType, number> = {
  EMAIL_VERIFY: 24 * 60 * 60 * 1000,
  PHONE_VERIFY: 10 * 60 * 1000,
  PASSWORD_RESET: 30 * 60 * 1000,
};

/** Public projection: never includes passwordHash or tokenVersion. */
const publicUser = (u: { id: string; email: string | null; phone: string | null; role: string; status: string; emailVerifiedAt: Date | null; phoneVerifiedAt: Date | null }) => ({
  id: u.id,
  email: u.email,
  phone: u.phone,
  role: u.role,
  status: u.status,
  emailVerified: !!u.emailVerifiedAt,
  phoneVerified: !!u.phoneVerifiedAt,
});

/**
 * Registers a user and atomically provisions: profile, NeS card, wallet (currency NES)
 * and the wallet's ledger account. All-or-nothing in one DB transaction.
 */
export async function register(input: RegisterInput) {
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);
  try {
    const user = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const u = await tx.user.create({
        data: {
          email: input.email ?? null,
          phone: input.phone ?? null,
          passwordHash,
          profile: { create: { fullName: input.fullName } },
        },
      });
      await createCardForUser(tx, u.id);
      const wallet = await tx.wallet.create({ data: { userId: u.id, currency: "NES" } });
      await tx.ledgerAccount.createMany({
        data: [
          { type: "USER_WALLET", walletId: wallet.id, name: `wallet:${u.id}` },
          { type: "USER_PENDING", walletId: wallet.id, name: `pending:${u.id}` },
        ],
      });
      await tx.auditLog.create({
        data: { actorId: u.id, action: "USER_REGISTERED", entityType: "User", entityId: u.id },
      });
      return u;
    });
    return user;
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") {
      // Do not reveal which field collided beyond what is needed to fix the form.
      throw conflict("ACCOUNT_EXISTS", "An account with these details already exists");
    }
    throw e;
  }
}

export async function login(identifier: string, password: string) {
  const user = await prisma.user.findFirst({
    where: { OR: [{ email: identifier }, { phone: identifier }] },
  });
  const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok) throw unauthorized("Invalid credentials");
  if (user.status !== "ACTIVE") throw unauthorized("Account is not active");
  return user;
}

export async function logout(userId: string) {
  // Bumping tokenVersion invalidates all outstanding session JWTs for this user.
  await prisma.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } });
}

async function issueToken(userId: string, type: AuthTokenType, value: string) {
  // Invalidate earlier unused tokens of the same type.
  await prisma.authToken.updateMany({ where: { userId, type, usedAt: null }, data: { usedAt: new Date() } });
  await prisma.authToken.create({
    data: { userId, type, tokenHash: sha256(value), expiresAt: new Date(Date.now() + TOKEN_TTL_MS[type]) },
  });
}

async function consumeToken(type: AuthTokenType, value: string, userId?: string) {
  const row = await prisma.authToken.findUnique({ where: { tokenHash: sha256(value) } });
  if (!row || row.type !== type || row.usedAt || row.expiresAt < new Date() || (userId && row.userId !== userId)) {
    throw badRequest("INVALID_TOKEN", "Token is invalid or expired");
  }
  // Atomic single-use: only one concurrent caller can flip usedAt from null.
  const claimed = await prisma.authToken.updateMany({
    where: { id: row.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (claimed.count !== 1) throw badRequest("INVALID_TOKEN", "Token is invalid or expired");
  return row.userId;
}

/** Always resolves, so callers cannot learn whether an account exists. */
export async function requestPasswordReset(identifier: string) {
  const user = await prisma.user.findFirst({ where: { OR: [{ email: identifier }, { phone: identifier }] } });
  if (!user || user.status === "DELETED") return;
  const token = randomToken();
  await issueToken(user.id, "PASSWORD_RESET", token);
  if (user.email) await deliverToken("email", user.email, "password-reset", token);
  else if (user.phone) await deliverToken("sms", user.phone, "password-reset", token);
}

export async function resetPassword(token: string, newPassword: string) {
  const userId = await consumeToken("PASSWORD_RESET", token);
  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
  await prisma.$transaction([
    // tokenVersion bump logs the user out everywhere.
    prisma.user.update({ where: { id: userId }, data: { passwordHash, tokenVersion: { increment: 1 } } }),
    prisma.auditLog.create({ data: { actorId: userId, action: "PASSWORD_RESET", entityType: "User", entityId: userId } }),
  ]);
}

export async function requestVerification(userId: string, channel: "email" | "phone") {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (channel === "email") {
    if (!user.email) throw badRequest("NO_EMAIL", "No email on this account");
    if (user.emailVerifiedAt) throw badRequest("ALREADY_VERIFIED", "Email already verified");
    const token = randomToken();
    await issueToken(userId, "EMAIL_VERIFY", token);
    await deliverToken("email", user.email, "email-verify", token);
  } else {
    if (!user.phone) throw badRequest("NO_PHONE", "No phone on this account");
    if (user.phoneVerifiedAt) throw badRequest("ALREADY_VERIFIED", "Phone already verified");
    const otp = randomOtp();
    await issueToken(userId, "PHONE_VERIFY", otp);
    await deliverToken("sms", user.phone, "phone-verify", otp);
  }
}

export async function confirmVerification(userId: string, channel: "email" | "phone", token: string) {
  // userId is enforced so a short OTP cannot be redeemed against someone else's account.
  await consumeToken(channel === "email" ? "EMAIL_VERIFY" : "PHONE_VERIFY", token, userId);
  await prisma.user.update({
    where: { id: userId },
    data: channel === "email" ? { emailVerifiedAt: new Date() } : { phoneVerifiedAt: new Date() },
  });
}

export async function getMe(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: { profile: true, card: true },
  });
  return { ...publicUser(user), fullName: user.profile?.fullName ?? null, createdAt: user.createdAt, cardNumber: user.card?.cardNumber ?? null };
}

/** The user's own digital card. Balance comes from the server-side wallet, in NeS only. */
export async function getMyCard(userId: string) {
  const [card, profile, wallet] = await Promise.all([
    prisma.readerCard.findUniqueOrThrow({ where: { userId } }),
    prisma.userProfile.findUnique({ where: { userId } }),
    prisma.wallet.findUniqueOrThrow({ where: { userId } }),
  ]);
  return {
    brand: "NeS",
    cardNumber: card.cardNumber,
    cardholderName: profile?.fullName ?? "",
    status: card.status,
    availableNes: wallet.availableNes.toString(),
    createdAt: card.createdAt,
    qrPayload: card.qrPayload,
  };
}

export { publicUser };
