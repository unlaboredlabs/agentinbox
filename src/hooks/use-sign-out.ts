import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { api, toastError } from "@/lib/api";
import { keys } from "@/lib/queries";

export function useSignOut() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return async () => {
    try {
      await api("/api/auth/logout", { method: "POST" });
    } catch (err) {
      toastError(err, "Couldn't sign out");
      return;
    }
    qc.clear();
    qc.setQueryData(keys.setupStatus, { claimed: true, authenticated: false });
    await navigate({ to: "/login" });
  };
}
