import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { intervalInWords, isRealtime } from "@/lib/delivery";
import { queries } from "@/lib/queries";

/** Whether new mail reaches agentinbox within seconds (Pub/Sub working), and the poll interval otherwise. */
export function useDeliverySpeed(): { realtime: boolean; interval: number } {
  const state = useQuery(queries.setupState());
  const settings = useQuery(queries.settings());
  const system = useQuery(queries.system());
  return { realtime: isRealtime(state.data?.pubsub, system.data?.ingest), interval: settings.data?.pollIntervalSeconds ?? 30 };
}

/** "within seconds of arriving" / "within about 30 seconds of arriving (turn on real-time delivery in Settings …)". */
export function ArrivalSpeed({ noun = "arriving" }: { noun?: string }) {
  const { realtime, interval } = useDeliverySpeed();
  if (realtime) return <>within seconds of {noun}</>;
  return (
    <>
      within about {intervalInWords(interval)} of {noun} (turn on{" "}
      <Link to="/settings" hash="pubsub" className="font-medium text-foreground underline underline-offset-4">
        real-time delivery in Settings
      </Link>{" "}
      to get it within seconds)
    </>
  );
}
