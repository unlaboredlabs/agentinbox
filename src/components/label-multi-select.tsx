import type { GmailLabel } from "@shared/types";
import { useQuery } from "@tanstack/react-query";
import { CheckIcon, ChevronsUpDownIcon, TagIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { apiGet } from "@/lib/api";
import { queries } from "@/lib/queries";
import { cn } from "@/lib/utils";

/** Friendlier names for Gmail's system labels. */
const SYSTEM_NAMES: Record<string, string> = {
  INBOX: "Inbox",
  SENT: "Sent",
  DRAFT: "Drafts",
  SPAM: "Spam",
  TRASH: "Trash",
  STARRED: "Starred",
  IMPORTANT: "Important",
  UNREAD: "Unread",
  CATEGORY_PERSONAL: "Category: Personal",
  CATEGORY_SOCIAL: "Category: Social",
  CATEGORY_PROMOTIONS: "Category: Promotions",
  CATEGORY_UPDATES: "Category: Updates",
  CATEGORY_FORUMS: "Category: Forums",
};

export function labelName(l: GmailLabel | undefined, id: string) {
  if (!l) return SYSTEM_NAMES[id] ?? id;
  return l.type === "system" ? (SYSTEM_NAMES[l.id] ?? l.name) : l.name;
}

/** Multi-select over an account's Gmail labels (or several accounts' labels). */
export function LabelMultiSelect({
  accountIds,
  value,
  onChange,
  placeholder = "Choose labels…",
  id,
}: {
  accountIds: string[];
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const first = accountIds[0] ?? "";
  const labelsQ = useQuery({ ...queries.labels(first), enabled: !!first });
  // Several accounts: fetch each and merge (system labels share ids; user labels differ per account).
  const extra = accountIds.slice(1);
  const extras = useQuery({
    queryKey: ["labels-many", extra],
    enabled: extra.length > 0,
    queryFn: async () => {
      const lists = await Promise.all(extra.map((a) => apiGet<GmailLabel[]>(`/api/accounts/${encodeURIComponent(a)}/labels`)));
      return lists.flat();
    },
    staleTime: 5 * 60_000,
  });
  const all = new Map<string, GmailLabel>();
  for (const l of [...(labelsQ.data ?? []), ...(extras.data ?? [])]) all.set(l.id, l);
  const labels = [...all.values()];
  const user = labels.filter((l) => l.type === "user").sort((a, b) => a.name.localeCompare(b.name));
  const system = labels.filter((l) => l.type === "system" && !["DRAFT", "UNREAD", "CHAT"].includes(l.id));
  const toggle = (lid: string) => onChange(value.includes(lid) ? value.filter((x) => x !== lid) : [...value, lid]);

  return (
    <div className="space-y-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button id={id} type="button" variant="outline" role="combobox" aria-expanded={open} className="w-full justify-between font-normal sm:w-72">
            <span className="flex items-center gap-2 truncate text-muted-foreground">
              <TagIcon />
              {value.length ? `${value.length} label${value.length === 1 ? "" : "s"} selected` : placeholder}
            </span>
            <ChevronsUpDownIcon className="opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-0" align="start">
          <Command>
            <CommandInput placeholder="Search labels…" />
            <CommandList>
              <CommandEmpty>{labelsQ.isPending && first ? "Loading labels…" : labelsQ.isError ? "Couldn't load labels." : "No labels found."}</CommandEmpty>
              {user.length > 0 && (
                <CommandGroup heading="Your labels">
                  {user.map((l) => (
                    <LabelItem key={l.id} label={l} selected={value.includes(l.id)} onSelect={() => toggle(l.id)} />
                  ))}
                </CommandGroup>
              )}
              {system.length > 0 && (
                <CommandGroup heading="Gmail">
                  {system.map((l) => (
                    <LabelItem key={l.id} label={l} selected={value.includes(l.id)} onSelect={() => toggle(l.id)} />
                  ))}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {value.map((lid) => (
            <Badge key={lid} variant="secondary" className="h-6 gap-1 pr-1 font-normal">
              <TagIcon />
              {labelName(all.get(lid), lid)}
              <button
                type="button"
                className="rounded-sm p-0.5 text-muted-foreground hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                aria-label={`Remove ${labelName(all.get(lid), lid)}`}
                onClick={() => toggle(lid)}
              >
                <XIcon className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

function LabelItem({ label, selected, onSelect }: { label: GmailLabel; selected: boolean; onSelect: () => void }) {
  return (
    <CommandItem value={`${labelName(label, label.id)} ${label.id}`} onSelect={onSelect}>
      <CheckIcon className={cn("size-4", selected ? "opacity-100" : "opacity-0")} />
      <span className="truncate">{labelName(label, label.id)}</span>
    </CommandItem>
  );
}
