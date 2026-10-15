import type { AppContext } from "../context.ts";
import { stubService } from "../util/stub.ts";
import type { PolicyService } from "./types.ts";

// PLACEHOLDER: replaced by the owning work area.
export function createPolicyService(_ctx: AppContext): PolicyService {
  return stubService<PolicyService>("policy");
}
