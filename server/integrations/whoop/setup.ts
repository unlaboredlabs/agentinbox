// The guided WHOOP setup: each user registers their own app (a shared one can't work: the client secret signs
// webhooks and refreshes tokens, Sandbox caps an app at 10 members, and an app has one webhook URL).
// The plan's five steps; the app step's two copies and the two pasted values are separate SetupSteps because a step
// holds at most one copy and one input.

import type { SetupContext, SetupStep } from "../../broker/types.ts";
import { WHOOP_CREATE_APP_URL, WHOOP_DASHBOARD_URL, WHOOP_DATA_SCOPES } from "./api.ts";
import { CLIENT_ID_INPUT, CLIENT_SECRET_INPUT } from "./oauth.ts";

export function whoopSetupSteps(ctx: SetupContext): SetupStep[] {
  const scopes = WHOOP_DATA_SCOPES.map((s) => `\`${s}\``).join(", ");
  const steps: SetupStep[] = [
    {
      id: "dashboard",
      title: "Open the WHOOP Developer Dashboard",
      body: "Sign in with the same WHOOP account you wear the strap with. Your own WHOOP app is free and needs no review, because only you use it.",
      link: { label: "Open the WHOOP Developer Dashboard", url: WHOOP_DASHBOARD_URL },
    },
    {
      id: "team",
      title: "Create a team",
      body: "The dashboard asks for a team before your first app. Click Get Started, type any name (for example your own), and click Create Team. If you already have a team, skip this step.",
      link: { label: "Open the dashboard", url: WHOOP_DASHBOARD_URL },
    },
    {
      id: "app",
      title: "Create an app",
      body:
        `Click Create App. Give it any name, and tick these scopes: ${scopes}. ` +
        "In Redirect URIs, paste the address below exactly as shown. Then click Create. " +
        "If WHOOP refuses this address (for example because it isn't https), give this install an https public URL in Settings and come back: this step will then show the new address. " +
        "Without an https address, enter `https://localhost/oauth/connections/callback` instead; after you approve, your browser shows an error page, and you paste that page's full address back here.",
      link: { label: "Create an app", url: WHOOP_CREATE_APP_URL },
      copy: { label: "Redirect URI", value: ctx.redirectUri },
    },
  ];
  if (ctx.webhookUrl) {
    steps.push({
      id: "webhook",
      title: "Turn on webhooks",
      body: "On the same app, paste the address below as the Webhook URL and choose the v2 webhook model if WHOOP asks. Then save the app. New recoveries, sleeps and workouts then arrive within seconds; without this, agentinbox checks every 15 minutes.",
      copy: { label: "Webhook URL", value: ctx.webhookUrl },
    });
  }
  steps.push(
    {
      id: "client-id",
      title: "Paste the client ID",
      body: "WHOOP shows a Client ID and a Client Secret once the app exists. To see them again, open the app in the Apps list. Copy the Client ID here.",
      input: { key: CLIENT_ID_INPUT, label: "Client ID", placeholder: "Client ID from the WHOOP app", pattern: "^\\S{8,200}$" },
    },
    {
      id: "client-secret",
      title: "Paste the client secret",
      body: "Copy the Client Secret here. agentinbox stores it encrypted and never shows it again. It's checked with WHOOP right away.",
      input: { key: CLIENT_SECRET_INPUT, label: "Client Secret", secret: true, pattern: "^\\S{8,500}$" },
    },
    {
      id: "connect",
      title: "Connect and approve",
      body: "Click Connect. WHOOP asks you to sign in and approve access to your recovery, sleep, cycles, workouts, profile and body measurements. Approve everything: agentinbox only reads, and keeps the connection alive on its own.",
    },
  );
  return steps;
}
