import type { GoogleAppType, GoogleClientImportResult } from "@shared/types";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2Icon, FileJsonIcon, InfoIcon } from "lucide-react";
import { useId, useRef, useState } from "react";
import { ErrorAlert } from "@/components/common";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError } from "@/lib/api";
import { keys } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { rememberClientRedirect } from "./redirect-notice";

/**
 * Drop, choose or paste the client JSON Google offers right after creating an OAuth client
 * (POST /api/google/client/import). Saves on its own: no field to copy by hand.
 */
export function ClientImport({
  appType,
  expectedProjectId,
  onImported,
  onNeedsManual,
  quiet,
}: {
  /** The surrounding page already says what's saved: skip the "Imported and saved" line. */
  quiet?: boolean;
  /** The audience chosen earlier; omitted keeps what the server has. */
  appType?: GoogleAppType;
  /** The project the earlier steps used: a different one in the file gets pointed out. */
  expectedProjectId?: string;
  onImported?: (r: GoogleClientImportResult) => void;
  /** The file can't be used (e.g. no secret in it): offer manual entry. */
  onNeedsManual?: () => void;
}) {
  const qc = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const textId = useId();
  const [text, setText] = useState("");
  const [dragging, setDragging] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [result, setResult] = useState<GoogleClientImportResult>();

  const submit = async (json: string) => {
    if (!json.trim()) return;
    setPending(true);
    setError(undefined);
    setResult(undefined);
    try {
      const r = await api<GoogleClientImportResult>("/api/google/client/import", { body: { json, ...(appType ? { appType } : {}) } });
      setResult(r);
      setText("");
      rememberClientRedirect(r);
      qc.setQueryData(keys.googleClient, r);
      for (const k of [keys.googleClient, keys.setupState]) void qc.invalidateQueries({ queryKey: k });
      onImported?.(r);
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
      // Announce and show the outcome where the user is looking.
      requestAnimationFrame(() => resultRef.current?.focus());
    }
  };

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 64_000) {
      setError(new ApiError(400, "client_json_invalid", "That file is too large to be an OAuth client JSON.", "Choose the client_secret_….json file you downloaded."));
      return;
    }
    await submit(await file.text());
  };

  const code = error instanceof ApiError ? error.code : undefined;
  const projectDiffers = result?.projectId && expectedProjectId && result.projectId !== expectedProjectId;

  return (
    <div className="space-y-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void readFile(e.dataTransfer.files[0]);
        }}
        className={cn(
          "flex flex-col items-center gap-2 rounded-lg border-2 border-dashed p-5 text-center text-sm transition-colors",
          dragging ? "border-primary bg-muted/60" : "border-border",
        )}
      >
        <FileJsonIcon className="size-7 text-muted-foreground" aria-hidden />
        <p className="text-foreground">
          Drop the downloaded <span className="font-mono text-xs">client_secret_….json</span> file here
        </p>
        <Button type="button" variant="default" size="sm" onClick={() => fileInput.current?.click()} disabled={pending}>
          {pending ? <Spinner /> : <FileJsonIcon />} Choose the JSON file
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => {
            void readFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor={textId} className="text-xs text-muted-foreground">
          Or paste the file's contents
        </label>
        <Textarea
          id={textId}
          rows={2}
          spellCheck={false}
          placeholder='{"web":{"client_id":"…apps.googleusercontent.com","client_secret":"…"}}'
          className="font-mono text-xs"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData("text");
            if (pasted.trim().startsWith("{")) {
              e.preventDefault();
              setText(pasted);
              void submit(pasted);
            }
          }}
        />
        {text.trim() && (
          <Button type="button" size="sm" variant="outline" onClick={() => void submit(text)} disabled={pending}>
            {pending && <Spinner />} Import
          </Button>
        )}
      </div>

      <div ref={resultRef} tabIndex={-1} className="space-y-2 outline-none" role="status">
        {result && !quiet && (
          <p className="flex items-start gap-1.5 text-sm text-foreground">
            <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-success" />
            <span>
              Imported and saved: client <span className="font-mono text-xs break-all">{result.clientId}</span>
              {result.projectId && (
                <>
                  {" "}
                  in project <span className="font-mono text-xs">{result.projectId}</span>
                </>
              )}
              .
            </span>
          </p>
        )}
        {projectDiffers && (
          <Alert variant="info">
            <InfoIcon />
            <AlertDescription>
              This client belongs to project <span className="font-mono">{result.projectId}</span>, not {expectedProjectId}. agentinbox uses{" "}
              {result.projectId} from now on; if that's wrong, create the client in the right project and import that one.
            </AlertDescription>
          </Alert>
        )}
        {error !== undefined && (
          <ErrorAlert error={error} title={code === "client_secret_missing" ? "This file has no client secret" : "Couldn't import that file"}>
            {(code === "client_secret_missing" || code === "client_json_invalid") && onNeedsManual && (
              <div className="pt-2">
                <Button size="sm" variant="outline" onClick={onNeedsManual}>
                  Enter the client ID and secret by hand
                </Button>
              </div>
            )}
          </ErrorAlert>
        )}
      </div>
    </div>
  );
}
