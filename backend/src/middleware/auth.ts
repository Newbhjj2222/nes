import type { NextFunction, Request, RequestHandler, Response } from "express";
import jwt from "jsonwebtoken";
import type { Role } from "@prisma/client";
import { env } from "../config/env";
import { forbidden, unauthorized } from "../lib/errors";
import { prisma } from "../lib/prisma";

export const SESSION_COOKIE = "nes_session";

export interface AuthUser {
  id: string;
  role: Role;
}

declare module "express-serve-static-core" {
  interface Request {
    user?: AuthUser;
  }
}

interface SessionClaims {
  sub: string;
  tv: number;
}

export function signSession(userId: string, tokenVersion: number): string {
  return jwt.sign({ sub: userId, tv: tokenVersion } satisfies SessionClaims, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"],
    algorithm: "HS256",
  });
}

/** Requires a valid browser session cookie (or Bearer token) for an ACTIVE user. */
export const requireAuth: RequestHandler = async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const header = req.headers.authorization;
    const token =
      (req.cookies?.[SESSION_COOKIE] as string | undefined) ??
      (header?.startsWith("Bearer ") ? header.slice(7) : undefined);
    if (!token) throw unauthorized();

    let claims: SessionClaims;
    try {
      claims = jwt.verify(token, env.JWT_SECRET, { algorithms: ["HS256"] }) as unknown as SessionClaims;
    } catch {
      throw unauthorized("Invalid or expired session");
    }

    const user = await prisma.user.findUnique({
      where: { id: claims.sub },
      select: { id: true, role: true, status: true, tokenVersion: true },
    });
    // Always re-check state in the DB: suspension and logout take effect immediately.
    if (!user || user.status !== "ACTIVE" || user.tokenVersion !== claims.tv) {
      throw unauthorized("Invalid or expired session");
    }
    req.user = { id: user.id, role: user.role };
    next();
  } catch (e) {
    next(e);
  }
};

export const requireRole =
  (...roles: Role[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };
