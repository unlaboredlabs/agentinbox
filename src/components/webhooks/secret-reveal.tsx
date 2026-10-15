import { ShieldAlertIcon } from "lucide-react";
import { CodeBlock, CopyField, SectionLabel } from "@/components/common";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const NODE = `// npm install standardwebhooks
import { Webhook } from "standardwebhooks";

const wh = new Webhook(process.env.AGENTINBOX_WEBHOOK_SECRET); // "whsec_…"

// Verify the raw request body (before JSON parsing). Throws if invalid.
const event = wh.verify(rawBody, {
  "webhook-id": req.headers["webhook-id"],
  "webhook-timestamp": req.headers["webhook-timestamp"],
  "webhook-signature": req.headers["webhook-signature"],
});`;

const PYTHON = `# pip install standardwebhooks
import os
from standardwebhooks.webhooks import Webhook

wh = Webhook(os.environ["AGENTINBOX_WEBHOOK_SECRET"])  # "whsec_…"

# Verify the raw request body. Raises if invalid.
event = wh.verify(raw_body, dict(request.headers))`;

const MANUAL = `import crypto from "node:crypto";

// Signed content: "<webhook-id>.<webhook-timestamp>.<raw body>"
// Key: base64-decoded secret after the "whsec_" prefix. Signature: HMAC-SHA256, base64.
function verify(secret, headers, rawBody) {
  const id = headers["webhook-id"];
  const ts = headers["webhook-timestamp"];
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // reject replays
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = crypto.createHmac("sha256", key).update(\`\${id}.\${ts}.\${rawBody}\`).digest("base64");
  // The header may hold several space-separated "v1,<signature>" entries.
  return headers["webhook-signature"].split(" ").some((entry) => {
    const sig = Buffer.from(entry.split(",")[1] ?? "");
    const want = Buffer.from(expected);
    return sig.length === want.length && crypto.timingSafeEqual(sig, want);
  });
}`;

/** How receivers verify agentinbox's Standard Webhooks signatures. */
export function VerificationSnippets() {
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        Requests are signed per <a className="underline underline-offset-4" href="https://www.standardwebhooks.com" target="_blank" rel="noopener noreferrer">Standard Webhooks</a> with
        the headers <code className="font-mono text-foreground">webhook-id</code>, <code className="font-mono text-foreground">webhook-timestamp</code> and{" "}
        <code className="font-mono text-foreground">webhook-signature</code>. Reply with any 2xx quickly; anything else is retried with backoff.
      </p>
      <Tabs defaultValue="node">
        <TabsList>
          <TabsTrigger value="node">Node.js</TabsTrigger>
          <TabsTrigger value="python">Python</TabsTrigger>
          <TabsTrigger value="manual">No library</TabsTrigger>
        </TabsList>
        <TabsContent value="node">
          <CodeBlock code={NODE} />
        </TabsContent>
        <TabsContent value="python">
          <CodeBlock code={PYTHON} />
        </TabsContent>
        <TabsContent value="manual">
          <CodeBlock code={MANUAL} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** The signing secret, shown once at creation and rotation. */
export function SecretReveal({ secret }: { secret: string }) {
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <SectionLabel>Signing secret</SectionLabel>
        <CopyField value={secret} size="lg" />
        <Alert variant="warning">
          <ShieldAlertIcon />
          <AlertTitle>Copy the secret now. It won't be shown again.</AlertTitle>
          <AlertDescription>Store it with your receiver (e.g. as AGENTINBOX_WEBHOOK_SECRET). If it's lost, rotate it from the webhook's page.</AlertDescription>
        </Alert>
      </div>
      <div className="space-y-2">
        <SectionLabel>Verify requests</SectionLabel>
        <VerificationSnippets />
      </div>
    </div>
  );
}
