import { useQuery } from "@tanstack/react-query";
import { queries } from "@/lib/queries";

/** The broker's console parts (Connections, connection access, first run with Google optional) show only with Settings.brokerUpstreams. */
export function useBrokerEnabled(): boolean {
  return useQuery(queries.settings()).data?.brokerUpstreams === true;
}
