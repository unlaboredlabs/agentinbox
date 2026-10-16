import type { ConnectionView, StartConnectResult } from "@shared/types";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2Icon, RotateCwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ErrorAlert } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";
import { keys } from "@/lib/queries";
import { oauthMessageFor } from "./connection-flow";

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
  | { kind: "waiting"; connectionId: string; authorizeUrl: string; popup: Window | null; baseline: string | null }
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
      if (popup) popup.location.href = result.authorizeUrl;
      const before = await getConnection(connectionId).catch(() => null);
      setPhase({ kind: "waiting", connectionId, authorizeUrl: result.authorizeUrl, popup, baseline: before ? fingerprint(before) : null });
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
  useEffect(() => {
    checkRef.current = check;
  });

  // The callback page posts to its opener and on BroadcastChannel "agentinbox-oauth" (server/api/oauth.ts).
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const p = phaseRef.current;
      if (p?.kind !== "waiting") return;
      if (e.origin && e.origin !== window.location.origin) return;
      const m = oauthMessageFor(e.data, p.connectionId);
      if (m) void checkRef.current(true, m.ok ? null : m.error);
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
        {phase?.kind === "waiting" && (
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
          {phase?.kind === "waiting" && (
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
