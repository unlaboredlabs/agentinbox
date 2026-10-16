import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2Icon, ExternalLinkIcon, RotateCwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ErrorAlert } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError } from "@/lib/api";
import { type ConnectionAttempt, type ConnectionAuthorize, type ConnectionView, keys } from "@/lib/queries";
import { oauthMessageFor, pastedProblem } from "./connection-flow";

export interface AuthRequest {
  /** What's being connected ("Notion"), for the dialog. */
  name: string;
  /**
   * Creates the connection or starts its reconnect. Returns the sign-in to run, or null when none is needed
   * (header and open servers). Called after the pop-up opens, inside the same click.
   */
  run: () => Promise<{ connection: ConnectionView; authorize: ConnectionAuthorize | null }>;
  onDone?: (c: ConnectionView) => void;
}

type Phase =
  | { kind: "starting" }
  | { kind: "waiting"; connection: ConnectionView; auth: ConnectionAuthorize; popup: Window | null }
  | { kind: "done"; connection: ConnectionView }
  | { kind: "error"; error: unknown };

// The mounted host registers its starter so any button can begin the flow inside its click handler
// (pop-up blockers only allow window.open during a user gesture), as connectAccount does for Google.
let starter: ((r: AuthRequest) => void) | null = null;

/** Runs a connection's create/reconnect and, for OAuth, the upstream sign-in in a pop-up (or paste mode). */
export function connectConnection(r: AuthRequest) {
  starter?.(r);
}

function openPopup(name: string): Window | null {
  const w = 520;
  const h = 700;
  const left = Math.max(0, window.screenX + (window.outerWidth - w) / 2);
  const top = Math.max(0, window.screenY + (window.outerHeight - h) / 2);
  const popup = window.open("", "agentinbox-connection-oauth", `popup,width=${w},height=${h},left=${left},top=${top}`);
  try {
    const doc = popup?.document;
    if (doc) {
      doc.title = "Connecting…";
      doc.body.style.cssText = "font:14px system-ui;display:grid;place-items:center;height:90vh;color:#666";
      doc.body.textContent = `Opening ${name} sign-in…`;
    }
  } catch {
    /* ignore */
  }
  return popup;
}

/** The upstream sign-in dialog. Mounted once in the app layout (and on the wizard), like ConnectAccountHost. */
export function ConnectionAuthHost() {
  const qc = useQueryClient();
  const [phase, setPhase] = useState<Phase | null>(null);
  const [req, setReq] = useState<AuthRequest | null>(null);
  const phaseRef = useRef<Phase | null>(null);
  const reqRef = useRef<AuthRequest | null>(null);
  useEffect(() => {
    phaseRef.current = phase;
    reqRef.current = req;
  });

  const refresh = () => {
    for (const k of [keys.connections, keys.setupState, keys.overview]) void qc.invalidateQueries({ queryKey: k });
    void qc.invalidateQueries({ queryKey: ["agent-connections"] });
  };

  const finish = (c: ConnectionView) => {
    setPhase((p) => {
      if (p?.kind === "waiting") p.popup?.close();
      return { kind: "done", connection: c };
    });
    refresh();
    const done = reqRef.current?.onDone;
    if (done) setTimeout(() => done(c), 0);
  };
  const fail = (error: unknown) => {
    setPhase((p) => {
      if (p?.kind === "waiting") p.popup?.close();
      return { kind: "error", error };
    });
    refresh();
  };
  const finishRef = useRef(finish);
  const failRef = useRef(fail);
  useEffect(() => {
    finishRef.current = finish;
    failRef.current = fail;
  });

  const start = async (r: AuthRequest) => {
    setReq(r);
    reqRef.current = r;
    // Opened now, in the click; closed again if no sign-in is needed or the server wants paste mode.
    const popup = openPopup(r.name);
    setPhase({ kind: "starting" });
    try {
      const res = await r.run();
      if (!res.authorize) {
        popup?.close();
        return finish(res.connection);
      }
      if (popup && res.authorize.callbackMode === "direct") popup.location.href = res.authorize.authUrl;
      else popup?.close();
      setPhase({ kind: "waiting", connection: res.connection, auth: res.authorize, popup: res.authorize.callbackMode === "direct" ? popup : null });
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

  /** Asks the server how this sign-in ended (the callback's message can miss this tab). */
  const ask = async () => {
    const p = phaseRef.current;
    if (p?.kind !== "waiting") return;
    let r: ConnectionAttempt;
    try {
      r = await api<ConnectionAttempt>("/api/connections/oauth/status", { body: { state: p.auth.state } });
    } catch {
      return;
    }
    const now = phaseRef.current;
    if (now?.kind !== "waiting" || now.auth.state !== p.auth.state) return;
    if (r.status === "connected") {
      const c = await api<ConnectionView>(`/api/connections/${encodeURIComponent(p.connection.id)}`).catch(() => p.connection);
      finishRef.current(c);
    } else if (r.status === "failed") failRef.current(new ApiError(400, r.code, r.error, r.hint ?? undefined));
  };
  const askRef = useRef(ask);
  useEffect(() => {
    askRef.current = ask;
  });

  // The callback page posts to its opener, or on BroadcastChannel when the opener was severed.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const p = phaseRef.current;
      if (p?.kind !== "waiting") return;
      if (e.origin && e.origin !== window.location.origin) return;
      const m = oauthMessageFor(e.data, p.connection.id);
      if (!m) return;
      if (m.ok) void askRef.current().then(() => phaseRef.current?.kind === "waiting" && finishRef.current(p.connection));
      else failRef.current(new ApiError(400, m.code, m.error, m.hint ?? undefined));
    };
    window.addEventListener("message", onMessage);
    const channel = "BroadcastChannel" in window ? new BroadcastChannel("agentinbox-oauth") : undefined;
    if (channel) channel.onmessage = onMessage;
    return () => {
      window.removeEventListener("message", onMessage);
      channel?.close();
    };
  }, []);

  // Coming back to this tab, or the pop-up closing, is a good moment to look.
  const waiting = phase?.kind === "waiting" ? phase : null;
  const popup = waiting?.popup ?? null;
  const waitingState = waiting?.auth.state ?? null;
  useEffect(() => {
    if (!waitingState) return;
    const onFocus = () => void askRef.current();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [waitingState]);
  useEffect(() => {
    if (!popup) return;
    const id = setInterval(() => {
      if (popup.closed) {
        clearInterval(id);
        void askRef.current();
      }
    }, 600);
    return () => clearInterval(id);
  }, [popup]);

  const close = () => {
    if (phase?.kind === "waiting") phase.popup?.close();
    setPhase(null);
  };
  const name = phase?.kind === "done" ? phase.connection.name : (req?.name ?? "the server");

  return (
    <Dialog open={!!phase} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{phase?.kind === "done" ? `${name} is connected` : phase?.kind === "error" ? `Couldn't connect ${name}` : `Connecting ${name}`}</DialogTitle>
          <DialogDescription>
            {phase?.kind === "done"
              ? "Agents with access see its tools on their next request."
              : phase?.kind === "waiting" && phase.auth.callbackMode === "paste"
                ? "Sign in in a new tab, then paste the address you land on."
                : phase?.kind === "waiting"
                  ? `Finish signing in to ${name} in the window that opened.`
                  : phase?.kind === "error"
                    ? "Nothing was changed on the other side."
                    : "One moment…"}
          </DialogDescription>
        </DialogHeader>

        {phase?.kind === "starting" && (
          <div className="flex justify-center py-6">
            <Spinner className="size-6" />
          </div>
        )}
        {phase?.kind === "waiting" && phase.auth.callbackMode === "direct" && (
          <div className="space-y-3 text-sm">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Spinner /> Waiting for {name}…
            </div>
            <p className="text-muted-foreground">
              No window?{" "}
              <a href={phase.auth.authUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-foreground underline underline-offset-4">
                Open the sign-in
              </a>
              .
            </p>
          </div>
        )}
        {phase?.kind === "waiting" && phase.auth.callbackMode === "paste" && (
          <PasteConnection auth={phase.auth} name={name} onConnected={(c) => finish(c)} />
        )}
        {phase?.kind === "done" && (
          <div className="flex items-start gap-3 rounded-lg border border-success/30 bg-success/[0.06] p-3 text-sm">
            <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-success" />
            <p>
              {phase.connection.toolCount > 0
                ? `${phase.connection.toolCount} tool${phase.connection.toolCount === 1 ? "" : "s"} found and pinned.`
                : "Its tools are being listed now."}{" "}
              If a tool's definition changes later, agentinbox holds that tool until you accept the change.
            </p>
          </div>
        )}
        {phase?.kind === "error" && <ErrorAlert error={phase.error} />}

        <DialogFooter>
          {phase?.kind === "error" && req && (
            <Button variant="outline" onClick={() => void start(req)}>
              <RotateCwIcon /> Try again
            </Button>
          )}
          {phase?.kind === "waiting" && (
            <Button variant="outline" onClick={() => void ask()}>
              I'm done, check again
            </Button>
          )}
          <Button variant={phase?.kind === "done" ? "default" : "ghost"} onClick={close}>
            {phase?.kind === "done" ? "Done" : "Close"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PasteConnection({ auth, name, onConnected }: { auth: ConnectionAuthorize; name: string; onConnected: (c: ConnectionView) => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<unknown>();
  const [pending, setPending] = useState(false);
  const problem = value.trim() ? pastedProblem(value, auth.state) : null;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!value.trim() || problem) return;
    setPending(true);
    setError(undefined);
    try {
      onConnected(await api<ConnectionView>("/api/connections/oauth/paste", { body: { url: value.trim() } }));
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <Button asChild className="w-full">
        <a href={auth.authUrl} target="_blank" rel="noopener noreferrer">
          <ExternalLinkIcon /> Sign in to {name}
        </a>
      </Button>
      <Field>
        <FieldLabel htmlFor="connection-paste">Address after signing in</FieldLabel>
        <Textarea
          id="connection-paste"
          rows={3}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={`${auth.redirectUri}?code=…&state=…`}
          className="font-mono text-xs break-all"
          aria-invalid={!!problem}
        />
        <FieldDescription>The page won't load, that's expected: copy its whole address from the address bar.</FieldDescription>
        {problem && <FieldError>{problem}</FieldError>}
      </Field>
      {error !== undefined && <ErrorAlert error={error} />}
      <Button type="submit" variant="outline" className="w-full" disabled={!value.trim() || !!problem || pending}>
        {pending && <Spinner />} Finish connecting
      </Button>
    </form>
  );
}
