import type { AppContext } from "../context.ts";
import { stubService } from "../util/stub.ts";
import type { AccountsService, GoogleService } from "./types.ts";

// PLACEHOLDER: replaced by the owning work area.
export function createGoogleService(_ctx: AppContext): GoogleService {
  return stubService<GoogleService>("google");
}

// PLACEHOLDER: replaced by the owning work area.
export function createAccountsService(_ctx: AppContext): AccountsService {
  return stubService<AccountsService>("accounts");
}
