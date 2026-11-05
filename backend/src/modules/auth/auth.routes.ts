import { Router } from "express";
import rateLimit from "express-rate-limit";
import { env } from "../../config/env";
import { SESSION_COOKIE, requireAuth, signSession } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import {
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  verifyConfirmSchema,
  verifyRequestSchema,
} from "./auth.schemas";
import * as auth from "./auth.service";

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.NODE_ENV === "test" ? 10_000 : 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Too many attempts, try again later" } },
});

const cookieOptions = {
  httpOnly: true,
  secure: env.NODE_ENV === "production",
  sameSite: "lax" as const,
  maxAge: 15 * 60 * 1000,
  path: "/",
};

export const authRouter = Router();
authRouter.use(limiter);

authRouter.post("/register", validateBody(registerSchema), async (req, res, next) => {
  try {
    const user = await auth.register(req.body);
    res.cookie(SESSION_COOKIE, signSession(user.id, user.tokenVersion), cookieOptions);
    res.status(201).json({ user: auth.publicUser(user) });
  } catch (e) {
    next(e);
  }
});

authRouter.post("/login", validateBody(loginSchema), async (req, res, next) => {
  try {
    const user = await auth.login(req.body.identifier, req.body.password);
    res.cookie(SESSION_COOKIE, signSession(user.id, user.tokenVersion), cookieOptions);
    res.json({ user: auth.publicUser(user) });
  } catch (e) {
    next(e);
  }
});

authRouter.post("/logout", requireAuth, async (req, res, next) => {
  try {
    await auth.logout(req.user!.id);
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

authRouter.get("/me", requireAuth, async (req, res, next) => {
  try {
    res.json({ user: await auth.getMe(req.user!.id) });
  } catch (e) {
    next(e);
  }
});

authRouter.post("/password/forgot", validateBody(forgotPasswordSchema), async (req, res, next) => {
  try {
    await auth.requestPasswordReset(req.body.identifier);
    res.json({ message: "If an account exists, reset instructions have been sent" });
  } catch (e) {
    next(e);
  }
});

authRouter.post("/password/reset", validateBody(resetPasswordSchema), async (req, res, next) => {
  try {
    await auth.resetPassword(req.body.token, req.body.newPassword);
    res.json({ message: "Password updated. Please log in again." });
  } catch (e) {
    next(e);
  }
});

authRouter.post("/verify/request", requireAuth, validateBody(verifyRequestSchema), async (req, res, next) => {
  try {
    await auth.requestVerification(req.user!.id, req.body.channel);
    res.json({ message: "Verification sent" });
  } catch (e) {
    next(e);
  }
});

authRouter.post("/verify/confirm", requireAuth, validateBody(verifyConfirmSchema), async (req, res, next) => {
  try {
    await auth.confirmVerification(req.user!.id, req.body.channel, req.body.token);
    res.json({ message: "Verified" });
  } catch (e) {
    next(e);
  }
});
