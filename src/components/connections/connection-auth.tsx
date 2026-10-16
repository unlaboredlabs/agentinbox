import type { ConnectionView, StartConnectResult } from "@shared/types";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2Icon, ExternalLinkIcon, RotateCwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ErrorAlert } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { keys } from "@/lib/queries";
import { oauthMessageFor, pastedProblem } from "./connection-flow";

export interface AuthRequest {
  /** What's being connected ("Notion"), for the dialog. */
  name: string;
  /**
   * Creates or prepares the connection and calls POST /api/connections/:id/connect. Runs after the pop-up opened,
   * inside the same click (pop-up blockers only allow window.open during a user gesture).
   */
  run: () => Promise<{ connectionId: string; result: StartConnectResult }>;
  onDone?: (c: ConnectionView) => void;
}

type Phase =
  | { kind: "starting" }
  | { kind: "waiting"; connectionId: string; authorizeUrl: string; popup: Window | null; baseline: string | null; paste: boolean; redirectUri: string | null }
  | { kind: "done"; connection: ConnectionView }
  | { kind: "error"; error: unknown };

let starter: ((r: AuthRequest) => void) | null = null;

/** Runs a connection's create/reconnect and, for OAuth, the upstream sign-in in a pop-up. */
export function connectConnection(r: AuthRequest) {
  starter?.(r);
}

function openPopup(name: string): Window | null {
  const w = 520;
  const h = 700;
  const left = Math.max(0, window.screenX + (window.outerWidth - w) / 2);
  const top = Math.max(0, window.screenY + (window.outerHeight - h) / 2);
  const popup = window.open("", "agentinbox-connection-oauth", `popup,width=${w},height=${h},left=${left},top=${top}`);
  // No way back to the console from the upstream's pages (reverse tabnabbing). The callback reaches us on the
  // BroadcastChannel, and the read-back on focus or close covers the rest.
  try {
    if (popup) popup.opener = null;
  } catch {
    /* ignore */
  }
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

const getConnection = (id: string) => api<ConnectionView>(`/api/connections/${encodeURIComponent(id)}`);
/** What the connection looked like before the sign-in: a change proves the sign-in landed. */
const fingerprint = (c: ConnectionView) => `${c.status}|${c.updatedAt}|${c.expiresAt ?? ""}`;

/** The upstream sign-in dialog. Mounted once in the app layout, like ConnectAccountHost. */
export function ConnectionAuthHost() {
  const qc = useQueryClient();
  const [phase, setPhase] = useState<Phase | null>(null);
  const [req, setReq] = useState<AuthRequest | null>(null);
  const [pasteFallback, setPasteFallback] = useState(false);
  const phaseRef = useRef<Phase | null>(null);
  const reqRef = useRef<AuthRequest | null>(null);
  useEffect(() => {
    phaseRef.current = phase;
    reqRef.current = req;
  });

  const refresh = () => {
    for (const k of [keys.connections, keys.setupState, keys.overview, ["agent-connections"]]) void qc.invalidateQueries({ queryKey: k });
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

  const start = async (r: AuthRequest) => {
    setReq(r);
    setPasteFallback(false);
    reqRef.current = r;
    const popup = openPopup(r.name);
    setPhase({ kind: "starting" });
    try {
      const { connectionId, result } = await r.run();
      if (result.status === "connected") {
        popup?.close();
        return finish(result.connection);
      }
      if (result.status === "error") {
        popup?.close();
        return fail(new Error(result.message));
      }
      // Paste mode: the upstream can't redirect back here (plain http off localhost). The user signs in in a tab
      // they open themselves and pastes the address it lands on (POST /api/connections/finish).
      const paste = result.callbackMode === "paste";
      if (paste) popup?.close();
      else if (popup) popup.location.href = result.authorizeUrl;
      const before = await getConnection(connectionId).catch(() => null);
      setPhase({
        kind: "waiting",
        connectionId,
        authorizeUrl: result.authorizeUrl,
        popup: paste ? null : popup,
        baseline: before ? fingerprint(before) : null,
        paste,
        redirectUri: result.redirectUri ?? null,
      });
    } catch (err) {
      popup?.close();
      fail(err);
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

  /**
   * Reads the connection back. `sure`: the callback said it finished (or the user says so): active means done,
   * anything else is the error. Otherwise (focus, pop-up closed) only a changed, active connection counts.
   */
  const check = async (sure: boolean, messageError?: string | null) => {
    const p = phaseRef.current;
    if (p?.kind !== "waiting") return;
    let c: ConnectionView;
    try {
      c = await getConnection(p.connectionId);
    } catch (err) {
      if (sure) fail(err);
      return;
    }
    const now = phaseRef.current;
    if (now?.kind !== "waiting" || now.connectionId !== p.connectionId) return;
    if (c.status === "active" && (sure || fingerprint(c) !== p.baseline)) return finish(c);
    if (sure) fail(new Error(messageError ?? c.statusReason ?? `${c.name} didn't finish connecting. Try again.`));
  };
  const checkRef = useRef(check);
  const failRef = useRef(fail);
  useEffect(() => {
    checkRef.current = check;
    failRef.current = fail;
  });

  /** Paste mode: POST /api/connections/finish with the address the sign-in landed on. */
  const finishPasted = async (url: string) => {
    const r = await api<StartConnectResult>("/api/connections/finish", { body: { url } });
    if (r.status === "connected") finish(r.connection);
    else if (r.status === "error") throw new Error(r.message);
    else throw new Error("The sign-in needs another step. Start again from Reconnect.");
  };

  // The callback page posts to its opener and on BroadcastChannel "agentinbox-oauth" (server/api/oauth.ts).
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const p = phaseRef.current;
      if (p?.kind !== "waiting") return;
      if (e.origin && e.origin !== window.location.origin) return;
      const m = oauthMessageFor(e.data, p.connectionId);
      if (!m) return;
      // A failed sign-in fails now, even while the connection still reads active (e.g. a reconnect before expiry).
      if (!m.ok) failRef.current(new Error(m.error ?? "The sign-in didn't complete. Try again."));
      else void checkRef.current(true);
    };
    window.addEventListener("message", onMessage);
    const channel = "BroadcastChannel" in window ? new BroadcastChannel("agentinbox-oauth") : undefined;
    if (channel) channel.onmessage = onMessage;
    return () => {
      window.removeEventListener("message", onMessage);
      channel?.close();
    };
  }, []);

  const waiting = phase?.kind === "waiting" ? phase : null;
  const popup = waiting?.popup ?? null;
  const waitingId = waiting?.connectionId ?? null;
  useEffect(() => {
    if (!waitingId) return;
    const onFocus = () => void checkRef.current(false);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [waitingId]);
  useEffect(() => {
    if (!popup) return;
    const id = setInterval(() => {
      if (popup.closed) {
        clearInterval(id);
        void checkRef.current(false);
      }
    }, 600);
    return () => clearInterval(id);
  }, [popup]);

  const close = () => {
    if (phase?.kind === "waiting") phase.popup?.close();
    setPhase(null);
    refresh();
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
              : phase?.kind === "waiting" && phase.paste
                ? `Sign in to ${name} in a new tab, then paste the address you land on.`
                : phase?.kind === "waiting"
                ? `Finish signing in to ${name} in the window that opened.`
                : phase?.kind === "error"
                  ? "Fix what's below, then try again."
                  : "One moment…"}
          </DialogDescription>
        </DialogHeader>

        {phase?.kind === "starting" && (
          <div className="flex justify-center py-6">
            <Spinner className="size-6" />
          </div>
        )}
        {phase?.kind === "waiting" && phase.paste && <PasteFinish authorizeUrl={phase.authorizeUrl} redirectUri={phase.redirectUri} name={name} onSubmit={finishPasted} />}
        {phase?.kind === "waiting" && !phase.paste && (
          <div className="space-y-3 text-sm">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Spinner /> Waiting for {name}…
            </div>
            <p className="text-muted-foreground">
              No window?{" "}
              <a href={phase.authorizeUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-foreground underline underline-offset-4">
                Open the sign-in
              </a>
              .
            </p>
            {/* WHOOP without an https address (and any server that can't redirect back): the browser ends on an error page. */}
            {pasteFallback ? (
              <PasteFinish authorizeUrl={phase.authorizeUrl} redirectUri={phase.redirectUri} name={name} onSubmit={finishPasted} />
            ) : (
              <Button variant="link" size="sm" className="h-auto px-0" onClick={() => setPasteFallback(true)}>
                Ended on an error page? Paste its address
              </Button>
            )}
          </div>
        )}
        {phase?.kind === "done" && (
          <div className="flex items-start gap-3 rounded-lg border border-success/30 bg-success/[0.06] p-3 text-sm">
            <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-success" />
            <p>
              {phase.connection.tools.total > 0
                ? `${phase.connection.tools.total} tool${phase.connection.tools.total === 1 ? "" : "s"} found and pinned.`
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
          {phase?.kind === "waiting" && !phase.paste && (
            <Button variant="outline" onClick={() => void check(true)}>
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

function PasteFinish({ authorizeUrl, redirectUri, name, onSubmit }: { authorizeUrl: string; redirectUri: string | null; name: string; onSubmit: (url: string) => Promise<void> }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<unknown>();
  const [pending, setPending] = useState(false);
  const problem = value.trim() ? pastedProblem(value) : null;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!value.trim() || problem) return;
    setPending(true);
    setError(undefined);
    try {
      await onSubmit(value.trim());
      setValue("");
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <Button asChild className="w-full">
        <a href={authorizeUrl} target="_blank" rel="noopener noreferrer">
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
          placeholder={`${redirectUri ?? "http://…/oauth/connections/callback"}?code=…&state=…`}
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
