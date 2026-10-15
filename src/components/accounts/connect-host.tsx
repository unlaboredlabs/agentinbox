import type { Account, ConnectAccountResponse, OAuthCallbackMessage } from "@shared/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { CheckCircle2Icon, ExternalLinkIcon, InfoIcon, RotateCwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CopyField, ErrorAlert } from "@/components/common";
import { Disclosure } from "@/components/setup/wizard-shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { api, ApiError } from "@/lib/api";
import { keys, queries } from "@/lib/queries";
import { useStreamListener } from "@/lib/stream";
import { PasteCallback } from "./paste-callback";
import { GoogleErrorHelp } from "./google-error-help";

interface ConnectRequest {
  /** Reconnect an existing account (needs_reauth) instead of adding a new one. */
  reauthAccountId?: string;
  email?: string;
  /** Extra Google access to request incrementally, e.g. ["pubsub"] for provisioning. */
  scopes?: string[];
  /** Called once the account is connected (e.g. to retry what needed the extra access). */
  /**
   * `confirmed`: Google's callback (or the pasted address) reported success. False when the user only
   * clicked "I'm done, check again", so the caller re-checks without assuming anything was granted.
   */
  onDone?: (confirmed: boolean) => void;
}

type Phase =
  | { kind: "starting" }
  | { kind: "waiting"; res: ConnectAccountResponse; popup: Window | null; closed: boolean }
  | { kind: "done"; email: string }
  | { kind: "error"; error: unknown }
  | { kind: "not-configured" };

const isOAuthMessage = (d: unknown): d is Partial<OAuthCallbackMessage> & { type: "agentinbox:oauth" } =>
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
  const [checkNote, setCheckNote] = useState<string | null>(null);
  const inWizard = useRouterState({ select: (st) => st.location.pathname === "/get-started" });
  const navigate = useNavigate();
  const primaryRef = useRef<HTMLButtonElement>(null);
  const [req, setReq] = useState<ConnectRequest>({});
  const known = useRef<Set<string>>(new Set());

  const reqRef = useRef<ConnectRequest>({});
  /** Reconnecting an account that was in needs_reauth: only then does "active again" prove the new sign-in landed. */
  const reauthFromBroken = useRef(false);
  const finish = (email: string, confirmed = true) => {
    const done = reqRef.current.onDone;
    reqRef.current = { ...reqRef.current, onDone: undefined };
    if (done) setTimeout(() => done(confirmed), 0);
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
    setCheckNote(null);
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
    // For active, paused or erroring accounts a status change proves nothing (resume, a recovered sync…):
    // those reconnects finish only on the callback page's own result.
    reauthFromBroken.current = !!r.reauthAccountId && accounts.some((a) => a.id === r.reauthAccountId && a.status === "needs_reauth");
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
      else
        setPhase({
          kind: "error",
          error: new ApiError(400, e.data.code ?? "oauth_error", e.data.error ?? "Google sign-in failed", e.data.hint ?? undefined),
        });
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
    if (reauth ? reauthFromBroken.current && a.id === reauth && a.status === "active" : !known.current.has(a.id)) finish(a.email);
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
    setCheckNote(null);
    // Extra access (Pub/Sub): the retry it was asked for is the real check, and it says if the box wasn't ticked.
    if (req.scopes?.length) {
      finish(req.email ?? "Your account", false);
      return;
    }
    const accounts = await qc.fetchQuery({ ...queries.accounts(), staleTime: 0 });
    const reauth = req.reauthAccountId;
    if (reauth && !reauthFromBroken.current) {
      setCheckNote("This account was already connected, so there's nothing new to detect from here. If Google's window said it worked, close this dialog.");
      return;
    }
    const found = accounts.find((a) => (reauth ? a.id === reauth && a.status === "active" : !known.current.has(a.id)));
    if (found) finish(found.email);
    else setCheckNote("No new account yet. Finish signing in with Google, or use the paste option below if the window ended on an error page.");
  };

  const close = () => {
    if (phase?.kind === "waiting") phase.popup?.close();
    setPhase(null);
  };

  const retry = () => void start(req);
  const reauthEmail = req.email;

  const pubsub = !!req.scopes?.includes("pubsub");
  const continueSetup = () => {
    close();
    void navigate({ to: "/get-started", search: { step: "pubsub" } });
  };

  // Put focus on the button that moves things forward whenever the dialog changes state (not on X).
  const kind = phase?.kind;
  useEffect(() => {
    if (kind === "done" || kind === "error" || kind === "not-configured") requestAnimationFrame(() => primaryRef.current?.focus());
  }, [kind]);

  const code = phase?.kind === "error" && phase.error instanceof ApiError ? phase.error.code : undefined;
  const clientProblem = code === "oauth_invalid_client" || code === "oauth_unauthorized_client" || code === "oauth_redirect_uri_mismatch" || code === "google_client_missing";

  return (
    <Dialog open={!!phase} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {pubsub ? `Grant Pub/Sub access${req.email ? ` for ${req.email}` : ""}` : reauthEmail ? `Reconnect ${reauthEmail}` : "Connect a Gmail account"}
          </DialogTitle>
          <DialogDescription>
            {phase?.kind === "waiting" && phase.res.callbackMode === "paste"
              ? "Sign in with Google in a new tab, then paste back the address you land on."
              : pubsub
                ? `Sign in as ${req.email ?? "the account agentinbox sets up Pub/Sub with"} (another account won't work) and tick the Pub/Sub box. agentinbox only uses it for its own topic and subscription in ${client.data?.projectId ?? "your project"}.`
                : reauthEmail
                  ? `Sign in as ${reauthEmail} and allow access again.`
                  : "Sign in with Google and allow agentinbox to manage the mailbox."}
          </DialogDescription>
        </DialogHeader>

        {phase?.kind === "starting" && (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground" role="status">
            <Spinner /> Preparing Google sign-in…
          </div>
        )}

        {phase?.kind === "not-configured" && (
          <Alert variant="warning">
            <InfoIcon />
            <AlertTitle>Set up the Google OAuth client first</AlertTitle>
            <AlertDescription>
              agentinbox signs in to Gmail through your own Google OAuth client. Import its JSON (step 4 of Get started), then come back here.
            </AlertDescription>
          </Alert>
        )}

        {phase?.kind === "error" && (
          <div className="space-y-3">
            <ErrorAlert
              error={phase.error}
              title={
                code === "oauth_access_denied"
                  ? "Sign-in was cancelled"
                  : code === "oauth_wrong_account"
                    ? "Signed in with a different Google account"
                    : "Couldn't connect the account"
              }
            />
            {code === "oauth_redirect_uri_mismatch" && client.data && (
              <div className="space-y-1.5 text-sm">
                <p>Add this exact redirect URI to the OAuth client, save, wait a few minutes, then try again:</p>
                <CopyField value={client.data.redirectUri} label="Copy redirect URI" />
              </div>
            )}
          </div>
        )}

        {phase?.kind === "done" && (
          <div className="flex flex-col items-center gap-2 py-6 text-center" role="status">
            <CheckCircle2Icon className="size-10 text-success" />
            {pubsub ? (
              <>
                <div className="font-medium">Back from Google</div>
                <p className="text-sm text-muted-foreground">Finishing real-time setup with {phase.email}…</p>
              </>
            ) : (
              <>
                <div className="font-medium">{phase.email} is connected</div>
                <p className="text-sm text-muted-foreground">Mail starts syncing now.</p>
              </>
            )}
          </div>
        )}

        {phase?.kind === "waiting" && phase.res.callbackMode === "direct" && (
          <div className="space-y-4">
            <div className="flex items-start gap-3 rounded-lg border bg-muted/40 p-3 text-sm" role="status">
              {phase.popup && !phase.closed ? <Spinner className="mt-0.5" /> : <InfoIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
              <div className="space-y-1">
                <div className="font-medium">
                  {!phase.popup ? "Your browser blocked the sign-in window" : phase.closed ? "Closed the Google window?" : "Waiting for Google…"}
                </div>
                <p className="text-muted-foreground">
                  {!phase.popup
                    ? "Open it with the button below."
                    : phase.closed
                      ? "Open it again with the button below. If you finished signing in, this updates in a moment."
                      : "Finish signing in in the pop-up window. This updates on its own when you're done."}
                </p>
              </div>
            </div>
            {checkNote && (
              <p className="text-sm text-muted-foreground" role="status">
                {checkNote}
              </p>
            )}
            <Disclosure summary="Sign-in ended on an error or a page that can't be reached? Paste its address">
              <PasteCallback res={phase.res} onConnected={finish} compact />
            </Disclosure>
            <GoogleErrorHelp />
          </div>
        )}

        {phase?.kind === "waiting" && phase.res.callbackMode === "paste" && <PasteCallback res={phase.res} onConnected={finish} />}

        <DialogFooter>
          {phase?.kind === "not-configured" && (
            <Button asChild onClick={close}>
              <Link to="/get-started" search={{ step: "client" }} ref={primaryRef as React.Ref<HTMLAnchorElement>}>
                Set up the OAuth client
              </Link>
            </Button>
          )}
          {phase?.kind === "error" && (
            <>
              {clientProblem && (
                <Button variant="outline" asChild onClick={close}>
                  <Link to="/get-started" search={{ step: "client" }}>
                    Check the OAuth client
                  </Link>
                </Button>
              )}
              <Button onClick={retry} ref={primaryRef}>
                <RotateCwIcon /> Try again
              </Button>
            </>
          )}
          {phase?.kind === "waiting" && phase.res.callbackMode === "direct" && (
            <>
              <Button variant="ghost" onClick={checkAgain}>
                I'm done, check again
              </Button>
              <Button variant={!phase.popup || phase.closed ? "default" : "outline"} asChild>
                <a href={phase.res.authUrl} target="agentinbox-oauth" rel="opener">
                  <ExternalLinkIcon /> {!phase.popup ? "Open Google sign-in" : "Open Google sign-in again"}
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
              {inWizard && !pubsub ? (
                <Button onClick={continueSetup} ref={primaryRef}>
                  Continue setup
                </Button>
              ) : (
                <Button onClick={close} ref={primaryRef}>
                  Done
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
