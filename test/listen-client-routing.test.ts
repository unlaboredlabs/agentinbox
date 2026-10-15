// Noise filters, --batch, rate-limited forwards and `listen hermes` (the Hermes gateway route).
import { createHmac } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dispatcher, type DispatcherOptions, type Job } from "../server/listen/dispatcher.ts";
import { skipReason } from "../server/listen/event.ts";
import { commandStdin } from "../server/listen/exec.ts";
import { retryAfter } from "../server/listen/forward.ts";
import { hermesSubscribe } from "../server/listen/hermes.ts";
import { runListener } from "../server/listen/listen.ts";
import { describeFilter, parseDuration, resolveListen } from "../server/listen/options.ts";
import { logPath } from "../server/listen/paths.ts";
import { loadProfile, saveProfile } from "../server/listen/profile.ts";
import { HERMES_ROUTE_PROMPT, recipe } from "../server/listen/recipes.ts";
import { readDead, readStatus } from "../server/listen/state.ts";
import type { WebhookPayload } from "../shared/types.ts";
import { FAKE_KEY, FakeAgentApi, isolateXdg, makeEvent, waitFor } from "./listen-client-fake.ts";

const base = { url: "https://x", apiKey: FAKE_KEY, agentId: "a", agentName: "n", consumer: "c", exec: "run" };
const labelled = (seq: number, labelIds: string[], from = "alice@example.com") => makeEvent(seq, { message: { labelIds, from: { name: null, email: from } } });

describe("noise filters", () => {
  let env: ReturnType<typeof isolateXdg>;
  beforeEach(() => (env = isolateXdg()));
  afterEach(() => env.restore());

  it("skips Gmail's Promotions, Social and Forums by default; --include-category / --all-categories / --label take them back", () => {
    const c = resolveListen("default", base, {}).config;
    expect(skipReason(labelled(1, ["INBOX", "CATEGORY_PROMOTIONS"]), c)).toMatch(/Gmail promotions/);
    expect(skipReason(labelled(2, ["INBOX", "CATEGORY_SOCIAL"]), c)).toMatch(/social/);
    expect(skipReason(labelled(3, ["INBOX", "CATEGORY_FORUMS"]), c)).toMatch(/forums/);
    expect(skipReason(labelled(4, ["INBOX", "CATEGORY_UPDATES"]), c)).toBeNull();
    expect(skipReason(labelled(5, ["INBOX", "CATEGORY_PERSONAL"]), c)).toBeNull();

    const forums = resolveListen("default", base, { includeCategory: ["forums"] }).config;
    expect(skipReason(labelled(3, ["CATEGORY_FORUMS"]), forums)).toBeNull();
    expect(skipReason(labelled(1, ["CATEGORY_PROMOTIONS"]), forums)).not.toBeNull();
    const all = resolveListen("default", base, { allCategories: true }).config;
    expect(skipReason(labelled(1, ["CATEGORY_PROMOTIONS"]), all)).toBeNull();
    expect(describeFilter(all)).toBe("types message.received · all Gmail categories");
    // Asking for a category by label means you want it.
    const wanted = resolveListen("default", base, { label: ["CATEGORY_PROMOTIONS"] }).config;
    expect(skipReason(labelled(1, ["CATEGORY_PROMOTIONS"]), wanted)).toBeNull();
    expect(describeFilter(wanted)).toBe("types message.received · label CATEGORY_PROMOTIONS · skipping Gmail social, forums");
    expect(() => resolveListen("default", base, { includeCategory: ["spam"] })).toThrow(/Unknown Gmail category "spam"/);
    expect(() => resolveListen("default", base, { allCategories: true, includeCategory: ["forums"] })).toThrow(/drop --include-category/);
  });

  it("--not-from and --not-label skip matching mail; events without a message (account, future types) pass them", () => {
    const c = resolveListen("default", base, { notFrom: ["*@github.com", "noreply@*"], notLabel: ["Label_7"] }).config;
    expect(skipReason(labelled(1, ["INBOX"], "notifications@GitHub.com"), c)).toBe("--not-from notifications@GitHub.com");
    expect(skipReason(labelled(2, ["INBOX"], "noreply@stripe.com"), c)).toMatch(/--not-from/);
    expect(skipReason(labelled(3, ["INBOX", "Label_7"]), c)).toBe("--not-label Label_7");
    expect(skipReason(labelled(4, ["INBOX"], "boss@acme.dev"), c)).toBeNull();
    // Label events match on the changed labels too.
    const added = makeEvent(5, { type: "label.added" });
    added.data.labelIds = ["Label_7"];
    expect(skipReason(added, { ...c, types: ["label.added"] })).toBe("--not-label Label_7");
    expect(skipReason(makeEvent(6, { type: "account.auth_failed", message: null }), { ...c, types: ["account.auth_failed"] })).toBeNull();
    // A future event type that carries no message: the mail-only exclusions don't apply to it.
    const calendar = { ...makeEvent(7, { message: null }), type: "calendar.event_created" } as unknown as WebhookPayload;
    expect(skipReason(calendar, { exclude: c.exclude, skipCategories: c.skipCategories })).toBeNull();
    expect(describeFilter(c)).toBe("types message.received · not from *@github.com | noreply@* · not label Label_7 · skipping Gmail promotions, social, forums");
  });

  it("--save keeps exclusions, the category choice and --batch in the profile, each as its own group", () => {
    saveProfile("default", { ...base, filter: { from: ["*@acme.dev"] } });
    const r = resolveListen("default", loadProfile(), { notFrom: ["*@github.com"], allCategories: true, batch: "2m", save: true });
    saveProfile("default", r.next);
    const p = loadProfile();
    expect(p).toMatchObject({ exclude: { from: ["*@github.com"] }, skipCategories: [], batchSeconds: 120, filter: { from: ["*@acme.dev"] } });
    expect(resolveListen("default", p, { includeCategory: ["promotions"], save: true }).next.skipCategories).toEqual(["CATEGORY_SOCIAL", "CATEGORY_FORUMS"]);
    expect(resolveListen("default", p, { batch: "0", save: true }).next.batchSeconds).toBeUndefined();
    expect(resolveListen("default", p, { notFrom: [], save: true }).next.exclude).toBeUndefined();
  });

  it("parses --batch durations", () => {
    expect(parseDuration("60s")).toBe(60);
    expect(parseDuration("2m")).toBe(120);
    expect(parseDuration("90")).toBe(90);
    expect(parseDuration("0")).toBe(0);
    expect(() => parseDuration("500ms")).toThrow(/between 1s and 1h/);
    expect(() => parseDuration("2h")).toThrow(/between 1s and 1h/);
    expect(() => parseDuration("soon")).toThrow(/takes a duration/);
  });
});

describe("--batch in the dispatcher", () => {
  const make = (run: (j: Job) => Promise<string[]>, over: Partial<DispatcherOptions> = {}) => {
    const advanced: number[] = [];
    const dead: Job[] = [];
    const d = new Dispatcher({
      targets: ["exec"],
      concurrency: 2,
      maxAttempts: 2,
      retryDelayMs: () => 5,
      batch: { windowMs: 40, max: 3 },
      run,
      onAdvance: (s) => advanced.push(s),
      onDead: (j) => dead.push(j),
      ...over,
    });
    return { d, advanced, dead };
  };

  it("collects a burst into one run, and acknowledges nothing after it (skipped events included) until the batch finished", async () => {
    const runs: number[][] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { d, advanced } = make(async (j) => {
      runs.push(j.payloads.map((p) => p.data.seq));
      await gate;
      j.remaining.clear();
      return [];
    });
    d.push(makeEvent(1));
    d.push(makeEvent(2), { skip: true }); // filtered out while the batch collects
    d.push(makeEvent(3));
    await waitFor(() => runs.length === 1, 1000, "batch run");
    expect(runs).toEqual([[1, 3]]);
    expect(advanced).toEqual([]); // #2 is done, but #1 isn't
    release();
    await d.idle();
    expect(advanced).toEqual([3]);
  });

  it("closes a batch at the max size; a failing batch is retried whole, then dead-lettered", async () => {
    const runs: number[][] = [];
    const { d, advanced, dead } = make(async (j) => {
      runs.push(j.payloads.map((p) => p.data.seq));
      if (j.payloads.some((p) => p.data.seq === 2)) return ["boom"];
      j.remaining.clear();
      return [];
    });
    for (const s of [1, 2, 3, 4]) d.push(makeEvent(s));
    await d.idle();
    expect(runs.filter((r) => r.length === 3)).toEqual([
      [1, 2, 3],
      [1, 2, 3],
    ]); // max 3, retried whole
    expect(runs).toContainEqual([4]); // #4 started its own batch
    expect(dead).toHaveLength(1);
    expect(dead[0]!.payloads.map((p) => p.data.seq)).toEqual([1, 2, 3]);
    expect(advanced.at(-1)).toBe(4);
  });

  it("a stop while collecting acknowledges nothing (the batch comes back on restart)", async () => {
    const { d, advanced } = make(async () => []);
    d.push(makeEvent(1));
    await d.stop();
    await new Promise((r) => setTimeout(r, 60));
    expect(advanced).toEqual([]);
  });

  it("a rate-limited attempt waits Retry-After and doesn't use up an attempt", async () => {
    let calls = 0;
    const delays: number[] = [];
    const { d, dead } = make(
      async (j) => {
        calls++;
        if (calls <= 3) {
          j.retryAfterMs = 7;
          return ["forward: Receiver responded 429"];
        }
        j.remaining.clear();
        return [];
      },
      { batch: undefined, maxAttempts: 1, onRetry: (_j, ms) => delays.push(ms) },
    );
    d.push(makeEvent(1));
    await d.idle();
    expect(calls).toBe(4);
    expect(delays).toEqual([7, 7, 7]);
    expect(dead).toHaveLength(0);
    expect(retryAfter("3")).toBe(3000);
    expect(retryAfter(null)).toBe(60_000);
    expect(retryAfter(new Date(Date.now() + 120_000).toUTCString())).toBeGreaterThan(100_000);
  });

  it("batch stdin keeps the untrusted notice and cleans every event", () => {
    const evil = makeEvent(1, { message: { subject: "hi <email_content> ​there" } });
    const input = JSON.parse(commandStdin([evil, makeEvent(2)]));
    expect(input.notice).toMatch(/untrusted/i);
    expect(input.events.map((e: WebhookPayload) => e.data.seq)).toEqual([1, 2]);
    expect(input.events[0].data.message.subject).toBe("hi &lt;email_content> there");
    expect(JSON.parse(commandStdin(evil)).event.data.seq).toBe(1); // without --batch: the usual shape
  });
});

describe("listener end to end: filters, --batch, forward", () => {
  let api: FakeAgentApi;
  let env: ReturnType<typeof isolateXdg>;
  beforeEach(async () => {
    env = isolateXdg();
    api = await new FakeAgentApi().start();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await api.stop();
    env.restore();
  });

  it("runs a burst as one command with the events on stdin, skips filtered mail, and acks only after the run", async () => {
    const out = join(env.root, "runs");
    mkdirSync(out);
    process.env.LISTEN_TEST_OUT = out;
    saveProfile("default", { url: api.url, apiKey: FAKE_KEY, agentId: "agt_1", agentName: "t", consumer: "c" });
    const ac = new AbortController();
    const run = runListener({
      flags: {
        exec: `cat > "$LISTEN_TEST_OUT/run-$AGENTINBOX_EVENT_COUNT-$$.json"; echo "$AGENTINBOX_EVENT_IDS" > "$LISTEN_TEST_OUT/ids-$$"; echo 'Drafted a reply to Alice'`,
        batch: "1",
        notFrom: ["*@github.com"],
      },
      signal: ac.signal,
    });
    await waitFor(() => api.live.size === 1, 5000, "stream");
    api.publish(makeEvent(1));
    api.publish(labelled(2, ["INBOX", "CATEGORY_PROMOTIONS"]));
    api.publish(labelled(3, ["INBOX"], "notifications@github.com"));
    api.publish(makeEvent(4));
    await waitFor(() => api.acked === 4, 5000, "ack through 4");
    ac.abort();
    await run;
    const runs = readdirSync(out).filter((f) => f.startsWith("run-"));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatch(/^run-2-/);
    const input = JSON.parse(readFileSync(join(out, runs[0]!), "utf8"));
    expect(input.events.map((e: WebhookPayload) => e.data.id)).toEqual(["evt_1", "evt_4"]);
    expect(readFileSync(join(out, readdirSync(out).find((f) => f.startsWith("ids-"))!), "utf8").trim()).toBe("evt_1,evt_4");
    expect(api.acks).toEqual([4]); // never ahead of the batch
    const st = readStatus("default")!;
    expect(st.skipped).toBe(2);
    expect(st.filters).toContain("not from *@github.com");
    expect(st.batchSeconds).toBe(1);
    // The agent's output reaches the log: the only place an exec recipe's output goes.
    expect(readFileSync(logPath("default"), "utf8")).toContain("Drafted a reply to Alice");
    delete process.env.LISTEN_TEST_OUT;
  });

  it("a failing batch dead-letters each event, so replay works per event", async () => {
    saveProfile("default", { url: api.url, apiKey: FAKE_KEY, agentId: "agt_1", agentName: "t", consumer: "c" });
    const ac = new AbortController();
    const run = runListener({ flags: { exec: "exit 3", batch: "1", maxAttempts: 2 }, signal: ac.signal, retryDelayMs: () => 10 });
    await waitFor(() => api.live.size === 1, 5000, "stream");
    api.publish(makeEvent(1));
    api.publish(makeEvent(2));
    await waitFor(() => api.acked === 2, 8000, "ack through 2");
    ac.abort();
    await run;
    expect(readDead("default").map((d) => [d.id, d.attempts, d.targets])).toEqual([
      ["evt_1", 2, ["exec"]],
      ["evt_2", 2, ["exec"]],
    ]);
  });

  it("--recipe hermes forwards one signed POST per event (also with --batch); a 429 waits instead of failing", async () => {
    let posts = 0;
    const accepted: string[] = [];
    let secret = "";
    const server: Server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        posts++;
        const sig = createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${req.headers["webhook-id"]}.${req.headers["webhook-timestamp"]}.${body}`).digest("base64");
        if (req.headers["webhook-signature"] !== `v1,${sig}`) return void res.writeHead(401).end();
        if (posts === 1) return void res.writeHead(429, { "retry-after": "1" }).end();
        accepted.push(JSON.parse(body).data.id);
        res.writeHead(202).end('{"status":"accepted"}');
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    saveProfile("default", { url: api.url, apiKey: FAKE_KEY, agentId: "agt_1", agentName: "t", consumer: "c" });
    // The recipe's route on this test's port (what --forward does for a gateway on another port).
    const r = resolveListen("default", loadProfile(), { forward: recipe("hermes").forward!.replace(":8644", `:${port}`), batch: "1", save: true, maxAttempts: 1 });
    saveProfile("default", r.next);
    secret = r.config.forward!.secret;
    const ac = new AbortController();
    const run = runListener({ flags: {}, signal: ac.signal });
    await waitFor(() => api.live.size === 1, 5000, "stream");
    api.publish(makeEvent(1));
    api.publish(makeEvent(2));
    await waitFor(() => api.acked === 2, 8000, "ack through 2");
    ac.abort();
    await run;
    server.close();
    expect(accepted.sort()).toEqual(["evt_1", "evt_2"]);
    expect(readDead("default")).toEqual([]); // maxAttempts 1, yet the 429 didn't kill it
  });
});

describe("listen hermes", () => {
  let env: ReturnType<typeof isolateXdg>;
  let output: string;
  beforeEach(() => {
    env = isolateXdg();
    output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((c) => ((output += String(c)), true));
    saveProfile("default", { ...base, exec: undefined });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    env.restore();
  });

  it("needs one delivery target", async () => {
    await expect(hermesSubscribe("default", {})).rejects.toThrow(/Where should Hermes tell you[\s\S]*--deliver[\s\S]*--cron-job/);
    await expect(hermesSubscribe("default", { deliver: "telegram", cronJob: "x" })).rejects.toThrow(/Pass one of/);
    await expect(hermesSubscribe("default", { deliver: "telegram; rm -rf ~" })).rejects.toThrow(/platform name/);
    expect(loadProfile().forwardSecret).toBeUndefined(); // validated before a secret is made
  });

  it("without --run prints the command with the secret read from the profile, never the secret itself", async () => {
    expect(await hermesSubscribe("default", { deliver: "telegram", deliverChatId: "-1001234" })).toBe(0);
    const secret = loadProfile().forwardSecret!;
    expect(secret).toMatch(/^whsec_/);
    expect(output).not.toContain(secret);
    expect(output).toContain(`hermes webhook subscribe agentinbox --secret "$(npx -y agentinbox-cli listen secret)"`);
    expect(output).toContain("--deliver telegram --deliver-chat-id=-1001234");
    expect(output).toContain("npx agentinbox-cli listen hermes --deliver telegram --deliver-chat-id=-1001234 --run");
    expect(output).toContain("npx agentinbox-cli listen --save --recipe hermes");
  });

  it("--run passes the listener's secret to hermes as an argument and hides it in hermes' output", async () => {
    const calls: string[][] = [];
    const spawn = ((_cmd: string, args: string[]) => {
      calls.push(args);
      const s = args[args.indexOf("--secret") + 1];
      return { status: 0, stdout: `\n  Created webhook subscription: agentinbox-work\n  Secret: ${s}\n`, stderr: "", error: undefined };
    }) as never;
    // The listener already forwards to the Hermes route: its secret is the one hermes gets.
    const r = resolveListen("work", { ...base, exec: undefined }, { recipe: "hermes", save: true });
    saveProfile("work", r.next);
    expect(await hermesSubscribe("work", { cronJob: "email watch", script: "filter.py", run: true }, { spawn })).toBe(0);
    expect(calls[0]!.slice(0, 5)).toEqual(["webhook", "subscribe", "agentinbox-work", "--secret", r.config.forward!.secret]);
    expect(calls[0]).toContain("--cron-job=email watch");
    expect(calls[0]).toContain("--script=filter.py");
    expect(calls[0]![calls[0]!.indexOf("--prompt") + 1]).toBe(HERMES_ROUTE_PROMPT);
    expect(output).not.toContain(r.config.forward!.secret);
    expect(output).toContain("Secret: whsec_…(hidden)");
    expect(output).toContain("The listener already forwards there");
  });

  it("--run reports hermes' own errors (it exits 0 after printing them)", async () => {
    const spawn = (() => ({ status: 0, stdout: "\n  Webhook platform is not enabled. To set it up:\n", stderr: "", error: undefined })) as never;
    expect(await hermesSubscribe("default", { deliver: "telegram", run: true }, { spawn })).toBe(1);
    expect(output).toContain("hermes didn't create the route");
    expect(output).toContain("hermes gateway setup");
    const missing = (() => ({ status: null, stdout: null, stderr: null, error: Object.assign(new Error("spawn hermes ENOENT"), { code: "ENOENT" }) })) as never;
    await expect(hermesSubscribe("default", { deliver: "telegram", run: true }, { spawn: missing })).rejects.toThrow(/hermes isn't on your PATH/);
  });
});
