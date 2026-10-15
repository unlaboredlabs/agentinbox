import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CheckCircle2Icon, PencilIcon } from "lucide-react";
import { useState } from "react";
import { CopyField, QueryError, ToneBadge } from "@/components/common";
import { ClientForm } from "@/components/google/client-form";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { queries } from "@/lib/queries";

export function GoogleClientCard() {
  const q = useQuery(queries.googleClient());
  const [editing, setEditing] = useState(false);
  const v = q.data;
  const configured = !!v?.clientId && v.hasSecret;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Google OAuth client</CardTitle>
        <CardDescription>Your own Google Cloud OAuth client, used to connect Gmail accounts.</CardDescription>
        {configured && !editing && (
          <CardAction>
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              <PencilIcon /> Edit
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {q.isPending ? (
          <Skeleton className="h-24" />
        ) : q.isError ? (
          <QueryError error={q.error} onRetry={() => void q.refetch()} />
        ) : editing || !configured ? (
          <>
            {!configured && (
              <p className="text-sm text-muted-foreground">
                Not configured yet. The{" "}
                <Link to="/get-started" search={{ step: "project" }} className="text-foreground underline underline-offset-4">
                  setup guide
                </Link>{" "}
                walks you through creating one.
              </p>
            )}
            <ClientForm view={v} onSaved={() => setEditing(false)} onCancel={configured ? () => setEditing(false) : undefined} />
          </>
        ) : (
          <dl className="grid grid-cols-[max-content_1fr] items-center gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Client ID</dt>
            <dd className="min-w-0 font-mono text-xs break-all">{v.clientId}</dd>
            <dt className="text-muted-foreground">Secret</dt>
            <dd className="flex items-center gap-1.5 text-xs">
              <CheckCircle2Icon className="size-3.5 text-success" /> Saved (encrypted)
            </dd>
            <dt className="text-muted-foreground">Project</dt>
            <dd className="font-mono text-xs">{v.projectId ?? "—"}</dd>
            <dt className="text-muted-foreground">Audience</dt>
            <dd>{v.appType === "internal" ? "Internal (Workspace)" : v.appType === "external" ? "External" : "—"}</dd>
            <dt className="text-muted-foreground">Callback</dt>
            <dd>
              {v.callbackMode === "direct" ? (
                <ToneBadge tone="good">Direct redirect</ToneBadge>
              ) : (
                <ToneBadge tone="warn">Paste mode</ToneBadge>
              )}
            </dd>
          </dl>
        )}
        {v && (
          <div className="space-y-1.5">
            <div className="text-sm font-medium">Authorized redirect URI</div>
            <CopyField value={v.redirectUri} />
            <p className="text-xs text-muted-foreground">Must be listed exactly like this on the OAuth client in Google Cloud. It follows the public URL.</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
