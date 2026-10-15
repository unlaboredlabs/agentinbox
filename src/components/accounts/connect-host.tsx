import type { Account, ConnectAccountResponse } from "@shared/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CheckCircle2Icon, ExternalLinkIcon, InfoIcon, RotateCwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ErrorAlert } from "@/components/common";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";
import { keys, queries } from "@/lib/queries";
import { useStreamListener } from "@/lib/stream";
import { PasteCallback } from "./paste-callback";
import { UnverifiedTip } from "./unverified-tip";

interface ConnectRequest {
  /** Reconnect an existing account (needs_reauth) instead of adding a new one. */
  reauthAccountId?: string;
  email?: string;
  /** Extra Google access to request incrementally, e.g. ["pubsub"] for provisioning. */
  scopes?: string[];
  /** Called once the account is connected (e.g. to retry what needed the extra access). */
  onDone?: () => void;
}

type Phase =
  | { kind: "starting" }
  | { kind: "waiting"; res: ConnectAccountResponse; popup: Window | null; closed: boolean }
  | { kind: "done"; email: string }
  | { kind: "error"; error: unknown }
  | { kind: "not-configured" };

/** Message the /oauth/callback page posts to its opener. */
interface OAuthMessage {
  type: "agentinbox:oauth";
  ok: boolean;
  email?: string;
  error?: string;
}

const isOAuthMessage = (d: unknown): d is OAuthMessage =>
  !!d && typeof d === "object" && (d as { type?: unknown }).type === "agentinbox:oauth";

// The mounted host registers its starter here so any button can begin the flow synchronously
// inside its click handler (pop-up blockers only allow window.open during a user gesture).
let starter: ((req: ConnectRequest) => void) | null = null;

export function connectAccount(req: ConnectRequest = {}) {
  starter?.(req);
}

function openPopup(): Window | null {
  const w = 520;
  const h = 700;
  const left = Math.max(0, window.screenX + (window.outerWidth - w) / 2);
  const top = Math.max(0, window.screenY + (window.outerHeight - h) / 2);
  const popup = window.open("", "agentinbox-oauth", `popup,width=${w},height=${h},left=${left},top=${top}`);
  try {
    popup?.document.write(
      '<title>Connecting…</title><body style="font:14px system-ui;display:grid;place-items:center;height:90vh;color:#666">Opening Google sign-in…</body>',
    );
  } catch {
    /* ignore */
  }
  return popup;
}

export function ConnectAccountHost() {
  const qc = useQueryClient();
  const client = useQuery(queries.googleClient());
  const [phase, setPhase] = useState<Phase | null>(null);
  const [req, setReq] = useState<ConnectRequest>({});
  const known = useRef<Set<string>>(new Set());

  const reqRef = useRef<ConnectRequest>({});
  const reauthWasActive = useRef(false);
  const finish = (email: string) => {
    const done = reqRef.current.onDone;
    reqRef.current = { ...reqRef.current, onDone: undefined };
    if (done) setTimeout(done, 0);
    setPhase((p) => {
      if (p?.kind === "waiting") p.popup?.close();
      return { kind: "done", email };
    });
    void qc.invalidateQueries({ queryKey: keys.accounts });
    void qc.invalidateQueries({ queryKey: keys.setupState });
    void qc.invalidateQueries({ queryKey: keys.overview });
  };
  const finishRef = useRef(finish);
  // Only react to OAuth results while a connect flow is running in this tab.
  const activeRef = useRef(false);
  const redirectOrigin = useRef<string | null>(null);
  useEffect(() => {
    finishRef.current = finish;
    activeRef.current = phase?.kind === "starting" || phase?.kind === "waiting";
    try {
      redirectOrigin.current = client.data ? new URL(client.data.redirectUri).origin : null;
    } catch {
      redirectOrigin.current = null;
    }
  });

  const start = async (r: ConnectRequest) => {
    setReq(r);
    reqRef.current = r;
    const cached = client.data;
    // Paste mode uses a plain link (the user needs a full address bar); otherwise open the pop-up now.
    const popup = cached?.callbackMode === "paste" ? null : openPopup();
    setPhase({ kind: "starting" });
    const view = cached ?? (await qc.fetchQuery(queries.googleClient()).catch(() => undefined));
    if (view && (!view.clientId || !view.hasSecret)) {
      popup?.close();
      setPhase({ kind: "not-configured" });
      return;
    }
    const accounts = qc.getQueryData<Account[]>(keys.accounts) ?? (await qc.fetchQuery(queries.accounts()).catch(() => []));
    known.current = new Set(accounts.map((a) => a.id));
    // Reconnecting an account that is still active: its routine updates on the stream prove nothing.
    reauthWasActive.current = !!r.reauthAccountId && accounts.some((a) => a.id === r.reauthAccountId && a.status === "active");
    try {
      const res = await api<ConnectAccountResponse>("/api/accounts/connect", {
        body: { ...(r.reauthAccountId ? { reauthAccountId: r.reauthAccountId } : {}), ...(r.scopes?.length ? { scopes: r.scopes } : {}) },
      });
      if (popup && res.callbackMode === "direct") popup.location.href = res.authUrl;
      else popup?.close();
      setPhase({ kind: "waiting", res, popup: res.callbackMode === "direct" ? popup : null, closed: false });
    } catch (err) {
      popup?.close();
      setPhase({ kind: "error", error: err });
    }
  };

  const startRef = useRef(start);
  useEffect(() => {
    startRef.current = start;
  });
  useEffect(() => {
    starter = (r) => void startRef.current(r);
    return () => {
      starter = null;
    };
  }, []);

  // The callback page posts back to its opener (direct mode), or via BroadcastChannel when the opener was severed.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!isOAuthMessage(e.data) || !activeRef.current) return;
      // window.postMessage carries an origin (BroadcastChannel is same-origin by construction).
      if (e.origin && e.origin !== window.location.origin && e.origin !== redirectOrigin.current) return;
      if (e.data.ok) finishRef.current(e.data.email ?? "Your account");
      else setPhase({ kind: "error", error: new Error(e.data.error ?? "Google sign-in failed") });
    };
    window.addEventListener("message", onMessage);
    const channel = "BroadcastChannel" in window ? new BroadcastChannel("agentinbox-oauth") : undefined;
    if (channel) channel.onmessage = onMessage;
    return () => {
      window.removeEventListener("message", onMessage);
      channel?.close();
    };
  }, []);

  // Fallback signal: the server announces the new or repaired account on the live stream.
  useStreamListener((m) => {
    if (m.kind !== "account" || (phase?.kind !== "waiting" && phase?.kind !== "starting")) return;
    const a = m.data;
    const reauth = req.reauthAccountId;
    if (reauth ? !reauthWasActive.current && a.id === reauth && a.status === "active" : !known.current.has(a.id)) finish(a.email);
  });

  // Notice when the popup goes away. Google's pages can sever window.opener, which also makes
  // `closed` read true early, so this only softens the message instead of failing the flow.
  const popup = phase?.kind === "waiting" ? phase.popup : null;
  useEffect(() => {
    if (!popup) return;
    const id = setInterval(() => {
      if (popup.closed) {
        clearInterval(id);
        setPhase((p) => (p?.kind === "waiting" ? { ...p, closed: true } : p));
      }
    }, 600);
    return () => clearInterval(id);
  }, [popup]);

  const checkAgain = async () => {
    const accounts = await qc.fetchQuery({ ...queries.accounts(), staleTime: 0 });
    const reauth = req.reauthAccountId;
    const found = accounts.find((a) => (reauth ? a.id === reauth && a.status === "active" : !known.current.has(a.id)));
    if (found) finish(found.email);
    else toast.info("No new account yet", { description: "Finish signing in with Google, or start again." });
  };

  const close = () => {
    if (phase?.kind === "waiting") phase.popup?.close();
    setPhase(null);
  };

  const retry = () => void start(req);
  const reauthEmail = req.email;

  return (
    <Dialog open={!!phase} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {req.scopes?.includes("pubsub") ? `Grant Pub/Sub access${req.email ? ` for ${req.email}` : ""}` : reauthEmail ? `Reconnect ${reauthEmail}` : "Connect a Gmail account"}
          </DialogTitle>
          <DialogDescription>
            {phase?.kind === "waiting" && phase.res.callbackMode === "paste"
              ? "Sign in with Google in a new tab, then paste back the address you land on."
              : req.scopes?.includes("pubsub")
                ? `Sign in as ${req.email ?? "the account agentinbox provisions Pub/Sub with"} (another account won't work) and allow Pub/Sub access. It must be an Owner or Pub/Sub Admin of ${client.data?.projectId ?? "the Google Cloud project"}. agentinbox only uses it for its own topic and subscription.`
                : "Sign in with Google and allow agentinbox to manage the mailbox."}
          </DialogDescription>
        </DialogHeader>

        {phase?.kind === "starting" && (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Spinner /> Preparing Google sign-in…
          </div>
        )}

        {phase?.kind === "not-configured" && (
          <Alert variant="warning">
            <InfoIcon />
            <AlertTitle>Set up the Google OAuth client first</AlertTitle>
            <AlertDescription>
              agentinbox signs in to Gmail with your own Google OAuth client. Add its client ID and secret, then come back here.
            </AlertDescription>
          </Alert>
        )}

        {phase?.kind === "error" && <ErrorAlert error={phase.error} title="Couldn't connect the account" />}

        {phase?.kind === "done" && (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <CheckCircle2Icon className="size-10 text-success" />
            {req.scopes?.includes("pubsub") ? (
              <>
                <div className="font-medium">Pub/Sub access granted</div>
                <p className="text-sm text-muted-foreground">Finishing real-time setup with {phase.email}…</p>
              </>
            ) : (
              <>
                <div className="font-medium">{phase.email} is connected</div>
                <p className="text-sm text-muted-foreground">Mail starts syncing now. Give agents access from the Agents page.</p>
              </>
            )}
          </div>
        )}

        {phase?.kind === "waiting" && phase.res.callbackMode === "direct" && (
          <div className="space-y-4">
            <div className="flex items-start gap-3 rounded-lg border bg-muted/40 p-3 text-sm">
              <Spinner className="mt-0.5" />
              <div className="space-y-1">
                <div className="font-medium">{phase.closed ? "Finished in the other window?" : "Waiting for Google…"}</div>
                <p className="text-muted-foreground">
                  {phase.closed
                    ? "If you approved access, this updates automatically in a moment. If you closed the window early, open sign-in again."
                    : !phase.popup
                      ? "Your browser blocked the pop-up. Open sign-in with the button below."
                      : "Complete sign-in in the pop-up window. This dialog updates on its own when you're done."}
                </p>
              </div>
            </div>
            <UnverifiedTip />
          </div>
        )}

        {phase?.kind === "waiting" && phase.res.callbackMode === "paste" && (
          <PasteCallback res={phase.res} onConnected={(a) => finish(a.email)} />
        )}

        <DialogFooter>
          {phase?.kind === "not-configured" && (
            <Button asChild onClick={close}>
              <Link to="/get-started" search={{ step: "client" }}>
                Set up OAuth client
              </Link>
            </Button>
          )}
          {phase?.kind === "error" && (
            <Button onClick={retry}>
              <RotateCwIcon /> Try again
            </Button>
          )}
          {phase?.kind === "waiting" && phase.res.callbackMode === "direct" && (
            <>
              <Button variant="ghost" onClick={checkAgain}>
                I'm done, check again
              </Button>
              <Button variant="outline" asChild>
                <a href={phase.res.authUrl} target="agentinbox-oauth" rel="opener">
                  <ExternalLinkIcon /> Open sign-in again
                </a>
              </Button>
            </>
          )}
          {phase?.kind === "done" && (
            <>
              {!reauthEmail && !req.scopes?.length && (
                <Button variant="outline" onClick={() => connectAccount()}>
                  Connect another
                </Button>
              )}
              <Button onClick={close}>Done</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
