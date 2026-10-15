# Publishing agentinbox to npm (nightly)

## How it works

Every push to `main` runs `.github/workflows/nightly.yml`. The workflow installs dependencies, typechecks, lints, tests and builds. It then publishes `agentinbox@<version>-nightly.<N>` to npm under the `latest` dist-tag. `<version>` is the `version` in `package.json` (currently `0.1.0`). `<N>` is the workflow's run number, which only ever goes up.

- **No npm token is stored anywhere.** The workflow uses npm *trusted publishing*: GitHub hands the run a short-lived identity token (OIDC), and npm accepts it because you told npm to trust this exact repo and workflow file.
- **Provenance is automatic.** The repo and the package are both public, so npm attaches a signed "built on GitHub Actions from commit X" statement to each version. The workflow doesn't need a `--provenance` flag.
- **It is off until you switch it on.** The publish job only runs when the repository variable `NPM_PUBLISH_ENABLED` is `true`. Until then, every Nightly run shows the job as *skipped* (grey), the run itself counts as successful, and `main` stays green.

You only have to do the steps below once. Do them in order. Parts 2, 3 and 4 must be finished **within 2 days** of each other (see the warning in Part 2).

---

## Before you start

- [ ] The CI workflow (`.github/workflows/ci.yml`) is on `main` and its latest run on `main` is green (GitHub → `unlaboredlabs/agentinbox` → **Actions** → **CI**). If CI is red, the first nightly will fail too.
- [ ] `.github/workflows/nightly.yml` is on `main`.
- [ ] You have an npmjs.com account and can sign in at <https://www.npmjs.com/login>.
- [ ] **Two-factor authentication is on for your npm account.** npm refuses publishes from accounts without 2FA. To check, open npmjs.com, click your avatar → **Account**, and look at **Two-Factor Authentication**. If it's off, turn it on there (a security key, Touch ID/Windows Hello, or an authenticator app all work).
- [ ] Your machine has Node 22.14 or newer (`node --version`), npm (`npm --version`), git, and pnpm. To install pnpm: `npm install -g pnpm@12.11.2`.
- [ ] npm is pointed at the public registry. `npm config get registry` must print `https://registry.npmjs.org/`.

---

## Part 1: Publish the very first version by hand (one time only)

npm only lets you add a trusted publisher to a package that **already exists** on the registry. `agentinbox` has never been published, so the first version has to come from your machine. Every version after this one comes from GitHub Actions.

This first version is published as `0.1.0-nightly.0`, not `0.1.0`. That keeps `0.1.0` free for a real release later, and the CI nightlies (`0.1.0-nightly.1`, `.2`, …) follow on from it in order.

Use a fresh clone so nothing from your working copy leaks into the package:

- [ ] Clone `main` into an empty temporary folder:
  ```sh
  cd "$(mktemp -d)"
  git clone https://github.com/unlaboredlabs/agentinbox.git
  cd agentinbox
  git log -1 --oneline        # should be the latest commit on main
  ```
- [ ] Install and build:
  ```sh
  pnpm install --frozen-lockfile
  pnpm build
  ls dist/cli.js              # must exist
  ```
- [ ] Set the first version. This only edits `package.json` in this throwaway clone, with no commit and no tag:
  ```sh
  npm version "$(node -p 'require("./package.json").version.split("-")[0]')-nightly.0" --no-git-tag-version
  ```
  It prints `v0.1.0-nightly.0`.
- [ ] Check what will be uploaded. You should see `LICENSE`, `README.md` (once the README is on `main`), `package.json` and files under `dist/` (`dist/cli.js`, `dist/web/…`, `dist/skill/…`), and nothing else:
  ```sh
  npm pack --dry-run
  ```
- [ ] Log in to npm. This opens your browser, and npm asks for your 2FA:
  ```sh
  npm login
  npm whoami                  # prints your npm username
  ```
- [ ] Publish:
  ```sh
  npm publish --tag latest --access public
  ```
  npm will ask for 2FA again. Either it prints `Authenticate your account at: https://www.npmjs.com/auth/cli/…` (press Enter to open your browser and approve), or it asks for a one-time password (type the code from your authenticator app). This is expected. `--tag latest` is required, because npm refuses to publish a pre-release version like `-nightly.0` without an explicit tag.
- [ ] Confirm it's live:
  ```sh
  npm view agentinbox dist-tags     # { latest: '0.1.0-nightly.0' }
  ```
- [ ] Delete the temporary folder. Nothing in it is needed any more.

> **If the publish fails with `403 … Package name too similar to existing package agent-inbox`**: stop here and read "Package name too similar" under Troubleshooting. An unrelated package called `agent-inbox` already exists, and npm blocks new names that match an existing one once dashes, dots and underscores are removed. This can't be checked without actually publishing, so the first publish is where it shows up.

---

## Part 2: Tell npm to trust the GitHub workflow

> **2-day deadline:** once you save a trusted publisher, npm gives it 2 days to complete its first successful publish. If that doesn't happen in time, the configuration expires and you must delete it and create it again. So do Parts 3 and 4 right after this part.

- [ ] Sign in at <https://www.npmjs.com>.
- [ ] Open the package: <https://www.npmjs.com/package/agentinbox>. (Or go to avatar → **Packages** → **agentinbox**.)
- [ ] Click the **Settings** tab.
- [ ] Find the **Trusted Publisher** section (some npm pages call it **Trusted publishing**). Under **Select your publisher**, click **GitHub Actions**.
- [ ] Fill in the form exactly as below. Every field is case-sensitive, and npm does **not** check these values when you save. A typo only shows up later as a failed publish.

  | Field | Value |
  |---|---|
  | Organization or user | `unlaboredlabs` |
  | Repository | `agentinbox` |
  | Workflow filename | `nightly.yml` (just the filename, not `.github/workflows/nightly.yml`) |
  | Environment name | *leave empty* (the workflow doesn't use a GitHub environment) |
  | Allowed actions | **tick "npm publish"**. "npm stage publish" is always allowed and can stay. "npm dist-tag" is not needed. |

  "Organization or user" means the **GitHub** owner of the repo (`unlaboredlabs`), not your npm username.

  **The "npm publish" tick matters.** Trusted publishers created after 3 September 2026 only allow *staged* publishing by default, where every version waits for a human to approve it. The nightly workflow publishes directly, so without this tick every nightly fails.
- [ ] Save the form. The button is labelled something like **Set up connection** or **Save**. npm may ask for your 2FA.
- [ ] Check that the section now lists one GitHub Actions publisher for `unlaboredlabs/agentinbox`, workflow `nightly.yml`.

*Command-line alternative* (same result; needs npm 11.15.0 or newer, which `npx` provides, and you must be logged in from Part 1):
```sh
npx --yes npm@latest trust github agentinbox --repo unlaboredlabs/agentinbox --file nightly.yml --allow-publish
```

---

## Part 3: Switch publishing on in GitHub

**Either** in the browser:

- [ ] GitHub → `unlaboredlabs/agentinbox` → **Settings** (repo settings, not your profile) → left sidebar **Secrets and variables** → **Actions**.
- [ ] Open the **Variables** tab (not "Secrets").
- [ ] Click **New repository variable**.
- [ ] Name: `NPM_PUBLISH_ENABLED`. Value: `true` (lowercase, no quotes, no spaces).
- [ ] Click **Add variable**.

**Or** from a terminal (with `gh` logged in as an org admin):

- [ ] Run:
  ```sh
  gh variable set NPM_PUBLISH_ENABLED --body true --repo unlaboredlabs/agentinbox
  gh variable list --repo unlaboredlabs/agentinbox   # shows NPM_PUBLISH_ENABLED  true
  ```

This is a *variable*, not a secret. It holds no credential, only an on/off switch.

---

## Part 4: Run it and check the result

- [ ] Start a run. Either push any commit to `main`, or start one by hand:
  - Browser: **Actions** → **Nightly** (left sidebar) → **Run workflow** → Branch: `main` → **Run workflow**.
  - Terminal:
    ```sh
    gh workflow run nightly.yml --repo unlaboredlabs/agentinbox --ref main
    gh run watch --repo unlaboredlabs/agentinbox      # pick the Nightly run
    ```
- [ ] The **publish** job turns green. Its run summary ends with `Published agentinbox@0.1.0-nightly.<N>`.
- [ ] npm shows the new version as `latest`:
  ```sh
  npm view agentinbox dist-tags          # { latest: '0.1.0-nightly.<N>' }
  npm view agentinbox versions
  ```
- [ ] Provenance is attached. On <https://www.npmjs.com/package/agentinbox> there's a **Provenance** section (a green check, "Built and signed on GitHub Actions") linking to the commit and to the workflow run. From the terminal:
  ```sh
  npm view agentinbox@latest dist.attestations
  ```
  This prints a URL and a provenance predicate. If it prints nothing, there's no provenance (see Troubleshooting). The hand-published `0.1.0-nightly.0` from Part 1 correctly has no provenance.
- [ ] The package runs:
  ```sh
  npx --yes agentinbox@latest --help
  ```

From now on, every push to `main` publishes a new nightly without any action from you.

---

## Part 5: Lock it down (do this once Part 4 has worked)

- [ ] npmjs.com → package **agentinbox** → **Settings** → **Publishing access** → select **Require two-factor authentication and disallow tokens** → **Update Package Settings**. Tokens can then never publish this package. Trusted publishing keeps working, because it doesn't use tokens. You can still publish by hand with 2FA.
- [ ] npmjs.com → avatar → **Access Tokens**: revoke any token you created for this project and no longer need.
- [ ] Leave the trusted publisher on "npm publish". (Switching it to stage-only would make every nightly wait for your manual approval, and the workflow would also have to change to `npm stage publish`.)

---

## Turning publishing off again

- [ ] Set the variable to anything other than `true`, or delete it:
  ```sh
  gh variable delete NPM_PUBLISH_ENABLED --repo unlaboredlabs/agentinbox
  ```
  Nightly runs then show the publish job as skipped again. To cut off GitHub completely, also delete the trusted publisher on npmjs.com (package → Settings → Trusted Publisher).

---

## Troubleshooting

When a publish fails, open the failed run → **publish** job → **Publish** step. The step runs npm with verbose logging, so look for lines starting with `npm verbose oidc`. They say whether the token exchange with npm worked and, if not, why.

**The publish job is grey / "skipped".**
- [ ] `NPM_PUBLISH_ENABLED` is missing or isn't `true` (Part 3). Note: it must be under the **Variables** tab, not **Secrets**.
- [ ] The run wasn't on `main`. A manual run from another branch is always skipped, on purpose.

**`403 Forbidden … Package name too similar to existing package agent-inbox` (Part 1).**
npm won't accept `agentinbox` as a new unscoped name while `agent-inbox` exists. You can't fix this in the workflow. Pick one:
- [ ] Publish under the org scope instead, as `@unlaboredlabs/agentinbox`. Create a free npm organization named `unlaboredlabs` (npmjs.com → avatar → **Add Organization**; public packages are free). Then change `"name"` in `package.json` to `@unlaboredlabs/agentinbox` with a normal pull request to `main`, and redo Part 1 from a fresh clone. The command people type stays `agentinbox` (the `bin` entry doesn't change). They install with `npx @unlaboredlabs/agentinbox`. The workflow needs no changes; it already publishes with `--access public`, which scoped packages need. In Part 2, configure the trusted publisher on the scoped package, and in Part 4 use `npm view @unlaboredlabs/agentinbox …`.
- [ ] Or ask npm support (<https://www.npmjs.com/support>) to allow the unscoped name. This works sometimes, and there's no promised response time.

**`ENEEDAUTH`, `E401`, or `E404 Not Found - PUT https://registry.npmjs.org/agentinbox`.**
npm didn't accept the run's identity, so it fell back to having no real credentials. (A 404 on *publish* almost always means this, not that the package is missing.) Check each of these:
- [ ] The trusted publisher exists on the package (Part 2) and hasn't expired. If more than 2 days passed before the first successful CI publish, delete it and add it again.
- [ ] Organization `unlaboredlabs`, repository `agentinbox`, workflow filename `nightly.yml`. All three must match exactly, including case and the `.yml` ending (`nightly.yaml` or `Nightly.yml` won't match).
- [ ] **"npm publish" is ticked** under Allowed actions. If you can't edit it, delete the publisher and add it again with the tick.
- [ ] The **Environment name** on npm is empty. If you filled it in, delete the publisher and add it again without one. The workflow uses no environment.
- [ ] Nobody renamed `.github/workflows/nightly.yml`. npm matches by filename, so a rename needs a new trusted publisher.
- [ ] `repository.url` in `package.json` is still `git+https://github.com/unlaboredlabs/agentinbox.git`. npm checks that it matches the repo the run came from.
- [ ] The run used a GitHub-hosted runner (`runs-on: ubuntu-latest`). Self-hosted runners aren't supported for trusted publishing.

**`npm verbose oidc Skipped because incorrect permissions for id-token`.**
- [ ] The workflow must keep `permissions: id-token: write` at the top of `nightly.yml`. If someone removed it or narrowed `permissions`, put it back.

**`npm` is too old.**
- [ ] Trusted publishing needs npm 11.5.1 or newer (and Node 22.14 or newer). The workflow's **Check npm version** step prints the npm version and upgrades npm itself if it's older. If that step failed, re-run the job.

**`403 … You cannot publish over the previously published versions: 0.1.0-nightly.<N>`.**
- [ ] You re-ran a run that had already published. Re-runs keep the same run number, so they try to publish the same version again. Start a new run instead (Part 4) or push a commit.

**`You must specify a tag using --tag when publishing a prerelease version`** (manual publish).
- [ ] Add `--tag latest` to `npm publish`, as in Part 1.

**`EOTP` / "This operation requires a one-time password"** (manual publish).
- [ ] Re-run `npm publish --tag latest --access public` and approve the 2FA prompt, or add `--otp=123456` with the current code from your authenticator app. If npm says you need 2FA enabled, turn it on first (see "Before you start").

**Published fine, but there's no provenance.**
- [ ] Provenance requires a public GitHub repo and a public package. Check that `unlaboredlabs/agentinbox` is public. Hand-published versions (Part 1) never have provenance; that's normal.

---

## Sources

- npm Docs, "Trusted publishing for npm packages": <https://docs.npmjs.com/trusted-publishers>
- npm Docs, `npm trust` command: <https://docs.npmjs.com/cli/v11/commands/npm-trust>
- npm Docs, "Requiring 2FA for package publishing and settings modification": <https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification>
- npm Docs, "About two-factor authentication": <https://docs.npmjs.com/about-two-factor-authentication>
- npm Docs, "Generating provenance statements": <https://docs.npmjs.com/generating-provenance-statements>
