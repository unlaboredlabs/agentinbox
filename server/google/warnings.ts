import type { SetupWarning } from "../../shared/types.ts";
import type { AppContext } from "../context.ts";
import { type AccountRow, allRows } from "./accounts.ts";
import { redirectWarning } from "./client.ts";

type Ctx = Pick<AppContext, "db" | "settings" | "config" | "crypto">;

const SEVERITY_ORDER: Record<SetupWarning["severity"], number> = { error: 0, warning: 1, info: 2 };

/** "2026-10-22 17:05 UTC" */
const formatDate = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

const CONSUMER_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/**
 * Personal Gmail account? workspace_domain is '' when the id_token said so; accounts connected before
 * it was recorded (NULL) fall back to the address (only @gmail.com/@googlemail.com are certain).
 */
function isPersonal(row: AccountRow): boolean | null {
  if (row.workspace_domain !== null) return row.workspace_domain === "";
  return CONSUMER_DOMAINS.has(row.email.split("@")[1]?.toLowerCase() ?? "") ? true : null;
}

/** Everything that looks wrong or risky about the setup; see SetupWarning in shared/types.ts. */
export function setupWarnings(ctx: Ctx): SetupWarning[] {
  const out: SetupWarning[] = [];
  const client = ctx.settings.getState("google.client");
  const project = client?.projectId ? `?project=${encodeURIComponent(client.projectId)}` : "";
  const audienceUrl = `https://console.cloud.google.com/auth/audience${project}`;
  const rows = allRows(ctx);

  const redirect = redirectWarning(ctx);
  if (redirect) out.push(redirect);

  for (const row of rows) {
    if (row.status === "needs_reauth") {
      out.push({
        code: "needs_reauth",
        severity: "error",
        message: `${row.email} is disconnected: Google rejected its saved sign-in, so agentinbox can't read or send its mail.`,
        hint:
          `Accounts → ${row.email} → Reconnect, and sign in as ${row.email}.` +
          (row.refresh_expires_at ? " Publish the OAuth app first (see the Testing warning), or the new sign-in expires again in 7 days." : ""),
        accountId: row.id,
      });
    }
  }

  for (const row of rows) {
    if (!row.refresh_expires_at) continue;
    const expired = Date.parse(row.refresh_expires_at) <= Date.now();
    out.push({
      code: "testing_mode",
      severity: expired || Date.parse(row.refresh_expires_at) - Date.now() < 24 * 3_600_000 ? "error" : "warning",
      message:
        `Your OAuth app is in Testing, so Google ${expired ? "expired" : "will expire"} the sign-in for ${row.email} on ` +
        `${formatDate(row.refresh_expires_at)} (7 days after it connected).`,
      hint: "Google Cloud → Google Auth Platform → Audience → Publish app → Confirm. Then reconnect the account so it gets a long-lived token.",
      url: audienceUrl,
      accountId: row.id,
    });
  }

  if (client?.appType === "internal") {
    for (const row of rows) {
      if (isPersonal(row) !== true) continue;
      out.push({
        code: "app_type_mismatch",
        severity: "warning",
        message:
          `${row.email} is a personal Gmail account, but the app type is set to Internal here. ` +
          "Internal apps only accept accounts from their own Workspace organization, so your app in Google Cloud is actually External.",
        hint:
          "Set the app type to External in the setup wizard's Google step, and make sure the app is published " +
          "(Google Cloud → Google Auth Platform → Audience → Publish app) so sign-ins don't expire after 7 days.",
        url: audienceUrl,
        accountId: row.id,
      });
    }
  } else if (client?.appType === "external" && rows.length) {
    const domains = new Set(rows.map((r) => r.workspace_domain));
    const [domain] = domains;
    if (domains.size === 1 && domain) {
      out.push({
        code: "app_type_mismatch",
        severity: "info",
        message: `Every connected account is in the ${domain} Google Workspace, but the OAuth app is External.`,
        hint:
          `That works. If you'll only ever connect ${domain} accounts, an Internal app is simpler: no 7-day Testing expiry and no Google verification. ` +
          "Google Cloud → Google Auth Platform → Audience → Make internal, then set the app type to Internal in the setup wizard.",
        url: audienceUrl,
      });
    }
  }

  if (ctx.settings.get().ingestMode === "pubsub") {
    const error = ctx.settings.getState("pubsub")?.lastError;
    if (error) {
      out.push({
        code: "pubsub_failing",
        severity: "error",
        message: "Pub/Sub notifications are failing, so new mail may arrive late or not at all.",
        hint: `${error} Or switch Settings → Ingest mode to Polling, which needs no Pub/Sub.`,
      });
    }
  }

  return out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}
