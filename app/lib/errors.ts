// Error description and the JSON wrapper every API route uses.
import "server-only";
import { NextResponse } from "next/server";
import { HttpError } from "./env";
import { describeCreateosError } from "./createos";

export function describe(e: unknown): string {
  if (e instanceof HttpError) return e.message;
  if (e && typeof e === "object" && "statusCode" in e && "requestId" in e) return describeCreateosError(e);
  if (e instanceof Error) {
    const cause = (e as { cause?: { message?: string; code?: string } }).cause;
    return cause?.message ? `${e.message} (${cause.code ?? ""} ${cause.message})` : e.message;
  }
  return String(e);
}

export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { "cache-control": "no-store" } });
}

/** Run a route body; map thrown errors to `{error, detail?}` with the right status. */
export async function route(fn: () => Promise<unknown>) {
  try {
    const out = await fn();
    return out instanceof Response ? out : json(out);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status >= 500) console.error("[once/api]", e);
    return json({ error: describe(e), ...(e instanceof HttpError && e.detail !== undefined ? { detail: e.detail } : {}) }, status);
  }
}

export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  const text = await req.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, "body is not valid JSON");
  }
}
