import type { z } from "zod";
import { ApiError } from "@/lib/errors";

export async function parseJson<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new ApiError(400, "Request body must be JSON");
  }
  return schema.parse(body);
}

export function searchParams(req: Request) {
  return new URL(req.url).searchParams;
}

export function intParam(v: string | null, def: number, min: number, max: number) {
  const n = v ? parseInt(v, 10) : def;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}
