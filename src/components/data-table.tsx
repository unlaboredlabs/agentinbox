import { type ColumnDef, type RowData, createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table";
import { ChevronRightIcon } from "lucide-react";
import { Fragment, useState } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

export interface ColumnMetaInfo {
  /** Applied to both the header and body cells. */
  className?: string;
}

/** Core-only feature set (no client sorting/filtering: the server pages and filters). */
export const coreFeatures = tableFeatures({ columnMeta: {} as ColumnMetaInfo });
export type Features = typeof coreFeatures;
export const columnHelper = <T extends RowData>() => createColumnHelper<Features, T>();
export type Columns<T extends RowData> = ColumnDef<Features, T, any>[];

/**
 * Table with optional expandable rows. Clicking a row (or its chevron button) toggles the detail
 * panel rendered by `renderExpanded` below it, spanning all columns.
 */
export function DataTable<T extends RowData>({
  columns,
  data,
  getRowId,
  renderExpanded,
  rowClassName,
  empty,
  className,
}: {
  columns: Columns<T>;
  data: T[];
  getRowId: (row: T) => string;
  renderExpanded?: (row: T) => React.ReactNode;
  rowClassName?: (row: T) => string | undefined;
  empty?: React.ReactNode;
  className?: string;
}) {
  const table = useTable({ features: coreFeatures, columns, data, getRowId: (r) => getRowId(r) });
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const colSpan = columns.length + (renderExpanded ? 1 : 0);
  const rows = table.getRowModel().rows;

  return (
    <div className={cn("overflow-hidden rounded-xl border", className)}>
      <Table>
        <TableHeader className="bg-muted/40">
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id} className="hover:bg-transparent">
              {renderExpanded && <TableHead className="w-8 pr-0" aria-label="Expand" />}
              {group.headers.map((h) => (
                <TableHead key={h.id} className={cn("text-xs", h.column.columnDef.meta?.className)}>
                  {h.isPlaceholder ? null : <table.FlexRender header={h} />}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {rows.length === 0 && (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={colSpan} className="h-32 text-center text-sm whitespace-normal text-muted-foreground">
                {empty ?? "Nothing here."}
              </TableCell>
            </TableRow>
          )}
          {rows.map((row) => {
            const open = expanded.has(row.id);
            return (
              <Fragment key={row.id}>
                <TableRow
                  data-state={open ? "selected" : undefined}
                  className={cn(renderExpanded && "cursor-pointer", rowClassName?.(row.original))}
                  onClick={
                    renderExpanded
                      ? (e) => {
                          // Let buttons and links inside the row do their own thing.
                          if ((e.target as HTMLElement).closest("button, a, input, [role=switch]")) return;
                          toggle(row.id);
                        }
                      : undefined
                  }
                >
                  {renderExpanded && (
                    <TableCell className="w-8 pr-0">
                      <button
                        type="button"
                        className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                        aria-expanded={open}
                        aria-label={open ? "Hide details" : "Show details"}
                        onClick={() => toggle(row.id)}
                      >
                        <ChevronRightIcon className={cn("size-4 transition-transform", open && "rotate-90")} />
                      </button>
                    </TableCell>
                  )}
                  {row.getAllCells().map((cell) => (
                    <TableCell key={cell.id} className={cell.column.columnDef.meta?.className}>
                      <table.FlexRender cell={cell} />
                    </TableCell>
                  ))}
                </TableRow>
                {open && renderExpanded && (
                  <TableRow className="bg-muted/20 hover:bg-muted/20">
                    <TableCell colSpan={colSpan} className="p-0 whitespace-normal">
                      <div className="p-4">{renderExpanded(row.original)}</div>
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
