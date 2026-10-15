import { type QueryKey, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "./api";

interface ApiMutationOptions<TVars, TData> {
  mutationFn: (vars: TVars) => Promise<TData>;
  /** Query keys (prefixes) to refetch after success. */
  invalidate?: readonly QueryKey[];
  /** Success toast. Return undefined to skip it. */
  success?: string | ((data: TData, vars: TVars) => string | undefined);
  /** Error toast title; the server's message and hint go underneath. Set false to handle errors yourself. */
  errorTitle?: string | false;
  onSuccess?: (data: TData, vars: TVars) => void;
}

/** A mutation with the console's standard feedback: toast on success/error and cache refresh. */
export function useApiMutation<TVars = void, TData = unknown>(opts: ApiMutationOptions<TVars, TData>) {
  const qc = useQueryClient();
  return useMutation<TData, Error, TVars>({
    mutationFn: opts.mutationFn,
    onSuccess: (data, vars) => {
      for (const key of opts.invalidate ?? []) void qc.invalidateQueries({ queryKey: key });
      const msg = typeof opts.success === "function" ? opts.success(data, vars) : opts.success;
      if (msg) toast.success(msg);
      opts.onSuccess?.(data, vars);
    },
    onError: (err) => {
      if (opts.errorTitle !== false) toastError(err, opts.errorTitle);
    },
  });
}
