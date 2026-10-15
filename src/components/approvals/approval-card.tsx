import type { Approval } from "@shared/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BotIcon, CheckIcon, MessageSquareQuoteIcon, StickyNoteIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { TimeAgo } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { api, toastError } from "@/lib/api";
import { KIND_LABEL } from "@/lib/labels";
import { keys } from "@/lib/queries";
import { Attachments, BodyPreview, ExpiryCountdown, Recipients } from "./approval-parts";

type Decision = "approve" | "reject";

/** A pending send request: everything needed to decide, plus approve / reject with an optional note. */
export function ApprovalCard({ approval: a }: { approval: Approval }) {
  const qc = useQueryClient();
  const [note, setNote] = useState("");
  const [noting, setNoting] = useState(false);

  const decide = useMutation({
    mutationFn: (d: Decision) =>
      api<Approval>(`/api/approvals/${encodeURIComponent(a.id)}/${d}`, { body: note.trim() ? { note: note.trim() } : {} }),
    onSuccess: (res, d) => {
      // Drop it from the pending list right away; the stream/refetch reconciles the rest.
      qc.setQueryData<Approval[]>([...keys.approvals, "pending"], (list) => list?.filter((x) => x.id !== a.id));
      void qc.invalidateQueries({ queryKey: keys.approvals });
      void qc.invalidateQueries({ queryKey: keys.overview });
      if (d === "reject") toast.success("Rejected", { description: "The draft was deleted and the agent is told it was rejected." });
      else if (res.status === "failed") toast.error("Approved, but sending failed", { description: res.error ?? undefined });
      else toast.success("Approved and sent", { description: `"${a.subject || "(no subject)"}" is on its way.` });
    },
    onError: (err) => toastError(err, "Couldn't record the decision"),
  });

  const pending = decide.isPending ? decide.variables : undefined;

  return (
    <Card>
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
            <Link
              to="/agents/$agentId"
              params={{ agentId: a.agentId }}
              className="flex items-center gap-1.5 font-medium hover:underline"
            >
              <BotIcon className="size-4 text-muted-foreground" />
              {a.agentName}
            </Link>
            <span className="text-muted-foreground">wants to send from</span>
            <span className="truncate font-medium">{a.accountEmail}</span>
            <Badge variant="secondary">{KIND_LABEL[a.kind]}</Badge>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <TimeAgo date={a.createdAt} />
            <ExpiryCountdown expiresAt={a.expiresAt} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {a.reason && (
          <div className="flex gap-2 rounded-lg border-l-2 border-chart-1 bg-chart-1/5 px-3 py-2 text-sm">
            <MessageSquareQuoteIcon className="mt-0.5 size-4 shrink-0 text-chart-1" />
            <div>
              <div className="text-xs font-medium text-muted-foreground">Agent's reason</div>
              <p className="whitespace-pre-wrap">{a.reason}</p>
            </div>
          </div>
        )}
        <Recipients approval={a} />
        <div className="space-y-2">
          <div className="text-base font-semibold break-words">{a.subject || <span className="text-muted-foreground italic">(no subject)</span>}</div>
          <BodyPreview body={a.body} />
        </div>
        <Attachments items={a.attachments} />
        {noting && (
          <Textarea
            autoFocus
            rows={2}
            placeholder="Optional note. The agent sees it with your decision (e.g. why you rejected)."
            value={note}
            onChange={(e) => setNote(e.target.value)}
            aria-label="Decision note"
          />
        )}
      </CardContent>
      <CardFooter className="flex-wrap justify-between gap-2 border-t">
        <Button variant="ghost" size="sm" onClick={() => setNoting(!noting)} aria-expanded={noting}>
          <StickyNoteIcon /> {noting ? "Hide note" : "Add a note"}
        </Button>
        <div className="flex gap-2">
          <Button variant="outline" disabled={decide.isPending} onClick={() => decide.mutate("reject")}>
            {pending === "reject" ? <Spinner /> : <XIcon />} Reject
          </Button>
          <Button disabled={decide.isPending} onClick={() => decide.mutate("approve")}>
            {pending === "approve" ? <Spinner /> : <CheckIcon />} Approve & send
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}
