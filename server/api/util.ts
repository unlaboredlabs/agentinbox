import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AuditInput } from "../audit.ts";
import type { AgentPrincipal } from "../policy/types.ts";
import { badRequest } from "../util/errors.ts";

/**
 * Hono environment for every router. `admin` is set by the console auth middleware (server/app.ts)
 * for /api/* routes; `agent` is set by the MCP bearer auth.
 */
export type AppEnv = { Variables: { admin?: true; agent?: AgentPrincipal } };

/**
 * Console API routers are `(ctx) => Hono<AppEnv>` factories with paths relative to /api
 * (e.g. "/accounts/:id"). server/app.ts mounts them behind the admin auth middleware and turns
 * thrown HttpError / PolicyDenied into ApiError JSON responses.
 */
export const router = () => new Hono<AppEnv>();

/** Parses and validates a JSON body; throws HttpError(400) with a readable message. */
export async function readBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    const text = await c.req.text();
    raw = text ? JSON.parse(text) : {};
  } catch {
    throw badRequest("Request body must be valid JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw badRequest(z.prettifyError(parsed.error));
  return parsed.data;
}

/** Audit fields for console (admin) actions: spread into ctx.audit.record. */
export const ADMIN_ACTOR: Pick<AuditInput, "actorType" | "actorId"> = { actorType: "admin", actorId: null };
