export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, msg: string) => new AppError(400, code, msg);
export const unauthorized = (msg = "Authentication required") => new AppError(401, "UNAUTHORIZED", msg);
export const forbidden = (msg = "Not permitted") => new AppError(403, "FORBIDDEN", msg);
export const notFound = (msg = "Not found") => new AppError(404, "NOT_FOUND", msg);
export const conflict = (code: string, msg: string) => new AppError(409, code, msg);
