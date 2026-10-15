import { InfoIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export function UnverifiedTip() {
  return (
    <Alert variant="info">
      <InfoIcon />
      <AlertTitle>Seeing "Google hasn't verified this app"?</AlertTitle>
      <AlertDescription>
        That's expected: it's your own OAuth app, not a third party's. Click <strong>Advanced</strong>, then <strong>Go to … (unsafe)</strong>. On
        the permissions screen, make sure every Gmail checkbox is ticked.
      </AlertDescription>
    </Alert>
  );
}
