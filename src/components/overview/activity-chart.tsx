import type { OverviewStats } from "@shared/types";
import { format } from "date-fns";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { type ChartConfig, ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { fmtCompact } from "@/lib/format";

// Categorical slots 1 and 2 of the theme palette (validated for CVD separation in light and dark).
const config = {
  events: { label: "Mail events", color: "var(--chart-1)" },
  toolCalls: { label: "Agent tool calls", color: "var(--chart-2)" },
} satisfies ChartConfig;

/** Hourly mail events vs agent tool calls over the last 24h. Same unit (count), one axis. */
export function ActivityChart({ activity }: { activity: OverviewStats["activity"] }) {
  const data = activity.map((b) => ({ t: new Date(b.hour).getTime(), events: b.events, toolCalls: b.toolCalls }));
  const empty = data.every((d) => d.events === 0 && d.toolCalls === 0);
  return (
    <div className="relative">
      <ChartContainer config={config} className="aspect-auto h-56 w-full" aria-label="Activity over the last 24 hours">
        <LineChart data={data} margin={{ left: 0, right: 8, top: 8 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="t" tickLine={false} axisLine={false} minTickGap={48} tickFormatter={(t: number) => format(t, "HH:mm")} />
          <YAxis tickLine={false} axisLine={false} width={36} allowDecimals={false} tickFormatter={fmtCompact} />
          <ChartTooltip
            cursor={{ stroke: "var(--border)", strokeWidth: 1 }}
            content={<ChartTooltipContent labelFormatter={(_, p) => (p?.[0] ? format(p[0].payload.t as number, "MMM d, HH:00") : "")} />}
          />
          <ChartLegend content={<ChartLegendContent />} />
          <Line
            dataKey="events"
            type="monotone"
            stroke="var(--color-events)"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }}
            isAnimationActive={false}
          />
          <Line
            dataKey="toolCalls"
            type="monotone"
            stroke="var(--color-toolCalls)"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }}
            isAnimationActive={false}
          />
        </LineChart>
      </ChartContainer>
      {empty && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center pb-8 text-sm text-muted-foreground">
          No activity in the last 24 hours yet
        </div>
      )}
      <table className="sr-only">
        <caption>Hourly activity, last 24 hours</caption>
        <thead>
          <tr>
            <th>Hour</th>
            <th>Mail events</th>
            <th>Agent tool calls</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.t}>
              <td>{format(d.t, "HH:00")}</td>
              <td>{d.events}</td>
              <td>{d.toolCalls}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
