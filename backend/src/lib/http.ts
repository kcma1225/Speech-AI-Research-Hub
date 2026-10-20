import { z } from "zod";

/** Throw from any handler; the error handler replies `{ error: message }` with `status`. */
export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export const badRequest = (message = "欄位內容不正確。") => new HttpError(400, message);
export const unauthorized = (message = "請重新登入。") => new HttpError(401, message);
export const forbidden = (message = "權限不足。") => new HttpError(403, message);
export const notFound = (message = "找不到資料。") => new HttpError(404, message);
export const conflict = (message: string) => new HttpError(409, message);

/** Parses input with a zod schema, throwing 400 with a user-facing message on failure. */
export function parse<T extends z.ZodType>(schema: T, input: unknown, message?: string): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw badRequest(message);
  return result.data;
}

export const uuid = z.uuid();
export const idParams = z.object({ id: z.uuid() });

/** Postgres unique_violation. */
export const isUniqueViolation = (error: unknown) => (error as { code?: string })?.code === "23505";
