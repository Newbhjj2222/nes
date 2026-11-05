import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth } from "../../middleware/auth";

export const walletRouter = Router();
walletRouter.use(requireAuth);

/** Balances are always in NeS and always read from the server, never from the client. */
walletRouter.get("/balance", async (req, res, next) => {
  try {
    const w = await prisma.wallet.findUniqueOrThrow({ where: { userId: req.user!.id } });
    res.json({
      wallet: { currency: "NES", availableNes: w.availableNes.toString(), pendingNes: w.pendingNes.toString() },
    });
  } catch (e) {
    next(e);
  }
});

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().uuid().optional(),
});

/** The caller's own wallet movements, newest first. Never exposes other users or metadata. */
walletRouter.get("/transactions", async (req, res, next) => {
  try {
    const q = listQuery.parse(req.query);
    const rows = await prisma.ledgerEntry.findMany({
      where: { account: { type: "USER_WALLET", wallet: { userId: req.user!.id } } },
      include: { transaction: { select: { reference: true, type: true, description: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, q.limit);
    res.json({
      transactions: page.map((r) => ({
        id: r.id,
        reference: r.transaction.reference,
        type: r.transaction.type,
        description: r.transaction.description,
        direction: r.direction,
        amountNes: r.amountNes.toString(),
        signedAmountNes: (r.direction === "CREDIT" ? r.amountNes : -r.amountNes).toString(),
        createdAt: r.createdAt,
      })),
      nextCursor: rows.length > q.limit ? page[page.length - 1]!.id : null,
    });
  } catch (e) {
    next(e);
  }
});
