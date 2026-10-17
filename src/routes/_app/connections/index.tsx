import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { PlugIcon, PlusIcon } from "lucide-react";
import { PageHeader, QueryError } from "@/components/common";
import { openAddConnection } from "@/components/connections/add-connection";
import { ConnectionRow } from "@/components/connections/connection-row";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { queries } from "@/lib/queries";

export const Route = createFileRoute("/_app/connections/")({
  component: ConnectionsPage,
});

const AddButton = ({ variant }: { variant?: "outline" }) => (
  <Button variant={variant} onClick={() => openAddConnection()}>
    <PlusIcon /> Add connection
  </Button>
);

function ConnectionsPage() {
  const list = useQuery(queries.connections());
  return (
    <>
      <PageHeader
        title="Connections"
        description="MCP servers and apps your agents use through xaq, like Notion. xaq holds every sign-in; agents get the tools you allow."
        actions={<AddButton />}
      />
      {list.isPending ? (
        <Skeleton className="h-40 rounded-xl" />
      ) : list.isError ? (
        <QueryError error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data.length === 0 ? (
        <Card>
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <PlugIcon />
              </EmptyMedia>
              <EmptyTitle>No connections yet</EmptyTitle>
              <EmptyDescription>Install an extension (Notion, T3 Code, WHOOP, Brightspace) and connect it, or add any MCP server. Every agent then reaches it through its one xaq connection.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <AddButton variant="outline" />
            </EmptyContent>
          </Empty>
        </Card>
      ) : (
        <Card className="gap-0 py-0">
          <div className="divide-y">
            {list.data.map((c) => (
              <ConnectionRow key={c.id} connection={c} />
            ))}
          </div>
        </Card>
      )}
    </>
  );
}
