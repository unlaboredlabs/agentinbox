// The console's setup-wizard logic that must agree with the server: the address verdicts (Google
// callback mode, agent transport rule), project IDs and the Cloud Shell command, the SSH tunnel
// command, and where long commands may wrap.
import { describe, expect, it } from "vitest";
import { callbackMode } from "../server/google/client.ts";
import { checkTransport } from "../server/listen/transport.ts";
import { cloudUrl, generateProjectId, iamBindingCommand, PROJECT_ID_RE, projectCommand, projectIdProblem } from "../src/lib/gcp-project.ts";
import { analyzeUrl, localConsoleUrl, urlVerdict } from "../src/lib/public-url.ts";
import { tunnelCommand } from "../src/lib/tunnel.ts";
import { wrapParts } from "../src/lib/wrap.ts";

// What names resolve to on the agent's machine (only *.localhost and *.ts.net are resolved by the CLI).
const resolve = async (host: string) => (host.endsWith(".localhost") ? ["127.0.0.1"] : host.endsWith(".ts.net") ? ["100.101.102.103"] : []);

const serverCallback = (publicUrl: string) =>
  callbackMode({ settings: { publicUrl: () => publicUrl }, config: { port: 8425 } } as unknown as Parameters<typeof callbackMode>[0]).mode;

const serverTransport = async (url: string) => (await checkTransport(url, { insecure: true, resolve })).kind;

describe("address verdicts match the server", () => {
  // url, host kind, Google sign-in verdict, agent transport
  const table: [string, string, "direct" | "paste" | "rejected", string][] = [
    ["http://localhost:8425", "loopback", "direct", "loopback"],
    ["http://127.0.0.1:8425", "loopback", "direct", "loopback"],
    ["http://[::1]:8425", "loopback", "direct", "loopback"],
    ["http://127.0.0.2:8425", "loopback", "paste", "loopback"],
    ["http://inbox.localhost:8425", "loopback", "paste", "loopback"],
    ["https://localhost:8443", "loopback", "direct", "https"],
    ["https://127.0.0.1:8443", "loopback", "direct", "https"],
    ["https://inbox.localhost", "loopback", "rejected", "https"],
    ["http://100.101.102.103:8425", "tailscale", "paste", "tailscale"],
    ["https://100.101.102.103:8425", "tailscale", "rejected", "https"],
    ["http://box.tail1234.ts.net:8425", "public-name", "paste", "tailscale"],
    ["https://box.tail1234.ts.net", "public-name", "direct", "https"],
    ["http://192.168.1.20:8425", "ip", "paste", "insecure"],
    ["https://192.168.1.20:8443", "ip", "rejected", "https"],
    ["https://agentinbox.home.lan", "private-name", "rejected", "https"],
    ["https://nas.local", "private-name", "rejected", "https"],
    ["http://nas.local:8425", "private-name", "paste", "insecure"],
    ["https://mail.example.com", "public-name", "direct", "https"],
    ["http://mail.example.com", "public-name", "paste", "insecure"],
  ];

  it.each(table)("%s", async (url, host, google, transport) => {
    const a = analyzeUrl(url)!;
    expect(a.host).toBe(host);
    expect(a.google).toBe(google);
    expect(a.transport).toBe(transport);
    // Agents: the CLI's own rule.
    expect(await serverTransport(url)).toBe(transport);
    // Google: "paste" exactly when the server uses paste mode; https is direct on the server (Google itself refuses some).
    expect(serverCallback(url)).toBe(google === "paste" ? "paste" : "direct");
  });

  it("only warns about agents when the CLI would need --insecure", () => {
    for (const [url, , , transport] of table) {
      const [tone] = urlVerdict(analyzeUrl(url)!, false).agents;
      expect(tone === "warn", url).toBe(transport === "insecure");
    }
  });

  it("says Google sign-in won't work for localhost seen from another machine", () => {
    expect(urlVerdict(analyzeUrl("http://localhost:8425")!, true).google[0]).toBe("bad");
    expect(urlVerdict(analyzeUrl("http://localhost:8425")!, false).google[0]).toBe("good");
    expect(urlVerdict(analyzeUrl("https://mail.example.com")!, true).google[0]).toBe("good");
  });

  it("recommends the loopback origin the browser is on for \"All on this computer\", not another hostname", () => {
    // Opened from the CLI's link when bound to --host 127.0.0.1: stay there (the session cookie is 127.0.0.1's).
    expect(localConsoleUrl("http://127.0.0.1:8425", "8425")).toEqual({ url: "http://127.0.0.1:8425", fromBrowser: true });
    expect(localConsoleUrl("http://localhost:8425", "8425")).toEqual({ url: "http://localhost:8425", fromBrowser: true });
    expect(localConsoleUrl("http://[::1]:8425", "8425")).toEqual({ url: "http://[::1]:8425", fromBrowser: true });
    expect(localConsoleUrl("https://localhost:8443", "8425")).toEqual({ url: "https://localhost:8443", fromBrowser: true });
    // Each of those is a direct callback on the server too.
    for (const o of ["http://127.0.0.1:8425", "http://localhost:8425", "http://[::1]:8425"]) expect(serverCallback(localConsoleUrl(o, "8425").url)).toBe("direct");
    // Loopback names the server doesn't call back to directly, and remote browsers: localhost on the server's port.
    expect(localConsoleUrl("http://127.0.0.2:8425", "8425")).toEqual({ url: "http://localhost:8425", fromBrowser: false });
    expect(localConsoleUrl("http://inbox.localhost:8425", "8425")).toEqual({ url: "http://localhost:8425", fromBrowser: false });
    expect(localConsoleUrl("http://192.168.1.20:8425", "8425")).toEqual({ url: "http://localhost:8425", fromBrowser: false });
    expect(localConsoleUrl("https://mail.example.com", "8425")).toEqual({ url: "http://localhost:8425", fromBrowser: false });
  });

  it("rejects what isn't an http(s) URL", () => {
    expect(analyzeUrl("ftp://example.com")).toBeNull();
    expect(analyzeUrl("not a url")).toBeNull();
  });
});

describe("project IDs", () => {
  it.each([
    ["agentinbox-123456", null],
    ["my-project", null],
    ["", /Enter/],
    ["471203994812", /project number/],
    ["My Project", /project name/],
    ["Agentinbox", /project name/],
    ["abc", /6 to 30/],
    ["a".repeat(31), /6 to 30/],
    ["1agentinbox", /lowercase letter/],
    ["agentinbox-", /hyphen/],
    ["agent_inbox", /only lowercase/],
  ] as const)("%j", (id, problem) => {
    const p = projectIdProblem(id);
    if (problem === null) expect(p).toBeNull();
    else expect(p).toMatch(problem);
    expect(PROJECT_ID_RE.test(id)).toBe(problem === null);
  });

  it("suggests valid, distinct IDs", () => {
    const ids = new Set(Array.from({ length: 20 }, generateProjectId));
    for (const id of ids) expect(id).toMatch(/^agentinbox-\d{6}$/);
    expect(ids.size).toBeGreaterThan(15);
  });

  it("builds the Cloud Shell command only for a valid ID", () => {
    expect(projectCommand("agentinbox-123456", false)).toBe(
      "gcloud projects create agentinbox-123456 --name=agentinbox && " +
        "gcloud services enable gmail.googleapis.com --project=agentinbox-123456 && " +
        'echo "agentinbox: project agentinbox-123456 is ready"',
    );
    expect(projectCommand("agentinbox-123456", true)).toContain(
      `--organization="$(gcloud organizations list --format='value(name.basename())' --limit=1)"`,
    );
    for (const bad of ["", "x; rm -rf ~", "agentinbox-1 && curl evil", "$(id)", "My Project"]) expect(projectCommand(bad, false)).toBeNull();
  });

  it("enables only Gmail in step 2 (Pub/Sub may need billing); step 6 links to enabling Pub/Sub", () => {
    // Google may require billing to enable Pub/Sub: that would fail the required Gmail path.
    expect(projectCommand("agentinbox-123456", false)).not.toContain("pubsub");
    expect(projectCommand("agentinbox-123456", true)).not.toContain("pubsub");
    expect(cloudUrl.enableGmail("agentinbox-123456")).toBe("https://console.cloud.google.com/flows/enableapi?apiid=gmail.googleapis.com&project=agentinbox-123456");
    expect(cloudUrl.enablePubsub("agentinbox-123456")).toBe("https://console.cloud.google.com/flows/enableapi?apiid=pubsub.googleapis.com&project=agentinbox-123456");
  });
});

describe("IAM binding command", () => {
  it("quotes the member and project for the shell", () => {
    expect(iamBindingCommand("agentinbox-123456", "ops@acme.dev")).toBe(
      "gcloud projects add-iam-policy-binding agentinbox-123456 --member=user:ops@acme.dev --role=roles/pubsub.admin",
    );
    // A quote in the address (valid in an email local part) can't end the quoting.
    expect(iamBindingCommand("agentinbox-123456", "o'brien@acme.dev")).toBe(
      `gcloud projects add-iam-policy-binding agentinbox-123456 --member='user:o'"'"'brien@acme.dev' --role=roles/pubsub.admin`,
    );
    expect(iamBindingCommand("agentinbox-123456", "a$(id)@acme.dev")).toContain(`--member='user:a$(id)@acme.dev'`);
    expect(iamBindingCommand("example.com:my-project", "ops@acme.dev")).toContain(" example.com:my-project ");
  });

  it("returns null for an invalid project ID or an empty email", () => {
    for (const bad of ["", "x; rm -rf ~", "$(id)", "My Project"]) expect(iamBindingCommand(bad, "ops@acme.dev")).toBeNull();
    expect(iamBindingCommand("agentinbox-123456", " ")).toBeNull();
  });
});

describe("SSH tunnel command (mirrors server tunnelCommand's forward target)", () => {
  it.each([
    // bound to all interfaces: forward to localhost
    [["http://localhost:8425", "http://192.168.1.20:8425"], "192.168.1.20", "ssh -N -L 8425:localhost:8425 you@192.168.1.20"],
    // bound to loopback only
    [["http://127.0.0.1:8425"], "box.lan", "ssh -N -L 8425:localhost:8425 you@box.lan"],
    // bound to one specific address: forward to it
    [["http://10.0.0.5:8425"], "10.0.0.5", "ssh -N -L 8425:10.0.0.5:8425 you@10.0.0.5"],
    // IPv6: brackets stripped from the SSH host, kept (quoted) in the forward
    [["http://[fd00::5]:8425"], "[fd00::5]", "ssh -N -L '8425:[fd00::5]:8425' you@fd00::5"],
    // browsing on localhost (e.g. through a tunnel already): placeholder host
    [["http://localhost:8425"], "localhost", "ssh -N -L 8425:localhost:8425 you@your-server"],
    // odd characters are quoted for the shell
    [["http://localhost:8425"], "a b;c", "ssh -N -L 8425:localhost:8425 'you@a b;c'"],
  ] as const)("%j via %s", (addresses, browserHost, expected) => {
    expect(tunnelCommand({ port: "8425", addresses: [...addresses], browserHost })).toBe(expected);
  });
});

describe("soft wrap points", () => {
  const segs = (text: string) => wrapParts(text).map((p) => ("space" in p ? " " : p.segments.join("|")));

  it("never breaks inside flags, hyphenated IDs or after =", () => {
    expect(segs("gcloud projects create agentinbox-123456 --set-as-default --project=agentinbox-123456")).toEqual([
      "gcloud", " ", "projects", " ", "create", " ", "agentinbox-123456", " ", "--set-as-default", " ", "--project=agentinbox-123456",
    ]);
  });

  it("breaks URLs after / ? & , but not inside //", () => {
    expect(segs("https://console.cloud.google.com/flows/enableapi?apiid=gmail.googleapis.com,pubsub.googleapis.com&project=x")).toEqual([
      "https://|console.cloud.google.com/|flows/|enableapi?|apiid=gmail.googleapis.com,|pubsub.googleapis.com&|project=x",
    ]);
  });

  it("keeps whitespace runs and drops nothing", () => {
    const text = "a  b\nc https://x.y/z";
    const rebuilt = wrapParts(text)
      .map((p) => ("space" in p ? p.space : p.segments.join("")))
      .join("");
    expect(rebuilt).toBe(text);
  });
});
