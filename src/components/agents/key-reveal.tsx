import { ShieldAlertIcon } from "lucide-react";
import { CopyField } from "@/components/common";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/** The agent's API key, shown exactly once. */
export function KeyReveal({ apiKey }: { apiKey: string }) {
  return (
    <div className="space-y-3">
      <CopyField value={apiKey} size="lg" />
      <Alert variant="warning">
        <ShieldAlertIcon />
        <AlertTitle>Copy this key now. It won't be shown again.</AlertTitle>
        <AlertDescription>
          agentinbox only stores a hash of it. Treat it like a password: anyone with it can act as this agent within its grants. If it leaks or
          gets lost, rotate the key.
        </AlertDescription>
      </Alert>
    </div>
  );
}
