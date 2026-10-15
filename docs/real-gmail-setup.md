# Real Gmail setup checklist

This checklist takes a fresh agentinbox install all the way to real Gmail accounts connected, new mail arriving in seconds, and an agent (Claude Code) reading and drafting mail. Each `- [ ]` item is one action. Values you can copy are in `code`. Items marked **(verify)** are details I couldn't confirm against the live UI or the current build. Check them as you go and fix this doc if they're wrong.

Google renamed things recently. The old "APIs & Services → OAuth consent screen" is now **Google Auth Platform**, with the pages **Overview, Branding, Audience, Clients, Data access** and **Verification center**. Older tutorials won't match what you see.

---

## 0. Before you start

**What you'll end up with**

- agentinbox running, with a console you've claimed using an admin password.
- A Google Cloud project with the Gmail API and the Cloud Pub/Sub API enabled, Google Auth Platform configured, and one OAuth client of type *Web application*.
- One or more Gmail or Workspace mailboxes connected, with new mail showing up under **Live events** within seconds (Pub/Sub) or about 30 s (polling).
- An agent with its own API key, set to read and draft, connected to Claude Code over MCP, with the agentinbox skill installed.

**Time:** about 30–45 minutes the first time. Each extra mailbox takes about 2 minutes.

**Prerequisites**

- [ ] Node.js 22.13 or newer on the machine that will run agentinbox. Check with `node -v`.
- [ ] Decide where agentinbox runs: your laptop, or a server (see §1).
- [ ] Decide which Google account **owns the Cloud project**. Connect this account as a mailbox too: one-click Pub/Sub uses its permissions (see §6).
- [ ] List the mailboxes you'll connect and sort them. They're either all in **one Google Workspace org**, or there's at least one **@gmail.com address (or other org)**. This decides Internal vs External in §3.
- [ ] Workspace only: know whether you're a **super admin** of the org. Admin settings can block three things here:
  - third-party app access to Gmail
  - the Pub/Sub permission grant (orgs created on or after 3 May 2024 block it by default)
  - long-lived Cloud tokens
- [ ] Claude Code installed on the machine where your agent runs (for §7).

**Values you'll collect** (keep them in a password manager or a private note)

| Value | Where it comes from | Example |
|---|---|---|
| Public URL | You choose it (§1) | `http://localhost:8425` |
| Admin password | You choose it (§1) | n/a |
| Project ID | Google Cloud (§2) | `agentinbox-wynn` |
| Redirect URI | Shown by the agentinbox console (§4) | `http://localhost:8425/oauth/callback` |
| Client ID | Google Auth Platform → Clients (§4) | `1234…-abc.apps.googleusercontent.com` |
| Client secret | Same dialog. **Shown only once** (§4) | `GOCSPX-…` |
| Agent API key | agentinbox → Agents. **Shown only once** (§7) | `aib_…` |

---

## 1. Start agentinbox and claim the console

### 1a. Choose where it runs and the Public URL

The **Public URL** is the address agentinbox uses in three places:

- the OAuth redirect URI you register with Google
- the MCP URL in agent snippets
- the URL baked into the skill

Google only redirects back to `https://…` addresses or `localhost`. For any other URL, the console uses **paste mode**: after approving, you copy the address you land on and paste it into the console.

| Your situation | Public URL | OAuth mode | Notes |
|---|---|---|---|
| agentinbox on your laptop, agents on the same laptop | `http://localhost:8425` | direct | Simplest. |
| agentinbox on a server, and you open the console through an SSH tunnel | `http://localhost:8425` | direct | `ssh -N -L 8425:localhost:8425 you@server`, then browse `http://localhost:8425` on your laptop. Agents on that server can use `localhost` too. |
| agentinbox on a server behind a domain with HTTPS (Caddy, nginx, Cloudflare Tunnel) | `https://mail.example.com` | direct | Proxy to `127.0.0.1:8425` and start with `TRUST_PROXY=1`. Agents anywhere can reach `/mcp`. |
| agentinbox on a LAN or tailnet, plain HTTP (e.g. `http://100.64.1.2:8425`) | that URL | paste | Works, but each connect needs a copy and paste. |

**Recommendation for you:**

- **If agentinbox runs on your laptop,** use `http://localhost:8425`.
- **If it runs on a server,** do this first real-Gmail run over an SSH tunnel with `http://localhost:8425`. Nothing gets exposed and OAuth works directly.
- **Later, for agents on other machines,** put it behind HTTPS and change the Public URL. Then add the new redirect URI to the same OAuth client next to the old one. Both can coexist.

> By default agentinbox listens on `0.0.0.0:8425` (all interfaces, plain HTTP). On a server that only you reach through a tunnel, start it with `--host 127.0.0.1` so the console isn't open to the network.

### 1b. Start it

- [ ] Run `node -v` and confirm it prints `v22.13.0` or higher.
- [ ] Start agentinbox:
  - Laptop: `npx agentinbox-cli`
  - Server: `npx agentinbox-cli --no-open --host 127.0.0.1`. Drop `--host` if agents on other machines need to reach it directly.
- [ ] You should see roughly this:
  ```
  agentinbox v0.x · data in /home/you/.agentinbox

  First run: open this link to claim the instance and finish setup:

  http://localhost:8425/setup?token=…
  ```
- [ ] Server only: on your laptop, run `ssh -N -L 8425:localhost:8425 you@server` and leave it running.
- [ ] Open the `http://localhost:8425/setup?token=…` link in your laptop browser.
  - Lost the link? It's stored in `~/.agentinbox/setup-token`, and restarting agentinbox prints it again.
- [ ] On **Welcome to agentinbox**, set an **Admin password**, enter it again under **Confirm password**, and submit. Save it in your password manager.
  - Forgot it later? Run `npx agentinbox-cli reset-password`. It prints a fresh setup link.
- [ ] You land in the console. Open **Get started** in the sidebar. It shows seven steps: Public URL → Google Cloud project → Consent screen → OAuth client → Gmail accounts → Real-time delivery (optional) → First agent.
- [ ] **Step "Confirm the public URL":** enter the URL you chose in 1a, e.g. `http://localhost:8425`, and confirm it. **(verify)** the exact field and button labels; the wizard route wasn't in the snapshot I read.

Leave agentinbox running in the foreground for now. Once everything works, `npx agentinbox-cli service install` turns it into a background service (systemd or launchd) using the same data directory. Stop the foreground copy first.

---

## 2. Google Cloud project

- [ ] Go to https://console.cloud.google.com and sign in with the **project-owner account**.
  - If you'll use **Internal** (all mailboxes in one Workspace org), this must be an account in that org.
- [ ] Create the project at https://console.cloud.google.com/projectcreate:
  - **Project name:** `agentinbox`
  - **Project ID:** below the name it says *Project ID: agentinbox-123456*. Click **Edit** to choose a memorable one, e.g. `agentinbox-wynn`. Rules: 6–30 characters, lowercase letters, digits and hyphens, starting with a letter. **The ID can never be changed.**
  - **Organization / Location:**
    - For Internal: your Workspace domain (e.g. `example.com`).
    - Consumer @gmail.com owners see **No organization**, which is fine for External.
  - Click **Create**, wait for the notification, then select the new project in the project picker in the top bar.
- [ ] Copy the **Project ID**, not the name or the number. It's on the dashboard's *Project info* card and in the project picker. You'll paste it into agentinbox in §4.
  - Gmail requires the Pub/Sub topic to live in **the same project as the OAuth client**, so use this one project for everything.
- [ ] Enable the Gmail API at https://console.cloud.google.com/apis/library/gmail.googleapis.com. Check that the project picker shows your project, click **Enable**, and wait until you see *API enabled*.
- [ ] Enable the Cloud Pub/Sub API at https://console.cloud.google.com/apis/library/pubsub.googleapis.com and click **Enable**. Skip this if you know you'll use polling.
  - **(verify)** whether the project needs a billing account first. If Google asks for one, you can:
    - link one: Gmail notification traffic is tiny, far below Pub/Sub's free 10 GB/month, or
    - skip Pub/Sub and use polling (§6).
- Alternative with gcloud (same result):
  ```sh
  gcloud projects create agentinbox-wynn --name=agentinbox
  gcloud services enable gmail.googleapis.com pubsub.googleapis.com --project=agentinbox-wynn
  ```
- [ ] In the agentinbox wizard, step **Google Cloud project**: paste the Project ID and confirm.

---

## 3. OAuth consent screen (Google Auth Platform)

### 3a. Decide: Internal or External

agentinbox uses **one OAuth client** for every mailbox, so the strictest mailbox decides.

| Your mailboxes | Audience | Publishing | Verification | Token lifetime |
|---|---|---|---|---|
| **All** in one Google Workspace org, and the project belongs to that org | **Internal** | n/a (no testing mode) | Not needed | No 7-day expiry |
| **Any** @gmail.com address, or any mailbox outside the project's org | **External** | Must be **In production** | Not needed for your own use. You'll click through "Google hasn't verified this app". Unverified apps are capped at 100 users total. | No 7-day expiry once In production |
| External but left in **Testing** | External | Testing | n/a | **Refresh tokens die after 7 days** and accounts flip to *Needs reauth*. Don't do this. |

The Gmail scope (`gmail.modify`) is a *restricted* scope. That's why you need your own app, and it's fine for an app that only you use.

### 3b. First-time setup

- [ ] Open https://console.cloud.google.com/auth/overview?project=YOUR_PROJECT_ID (Menu → **Google Auth Platform** → **Overview**). The page says *Google Auth Platform not configured yet*.
- [ ] Click **Get started** and step through the wizard:
  1. **App Information:**
     - **App name:** `agentinbox` (users see this on the consent screen)
     - **User support email:** your address
     - Click **Next**.
  2. **Audience:** pick **Internal** or **External** based on 3a, then click **Next**.
     - **Internal** is only selectable when the project belongs to a Workspace organization.
  3. **Contact Information:** enter your email and click **Next**.
  4. **Finish:** tick *I agree to the Google API Services: User Data Policy*, click **Continue**, then **Create**.

### 3c. Branding

- [ ] Open https://console.cloud.google.com/auth/branding.
  - App name and support email are already filled in.
  - Logo, home page, privacy policy and authorized domains are optional for a personal app. Leave them empty unless §3d's **Publish app** button is greyed out (see the note there).
- [ ] Under **Developer contact information**, make sure your email is listed. Click **Save** if you changed anything.

### 3d. Audience: publish to production (External only)

- [ ] Open https://console.cloud.google.com/auth/audience. You should see **User type: External** and **Publishing status: Testing**.
- [ ] Click **Publish app**. In the **Push to production?** dialog, click **Confirm**. The status changes to **In production**.
  - It may say the app needs verification because it uses restricted scopes. For personal use you can ignore that: the app works unverified, and users get the "unverified app" interstitial.
- [ ] **Test users:** not needed once the app is In production. Only add yourself under *Test users → Add users* if you deliberately stay in Testing, and remember the 7-day expiry.
- If **Publish app** is greyed out with *"To publish your app, you must complete the configuration on the Branding page"*: Google forum reports from October 2026 say this happens even when Branding shows no errors. **(verify)** Try filling in the following on Branding, then retry:
  - **Application home page:** e.g. `https://github.com/unlaboredlabs/agentinbox` or your own site
  - **Application privacy policy link**
  - that URL's domain under **Authorized domains**

For **Internal** this page shows *User type: Internal* and there's nothing to publish.

### 3e. Data access: register the scopes

agentinbox requests `https://www.googleapis.com/auth/gmail.modify` and `https://www.googleapis.com/auth/pubsub`, plus `openid`, `email` and `profile` to learn the account's address and name.

- [ ] Open https://console.cloud.google.com/auth/scopes (**Data access**) and click **Add or remove scopes**.
- [ ] In the side panel, filter the table and tick the scopes below. A scope only appears in the table when its API is enabled in §2. Otherwise paste the full URLs into **Manually add scopes** and click **Add to table** **(verify)** the label.
  - `https://www.googleapis.com/auth/gmail.modify`, shown as *Read, compose, and send emails from your Gmail account* (restricted)
  - `https://www.googleapis.com/auth/pubsub`, shown as *View and manage Pub/Sub topics and subscriptions*
  - `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`
- [ ] Click **Update**, then **Save** at the bottom of the page.
  - Gmail lands under *Your restricted scopes*. That's expected. Ignore prompts to start verification.

---

## 4. OAuth client

- [ ] In agentinbox, open the wizard step **OAuth client**. It shows the **Redirect URI** with a copy button. Copy it.
  - Direct mode: `<Public URL>/oauth/callback`, e.g. `http://localhost:8425/oauth/callback` or `https://mail.example.com/oauth/callback`.
  - Paste mode: always `http://localhost:8425/oauth/callback`.
- [ ] Open https://console.cloud.google.com/auth/clients (Google Auth Platform → **Clients**) and click **Create client**.
  - **Application type:** `Web application`. Not Desktop: agentinbox only accepts Web clients.
  - **Name:** `agentinbox` (only shown inside Cloud Console).
  - **Authorized JavaScript origins:** leave empty.
  - **Authorized redirect URIs:** click **Add URI** and paste the console's URI **exactly**. That means the same scheme, host and port, and no trailing slash. `localhost` and `127.0.0.1` count as different. If you plan a later HTTPS URL, you can add it now as a second URI.
  - Leave *Use this client for an AI-powered agent* **unticked**. It can't be changed later, and agentinbox is a normal web-server OAuth app. **(verify)** whether this checkbox is shown for you.
  - Click **Create**.
- [ ] A dialog shows **Client ID** and **Client secret**. **Copy both now and click Download JSON.** Since mid-2025 Google only shows the secret at creation time and masks it afterwards. If you lose it, add a new secret on the client's page and delete the old one **(verify)** the button label.
- [ ] Back in the agentinbox wizard, paste the **Client ID** (ends in `.apps.googleusercontent.com`) and the **Client secret**, plus the Project ID and Internal/External choice if asked, then **Save**.
  - The console rejects IDs that don't end in `.apps.googleusercontent.com` and project IDs that don't look like IDs.
- Google notes that redirect URI changes can take **5 minutes to a few hours** to take effect. If the first connect fails with `redirect_uri_mismatch` and the URI matches exactly, wait and retry.
- Google auto-deletes OAuth clients that are unused for **6 months**. A running agentinbox uses its client daily, so this only matters if the instance sits switched off.

---

## 5. Connect each Gmail account

Connect the **project-owner account first** if it's one of your mailboxes, because Pub/Sub provisioning in §6 uses the first connected account that has Pub/Sub access.

- [ ] In the wizard step **Connect Gmail accounts** (or **Gmail accounts** in the sidebar), click connect.
  - **Direct mode:** a pop-up opens with Google sign-in. If your browser blocks it, allow pop-ups for the console, or use **Open sign-in again** in the dialog.
  - **Paste mode:** a dialog with three numbered steps appears. Click **Open Google sign-in** (opens in a new tab).
- [ ] Pick the account in Google's account chooser.
- [ ] **External apps only.** You see **"Google hasn't verified this app"**. That's expected, because it's your own app.
  - Click **Advanced**, then **Go to agentinbox (unsafe)** (the text uses your app name).
  - Internal apps skip this screen.
- [ ] On the permissions screen, **tick every box**, or use **Select all** if it appears:
  - *Read, compose, and send emails from your Gmail account*. **Required.** agentinbox refuses the connection without it, with *"Gmail access wasn't granted."*
  - *View and manage Pub/Sub topics and subscriptions*. Needed on the account that provisions and pulls Pub/Sub. Tick it everywhere to keep things simple.
- [ ] Click **Continue** (or **Allow**).
  - **Direct mode:** the pop-up closes and the dialog says *you@example.com is connected*.
  - **Paste mode:**
    1. The tab lands on `http://localhost:8425/oauth/callback?state=…&code=…`. It probably shows *This site can't be reached*, which is expected.
    2. Copy the whole address from the address bar.
    3. Paste it into step 3 of the dialog and click **Finish connecting**. Each code works once and expires within minutes.
    - Tip: with the SSH tunnel from §1 open, `localhost:8425` on your laptop actually reaches agentinbox, so the callback may complete by itself **(verify)**.
- [ ] Click **Connect another** for each additional mailbox, or **Done**.
- [ ] Check the **Gmail accounts** page: each account shows status **Active**. It starts in polling mode, so mail syncs immediately even before §6.

---

## 6. Real-time delivery (Pub/Sub) or polling

**Polling** is the default: agentinbox checks each mailbox every 30 s, configurable under **Settings**, from 5 to 3600 s. It needs zero Google setup.

**Pub/Sub** delivers within seconds and needs no inbound connection, because agentinbox *pulls* from a subscription.

### 6a. One-click provisioning

The console creates the following, using one connected account's token:

- topic `projects/<PROJECT_ID>/topics/agentinbox-gmail`
- a grant of **Pub/Sub Publisher** (`roles/pubsub.publisher`) on that topic to `gmail-api-push@system.gserviceaccount.com`
- pull subscription `projects/<PROJECT_ID>/subscriptions/agentinbox-gmail-pull`, with ack deadline 60 s, 1-day retention and no expiry

It then starts a Gmail `watch` on every account and switches ingest to `pubsub`. It renews watches daily (Gmail expires them after 7 days).

Requirements:

- the Pub/Sub API is enabled (§2)
- the connected account granted the Pub/Sub permission (§5)
- that account has **Owner** or **Pub/Sub Admin** (`roles/pubsub.admin`) on the project

The account that creates the project is Owner automatically. Basic **Editor** and Pub/Sub Editor can't change IAM policies, so they likely fail at the publisher grant. **(verify)** The console's hint text mentions Editor; it probably shouldn't.

- [ ] In the wizard step **Turn on real-time delivery**, click the provision button **(verify)** the label. Wait a few seconds.
- [ ] Click the test button. It publishes a test message and pulls it back. Success reads *"Published and received a test message in N ms. Pub/Sub is working."*
- [ ] Don't want Pub/Sub, or it's blocked? Skip the step and polling keeps working. The wizard marks the step *skipped*. It's optional for completing setup.

### 6b. What the errors mean

| Console message | Cause | Fix |
|---|---|---|
| *The Cloud Pub/Sub API isn't enabled…* (or *The Gmail API isn't enabled…*) | API off (`SERVICE_DISABLED`) | Enable it with the link in the message (§2), wait 1–2 min, retry. |
| *…didn't grant agentinbox access to Pub/Sub* | The Pub/Sub box was unticked during consent | **Gmail accounts** → reconnect the account, tick every box, retry. |
| *…doesn't have permission to manage Pub/Sub in project…* (`PERMISSION_DENIED`) | Connected account isn't Owner or Pub/Sub Admin | IAM & Admin → **IAM** (https://console.cloud.google.com/iam-admin/iam) → **Grant access** → principal = that account, role **Pub/Sub Admin** → **Save**. Retry. |
| *Google Cloud project "…" or its Pub/Sub resources were not found* | Wrong Project ID (the name or number was entered) | Fix the Project ID in the wizard's Google step. |
| *Your Google Workspace organization policy (Domain Restricted Sharing, iam.allowedPolicyMemberDomains) blocks…* | Org policy forbids granting anything to principals outside your domain. It's on by default for orgs created on or after 3 May 2024. | Stay on **polling**, or have an org-policy admin allow an exception for this project (see 6c). |
| *Gmail couldn't publish to the Pub/Sub topic* | The publisher grant is missing | Check the topic's permissions (6c) and retry provisioning. |
| *Published a test message but didn't receive it within 20s…* | Subscription not attached to the topic | Check the subscription's topic in the Pub/Sub console. Retry provisioning, which is idempotent. |
| *…needs to be reconnected* | Token for the provisioning account is dead | Reconnect it on **Gmail accounts**. |

### 6c. Manual fallback (gcloud or console)

Use this if someone else must create the resources. Afterwards, still click **provision** in agentinbox: it treats existing resources as fine, starts the watches and switches modes. The connected account still needs to read the topic's IAM policy, create or reuse the topic and subscription, publish, and consume. **Pub/Sub Admin** covers all of that.

```sh
P=agentinbox-wynn   # your Project ID
gcloud services enable gmail.googleapis.com pubsub.googleapis.com --project=$P
gcloud pubsub topics create agentinbox-gmail --project=$P
gcloud pubsub topics add-iam-policy-binding agentinbox-gmail --project=$P \
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
  --role=roles/pubsub.publisher
gcloud pubsub subscriptions create agentinbox-gmail-pull --project=$P \
  --topic=agentinbox-gmail --ack-deadline=60 \
  --message-retention-duration=1d --expiration-period=never
```

In the Cloud console instead **(verify)** the labels:

1. Go to **Pub/Sub → Topics** (https://console.cloud.google.com/cloudpubsub/topic/list) and click **Create topic**.
   - **Topic ID:** `agentinbox-gmail`
   - Untick *Add a default subscription*.
   - Click **Create**.
2. Open the topic and go to the **Permissions** tab (or *Show info panel*). Click **Add principal**.
   - Principal: `gmail-api-push@system.gserviceaccount.com`
   - Role: **Pub/Sub Publisher**
   - Click **Save**.
3. Go to **Pub/Sub → Subscriptions** and click **Create subscription**.
   - **Subscription ID:** `agentinbox-gmail-pull`
   - Topic: `agentinbox-gmail`
   - **Delivery type:** Pull
   - Retention: 1 day
   - Expiration: *Never expire*
   - Ack deadline: 60 s
   - Click **Create**.

Org-policy exception (Workspace, only if you want Pub/Sub). It needs **Organization Policy Administrator** at the org level. Even a super admin may have to grant themselves `roles/orgpolicy.policyAdmin` first. Two ways to do it:

- **Console:** IAM & Admin → **Organization policies** → select the *project* → **Domain restricted sharing** (`iam.allowedPolicyMemberDomains`) → **Manage policy** → *Override parent's policy* → rule **Allow All** → **Set policy**.
- **gcloud:** `gcloud org-policies set-policy` with `allowAll: true` on `projects/<PROJECT_ID>/policies/iam.allowedPolicyMemberDomains` **(verify)**.

After that, run provisioning. You can then restore the policy: agentinbox doesn't re-grant once the binding exists. **(verify)** that removing the override leaves the existing binding in place.

---

## 7. First agent

- [ ] Go to **Agents** → **New agent** (or the wizard step **Create your first agent**).
  - **Name:** e.g. `Claude Code on laptop`. It's shown in audit logs and approval requests.
  - **Mailboxes it can use:** tick one mailbox to start.
  - **Starting permissions:** **Read and draft (recommended)**. The agent reads mail, and anything it "sends" becomes a Gmail draft for you to review (send mode `draft_only`).
    - Other presets: *Read only*, *Send with my approval* (each send waits under **Approvals**), *Full access*. Avoid Full access until you trust the setup.
  - Create it.
- [ ] Copy the key (`aib_…`). **It's shown once.** Click **I've saved the key**. Lost it? Rotate the key on the agent's page.
- [ ] In the **Claude Code** tab of the connect snippets, copy the command and run it on the machine where Claude Code runs:
  ```sh
  claude mcp add --transport http agentinbox http://localhost:8425/mcp \
    --header "Authorization: Bearer aib_…"
  ```
  - The URL is `<Public URL>/mcp`. If Claude Code runs on a different machine from agentinbox, that machine must reach this URL. Use the HTTPS URL, or its own SSH tunnel to `localhost:8425`.
- [ ] Click **Test connection** on the agent. It connects over MCP as the agent and lists the tools it gets. You should see read tools (`search_threads`, `get_thread`, …) plus `create_draft` / `reply`.
- [ ] In Claude Code, run `/mcp` or `claude mcp list` and confirm `agentinbox` shows as connected.
- [ ] Install the skill on the agent's machine:
  ```sh
  npx agentinbox-cli skill install --url http://localhost:8425
  ```
  Use your Public URL. This writes `~/.claude/skills/agentinbox/SKILL.md`. For Codex, use `--target codex`. The skill is also served at `<Public URL>/skill.md`.

---

## 8. Verify end to end

- [ ] From another address (your phone, another account), email a connected mailbox with the subject `agentinbox test 1`.
- [ ] In the console, open **Live events**. A `message.received` event for that mailbox appears, within seconds on Pub/Sub or up to about 30 s on polling.
- [ ] On **Overview**, the ingest status shows the mode (`pubsub` or `poll`) with no error.
- [ ] In Claude Code, ask: *"Use agentinbox to find the email with subject 'agentinbox test 1' and summarize it."* It should call `search_threads` and then `get_thread`.
- [ ] Ask it to *"draft a short reply"*. Gmail's **Drafts** folder gets a threaded reply draft, and **nothing is sent**, because the grant is `draft_only`.
- [ ] Open **Audit log**. You see the agent's tool calls with outcome `ok`.
- [ ] Webhook test (optional):
  1. Open https://webhook.site and copy your unique URL.
  2. Go to **Webhooks** → new webhook. Use that URL, event type `message.received`, and the agent's mailbox.
  3. Click the test-send button. The delivery log shows a 2xx response.
  4. Send yourself another email. A real delivery appears on webhook.site.
  - Private and LAN addresses are blocked unless you add them under **Settings → Webhook allowlist**.
- [ ] Restart agentinbox with Ctrl-C and `npx agentinbox-cli`. Accounts stay **Active** and no setup link is printed.
- [ ] **External apps:** look at **Gmail accounts** again after 8+ days. Still **Active** means the app is really In production. *Needs reauth* around day 7 means it's still in Testing (see §9).

---

## 9. Troubleshooting

| Symptom | Meaning | Fix |
|---|---|---|
| `Error 400: redirect_uri_mismatch` | The redirect URI sent doesn't exactly match one on the OAuth client | Copy the URI from the console's OAuth client step into **Clients → your client → Authorized redirect URIs**, character for character. Check http vs https, port, `localhost` vs `127.0.0.1`, no trailing slash. Changed the Public URL? Add the new URI. Wait up to a few hours for it to take effect. |
| `Error 403: access_denied`, "Access blocked: agentinbox has not completed the Google verification process" | External app in **Testing** and this account isn't a test user, or you clicked Cancel | Publish the app (§3d) or add the account as a test user. Click **Continue**/**Allow** and keep the boxes ticked. |
| `Error 403: org_internal` | Internal app, but the account is outside the project's Workspace org | Sign in with an org account, or switch to **External** and publish (Audience → **Make external** **(verify)** label). |
| `admin_policy_enforced`, or "Access blocked: your administrator…" | Workspace admin restricts third-party access to Gmail | Admin console → **Security → Access and data control → API controls → Manage third-party app access → Configure new app** → search by the Client ID → set **Trusted**. |
| *"Gmail access wasn't granted."* | The Gmail checkbox was unticked | Connect again and tick *Read, compose, and send emails…*. |
| *"Google didn't return a refresh token…"* | Google reused an earlier grant without issuing a new long-lived token | Open https://myaccount.google.com/permissions (Third-party apps & services) → agentinbox → **Delete all connections** / remove access **(verify)**. Then connect again. |
| `invalid_client` / `unauthorized_client` | Client ID or secret is wrong, the client is the wrong type, or the secret was rotated | Re-paste the ID and secret. The client must be **Web application**. |
| `invalid_grant` while connecting | The authorization code was used twice or expired (paste mode) | Start the connect again and paste the new address promptly. |
| Account shows **Needs reauth** about 7 days after connecting (`invalid_grant`) | External app still in **Testing**: Google expires refresh tokens after 7 days | Publish to **In production** (§3d), then **Reconnect** each account. Publishing doesn't revive old tokens. |
| **Needs reauth** at another time | One of: password changed (Google revokes Gmail-scoped tokens on a password change), access removed at myaccount, token unused for 6 months, or account deleted or suspended | **Gmail accounts** → **Reconnect**. agentinbox also emits an `account.auth_failed` event. |
| **Needs reauth** daily or hourly on Workspace, with `invalid_rapt` in the server log | Workspace **Google Cloud session control** forces reauthentication for apps using Cloud scopes. **(verify)** whether the `pubsub` scope triggers it. | Admin console → **Security → Access and data control → Google Cloud session control**: either *Never require reauthentication*, or mark the client **Trusted** (row above) and tick **Exempt trusted apps**. Or skip Pub/Sub and reconnect with only Gmail ticked. |
| Pub/Sub `PERMISSION_DENIED` | Provisioning account lacks IAM on the project | Grant **Owner** or **Pub/Sub Admin** (§6b). |
| `SERVICE_DISABLED` / "…has not been used in project … or it is disabled" | API not enabled | Enable the Gmail or Pub/Sub API (§2), wait a couple of minutes. |
| Org policy / *Domain Restricted Sharing* error | `iam.allowedPolicyMemberDomains` blocks the publisher grant | Use polling, or get a project exception (§6c). |
| No events in Pub/Sub mode, but polling works | Watch missing or expired, or the subscription is broken | Re-run provisioning, which restarts all watches. Gmail watches expire after 7 days. agentinbox renews daily and on provisioning, so expiry only happens if it was stopped for over a week **(verify)** that it re-arms watches on startup. A `sync.gap` event means it resynced after missing history. |
| **Publish app** greyed out | Branding incomplete | See §3d. |
| Pop-up never opens | Browser blocked it | Allow pop-ups for the console, or click **Open sign-in again**. |
| Console unreachable from the laptop | Tunnel down, or bound to the wrong host | Restart `ssh -N -L 8425:localhost:8425 you@server`. Check that agentinbox printed its URL and that the port isn't used by something else. |

---

## 10. Security notes

- **Everything lives in `~/.agentinbox/`** (directory mode `0700`). Override the location with `--data` or `AGENTINBOX_DATA`.
  - `agentinbox.db` (SQLite) holds:
    - connected accounts with **AES-256-GCM-encrypted** refresh and access tokens
    - the encrypted OAuth client secret
    - agents, with API keys stored only as **SHA-256 hashes**
    - the admin password as a **scrypt** hash
    - grants, events, webhook config and secrets, deliveries, approvals and the audit log
  - `master.key` (mode `0600`) is the 32-byte key that decrypts the secrets above. Alternatively set `AGENTINBOX_MASTER_KEY` (base64, 32 bytes) and don't keep the file.
  - `setup-token` exists only until you claim the instance.
- **Back up `master.key` and `agentinbox.db`, but store them separately.** Together they grant mailbox access. If you lose `master.key`, you must reconnect every account and re-enter the client secret.
- Mail bodies aren't stored long term: tools fetch them from Gmail on demand. Webhooks that opt into bodies send them to the receiver **(verify)** whether event rows keep snippets.
- The console is plain HTTP on `0.0.0.0:8425` by default. On a server, use `--host 127.0.0.1` plus an SSH tunnel, or an HTTPS reverse proxy. Don't expose plain HTTP to the internet. The admin login locks out after 5 failed attempts.
- `gmail.modify` lets agentinbox read, compose, send, label and trash mail, but not permanently delete it. What each **agent** can do is narrower, set by its grant. Start with `draft_only` and consider label scopes.
- **Revoking access:**
  - **One mailbox:** **Gmail accounts** → remove. This stops the watch, revokes the token at Google and deletes grants. Or do it from Google's side at https://myaccount.google.com/permissions.
  - **One agent:** delete it or rotate its key under **Agents**.
  - **Everything:** delete the OAuth client in Google Auth Platform → **Clients**. Every token stops working.
  - **Leaked client secret:** add a new secret on the client, update it in agentinbox, then delete the old one.
- Keep the OAuth app to yourself. Unverified External apps are capped at 100 users over the project's lifetime, and you'd be the "developer" responsible for anyone else's data.

---

### Sources checked (October 2026)

- Google Auth Platform consent configuration: https://developers.google.com/workspace/guides/configure-oauth-consent
- Creating OAuth clients (Clients page, Web application, redirect URIs): https://developers.google.com/workspace/guides/create-credentials
- Manage OAuth clients (secret only visible at creation; unused clients deleted after 6 months): https://support.google.com/cloud/answer/15549257
- Usability and safety updates to Google Auth Platform (secret masking): https://developers.googleblog.com/usability-and-safety-updates-to-google-auth-platform/
- Manage app audience (Testing vs In production, 7-day expiry, 100 test users, 100-user unverified cap, `org_internal`): https://support.google.com/cloud/answer/15549945
- Unverified apps: https://support.google.com/cloud/answer/7454865
- OAuth 2.0 overview (refresh token expiry reasons, password change revokes Gmail tokens, 100 tokens per client per account): https://developers.google.com/identity/protocols/oauth2
- Web server OAuth (`redirect_uri_mismatch`): https://developers.google.com/identity/protocols/oauth2/web-server
- Gmail scopes (`gmail.modify` restricted, description text): https://developers.google.com/workspace/gmail/api/auth/scopes
- Gmail push notifications (`gmail-api-push@system.gserviceaccount.com`, watch every 7 days / daily, domain-restricted sharing): https://developers.google.com/workspace/gmail/api/guides/push
- `users.watch` (topic must be in the same project): https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/watch
- Pub/Sub access control (Editor lacks `setIamPolicy`, Admin has it): https://docs.cloud.google.com/pubsub/docs/access-control
- `gcloud pubsub subscriptions create` flags: https://docs.cloud.google.com/sdk/gcloud/reference/pubsub/subscriptions/create
- Domain-restricted sharing and the secure-by-default orgs created on or after 3 May 2024: https://docs.cloud.google.com/organization-policy/domain-restricted-sharing, https://docs.cloud.google.com/iam/docs/allow-policies
- Google Cloud session control (`invalid_rapt`): https://support.google.com/a/answer/9368756
- Publishing walkthrough ("Push to production?" dialog): https://workos.com/docs/integrations/google-oauth
- "Publish app" disabled report: https://discuss.google.dev/t/google-auth-platform-publish-app-disabled-for-external-testing-personal-use-oauth-app/402925
