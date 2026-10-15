import { useQuery } from "@tanstack/react-query";
import { CopyField, ExternalLink } from "@/components/common";
import { cloudUrl } from "@/components/setup/step-project";
import { Disclosure, Path } from "@/components/setup/wizard-shell";
import { queries } from "@/lib/queries";

/**
 * What to do about the errors Google shows on its own pages (they never reach agentinbox), plus the
 * unverified-app notice. Used in the connect dialog and on the wizard's accounts step.
 */
export function GoogleErrorHelp({ defaultOpen }: { defaultOpen?: boolean }) {
  const client = useQuery(queries.googleClient());
  const v = client.data;
  const project = v?.projectId ?? "";
  const internal = v?.appType === "internal";
  return (
    <Disclosure summary="Seeing an error or a warning on Google's page?" defaultOpen={defaultOpen}>
      <dl className="space-y-3">
        {!internal && (
          <Item title="“Google hasn't verified this app”">
            Expected: it's your own app. Click <Path items={["Advanced", "Go to agentinbox (unsafe)"]} />, then continue.
          </Item>
        )}
        <Item title="A list of permissions with checkboxes">
          Click <strong className="text-foreground">Select all</strong> (or tick each box), then <strong className="text-foreground">Continue</strong>.
          Gmail is required: without it agentinbox can't read mail. Calendar's boxes are optional: unticked, mail still works and you can add
          Calendar later.
        </Item>
        <Item title="“Error 400: redirect_uri_mismatch”">
          <p>The OAuth client doesn't list this exact redirect URI. Add it, save, wait a few minutes, then open sign-in again:</p>
          {v && <CopyField value={v.redirectUri} label="Copy redirect URI" />}
          <p>
            <Path items={["Google Auth Platform", "Clients", "your client", "Authorized redirect URIs", "Add URI"]} />
            {project && (
              <>
                {" "}
                · <ExternalLink href={cloudUrl.clients(project)}>Open Clients</ExternalLink>
              </>
            )}
          </p>
        </Item>
        <Item title="“Access blocked: agentinbox can only be used within its organization” (org_internal)">
          The app is Internal, and this account isn't in its Google Workspace. Sign in with an account of that organization, or make the app
          External (<Path items={["Audience", "Make external"]} />), publish it, and set the audience to External in step 3.
        </Item>
        <Item title="“Access blocked: agentinbox has not completed the Google verification process” (Error 403: access_denied on Google's page)">
          The app is still in Testing. Publish it: <Path items={["Audience", "Publish app", "Push to production?", "Confirm"]} />
          {project && (
            <>
              {" "}
              (<ExternalLink href={cloudUrl.authAudience(project)}>Open Audience</ExternalLink>)
            </>
          )}
          , then open sign-in again.
        </Item>
        <Item title="“Error 400: admin_policy_enforced” or “This app is blocked”">
          A Google Workspace admin must trust the app: admin.google.com →{" "}
          <Path items={["Security", "Access and data control", "API controls", "Manage Third-Party App Access", "Configure new app"]} />, search for
          the client ID{v?.clientId ? <span className="font-mono break-all"> {v.clientId}</span> : ""}, and set it to{" "}
          <strong className="text-foreground">Trusted</strong>. If the admin blocks only Google Calendar, connect with mail only (the connect dialog
          offers it), or turn Calendar off in <Path items={["Settings", "Google Calendar", "Turn off"]} />.
        </Item>
        <Item title="“Error 401: invalid_client” or “deleted_client”">
          The client ID is wrong, or the client was deleted (Google deletes clients unused for 6 months). Create a new client and import it in step 4.
        </Item>
        <Item title="Can't sign in with a shared address (like ops@)">
          Groups and aliases can't sign in to Google. Use a mailbox with its own Google account (a licensed user).
        </Item>
      </dl>
    </Disclosure>
  );
}

function Item({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <dt className="font-medium text-foreground">{title}</dt>
      <dd className="space-y-1.5">{children}</dd>
    </div>
  );
}
