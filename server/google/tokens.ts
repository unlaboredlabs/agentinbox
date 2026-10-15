import type { AppContext } from "../context.ts";
import { sha256 } from "../crypto.ts";
import { errorMessage, notFound } from "../util/errors.ts";
import { type AccountRow, getRow, updateRow } from "./accounts.ts";
import { clientCredentials } from "./client.ts";
import {
  backoffMs,
  buildUrl,
  googleErrorFromBody,
  hasReason,
  isAbortError,
  isRetryable,
  networkError,
  rejectedBeforeProcessing,
  REQUEST_TIMEOUT_MS,
  sleep,
} from "./http.ts";
import { AccountNeedsReauthError, GoogleApiError } from "./types.ts";

export interface TokenResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  id_token?: string;
  token_type?: string;
}

/** Refresh this long before the access token expires. */
const EARLY_REFRESH_MS = 60_000;

/**
 * POSTs a form to Google's token endpoint (30 s per attempt). Refreshes retry timeouts, network errors
 * and 5xx; the one-time authorization code exchange only retries when the request never left this
 * machine (a retried code would fail with invalid_grant anyway, hiding the real error).
 */
export async function postToken(ctx: Pick<AppContext, "config">, params: Record<string, string>): Promise<TokenResponse> {
  const url = buildUrl(ctx.config.google.oauthBase, "/token");
  const host = new URL(url).host;
  const idempotent = params.grant_type !== "authorization_code";
  for (let attempt = 0; ; attempt++) {
    let err: GoogleApiError;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await res.text();
      let body: unknown = null;
      try {
        body = JSON.parse(text);
      } catch {
        // handled below
      }
      if (res.ok && body && typeof (body as TokenResponse).access_token === "string") return body as TokenResponse;
      err = googleErrorFromBody(res.status, body, `Google's token endpoint returned HTTP ${res.status}`);
    } catch (e) {
      err = isAbortError(e)
        ? new GoogleApiError(0, `Google's token endpoint (${host}) didn't respond within ${REQUEST_TIMEOUT_MS / 1000}s`, "timeout")
        : networkError(e, host);
    }
    const retry = idempotent ? isRetryable(err) : rejectedBeforeProcessing(err);
    if (!retry || attempt >= 2) throw err;
    await sleep(backoffMs(attempt, err.details.retryAfterMs));
  }
}

/**
 * Access tokens are cached encrypted on the account row and refreshed ~60s before expiry, one refresh
 * in flight per account. A revoked/expired refresh token (`invalid_grant`) marks the account
 * `needs_reauth`, emits `account.auth_failed`, audits, and throws AccountNeedsReauthError.
 */
export class TokenManager {
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(private readonly ctx: AppContext) {}

  async accessToken(accountId: string, opts: { force?: boolean } = {}): Promise<string> {
    const row = getRow(this.ctx, accountId);
    if (!row) throw notFound("Account");
    if (row.status === "needs_reauth") throw new AccountNeedsReauthError(row.id, row.email);
    if (!opts.force && row.access_token_enc && row.access_expires_at) {
      if (Date.parse(row.access_expires_at) - EARLY_REFRESH_MS > Date.now()) return this.ctx.crypto.decrypt(row.access_token_enc);
    }
    const pending = this.inflight.get(accountId);
    if (pending) return pending;
    const p = this.refresh(row).finally(() => this.inflight.delete(accountId));
    this.inflight.set(accountId, p);
    return p;
  }

  /** Drops the cached access token (e.g. after a 401). */
  invalidate(accountId: string): void {
    this.ctx.db.run("UPDATE accounts SET access_token_enc = NULL, access_expires_at = NULL WHERE id = ?", accountId);
  }

  private async refresh(row: AccountRow): Promise<string> {
    const { clientId, clientSecret } = clientCredentials(this.ctx);
    let res: TokenResponse;
    try {
      res = await postToken(this.ctx, {
        grant_type: "refresh_token",
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: this.ctx.crypto.decrypt(row.refresh_token_enc),
      });
    } catch (err) {
      if (err instanceof GoogleApiError && err.reason === "invalid_grant") {
        // A reconnect may have stored a new refresh token while this refresh was in flight.
        const fresh = getRow(this.ctx, row.id);
        if (fresh && fresh.status !== "needs_reauth" && fresh.refresh_token_enc !== row.refresh_token_enc) return this.refresh(fresh);
        this.authFailed(row, err.message, hasReason(err, "invalid_rapt"));
      }
      if (err instanceof GoogleApiError && err.reason === "invalid_client") {
        throw new GoogleApiError(
          err.status,
          "Google rejected the OAuth client ID or secret (invalid_client). Check the client in the setup wizard.",
          err.reason,
          err.details,
        );
      }
      throw err;
    }
    const expiresAt = new Date(Date.now() + (res.expires_in ?? 3600) * 1000).toISOString();
    updateRow(this.ctx, row.id, {
      access_token_enc: this.ctx.crypto.encrypt(res.access_token),
      access_expires_at: expiresAt,
      // Google may rotate refresh tokens.
      ...(res.refresh_token ? { refresh_token_enc: this.ctx.crypto.encrypt(res.refresh_token) } : {}),
    });
    return res.access_token;
  }

  private authFailed(row: AccountRow, description: string, rapt: boolean): never {
    const error = rapt
      ? `Google requires ${row.email} to sign in again (invalid_rapt): your Workspace admin requires periodic re-authentication ` +
        "for apps using Google Cloud scopes (Google Cloud session control). Reconnect the account, or ask the admin to exempt this app."
      : `Google rejected the saved sign-in for ${row.email} (${description || "invalid_grant"}). Reconnect the account.` +
        // The 7-day expiry only happens to External apps left in Testing.
        (this.ctx.settings.getState("google.client")?.appType === "external"
          ? " If this keeps happening about every 7 days, your OAuth app is still in Testing: publish it (In production)."
          : "");
    this.ctx.log.child("google").warn("Refresh token rejected; account needs re-auth", { email: row.email });
    this.ctx.accounts.setStatus(row.id, "needs_reauth", error);
    try {
      this.ctx.events.emit({
        type: "account.auth_failed",
        accountId: row.id,
        detail: { email: row.email, error },
        dedupeKey: `${row.id}:auth_failed:${sha256(row.refresh_token_enc).slice(0, 12)}`,
      });
    } catch (err) {
      this.ctx.log.child("google").error("Could not record account.auth_failed", { error: errorMessage(err) });
    }
    this.ctx.audit.record({
      actorType: "system",
      action: "account.auth_failed",
      accountId: row.id,
      outcome: "error",
      detail: { email: row.email, error: description, ...(rapt ? { subtype: "invalid_rapt" } : {}) },
    });
    throw new AccountNeedsReauthError(row.id, row.email);
  }
}
