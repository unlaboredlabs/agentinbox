/**
 * In-memory fake of every Google endpoint agentinbox calls (OAuth, Gmail REST, Pub/Sub REST), served by
 * node:http on 127.0.0.1:<random port>. Deterministic and fast; used by unit tests and the end-to-end test.
 *
 *   const g = await startFakeGoogle();
 *   const { ctx } = testContext({}, { google: g.google });       // all four base URLs point at the fake
 *   ctx.google.setClient({ ...FAKE_CLIENT, appType: "internal" }); // the fake only accepts FAKE_CLIENT
 *   g.addAccount("me@example.com", { name: "Me" });
 *   g.consentAs("me@example.com");                                 // next /o/oauth2/v2/auth request consents as this account
 *   const { authUrl } = ctx.google.startConnect();
 *   const res = await fetch(authUrl, { redirect: "manual" });       // 302 → redirect_uri?code=…&state=…
 *   await ctx.google.completeConnectFromUrl(res.headers.get("location")!);
 *   g.deliver("me@example.com", { from: "Bob <bob@x.com>", subject: "Hi", text: "Hello" });
 *   await g.close();
 *
 * State helpers
 *   addAccount(email, { name?, projectAccess?, workspaceDomain? })  create a mailbox (projectAccess=false → Pub/Sub admin calls get
 *                                                  PERMISSION_DENIED; workspaceDomain → the id_token carries hd=<domain>)
 *   addLabel(email, name) → id                     create a user label ("Label_N")
 *   consentAs(email, { deny?, noRefreshToken?, scopes? })  queue the next consent (otherwise the only account, if exactly one exists)
 *   deliver(email, msg) → GmailMessage             incoming mail: builds RFC 5322, adds INBOX+UNREAD (or msg.labelIds), records
 *                                                  history and publishes a Pub/Sub notification if the mailbox is watched
 *   setLabels(email, messageId, add, remove)       label change with history (unknown user label ids are created)
 *   failRefresh(email, { rapt? })                  revoke the user's grant: refresh → 400 invalid_grant (error_subtype invalid_rapt with rapt)
 *   expireAccessTokens(email)                      make cached access tokens invalid (next API call → 401)
 *   expireHistory(email)                           history.list with any cursor obtained before this call → 404
 *   orgPolicyBlocksIam(on)                         setIamPolicy adding a non-org member → 400 FAILED_PRECONDITION (iam.allowedPolicyMemberDomains)
 *   disableApi("gmail" | "pubsub", on)             API calls → 403 SERVICE_DISABLED
 *   failNext({ method?, path, status, reason?, message?, retryAfter?, times?, afterProcessing? })  inject errors for matching
 *                                                  requests (afterProcessing: the request takes effect, then the error is returned)
 *   accessTokenTtl                                 seconds for newly issued access tokens (default 3600)
 *   refreshTokenTtl                                null (default): long-lived refresh tokens. A number simulates an External app in
 *                                                  Testing: new refresh tokens expire after that many seconds (Google: 604800) and
 *                                                  token responses carry refresh_token_expires_in (time left, on refreshes too)
 *   pullWaitMs                                     how long an empty Pub/Sub pull is held open (default 1000;
 *                                                  returnImmediately pulls answer at once)
 *   abortedPulls                                   count of waiting pulls the client cancelled (seen server-side)
 *
 * Inspection
 *   sent(email) / drafts(email) / messages(email) / message(email, id)   format=full Gmail JSON (+ drafts as {id, message})
 *   watch(email)  topics()  subscription(name)  iamPolicy(topic)  revoked (tokens)  requests ({method, path} log)
 *
 * OAuth grants are per user (like Google): revoking any token of a user revokes all of that user's tokens, and
 * consent with include_granted_scopes=true adds to the scopes granted before. Unknown routes (or wrong verbs)
 * get Google's HTML 404. Payload headers keep structured values (From, To, Message-ID, …) raw and decode
 * encoded-words only in free-text headers (Subject).
 *
 * Gmail search (`q`) supports label:, in:, is:, from:, to:, cc:, subject:, has:attachment, newer_than:, older_than:,
 * after:, before:, rfc822msgid:, quoted phrases, free text, -negation, OR, AND, (…) and {…}.
 * messages.send / drafts.create parse the raw RFC 5322 (headers, encoded-words, multipart, base64/QP, attachments)
 * and thread by threadId or In-Reply-To/References. Mail sent to another fake account is delivered to it too.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import addressparser from "nodemailer/lib/addressparser";
import type { Account } from "../shared/types.ts";
import type { Config } from "../server/config.ts";
import type { AppContext } from "../server/context.ts";
import type { EventsService, NewEvent } from "../server/events/types.ts";
import type { GmailHeader, GmailHistoryRecord, GmailLabelRaw, GmailMessage, GmailPart } from "../server/google/types.ts";

export const FAKE_CLIENT = {
  clientId: "fake-client.apps.googleusercontent.com",
  clientSecret: "fake-client-secret",
  projectId: "fake-project",
};

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
export const PUBSUB_SCOPE = "https://www.googleapis.com/auth/pubsub";
const GMAIL_PUSH = "serviceAccount:gmail-api-push@system.gserviceaccount.com";

export interface DeliverInput {
  from: string;
  to?: string;
  cc?: string;
  subject: string;
  text?: string;
  html?: string;
  threadId?: string;
  labelIds?: string[];
  headers?: Record<string, string>;
  attachments?: { filename: string; mimeType: string; content: string | Buffer }[];
  date?: Date;
}

export interface FailRule {
  method?: string;
  path: string | RegExp;
  status: number;
  reason?: string;
  message?: string;
  retryAfter?: number;
  times?: number;
  /** Run the request normally first, then answer with the error (e.g. "sent, then 500"). */
  afterProcessing?: boolean;
}

export interface FakeGoogle {
  url: string;
  google: Config["google"];
  close(): Promise<void>;
  addAccount(email: string, opts?: { name?: string; projectAccess?: boolean; workspaceDomain?: string }): void;
  addLabel(email: string, name: string): string;
  consentAs(email: string, opts?: { deny?: boolean; noRefreshToken?: boolean; scopes?: string[] }): void;
  deliver(email: string, msg: DeliverInput): GmailMessage;
  setLabels(email: string, messageId: string, add: string[], remove: string[]): void;
  failRefresh(email: string, opts?: { rapt?: boolean }): void;
  expireAccessTokens(email: string): void;
  expireHistory(email: string): void;
  orgPolicyBlocksIam(on: boolean): void;
  disableApi(api: "gmail" | "pubsub", on: boolean): void;
  failNext(rule: FailRule): void;
  sent(email: string): GmailMessage[];
  drafts(email: string): { id: string; message: GmailMessage }[];
  messages(email: string): GmailMessage[];
  message(email: string, id: string): GmailMessage | null;
  watch(email: string): { topic: string; expiration: number } | null;
  topics(): string[];
  subscription(name: string): { topic: string; ackDeadlineSeconds: number; outstanding: number; queued: number } | null;
  iamPolicy(topic: string): { bindings: { role: string; members: string[] }[] } | null;
  accessTokenTtl: number;
  refreshTokenTtl: number | null;
  pullWaitMs: number;
  /** Long-poll pulls the client cancelled while they were waiting (seen by the server). */
  abortedPulls: number;
  revoked: string[];
  requests: { method: string; path: string }[];
}

// ───────────── MIME (fake side) ─────────────

function decodeWords(value: string): string {
  if (!value.includes("=?")) return value;
  return value
    .replace(/(\?=)\s+(?==\?)/g, "$1")
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, cs: string, enc: string, text: string) => {
      const bytes =
        enc.toUpperCase() === "B"
          ? Buffer.from(text, "base64")
          : Buffer.from(text.replace(/_/g, " ").replace(/=([0-9a-fA-F]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1");
      try {
        return new TextDecoder(cs.split("*")[0]).decode(bytes);
      } catch {
        return bytes.toString("utf8");
      }
    });
}

const encodeWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString("base64")}?=`);

function encodeAddressHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return addressparser(value, { flatten: true })
    .map((a) => (a.name ? `${encodeWord(a.name)} <${a.address}>` : a.address))
    .join(", ");
}

interface MimeNode {
  headers: GmailHeader[];
  type: string;
  params: Record<string, string>;
  disposition: string;
  dispParams: Record<string, string>;
  body: Buffer;
  children: MimeNode[];
}

function splitHead(buf: Buffer): [string, Buffer] {
  const crlf = buf.indexOf("\r\n\r\n");
  const lf = buf.indexOf("\n\n");
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) return [buf.subarray(0, crlf).toString("latin1"), buf.subarray(crlf + 4)];
  if (lf >= 0) return [buf.subarray(0, lf).toString("latin1"), buf.subarray(lf + 2)];
  return [buf.toString("latin1"), Buffer.alloc(0)];
}

function parseHeaderBlock(head: string): GmailHeader[] {
  const out: GmailHeader[] = [];
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && out.length) out[out.length - 1]!.value += " " + line.trim();
    else {
      const i = line.indexOf(":");
      if (i > 0) out.push({ name: line.slice(0, i).trim(), value: line.slice(i + 1).trim() });
    }
  }
  // Header bytes are UTF-8 when not encoded-words.
  const text = new Set(["subject", "comments", "keywords", "thread-topic"]);
  return out.map((h) => {
    const value = Buffer.from(h.value, "latin1").toString("utf8");
    return { name: h.name, value: text.has(h.name.toLowerCase()) ? decodeWords(value) : value };
  });
}

function parseParams(value: string): { value: string; params: Record<string, string> } {
  const [first, ...rest] = value.split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  const params: Record<string, string> = {};
  const continuations: Record<string, string[]> = {};
  for (const p of rest) {
    const m = /^\s*([^=\s*]+)(\*\d+)?(\*)?\s*=\s*(.*)\s*$/.exec(p);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    let v = m[4]!.trim().replace(/^"(.*)"$/, "$1");
    if (m[3]) {
      const ext = /^([^']*)'[^']*'(.*)$/.exec(v);
      v = decodeURIComponent((ext ? ext[2]! : v).replace(/%(?![0-9a-fA-F]{2})/g, "%25"));
    }
    if (m[2]) (continuations[key] ??= [])[Number(m[2].slice(1))] = v;
    else params[key] = v;
  }
  for (const [k, parts] of Object.entries(continuations)) params[k] = parts.join("");
  return { value: (first ?? "").trim().toLowerCase(), params };
}

function decodeQp(s: string): Buffer {
  const bytes: number[] = [];
  const src = s.replace(/=\r?\n/g, "");
  for (let i = 0; i < src.length; i++) {
    if (src[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(src.slice(i + 1, i + 3))) {
      bytes.push(parseInt(src.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(src.charCodeAt(i) & 0xff);
  }
  return Buffer.from(bytes);
}

function parseMime(buf: Buffer): MimeNode {
  const [head, rawBody] = splitHead(buf);
  const headers = parseHeaderBlock(head);
  const get = (n: string) => headers.find((h) => h.name.toLowerCase() === n)?.value ?? "";
  const ct = parseParams(get("content-type") || "text/plain; charset=utf-8");
  const cd = parseParams(get("content-disposition"));
  const node: MimeNode = {
    headers,
    type: ct.value,
    params: ct.params,
    disposition: cd.value,
    dispParams: cd.params,
    body: Buffer.alloc(0),
    children: [],
  };
  if (ct.value.startsWith("multipart/") && ct.params.boundary) {
    const text = rawBody.toString("latin1");
    const delim = `--${ct.params.boundary}`;
    const pieces = text.split(new RegExp(`(?:^|\\r?\\n)${delim.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    for (const piece of pieces.slice(1)) {
      if (piece.startsWith("--")) break;
      node.children.push(parseMime(Buffer.from(piece.replace(/^[ \t]*\r?\n/, ""), "latin1")));
    }
    return node;
  }
  const cte = get("content-transfer-encoding").toLowerCase();
  if (cte === "base64") node.body = Buffer.from(rawBody.toString("latin1").replace(/\s+/g, ""), "base64");
  else if (cte === "quoted-printable") node.body = decodeQp(rawBody.toString("latin1"));
  else node.body = rawBody.length && rawBody.toString("latin1").endsWith("\r\n") ? rawBody.subarray(0, -2) : rawBody;
  return node;
}

const b64url = (b: Buffer) => b.toString("base64url");

function buildRaw(m: DeliverInput & { to: string; messageId: string }): Buffer {
  const lines: string[] = [];
  const add = (k: string, v: string | undefined) => v && lines.push(`${k}: ${v}`);
  add("From", encodeAddressHeader(m.from));
  add("To", encodeAddressHeader(m.to));
  add("Cc", m.cc && encodeAddressHeader(m.cc));
  add("Subject", encodeWord(m.subject));
  add("Date", (m.date ?? new Date()).toUTCString().replace("GMT", "+0000"));
  add("Message-ID", m.messageId);
  for (const [k, v] of Object.entries(m.headers ?? {})) add(k, v);
  add("MIME-Version", "1.0");
  const leaf = (type: string, content: Buffer, extra: string[] = []) =>
    [`Content-Type: ${type}`, "Content-Transfer-Encoding: base64", ...extra, "", content.toString("base64").replace(/.{76}/g, "$&\r\n")].join("\r\n");
  const multipart = (sub: string, parts: string[]) => {
    const boundary = `----fake${randomBytes(8).toString("hex")}`;
    return [`Content-Type: multipart/${sub}; boundary="${boundary}"`, "", ...parts.map((p) => `--${boundary}\r\n${p}`), `--${boundary}--`, ""].join(
      "\r\n",
    );
  };
  const bodies: string[] = [];
  if (m.text !== undefined || m.html === undefined) bodies.push(leaf("text/plain; charset=utf-8", Buffer.from(m.text ?? "")));
  if (m.html !== undefined) bodies.push(leaf("text/html; charset=utf-8", Buffer.from(m.html)));
  let body = bodies.length > 1 ? multipart("alternative", bodies) : bodies[0]!;
  if (m.attachments?.length) {
    const atts = m.attachments.map((a) => {
      const name = /^[\x20-\x7e]*$/.test(a.filename) ? `filename="${a.filename}"` : `filename*=utf-8''${encodeURIComponent(a.filename)}`;
      return leaf(a.mimeType, Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content), [`Content-Disposition: attachment; ${name}`]);
    });
    body = multipart("mixed", [body, ...atts]);
  }
  return Buffer.from(lines.join("\r\n") + "\r\n" + body, "utf8");
}

// ───────────── State ─────────────

interface StoredMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  internalDate: number;
  historyId: number;
  raw: Buffer;
  payload: GmailPart;
  snippet: string;
  attachments: Map<string, Buffer>;
  messageIdHeader: string | null;
  hasAttachment: boolean;
  search: { from: string; to: string; cc: string; subject: string; text: string };
}

interface Mailbox {
  email: string;
  name: string;
  historyId: number;
  minHistoryId: number;
  messages: Map<string, StoredMessage>;
  history: GmailHistoryRecord[];
  labels: Map<string, GmailLabelRaw>;
  drafts: Map<string, string>;
  watch: { topic: string; expiration: number } | null;
  projectAccess: boolean;
  nextLabel: number;
  workspaceDomain: string | null;
}

interface Token {
  email: string;
  scopes: string[];
  expiresAt: number;
  revoked: boolean;
  /** Grant generation this token belongs to; revoking the grant bumps it. */
  gen: number;
}

interface PubsubMessage {
  data: string;
  messageId: string;
  publishTime: string;
  attributes?: Record<string, string>;
  attempts: number;
}

interface Subscription {
  topic: string;
  ackDeadlineSeconds: number;
  queue: PubsubMessage[];
  outstanding: Map<string, { msg: PubsubMessage; deadline: number }>;
  waiters: Set<() => void>;
}

const SYSTEM_LABELS = [
  "INBOX",
  "SENT",
  "DRAFT",
  "SPAM",
  "TRASH",
  "UNREAD",
  "STARRED",
  "IMPORTANT",
  "CHAT",
  "CATEGORY_PERSONAL",
  "CATEGORY_SOCIAL",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
];

class HttpFail extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    readonly headers: Record<string, string> = {},
  ) {
    super(`HTTP ${status}`);
  }
}

const STATUS_TEXT: Record<number, string> = {
  400: "INVALID_ARGUMENT",
  401: "UNAUTHENTICATED",
  403: "PERMISSION_DENIED",
  404: "NOT_FOUND",
  409: "ALREADY_EXISTS",
  429: "RESOURCE_EXHAUSTED",
  500: "INTERNAL",
  503: "UNAVAILABLE",
};

const apiError = (status: number, message: string, reason?: string, extra: { status?: string; details?: unknown[] } = {}) =>
  new HttpFail(status, {
    error: {
      code: status,
      message,
      status: extra.status ?? STATUS_TEXT[status] ?? "UNKNOWN",
      errors: [{ message, domain: "global", reason: reason ?? (STATUS_TEXT[status] ?? "error").toLowerCase() }],
      ...(extra.details ? { details: extra.details } : {}),
    },
  });

const serviceDisabled = (service: "gmail" | "pubsub") => {
  const name = service === "gmail" ? "Gmail API" : "Cloud Pub/Sub API";
  const host = `${service}.googleapis.com`;
  return apiError(
    403,
    `${name} has not been used in project 123456789 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/${host}/overview?project=123456789 then retry.`,
    "accessNotConfigured",
    {
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason: "SERVICE_DISABLED",
          domain: "googleapis.com",
          metadata: { service: host, consumer: "projects/123456789" },
        },
      ],
    },
  );
};

function sha256b64url(s: string): string {
  return createHash("sha256").update(s).digest("base64url");
}

export async function startFakeGoogle(): Promise<FakeGoogle> {
  const mailboxes = new Map<string, Mailbox>();
  const accessTokens = new Map<string, Token>();
  const refreshTokens = new Map<string, Token>();
  /** Per-user OAuth grant for the fake client. */
  const grants = new Map<string, { scopes: Set<string>; gen: number; rapt: boolean }>();
  const grantOf = (email: string) => {
    let g = grants.get(email);
    if (!g) grants.set(email, (g = { scopes: new Set(), gen: 0, rapt: false }));
    return g;
  };
  const revokeGrant = (email: string, rapt = false) => {
    const g = grantOf(email);
    g.gen++;
    g.scopes.clear();
    g.rapt = rapt;
  };
  const valid = (t: Token | undefined): t is Token => Boolean(t && !t.revoked && t.gen === grantOf(t.email).gen);
  const codes = new Map<string, { email: string; scopes: string[]; challenge: string; redirectUri: string; noRefreshToken: boolean }>();
  const consents: { email: string; deny?: boolean; noRefreshToken?: boolean; scopes?: string[] }[] = [];
  const topics = new Map<string, { policy: { version: number; etag: string; bindings: { role: string; members: string[] }[] } }>();
  const subs = new Map<string, Subscription>();
  const failRules: (FailRule & { left: number })[] = [];
  const disabled = new Set<string>();
  let orgPolicy = false;
  let idCounter = 0x18f2a00000000000n;
  let seq = 0;
  const newMsgId = () => (idCounter++).toString(16);
  const token = (prefix: string) => `${prefix}${randomBytes(12).toString("hex")}`;

  const box = (email: string): Mailbox => {
    const mb = mailboxes.get(email.toLowerCase());
    if (!mb) throw new Error(`fake-google: unknown account ${email}`);
    return mb;
  };

  // ───── Gmail model ─────

  const labelName = (mb: Mailbox, id: string) => mb.labels.get(id)?.name ?? id;
  const normLabel = (s: string) => s.toLowerCase().replace(/[\s/]+/g, "-");

  function ensureLabel(mb: Mailbox, id: string) {
    if (!mb.labels.has(id)) mb.labels.set(id, { id, name: id, type: "user" });
  }

  function format(m: StoredMessage, fmt = "full", metadataHeaders?: string[]): GmailMessage {
    const base: GmailMessage = {
      id: m.id,
      threadId: m.threadId,
      labelIds: [...m.labelIds],
      snippet: m.snippet,
      historyId: String(m.historyId),
      internalDate: String(m.internalDate),
      sizeEstimate: m.raw.length,
    };
    if (fmt === "minimal") return base;
    if (fmt === "raw") return { ...base, raw: b64url(m.raw) };
    if (fmt === "metadata") {
      const wanted = metadataHeaders?.map((h) => h.toLowerCase());
      const headers = (m.payload.headers ?? []).filter((h) => !wanted?.length || wanted.includes(h.name.toLowerCase()));
      return { ...base, payload: { partId: "", mimeType: m.payload.mimeType, filename: "", headers, body: { size: 0 } } };
    }
    return { ...base, payload: structuredClone(m.payload) };
  }

  function toPart(node: MimeNode, partId: string, atts: Map<string, Buffer>): GmailPart {
    const filename = node.dispParams.filename ?? node.params.name ?? "";
    const part: GmailPart = { partId, mimeType: node.type, filename, headers: node.headers, body: { size: 0 } };
    if (node.type.startsWith("multipart/")) {
      part.parts = node.children.map((c, i) => toPart(c, partId ? `${partId}.${i}` : String(i), atts));
    } else if (filename || node.disposition === "attachment") {
      const attachmentId = `ANGjdJ_${sha256b64url(`${seq++}:${partId}`).slice(0, 24)}`;
      atts.set(attachmentId, node.body);
      part.body = { attachmentId, size: node.body.length };
    } else {
      part.body = { size: node.body.length, data: b64url(node.body) };
    }
    return part;
  }

  function firstText(node: MimeNode): string {
    const leaves: MimeNode[] = [];
    (function walk(n: MimeNode): void {
      if (n.children.length) n.children.forEach(walk);
      else leaves.push(n);
    })(node);
    const body = (n: MimeNode) => {
      try {
        return new TextDecoder(n.params.charset ?? "utf-8").decode(n.body);
      } catch {
        return n.body.toString("utf8");
      }
    };
    const plain = leaves.find((n) => n.type === "text/plain" && !n.dispParams.filename);
    if (plain) return body(plain);
    const html = leaves.find((n) => n.type === "text/html");
    return html ? body(html).replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ") : "";
  }

  const escapeSnippet = (s: string) =>
    s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

  function makeMessage(mb: Mailbox, raw: Buffer, labelIds: string[], threadHint: string | null, date?: Date): StoredMessage {
    const node = parseMime(raw);
    const header = (n: string) => node.headers.find((h) => h.name.toLowerCase() === n)?.value ?? "";
    const atts = new Map<string, Buffer>();
    const payload = toPart(node, "", atts);
    const id = newMsgId();
    const refs: string[] = `${header("in-reply-to")} ${header("references")}`.match(/<[^<>\s]+>/g) ?? [];
    let threadId: string | null = threadHint && [...mb.messages.values()].some((m) => m.threadId === threadHint) ? threadHint : null;
    if (!threadId && refs.length) {
      threadId = [...mb.messages.values()].find((m) => m.messageIdHeader && refs.includes(m.messageIdHeader))?.threadId ?? null;
    }
    const text = firstText(node);
    for (const l of labelIds) ensureLabel(mb, l);
    return {
      id,
      threadId: threadId ?? id,
      labelIds: [...new Set(labelIds)],
      internalDate: (date ?? new Date()).getTime(),
      historyId: mb.historyId,
      raw,
      payload,
      snippet: escapeSnippet(text.replace(/\s+/g, " ").trim().slice(0, 200)),
      attachments: atts,
      messageIdHeader: header("message-id").match(/<[^<>\s]+>/)?.[0] ?? null,
      hasAttachment: atts.size > 0,
      search: { from: header("from"), to: `${header("to")} ${header("bcc")}`, cc: header("cc"), subject: header("subject"), text },
    };
  }

  function publish(topicName: string, data: string, attributes?: Record<string, string>): string {
    const messageId = String(1_000_000 + seq++);
    for (const sub of subs.values()) {
      if (sub.topic !== topicName) continue;
      sub.queue.push({ data, messageId, publishTime: new Date().toISOString(), attributes, attempts: 0 });
      for (const w of sub.waiters) w();
    }
    return messageId;
  }

  const canPublish = (topic: string) =>
    topics.get(topic)?.policy.bindings.some((b) => b.role === "roles/pubsub.publisher" && b.members.includes(GMAIL_PUSH)) ?? false;

  function record(mb: Mailbox, rec: Omit<GmailHistoryRecord, "id">, touched: StoredMessage[]) {
    mb.historyId++;
    for (const m of touched) m.historyId = mb.historyId;
    mb.history.push({ id: String(mb.historyId), ...rec });
    if (mb.watch && mb.watch.expiration > Date.now() && canPublish(mb.watch.topic)) {
      publish(mb.watch.topic, Buffer.from(JSON.stringify({ emailAddress: mb.email, historyId: mb.historyId })).toString("base64"));
    }
  }

  const ref = (m: StoredMessage) => ({ id: m.id, threadId: m.threadId, labelIds: [...m.labelIds] });

  function insert(mb: Mailbox, m: StoredMessage) {
    mb.messages.set(m.id, m);
    record(mb, { messages: [ref(m)], messagesAdded: [{ message: ref(m) }] }, [m]);
  }

  function remove(mb: Mailbox, m: StoredMessage) {
    mb.messages.delete(m.id);
    record(mb, { messages: [ref(m)], messagesDeleted: [{ message: ref(m) }] }, []);
  }

  function modify(mb: Mailbox, m: StoredMessage, add: string[], removeIds: string[]) {
    for (const l of add) ensureLabel(mb, l);
    const added = add.filter((l) => !m.labelIds.includes(l));
    const removed = removeIds.filter((l) => m.labelIds.includes(l) && !add.includes(l));
    if (added.length) {
      m.labelIds.push(...added);
      record(mb, { messages: [ref(m)], labelsAdded: [{ message: ref(m), labelIds: added }] }, [m]);
    }
    if (removed.length) {
      m.labelIds = m.labelIds.filter((l) => !removed.includes(l));
      record(mb, { messages: [ref(m)], labelsRemoved: [{ message: ref(m), labelIds: removed }] }, [m]);
    }
  }

  const msgOr404 = (mb: Mailbox, id: string) => {
    const m = mb.messages.get(id);
    if (!m) throw apiError(404, "Requested entity was not found.", "notFound");
    return m;
  };

  const threadMessages = (mb: Mailbox, threadId: string) =>
    [...mb.messages.values()].filter((m) => m.threadId === threadId).sort((a, b) => a.internalDate - b.internalDate);

  /** Sends raw mail from `mb` and delivers copies to recipients that are fake accounts. */
  function sendRaw(mb: Mailbox, raw: Buffer, threadId: string | null): StoredMessage {
    let bytes = raw;
    if (!/^message-id:/im.test(splitHead(raw)[0])) {
      bytes = Buffer.concat([Buffer.from(`Message-ID: <fake-${randomBytes(8).toString("hex")}@mail.gmail.com>\r\n`), raw]);
    }
    const head = parseHeaderBlock(splitHead(bytes)[0]);
    const hv = (n: string) => head.find((h) => h.name.toLowerCase() === n)?.value ?? "";
    const rcpts = addressparser(`${hv("to")}, ${hv("cc")}, ${hv("bcc")}`, { flatten: true }).map((a) => a.address.toLowerCase());
    const labels = ["SENT", ...(rcpts.includes(mb.email) ? ["INBOX", "UNREAD"] : [])];
    const m = makeMessage(mb, bytes, labels, threadId);
    insert(mb, m);
    for (const r of new Set(rcpts)) {
      const other = mailboxes.get(r);
      if (other && other !== mb) insert(other, makeMessage(other, bytes, ["INBOX", "UNREAD"], null));
    }
    return m;
  }

  // ───── Gmail search ─────

  type Pred = (m: StoredMessage, mb: Mailbox) => boolean;

  function tokenize(q: string): string[] {
    const out: string[] = [];
    const re = /\s*(\(|\)|\{|\}|-?[a-zA-Z_]+:"[^"]*"|-?"[^"]*"|[^\s(){}]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(q))) out.push(m[1]!);
    return out;
  }

  const DURATION: Record<string, number> = { h: 3600e3, d: 86400e3, m: 30 * 86400e3, y: 365 * 86400e3 };
  const IN: Record<string, string> = { inbox: "INBOX", sent: "SENT", spam: "SPAM", trash: "TRASH", drafts: "DRAFT", draft: "DRAFT", starred: "STARRED", important: "IMPORTANT", chats: "CHAT" };

  function term(tok: string): Pred {
    const t = tok.replace(/^"(.*)"$/, "$1");
    const m = /^([a-zA-Z_]+):(.*)$/.exec(t);
    const has = (hay: string, needle: string) => hay.toLowerCase().includes(needle.toLowerCase());
    if (!m) {
      return (msg, mb) =>
        [msg.search.subject, msg.search.from, msg.search.to, msg.search.cc, msg.search.text, msg.labelIds.map((l) => labelName(mb, l)).join(" ")].some(
          (h) => has(h, t),
        );
    }
    const key = m[1]!.toLowerCase();
    const val = m[2]!.replace(/^"(.*)"$/, "$1");
    const date = (s: string) => (/^\d+$/.test(s) ? Number(s) * 1000 : Date.parse(s.replace(/\//g, "-")));
    switch (key) {
      case "label":
        return (msg, mb) => msg.labelIds.some((l) => normLabel(l) === normLabel(val) || normLabel(labelName(mb, l)) === normLabel(val));
      case "in":
        return val.toLowerCase() === "anywhere" ? () => true : (msg) => msg.labelIds.includes(IN[val.toLowerCase()] ?? val.toUpperCase());
      case "is":
        if (val === "read") return (msg) => !msg.labelIds.includes("UNREAD");
        return (msg) => msg.labelIds.includes(val.toUpperCase());
      case "from":
      case "to":
      case "cc":
      case "subject":
        return (msg) => has(msg.search[key], val);
      case "has":
        return (msg) => (val === "attachment" ? msg.hasAttachment : false);
      case "newer_than":
      case "older_than": {
        const d = /^(\d+)([hdmy])$/.exec(val);
        const ms = d ? Number(d[1]) * DURATION[d[2]!]! : 0;
        return key === "newer_than" ? (msg) => msg.internalDate >= Date.now() - ms : (msg) => msg.internalDate < Date.now() - ms;
      }
      case "after":
        return (msg) => msg.internalDate >= date(val);
      case "before":
        return (msg) => msg.internalDate < date(val);
      case "rfc822msgid":
        return (msg) => msg.messageIdHeader === (val.startsWith("<") ? val : `<${val}>`);
      default:
        return (msg) => has(msg.search.text, t);
    }
  }

  function parseQuery(q: string): Pred {
    const toks = tokenize(q);
    let i = 0;
    const orExpr = (end?: string): Pred => {
      const alts: Pred[] = [andExpr(end)];
      while (toks[i] === "OR") {
        i++;
        alts.push(andExpr(end));
      }
      return alts.length === 1 ? alts[0]! : (m, mb) => alts.some((p) => p(m, mb));
    };
    const andExpr = (end?: string): Pred => {
      const all: Pred[] = [];
      while (i < toks.length && toks[i] !== "OR" && toks[i] !== ")" && toks[i] !== end) {
        if (toks[i] === "AND") {
          i++;
          continue;
        }
        all.push(unary());
      }
      return (m, mb) => all.every((p) => p(m, mb));
    };
    const unary = (): Pred => {
      const tok = toks[i++]!;
      if (tok === "-") {
        const p = unary();
        return (m, mb) => !p(m, mb);
      }
      if (tok === "(") {
        const p = orExpr();
        if (toks[i] === ")") i++;
        return p;
      }
      if (tok === "{") {
        const alts: Pred[] = [];
        while (i < toks.length && toks[i] !== "}") alts.push(unary());
        i++;
        return (m, mb) => alts.some((p) => p(m, mb));
      }
      if (tok.startsWith("-") && tok.length > 1) {
        const p = term(tok.slice(1));
        return (m, mb) => !p(m, mb);
      }
      return term(tok);
    };
    return orExpr();
  }

  function search(mb: Mailbox, query: URLSearchParams): StoredMessage[] {
    const q = query.get("q") ?? "";
    const labelIds = query.getAll("labelIds");
    const includeSpamTrash = query.get("includeSpamTrash") === "true" || /\b(in|label):(spam|trash|anywhere)\b/i.test(q);
    const pred = q.trim() ? parseQuery(q) : () => true;
    return [...mb.messages.values()]
      .filter((m) => includeSpamTrash || !m.labelIds.some((l) => l === "SPAM" || l === "TRASH"))
      .filter((m) => labelIds.every((l) => m.labelIds.includes(l)))
      .filter((m) => pred(m, mb))
      .sort((a, b) => b.internalDate - a.internalDate || (BigInt(`0x${b.id}`) > BigInt(`0x${a.id}`) ? 1 : -1));
  }

  function page<T>(items: T[], query: URLSearchParams, def = 100): { items: T[]; next: string | null } {
    const start = Number(query.get("pageToken") ?? 0) || 0;
    const max = Math.min(Number(query.get("maxResults") ?? def) || def, 500);
    const slice = items.slice(start, start + max);
    return { items: slice, next: start + max < items.length ? String(start + max) : null };
  }

  // ───── Auth ─────

  function bearer(req: IncomingMessage, scope: string, api: "gmail" | "pubsub"): Token {
    const t = accessTokens.get((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
    if (!valid(t) || t.expiresAt < Date.now()) {
      throw apiError(401, "Request had invalid authentication credentials. Expected OAuth 2 access token.", "authError");
    }
    if (!t.scopes.includes(scope)) {
      throw apiError(403, "Request had insufficient authentication scopes.", "insufficientPermissions", {
        details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT", domain: "googleapis.com" }],
      });
    }
    if (disabled.has(api)) throw serviceDisabled(api);
    return t;
  }

  function issueAccess(email: string, scopes: string[]): string {
    const at = token("ya29.fake-");
    accessTokens.set(at, { email, scopes, expiresAt: Date.now() + fake.accessTokenTtl * 1000, revoked: false, gen: grantOf(email).gen });
    return at;
  }

  // ───── HTTP plumbing ─────

  type Handler = (req: IncomingMessage, url: URL, body: Buffer, m: RegExpExecArray, res: ServerResponse) => unknown | Promise<unknown>;
  const routes: [string, RegExp, Handler][] = [];
  const on = (method: string, re: RegExp, h: Handler) => routes.push([method, re, h]);

  const json = (body: Buffer): Record<string, unknown> => {
    try {
      return body.length ? (JSON.parse(body.toString("utf8")) as Record<string, unknown>) : {};
    } catch {
      throw apiError(400, "Invalid JSON payload received.");
    }
  };
  const form = (body: Buffer, url: URL) => {
    const p = new URLSearchParams(body.toString("utf8"));
    for (const [k, v] of url.searchParams) if (!p.has(k)) p.set(k, v);
    return p;
  };
  const oauthFail = (status: number, error: string, description: string) => new HttpFail(status, { error, error_description: description });

  // OAuth consent
  on("GET", /^\/o\/oauth2\/v2\/auth$/, (_req, url, _b, _m, res) => {
    const q = url.searchParams;
    const redirect = q.get("redirect_uri");
    if (q.get("client_id") !== FAKE_CLIENT.clientId) throw new HttpFail(401, "Error 401: invalid_client");
    if (!redirect || q.get("response_type") !== "code") throw new HttpFail(400, "Error 400: invalid_request");
    if (q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) throw new HttpFail(400, "Error 400: PKCE required");
    const consent = consents.shift() ?? (mailboxes.size === 1 ? { email: [...mailboxes.keys()][0]! } : null);
    if (!consent) throw new HttpFail(400, "fake-google: no consent queued (call consentAs)");
    const target = new URL(redirect);
    const state = q.get("state");
    if (consent.deny) {
      target.searchParams.set("error", "access_denied");
    } else {
      const requested = (q.get("scope") ?? "").split(/\s+/).filter(Boolean);
      let scopes = consent.scopes ?? requested.map((s) => (s === "email" ? "https://www.googleapis.com/auth/userinfo.email" : s));
      const grant = grantOf(consent.email);
      if (q.get("include_granted_scopes") === "true") scopes = [...new Set([...grant.scopes, ...scopes])];
      grant.scopes = new Set(scopes);
      grant.rapt = false;
      const code = token("4/0fake-");
      codes.set(code, { email: consent.email, scopes, challenge: q.get("code_challenge")!, redirectUri: redirect, noRefreshToken: Boolean(consent.noRefreshToken) });
      target.searchParams.set("code", code);
      target.searchParams.set("scope", scopes.join(" "));
    }
    if (state) target.searchParams.set("state", state);
    res.writeHead(302, { location: target.toString() }).end();
  });

  on("POST", /^\/token$/, (_req, url, body) => {
    const p = form(body, url);
    if (p.get("client_id") !== FAKE_CLIENT.clientId || p.get("client_secret") !== FAKE_CLIENT.clientSecret) {
      throw oauthFail(401, "invalid_client", "The OAuth client was not found.");
    }
    if (p.get("grant_type") === "authorization_code") {
      const c = codes.get(p.get("code") ?? "");
      codes.delete(p.get("code") ?? "");
      if (!c) throw oauthFail(400, "invalid_grant", "Malformed auth code.");
      if (c.redirectUri !== p.get("redirect_uri")) throw oauthFail(400, "redirect_uri_mismatch", "Bad Request");
      if (sha256b64url(p.get("code_verifier") ?? "") !== c.challenge) throw oauthFail(400, "invalid_grant", "Invalid code verifier.");
      const mb = box(c.email);
      const out: Record<string, unknown> = {
        access_token: issueAccess(mb.email, c.scopes),
        expires_in: fake.accessTokenTtl,
        scope: c.scopes.join(" "),
        token_type: "Bearer",
      };
      if (!c.noRefreshToken) {
        const rt = token("1//fake-rt-");
        const ttl = fake.refreshTokenTtl;
        refreshTokens.set(rt, { email: mb.email, scopes: c.scopes, expiresAt: ttl ? Date.now() + ttl * 1000 : Infinity, revoked: false, gen: grantOf(mb.email).gen });
        out.refresh_token = rt;
        if (ttl) out.refresh_token_expires_in = ttl;
      }
      if (c.scopes.includes("openid")) {
        const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
        const claims = { iss: "https://accounts.google.com", email: mb.email, name: mb.name, sub: mb.email, ...(mb.workspaceDomain ? { hd: mb.workspaceDomain } : {}) };
        out.id_token = `${enc({ alg: "none" })}.${enc(claims)}.`;
      }
      return out;
    }
    if (p.get("grant_type") === "refresh_token") {
      const rt = refreshTokens.get(p.get("refresh_token") ?? "");
      if (rt && rt.gen !== grantOf(rt.email).gen && grantOf(rt.email).rapt) {
        throw new HttpFail(400, { error: "invalid_grant", error_description: "reauth related error (invalid_rapt)", error_subtype: "invalid_rapt" });
      }
      if (!valid(rt) || rt.expiresAt <= Date.now()) throw oauthFail(400, "invalid_grant", "Token has been expired or revoked.");
      return {
        access_token: issueAccess(rt.email, rt.scopes),
        expires_in: fake.accessTokenTtl,
        scope: rt.scopes.join(" "),
        token_type: "Bearer",
        ...(Number.isFinite(rt.expiresAt) ? { refresh_token_expires_in: Math.floor((rt.expiresAt - Date.now()) / 1000) } : {}),
      };
    }
    throw oauthFail(400, "unsupported_grant_type", "Invalid grant_type.");
  });

  on("POST", /^\/revoke$/, (_req, url, body) => {
    const t = form(body, url).get("token") ?? "";
    const found = refreshTokens.get(t) ?? accessTokens.get(t);
    if (!valid(found)) throw oauthFail(400, "invalid_token", "Token expired or revoked");
    // Like Google: revoking one token removes the user's whole grant for this client.
    revokeGrant(found.email);
    fake.revoked.push(t);
    return {};
  });

  // Gmail
  const G = "^/gmail/v1/users/me";
  const gmailRoute = (method: string, path: string, h: (mb: Mailbox, url: URL, body: Buffer, m: RegExpExecArray) => unknown) =>
    on(method, new RegExp(`${G}${path}$`), (req, url, body, m) => h(box(bearer(req, GMAIL_SCOPE, "gmail").email), url, body, m));

  gmailRoute("GET", "/profile", (mb) => ({
    emailAddress: mb.email,
    messagesTotal: mb.messages.size,
    threadsTotal: new Set([...mb.messages.values()].map((m) => m.threadId)).size,
    historyId: String(mb.historyId),
  }));

  gmailRoute("GET", "/messages", (mb, url) => {
    const all = search(mb, url.searchParams);
    const { items, next } = page(all, url.searchParams);
    return {
      ...(items.length ? { messages: items.map((m) => ({ id: m.id, threadId: m.threadId })) } : {}),
      ...(next ? { nextPageToken: next } : {}),
      resultSizeEstimate: all.length,
    };
  });

  gmailRoute("GET", "/messages/([^/]+)", (mb, url, _b, m) =>
    format(msgOr404(mb, m[1]!), url.searchParams.get("format") ?? "full", url.searchParams.getAll("metadataHeaders")),
  );

  gmailRoute("GET", "/messages/([^/]+)/attachments/([^/]+)", (mb, _u, _b, m) => {
    const data = msgOr404(mb, m[1]!).attachments.get(m[2]!);
    if (!data) throw apiError(404, "Requested entity was not found.", "notFound");
    return { attachmentId: m[2], size: data.length, data: b64url(data) };
  });

  gmailRoute("POST", "/messages/([^/]+)/modify", (mb, _u, body, m) => {
    const msg = msgOr404(mb, m[1]!);
    const b = json(body) as { addLabelIds?: string[]; removeLabelIds?: string[] };
    modify(mb, msg, b.addLabelIds ?? [], b.removeLabelIds ?? []);
    return format(msg, "minimal");
  });

  gmailRoute("POST", "/messages/([^/]+)/trash", (mb, _u, _b, m) => {
    const msg = msgOr404(mb, m[1]!);
    modify(mb, msg, ["TRASH"], ["INBOX"]);
    return format(msg, "minimal");
  });

  gmailRoute("POST", "/messages/send", (mb, _u, body) => {
    const b = json(body) as { raw?: string; threadId?: string };
    if (!b.raw) throw apiError(400, "Invalid value for ByteString: raw is required", "invalidArgument");
    return format(sendRaw(mb, Buffer.from(b.raw, "base64url"), b.threadId ?? null), "minimal");
  });

  gmailRoute("GET", "/threads", (mb, url) => {
    const matched = search(mb, url.searchParams);
    const ids = [...new Set(matched.map((m) => m.threadId))];
    const all = ids.map((id) => {
      const msgs = threadMessages(mb, id);
      const last = msgs.at(-1)!;
      return { id, snippet: last.snippet, historyId: String(Math.max(...msgs.map((x) => x.historyId))) };
    });
    const { items, next } = page(all, url.searchParams);
    return { ...(items.length ? { threads: items } : {}), ...(next ? { nextPageToken: next } : {}), resultSizeEstimate: all.length };
  });

  const threadOr404 = (mb: Mailbox, id: string) => {
    const msgs = threadMessages(mb, id);
    if (!msgs.length) throw apiError(404, "Requested entity was not found.", "notFound");
    return msgs;
  };

  gmailRoute("GET", "/threads/([^/]+)", (mb, url, _b, m) => {
    const msgs = threadOr404(mb, m[1]!);
    const fmt = url.searchParams.get("format") ?? "full";
    return {
      id: m[1],
      historyId: String(Math.max(...msgs.map((x) => x.historyId))),
      messages: msgs.map((x) => format(x, fmt, url.searchParams.getAll("metadataHeaders"))),
    };
  });

  gmailRoute("POST", "/threads/([^/]+)/modify", (mb, _u, body, m) => {
    const b = json(body) as { addLabelIds?: string[]; removeLabelIds?: string[] };
    const msgs = threadOr404(mb, m[1]!);
    for (const x of msgs) modify(mb, x, b.addLabelIds ?? [], b.removeLabelIds ?? []);
    return { id: m[1], messages: msgs.map((x) => format(x, "minimal")) };
  });

  gmailRoute("POST", "/threads/([^/]+)/trash", (mb, _u, _b, m) => {
    const msgs = threadOr404(mb, m[1]!);
    for (const x of msgs) modify(mb, x, ["TRASH"], ["INBOX"]);
    return { id: m[1], messages: msgs.map((x) => format(x, "minimal")) };
  });

  gmailRoute("GET", "/labels", (mb) => ({
    labels: [...mb.labels.values()].map((l) => ({
      ...l,
      ...(l.type === "user" ? { messageListVisibility: "show", labelListVisibility: "labelShow" } : {}),
    })),
  }));

  const draftOr404 = (mb: Mailbox, id: string) => {
    const msgId = mb.drafts.get(id);
    const msg = msgId ? mb.messages.get(msgId) : undefined;
    if (!msgId || !msg) throw apiError(404, "Requested entity was not found.", "notFound");
    return msg;
  };

  gmailRoute("POST", "/drafts", (mb, _u, body) => {
    const b = json(body) as { message?: { raw?: string; threadId?: string } };
    if (!b.message?.raw) throw apiError(400, "Missing draft message", "invalidArgument");
    const msg = makeMessage(mb, Buffer.from(b.message.raw, "base64url"), ["DRAFT"], b.message.threadId ?? null);
    insert(mb, msg);
    const id = `r${(seq++).toString().padStart(19, "0")}`;
    mb.drafts.set(id, msg.id);
    return { id, message: format(msg, "minimal") };
  });

  gmailRoute("GET", "/drafts/([^/]+)", (mb, url, _b, m) => ({
    id: m[1],
    message: format(draftOr404(mb, m[1]!), url.searchParams.get("format") ?? "full"),
  }));

  gmailRoute("DELETE", "/drafts/([^/]+)", (mb, _u, _b, m) => {
    remove(mb, draftOr404(mb, m[1]!));
    mb.drafts.delete(m[1]!);
    return undefined;
  });

  gmailRoute("POST", "/drafts/send", (mb, _u, body) => {
    const b = json(body) as { id?: string };
    const draft = draftOr404(mb, b.id ?? "");
    mb.drafts.delete(b.id!);
    remove(mb, draft);
    return format(sendRaw(mb, draft.raw, draft.threadId), "minimal");
  });

  gmailRoute("GET", "/history", (mb, url) => {
    const start = Number(url.searchParams.get("startHistoryId"));
    if (!Number.isFinite(start) || start < mb.minHistoryId) throw apiError(404, "Requested entity was not found.", "notFound");
    const types = url.searchParams.getAll("historyTypes");
    const key: Record<string, keyof GmailHistoryRecord> = {
      messageAdded: "messagesAdded",
      messageDeleted: "messagesDeleted",
      labelAdded: "labelsAdded",
      labelRemoved: "labelsRemoved",
    };
    const wanted = types.length ? types.map((t) => key[t]) : Object.values(key);
    const records = mb.history
      .filter((r) => Number(r.id) > start)
      .map((r) => {
        const out: GmailHistoryRecord = { id: r.id, messages: r.messages };
        for (const k of wanted) if (k && r[k]) (out as unknown as Record<string, unknown>)[k] = r[k];
        return out;
      })
      .filter((r) => wanted.some((k) => k && k in r));
    const { items, next } = page(records, url.searchParams);
    return { ...(items.length ? { history: items } : {}), ...(next ? { nextPageToken: next } : {}), historyId: String(mb.historyId) };
  });

  gmailRoute("POST", "/watch", (mb, _u, body) => {
    const b = json(body) as { topicName?: string };
    const topic = b.topicName ?? "";
    if (!topics.has(topic)) throw apiError(404, `Resource not found (resource=${topic.split("/").pop()}).`, "notFound");
    if (!canPublish(topic)) {
      throw apiError(403, `Error sending test message to Cloud PubSub ${topic} : User not authorized to perform this action.`, "forbidden");
    }
    mb.watch = { topic, expiration: Date.now() + 7 * 86400e3 };
    return { historyId: String(mb.historyId), expiration: String(mb.watch.expiration) };
  });

  gmailRoute("POST", "/stop", (mb) => {
    mb.watch = null;
    return undefined;
  });

  // Pub/Sub
  const pubsubRoute = (method: string, re: RegExp, h: (url: URL, body: Buffer, m: RegExpExecArray, res: ServerResponse) => unknown) =>
    on(method, re, (req, url, body, m, res) => {
      const t = bearer(req, PUBSUB_SCOPE, "pubsub");
      if (!box(t.email).projectAccess) {
        throw apiError(403, "User not authorized to perform this action.", undefined, { status: "PERMISSION_DENIED" });
      }
      return h(url, body, m, res);
    });
  const TOPIC = /^\/v1\/(projects\/[^/]+\/topics\/[^/:]+)$/;
  const SUB = /^\/v1\/(projects\/[^/]+\/subscriptions\/[^/:]+)$/;

  pubsubRoute("PUT", TOPIC, (_u, _b, m) => {
    if (topics.has(m[1]!)) throw apiError(409, "Resource already exists in the project (resource=agentinbox-gmail).");
    topics.set(m[1]!, { policy: { version: 1, etag: "BwYA", bindings: [] } });
    return { name: m[1] };
  });

  pubsubRoute("GET", TOPIC, (_u, _b, m) => {
    if (!topics.has(m[1]!)) throw apiError(404, "Resource not found (resource=agentinbox-gmail).");
    return { name: m[1] };
  });

  const topicOr404 = (name: string) => {
    const t = topics.get(name);
    if (!t) throw apiError(404, `Resource not found (resource=${name.split("/").pop()}).`);
    return t;
  };

  // GET only, like Google (a POST gets the HTML 404).
  pubsubRoute("GET", /^\/v1\/(projects\/[^/]+\/topics\/[^/:]+):getIamPolicy$/, (_u, _b, m) => structuredClone(topicOr404(m[1]!).policy));

  pubsubRoute("POST", /^\/v1\/(projects\/[^/]+\/topics\/[^/:]+):setIamPolicy$/, (_u, body, m) => {
    const t = topicOr404(m[1]!);
    const policy = (json(body).policy ?? {}) as { etag?: string; bindings?: { role: string; members: string[] }[] };
    if (policy.etag && policy.etag !== t.policy.etag) throw apiError(409, "There were concurrent policy changes.", undefined, { status: "ABORTED" });
    const members = (policy.bindings ?? []).flatMap((b) => b.members);
    if (orgPolicy && members.some((x) => x.endsWith("gserviceaccount.com"))) {
      throw apiError(400, "One or more users named in the policy do not belong to a permitted customer,  perhaps due to an organization policy.", undefined, {
        status: "FAILED_PRECONDITION",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.PreconditionFailure",
            violations: [
              {
                type: "constraints/iam.allowedPolicyMemberDomains",
                subject: "orgpolicy:projects/fake-project",
                description: "User gmail-api-push@system.gserviceaccount.com is not in permitted organization.",
              },
            ],
          },
        ],
      });
    }
    t.policy = { version: 1, etag: `BwYB${seq++}`, bindings: policy.bindings ?? [] };
    return structuredClone(t.policy);
  });

  pubsubRoute("POST", /^\/v1\/(projects\/[^/]+\/topics\/[^/:]+):publish$/, (_u, body, m) => {
    topicOr404(m[1]!);
    const msgs = (json(body).messages ?? []) as { data?: string; attributes?: Record<string, string> }[];
    return { messageIds: msgs.map((x) => publish(m[1]!, x.data ?? "", x.attributes)) };
  });

  pubsubRoute("PUT", SUB, (_u, body, m) => {
    if (subs.has(m[1]!)) throw apiError(409, "Resource already exists in the project (resource=agentinbox-gmail-pull).");
    const b = json(body) as { topic?: string; ackDeadlineSeconds?: number };
    topicOr404(b.topic ?? "");
    subs.set(m[1]!, { topic: b.topic!, ackDeadlineSeconds: b.ackDeadlineSeconds ?? 10, queue: [], outstanding: new Map(), waiters: new Set() });
    return { name: m[1], topic: b.topic, ackDeadlineSeconds: b.ackDeadlineSeconds ?? 10 };
  });

  const subOr404 = (name: string) => {
    const s = subs.get(name);
    if (!s) throw apiError(404, `Resource not found (resource=${name.split("/").pop()}).`);
    return s;
  };

  pubsubRoute("GET", SUB, (_u, _b, m) => {
    const s = subOr404(m[1]!);
    return { name: m[1], topic: s.topic, ackDeadlineSeconds: s.ackDeadlineSeconds };
  });

  function take(s: Subscription, max: number) {
    const t = Date.now();
    for (const [ackId, o] of s.outstanding) {
      if (o.deadline <= t) {
        s.outstanding.delete(ackId);
        s.queue.push(o.msg);
      }
    }
    return s.queue.splice(0, max).map((msg) => {
      const ackId = token("ack-");
      msg.attempts++;
      s.outstanding.set(ackId, { msg, deadline: t + s.ackDeadlineSeconds * 1000 });
      return {
        ackId,
        message: { data: msg.data, messageId: msg.messageId, publishTime: msg.publishTime, ...(msg.attributes ? { attributes: msg.attributes } : {}) },
        deliveryAttempt: msg.attempts,
      };
    });
  }

  pubsubRoute("POST", /^\/v1\/(projects\/[^/]+\/subscriptions\/[^/:]+):pull$/, async (_u, body, m, res) => {
    const s = subOr404(m[1]!);
    const b = json(body);
    const max = Number(b.maxMessages ?? 100) || 100;
    let got = take(s, max);
    if (!got.length && b.returnImmediately !== true) {
      let closed = false;
      await new Promise<void>((resolve) => {
        const onClose = () => {
          closed = true;
          done();
        };
        const done = () => {
          clearTimeout(timer);
          s.waiters.delete(done);
          res.off("close", onClose);
          closers.delete(done);
          resolve();
        };
        const timer = setTimeout(done, fake.pullWaitMs);
        s.waiters.add(done);
        closers.add(done);
        res.on("close", onClose);
      });
      // Like Pub/Sub, never dispatch messages into a pull the client already cancelled.
      if (closed) {
        fake.abortedPulls++;
        return {};
      }
      got = take(s, max);
    }
    return got.length ? { receivedMessages: got } : {};
  });

  pubsubRoute("POST", /^\/v1\/(projects\/[^/]+\/subscriptions\/[^/:]+):acknowledge$/, (_u, body, m) => {
    const s = subOr404(m[1]!);
    for (const id of (json(body).ackIds ?? []) as string[]) s.outstanding.delete(id);
    return {};
  });

  pubsubRoute("POST", /^\/v1\/(projects\/[^/]+\/subscriptions\/[^/:]+):modifyAckDeadline$/, (_u, body, m) => {
    const s = subOr404(m[1]!);
    const b = json(body) as { ackIds?: string[]; ackDeadlineSeconds?: number };
    for (const id of b.ackIds ?? []) {
      const o = s.outstanding.get(id);
      if (o) o.deadline = Date.now() + (b.ackDeadlineSeconds ?? 0) * 1000;
    }
    if (!b.ackDeadlineSeconds) for (const w of s.waiters) w();
    return {};
  });

  // ───── Server ─────

  const closers = new Set<() => void>();

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://fake");
    const method = req.method ?? "GET";
    fake.requests.push({ method, path: url.pathname });
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    try {
      const rule = failRules.find(
        (r) => r.left > 0 && (!r.method || r.method === method) && (typeof r.path === "string" ? url.pathname.includes(r.path) : r.path.test(url.pathname)),
      );
      const injected = () => {
        rule!.left--;
        const fail = apiError(rule!.status, rule!.message ?? `Injected failure ${rule!.status}`, rule!.reason);
        return new HttpFail(fail.status, fail.body, rule!.retryAfter !== undefined ? { "retry-after": String(rule!.retryAfter) } : {});
      };
      if (rule && !rule.afterProcessing) throw injected();
      for (const [m, re, h] of routes) {
        if (m !== method) continue;
        const match = re.exec(url.pathname);
        if (!match) continue;
        const out = await h(req, url, body, match, res);
        if (rule?.afterProcessing) throw injected();
        if (res.headersSent || res.writableEnded) return;
        if (out === undefined) res.writeHead(204).end();
        else res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
        return;
      }
      // Google answers unknown paths and wrong verbs with an HTML page.
      throw new HttpFail(404, `<!DOCTYPE html><html lang=en><title>Error 404 (Not Found)!!1</title><p><b>404.</b> <ins>That’s an error.</ins><p>The requested URL <code>${url.pathname}</code> was not found on this server. <ins>That’s all we know.</ins>`);
    } catch (err) {
      if (res.writableEnded) return;
      if (err instanceof HttpFail) {
        const isText = typeof err.body === "string";
        res.writeHead(err.status, { "content-type": isText ? "text/html" : "application/json", ...err.headers });
        res.end(isText ? err.body : JSON.stringify(err.body));
      } else {
        res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: 500, message: String(err), status: "INTERNAL" } }));
      }
    }
  }

  const server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const fake: FakeGoogle = {
    url,
    google: { oauthBase: url, authBase: url, gmailBase: url, pubsubBase: url },
    accessTokenTtl: 3600,
    refreshTokenTtl: null,
    pullWaitMs: 1000,
    abortedPulls: 0,
    revoked: [],
    requests: [],
    async close() {
      for (const c of closers) c();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    addAccount(email, opts = {}) {
      const key = email.toLowerCase();
      if (mailboxes.has(key)) return;
      const labels = new Map<string, GmailLabelRaw>(SYSTEM_LABELS.map((id) => [id, { id, name: id, type: "system" as const }]));
      mailboxes.set(key, {
        email: key,
        name: opts.name ?? key.split("@")[0]!,
        historyId: 1000,
        minHistoryId: 0,
        messages: new Map(),
        history: [],
        labels,
        drafts: new Map(),
        watch: null,
        projectAccess: opts.projectAccess ?? true,
        nextLabel: 1,
        workspaceDomain: opts.workspaceDomain?.toLowerCase() ?? null,
      });
    },
    addLabel(email, name) {
      const mb = box(email);
      const existing = [...mb.labels.values()].find((l) => l.name === name);
      if (existing) return existing.id;
      const id = `Label_${mb.nextLabel++}`;
      mb.labels.set(id, { id, name, type: "user" });
      return id;
    },
    consentAs(email, opts = {}) {
      box(email);
      consents.push({ email: email.toLowerCase(), ...opts });
    },
    deliver(email, input) {
      const mb = box(email);
      const thread = input.threadId ? threadMessages(mb, input.threadId) : [];
      const parent = thread.at(-1);
      const headers = { ...input.headers };
      if (parent?.messageIdHeader && !Object.keys(headers).some((k) => k.toLowerCase() === "in-reply-to")) {
        headers["In-Reply-To"] = parent.messageIdHeader;
        headers.References = thread.map((m) => m.messageIdHeader).filter(Boolean).join(" ");
      }
      const raw = buildRaw({
        ...input,
        headers,
        to: input.to ?? (mb.name ? `${mb.name} <${mb.email}>` : mb.email),
        messageId: `<fake-${randomBytes(8).toString("hex")}@mail.example>`,
      });
      const msg = makeMessage(mb, raw, input.labelIds ?? ["INBOX", "UNREAD"], input.threadId ?? null, input.date);
      insert(mb, msg);
      return format(msg, "full");
    },
    setLabels(email, messageId, add, removeIds) {
      const mb = box(email);
      modify(mb, msgOr404(mb, messageId), add, removeIds);
    },
    failRefresh(email, opts = {}) {
      revokeGrant(email.toLowerCase(), opts.rapt);
    },
    expireAccessTokens(email) {
      for (const t of accessTokens.values()) if (t.email === email.toLowerCase()) t.expiresAt = 0;
    },
    expireHistory(email) {
      const mb = box(email);
      // Every cursor handed out so far becomes too old; the profile's (bumped) historyId stays valid.
      mb.historyId++;
      mb.minHistoryId = mb.historyId;
    },
    orgPolicyBlocksIam(on) {
      orgPolicy = on;
    },
    disableApi(api, on) {
      if (on) disabled.add(api);
      else disabled.delete(api);
    },
    failNext(rule) {
      failRules.push({ ...rule, left: rule.times ?? 1 });
    },
    sent: (email) => {
      const mb = box(email);
      return [...mb.messages.values()].filter((m) => m.labelIds.includes("SENT")).map((m) => format(m));
    },
    drafts: (email) => {
      const mb = box(email);
      return [...mb.drafts.entries()].flatMap(([id, mid]) => {
        const m = mb.messages.get(mid);
        return m ? [{ id, message: format(m) }] : [];
      });
    },
    messages: (email) => {
      const mb = box(email);
      return [...mb.messages.values()].map((m) => format(m));
    },
    message: (email, id) => {
      const mb = box(email);
      const m = mb.messages.get(id);
      return m ? format(m) : null;
    },
    watch: (email) => box(email).watch,
    topics: () => [...topics.keys()],
    subscription: (name) => {
      const s = subs.get(name);
      return s ? { topic: s.topic, ackDeadlineSeconds: s.ackDeadlineSeconds, outstanding: s.outstanding.size, queued: s.queue.length } : null;
    },
    iamPolicy: (topic) => (topics.has(topic) ? structuredClone(topics.get(topic)!.policy) : null),
  };
  return fake;
}

// ───────────── Test helpers ─────────────

/**
 * Configures the fake OAuth client (unless already set) and runs the whole connect flow for `email`
 * (adding the mailbox if needed): startConnect → fake consent → completeConnectFromUrl. `pubsub: true`
 * then also grants the Pub/Sub scope through the incremental-consent flow provisioning uses.
 * `scopes` overrides what the fake user grants on the consent screen.
 */
export async function connectFakeAccount(
  ctx: AppContext,
  fake: FakeGoogle,
  email: string,
  opts: { name?: string; reauthAccountId?: string; scopes?: string[]; pubsub?: boolean } = {},
): Promise<Account> {
  if (!ctx.google.clientView().hasSecret) ctx.google.setClient({ ...FAKE_CLIENT, appType: "internal" });
  fake.addAccount(email, { name: opts.name });
  const consent = async (start: { reauthAccountId?: string; scopes?: "pubsub"[] }) => {
    fake.consentAs(email, { scopes: opts.scopes });
    const { authUrl } = ctx.google.startConnect(start);
    const res = await fetch(authUrl, { redirect: "manual" });
    const location = res.headers.get("location");
    if (!location) throw new Error(`fake consent failed: HTTP ${res.status} ${await res.text()}`);
    return ctx.google.completeConnectFromUrl(location);
  };
  const account = await consent({ reauthAccountId: opts.reauthAccountId });
  return opts.pubsub ? consent({ reauthAccountId: account.id, scopes: ["pubsub"] }) : account;
}

/**
 * A minimal EventsService that records emits and enforces dedupe keys, for tests that don't want the
 * real events/webhooks pipeline: `testContext({ events: rec.factory })`, then inspect `rec.events`.
 */
export function recordingEvents() {
  const events: (NewEvent & { seq: number })[] = [];
  const keys = new Set<string>();
  const notImplemented = () => {
    throw new Error("recordingEvents: not implemented");
  };
  const service: EventsService = {
    emit(e) {
      if (keys.has(e.dedupeKey)) return null;
      keys.add(e.dedupeKey);
      const seq = events.length + 1;
      events.push({ ...e, seq });
      return {
        id: `evt_${seq}`,
        seq,
        type: e.type,
        accountId: e.accountId,
        accountEmail: "",
        message: e.message ?? null,
        labelIds: e.labelIds,
        detail: e.detail,
        createdAt: new Date().toISOString(),
      };
    },
    get: notImplemented,
    list: notImplemented,
    feed: notImplemented,
    wait: notImplemented,
    ack: notImplemented,
    prune: () => 0,
  };
  return {
    events,
    factory: () => service,
    ofType: (type: NewEvent["type"]) => events.filter((e) => e.type === type),
  };
}
