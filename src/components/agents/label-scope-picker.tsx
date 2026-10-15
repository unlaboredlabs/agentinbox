import { LabelMultiSelect } from "@/components/label-multi-select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

/** A grant's label scope: the whole mailbox (null) or threads carrying any of the chosen labels. */
export function LabelScopePicker({ accountId, value, onChange }: { accountId: string; value: string[] | null; onChange: (v: string[] | null) => void }) {
  return (
    <div className="space-y-2">
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={value === null ? "all" : "labels"}
        onValueChange={(v) => v && onChange(v === "all" ? null : (value ?? []))}
        aria-label="Label scope"
      >
        <ToggleGroupItem value="all">Whole mailbox</ToggleGroupItem>
        <ToggleGroupItem value="labels">Only some labels</ToggleGroupItem>
      </ToggleGroup>
      {value !== null && (
        <>
          <LabelMultiSelect accountIds={[accountId]} value={value} onChange={onChange} />
          {value.length === 0 && <p className="text-xs text-warning">Pick at least one label, or the agent won't see any mail.</p>}
        </>
      )}
    </div>
  );
}
