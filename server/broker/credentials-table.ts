// A plain CredentialStore over connection_credentials (migration 8), so the broker service can wire the policy
// runtime before the credential workstream (server/broker/credentials/*) lands. That store replaces this one in
// createBrokerService (BrokerParts.credentials); this one has no refresh logic and no single-flight.

import type { AppContext } from "../context.ts";
import { now } from "../db/index.ts";
import type { CredentialStore, StoredTokens } from "./types.ts";

interface CredRow {
  header_name_enc: string | null;
  header_value_enc: string | null;
  oauth_issuer_enc: string | null;
  oauth_client_enc: string | null;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  expires_at: string | null;
  scope: string | null;
}

export function tableCredentials(ctx: AppContext): CredentialStore {
  const { db, crypto } = ctx;
  const row = (id: string) => db.get<CredRow>("SELECT * FROM connection_credentials WHERE connection_id = ?", id);
  const dec = (v: string | null) => (v ? crypto.decrypt(v) : null);
  const enc = (v: string | null) => (v === null ? null : crypto.encrypt(v));
  const ensure = (id: string) => {
    const t = now();
    db.run("INSERT INTO connection_credentials (connection_id, created_at, updated_at) VALUES (?, ?, ?) ON CONFLICT(connection_id) DO NOTHING", id, t, t);
  };

  return {
    header(id) {
      const r = row(id);
      const name = dec(r?.header_name_enc ?? null);
      const value = dec(r?.header_value_enc ?? null);
      return name && value ? { name, value } : null;
    },
    setHeader(id, name, value) {
      ensure(id);
      db.run("UPDATE connection_credentials SET header_name_enc = ?, header_value_enc = ?, updated_at = ? WHERE connection_id = ?", enc(name), enc(value), now(), id);
    },
    tokens(id) {
      const r = row(id);
      const accessToken = dec(r?.access_token_enc ?? null);
      if (!r || !accessToken) return null;
      return { accessToken, refreshToken: dec(r.refresh_token_enc), expiresAt: r.expires_at ? Date.parse(r.expires_at) : null, scope: r.scope, issuer: dec(r.oauth_issuer_enc) };
    },
    saveTokens(id, tokens: StoredTokens, expected) {
      ensure(id);
      if (expected !== undefined && (dec(row(id)?.refresh_token_enc ?? null) ?? null) !== expected) return false;
      db.run(
        `UPDATE connection_credentials SET access_token_enc = ?, refresh_token_enc = ?, expires_at = ?, scope = ?, oauth_issuer_enc = ?, updated_at = ? WHERE connection_id = ?`,
        enc(tokens.accessToken),
        enc(tokens.refreshToken),
        tokens.expiresAt === null ? null : new Date(tokens.expiresAt).toISOString(),
        tokens.scope,
        enc(tokens.issuer),
        now(),
        id,
      );
      return true;
    },
    client(id) {
      const raw = dec(row(id)?.oauth_client_enc ?? null);
      if (!raw) return null;
      try {
        const parsed: unknown = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    },
    setClient(id, client) {
      ensure(id);
      db.run("UPDATE connection_credentials SET oauth_client_enc = ?, updated_at = ? WHERE connection_id = ?", enc(JSON.stringify(client)), now(), id);
    },
    markNeedsReauth(id, reason) {
      const { changes } = db.run("UPDATE connections SET status = 'needs_reauth', status_reason = ?, updated_at = ? WHERE id = ? AND status <> 'needs_reauth'", reason, now(), id);
      if (!changes) return;
      ctx.audit.record({ actorType: "system", action: "connection.needs_reauth", target: id, outcome: "error", reason: "needs_reauth", detail: { reason } });
      ctx.events.emit({ type: "connection.auth_failed", connectionId: id, dedupeKey: `${id}:connection.auth_failed:${Date.now()}`, detail: { reason } });
    },
    clear(id) {
      db.run("DELETE FROM connection_credentials WHERE connection_id = ?", id);
    },
  };
}
