import type { AppContext } from "../context.ts";
import { router } from "./util.ts";

// PLACEHOLDER: replaced by the owning work area. Mounted at the root (unauthenticated): GET /oauth/callback.
export function oauthRoutes(_ctx: AppContext) {
  return router();
}
