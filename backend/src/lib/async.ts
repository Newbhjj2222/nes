import type { NextFunction, Request, RequestHandler, Response } from "express";

/** Express 4 does not catch rejected promises; this forwards them to the error handler. */
export const ah =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };
