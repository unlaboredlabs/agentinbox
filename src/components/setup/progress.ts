import type { GoogleAppType, SetupState } from "@shared/types";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { PROJECT_ID_RE } from "@/lib/gcp-project";
import { queries } from "@/lib/queries";

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
  /**
   * The redirect URI the OAuth client was saved with (import or manual entry). When the public URL
   * changes later, the current one differs and step 4 / Settings ask to add the new URI.
   */
  clientRedirectUri?: string;
  pubsubSkipped?: boolean;
  /** Set by the "Check that it works" step once the first event reached the agent. */
  verified?: boolean;
}

// Per instance: the same browser may set up several agentinbox daemons.
const KEY = `agentinbox.setup:${typeof window === "undefined" ? "" : window.location.host}`;
const listeners = new Set<() => void>();
let cache: SetupDraft | null = null;

/** The current draft outside React (event handlers). */
export const readDraft = (): SetupDraft => read();

function read(): SetupDraft {
  if (cache) return cache;
  try {
    cache = JSON.parse(localStorage.getItem(KEY) ?? "{}") as SetupDraft;
  } catch {
    cache = {};
  }
  return cache;
}

export function updateDraft(patch: Partial<SetupDraft>) {
  cache = { ...read(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* private mode: keep in memory */
  }
  for (const l of listeners) l();
}

/** Removes answers the server now owns (once the OAuth client is saved, it stores project id and app type). */
export function clearServerOwnedDraft() {
  const d = read();
  if (d.projectId === undefined && d.appType === undefined && d.productionConfirmed === undefined && d.projectConfirmed === undefined) return;
  // projectMode stays: later steps (and Settings) still adapt their advice for a shared project.
  const { projectId: _p, appType: _a, productionConfirmed: _c, projectConfirmed: _pc, ...rest } = d;
  cache = rest;
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* ignore */
  }
  for (const l of listeners) l();
}

export function useSetupDraft(): SetupDraft {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    read,
  );
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
  pubsub: { title: "Get new mail within seconds", short: "Instant delivery", optional: true },
  agent: { title: "Connect your first agent", short: "First agent" },
  verify: { title: "Check that it works", short: "Check it works" },
};

export { generateProjectId, PROJECT_ID_RE } from "@/lib/gcp-project";

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
    verify: s?.verified || draft.verified ? "done" : "todo",
  };
}

/** Setup checklist state shared by the wizard, the overview card and the sidebar. */
export function useSetupProgress() {
  const query = useQuery(queries.setupState());
  const draft = useSetupDraft();
  const configured = !!query.data?.googleClientConfigured;
  useEffect(() => {
    if (configured) clearServerOwnedDraft();
  }, [configured]);
  const statuses = stepStatuses(query.data, draft);
  const finished = STEP_IDS.filter((id) => statuses[id] !== "todo").length;
  const firstTodo = STEP_IDS.find((id) => statuses[id] === "todo");
  // Pub/Sub is optional: setup counts as done once everything else is.
  const allDone = STEP_IDS.every((id) => statuses[id] !== "todo" || STEP_META[id].optional);
  return { query, state: query.data, draft, statuses, finished, total: STEP_IDS.length, firstTodo, allDone };
}
