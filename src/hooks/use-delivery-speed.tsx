import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type DeliveryMode, deliveryMode, intervalInWords } from "@/lib/delivery";
import { queries } from "@/lib/queries";

export type DeliverySpeed = { ready: false } | { ready: true; mode: DeliveryMode; interval: number };

/**
 * How quickly new mail reaches xaq (see deliveryMode). With `accountId`, also requires that
 * account's Gmail watch for real-time. `ready` is false until every query has data: show neutral copy.
 */
export function useDeliverySpeed(accountId?: string): DeliverySpeed {
  const state = useQuery(queries.setupState());
  const settings = useQuery(queries.settings());
  const system = useQuery(queries.system());
  const accounts = useQuery({ ...queries.accounts(), enabled: !!accountId });
  if (!state.data || !settings.data || !system.data || (accountId && !accounts.data)) return { ready: false };
  const account = accountId ? (accounts.data?.find((a) => a.id === accountId) ?? null) : undefined;
  return { ready: true, mode: deliveryMode(state.data.pubsub, system.data.ingest, account), interval: settings.data.pollIntervalSeconds };
}

const settingsLink = (text: string) => (
  <Link to="/settings" hash="pubsub" className="font-medium text-foreground underline underline-offset-4">
    {text}
  </Link>
);

/**
 * "within seconds of arriving" / "within about 30 seconds of arriving (turn on real-time delivery in Settings to
 * get it within seconds)". `of` names what the time counts from (omit for just "within …"); `neutral` is
 * shown until the state is loaded (no flash of the wrong claim); `it` is the pronoun in the Settings hint.
 */
export function ArrivalSpeed({ of, neutral, it = "it", accountId }: { of?: string; neutral: React.ReactNode; it?: string; accountId?: string }) {
  const speed = useDeliverySpeed(accountId);
  if (!speed.ready || speed.mode === "inactive") return <>{neutral}</>;
  const from = of ? ` of ${of}` : "";
  if (speed.mode === "realtime") return <>within seconds{from}</>;
  return (
    <>
      within about {intervalInWords(speed.interval)}
      {from} (
      {speed.mode === "poll" ? (
        <>turn on {settingsLink("real-time delivery in Settings")} to get {it} within seconds</>
      ) : speed.mode === "unfinished" ? (
        <>finish setting up {settingsLink("real-time delivery in Settings")} to get {it} within seconds</>
      ) : (
        <>real-time delivery isn't working right now, see {settingsLink("Settings")}</>
      )}
      )
    </>
  );
}
