import type { RequestHandler } from "express";
import type { ZodTypeAny, z } from "zod";

/** Parses req.body with a Zod schema and replaces it with the parsed (stripped) value. */
export const validateBody =
  <T extends ZodTypeAny>(schema: T): RequestHandler =>
  (req, _res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) return next(result.error);
    req.body = result.data as z.infer<T>;
    next();
  };
