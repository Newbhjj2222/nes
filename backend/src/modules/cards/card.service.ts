import type { Prisma } from "@prisma/client";
import { generateCardNumber } from "../../lib/crypto";

/**
 * Creates the card for a user inside an existing DB transaction.
 * Retries on the (very unlikely) card number collision.
 */
export async function createCardForUser(tx: Prisma.TransactionClient, userId: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const cardNumber = generateCardNumber();
    const exists = await tx.readerCard.findUnique({ where: { cardNumber }, select: { id: true } });
    if (exists) continue;
    return tx.readerCard.create({
      data: { userId, cardNumber, status: "ACTIVE", qrPayload: `nes:card:${cardNumber}` },
    });
  }
  throw new Error("Could not allocate a unique card number");
}
