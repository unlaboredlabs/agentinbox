// The wizard's steps and their done/todo state as a pure function of the server's SetupState and this
// browser's draft, so it can be tested directly. No React and relative imports only (no @ aliases):
// vitest and the server/test typecheck load this module too.

import type { GoogleAppType, SetupState } from "../../../shared/types.ts";
import { PROJECT_ID_RE } from "../../lib/gcp-project.ts";

/**
 * Wizard answers the server can't store yet: the Google client endpoint only accepts the project id
 * and app type together with the OAuth client, so those are kept here (per browser) until step 4
 * saves everything. Also remembers acknowledgements like "public URL confirmed".
 */
export interface SetupDraft {
  urlConfirmed?: boolean;
  /** "new" (default): a dedicated project created for agentinbox; "existing": reuse one (advanced). */
  projectMode?: "new" | "existing";
  /** Pre-generated ID for the new project (agentinbox-123456), editable. Kept so the command stays the same. */
  newProjectId?: string;
  /** The ID typed for an existing project. */
  existingProjectId?: string;
  /** How the new project gets created: one Cloud Shell command, or clicks in the console. */
  projectMethod?: "shell" | "console";
  /** Create the new project inside the user's Google Workspace organization (needed for Internal). */
  projectInOrg?: boolean;
  /** The project the later steps use, set when step 2 is confirmed. */
  projectId?: string;
  projectConfirmed?: boolean;
  appType?: GoogleAppType;
  productionConfirmed?: boolean;
  pubsubSkipped?: boolean;
  /**
   * Set when this browser first opens "Check that it works" before it is done. From then on only
   * this browser's own result (verified) completes that step, not the server's weaker evidence.
   */
  verifyStarted?: boolean;
  /** Set by the "Check that it works" step: "Finish setup" (every check green) or "Finish without checking". */
  verified?: boolean;
}

export const STEP_IDS = ["url", "project", "consent", "client", "accounts", "pubsub", "agent", "verify"] as const;
export type StepId = (typeof STEP_IDS)[number];
export type StepStatus = "done" | "skipped" | "todo";

export const STEP_META: Record<StepId, { title: string; short: string; optional?: boolean }> = {
  url: { title: "Choose the address of agentinbox", short: "Address" },
  project: { title: "Create a Google Cloud project", short: "Google Cloud project" },
  consent: { title: "Set up the Google sign-in screen", short: "Sign-in screen" },
  client: { title: "Create the OAuth client", short: "OAuth client" },
  accounts: { title: "Connect Gmail accounts", short: "Gmail accounts" },
  pubsub: { title: "Set up real-time delivery", short: "Real-time delivery", optional: true },
  agent: { title: "Connect your first agent", short: "First agent" },
  verify: { title: "Check that it works", short: "Check it works" },
};

export function stepStatuses(state: SetupState | undefined, draft: SetupDraft): Record<StepId, StepStatus> {
  const s = state;
  const clientDone = !!s?.googleClientConfigured;
  const accountsDone = (s?.accountsConnected ?? 0) > 0;
  const pubsubReady = s?.pubsub.mode === "pubsub" && !!s.pubsub.subscription;
  return {
    url: draft.urlConfirmed || clientDone || accountsDone ? "done" : "todo",
    project: s?.gcpProjectId || (draft.projectConfirmed && draft.projectId && PROJECT_ID_RE.test(draft.projectId)) ? "done" : "todo",
    consent:
      s?.googleAppType || (draft.appType && (draft.appType === "internal" || draft.productionConfirmed)) ? "done" : "todo",
    client: clientDone ? "done" : "todo",
    accounts: accountsDone ? "done" : "todo",
    pubsub: pubsubReady ? "done" : draft.pubsubSkipped ? "skipped" : "todo",
    agent: (s?.agentsCreated ?? 0) > 0 ? "done" : "todo",
    // Started here but not finished: stay todo (the server's evidence turns up long before the test email).
    verify: draft.verified || (!draft.verifyStarted && s?.verified) ? "done" : "todo",
  };
}

/** Setup counts as done once every step is (Pub/Sub is optional). */
export function allStepsDone(statuses: Record<StepId, StepStatus>): boolean {
  return STEP_IDS.every((id) => statuses[id] !== "todo" || STEP_META[id].optional);
}
