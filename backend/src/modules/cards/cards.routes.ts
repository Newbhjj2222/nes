import { Router } from "express";
import { isValidCardNumber } from "../../lib/crypto";
import { badRequest, notFound } from "../../lib/errors";
import { prisma } from "../../lib/prisma";
import { requireAuth } from "../../middleware/auth";
import { getMyCard } from "../auth/auth.service";

export const cardsRouter = Router();
cardsRouter.use(requireAuth);

cardsRouter.get("/me", async (req, res, next) => {
  try {
    res.json({ card: await getMyCard(req.user!.id) });
  } catch (e) {
    next(e);
  }
});

/**
 * Card lookup for identification. Deliberately minimal: returns only whether the
 * card exists and its status. No name, no balance, no user ID.
 */
cardsRouter.get("/:cardNumber", async (req, res, next) => {
  try {
    const cardNumber = String(req.params.cardNumber).toUpperCase();
    if (!isValidCardNumber(cardNumber)) throw badRequest("INVALID_CARD_NUMBER", "Malformed card number");
    const card = await prisma.readerCard.findUnique({ where: { cardNumber }, select: { cardNumber: true, status: true } });
    if (!card) throw notFound("Card not found");
    res.json({ card: { cardNumber: card.cardNumber, status: card.status, valid: card.status === "ACTIVE" } });
  } catch (e) {
    next(e);
  }
});
