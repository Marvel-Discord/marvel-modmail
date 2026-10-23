# Marvel Modmail — Fork Changes

This repository is a fork of [Dragory/modmailbot](https://github.com/Dragory/modmailbot) (upstream remote `upstream`, default comparison `git diff upstream/master...master`). This document lists every intentional deviation so upstream merges stay mechanical. Last verified against upstream `536317c` (v3.11.0 + 7 commits, contained in fork master via PR #5).

| # | Change | Files | Config keys |
|---|--------|-------|-------------|
| 1 | OAuth2 log/attachment protection + confidential threads | `src/modules/webserver.js`, `src/modules/webserverPlugin.js` | `oauthClientSecret`, `confidentialAccessRoleIds`, `confidentialAccessUserIds` |
| 2 | Suppress Discord embeds on posted links | `src/modules/close.js`, `src/main.js` | — |
| 3 | Plugin install machinery (offline name cache) | `src/plugins.js` | `reinstallPlugins`; env `MM_PLUGIN_INSTALL_MAX_RETRIES`, `MM_PLUGIN_INSTALL_RETRY_BASE_DELAY_MS`, `MM_PLUGIN_INSTALL_RETRY_MAX_DELAY_MS`, `GITHUB_TOKEN` |
| 4 | Error resilience | `src/bot.js`, `src/index.js` | — |
| 5 | SQLite connection pool | `src/knexConfig.js` | — |
| 6 | Docker/infra | `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `packages/*` (pinned plugin gitlinks) | — |
| 7 | Privacy policy | `PRIVACY_POLICY.md` | — |

## 1. OAuth2 log/attachment protection + confidential threads

Based on https://gist.github.com/promise/951880b7ee092aedaa5d6f281f181046 (adapted).

**What:** The `/logs` and `/attachments` routes were moved from webserver.js into webserverPlugin.js behind Discord OAuth2 (identify scope, JWT cookie, 1h expiry, random per-boot HMAC key — NOTE: OAuth sessions are invalidated on every bot restart). Inbox-server membership is required; attachments also require OAuth. Confidential threads: `!promote`/`!elevate`/`!raise` marks a thread confidential, `!demote`/`!downgrade`/`!lower` unmarks it; confidential logs are restricted to inbox-server admins, configured roles, and configured users.

Config keys (config.ini, gitignored):
- `oauthClientSecret` — required; the bot fails to start without it (Discord Developer Portal → app → Bot → Client Secret). The previously committed value is in git history and must be treated as compromised — rotate it.
- `confidentialAccessRoleIds` — comma-separated role IDs.
- `confidentialAccessUserIds` — comma-separated user IDs.

**Merge notes:** Upstream changes to webserver.js routes/log formatting must be manually mirrored into webserverPlugin.js's `serveLogs`/`serveAttachments` (this happened for the embed-summarisation feature in upstream v3.11.0-era code). webserver.js is upstream minus the two route registrations.

## 2. Suppress Discord embeds on posted links

**What:** Close notifications post `Logs: <url>`; bot-mention notifications inline the message link wrapped as `<link>`.

**Why:** Unwrapped URLs render embeds in Discord.

**Merge notes:** One-line strings in close.js (`sendCloseNotification`) and main.js (bot-mention handler).

## 3. Plugin install machinery (offline name cache)

**What:** npm-source plugins (`npm:owner/repo#ref` or npm package names) are resolved through a
persistent spec→name cache at `db/plugin-names.json` (rides the database volume in production):

- **Boot with plugins installed (steady state):** cache hit → `require.resolve(name)` — a local
  filesystem check. Zero network requests, no npm invocations.
- **Cold container / new plugin:** queued → one batched `npm install` (spawns the npm CLI) →
  package names are recovered offline from `node_modules/.package-lock.json` (tarball URL → name
  reverse-lookup) and written to the cache. Installs of GitHub specs authenticate to
  api.github.com via the npmrc the Dockerfile CMD writes from `GITHUB_TOKEN` (5,000 req/hr token
  quota instead of 60 req/hr unauthenticated).
- `load()` prefers the cache; `pacote.manifest()` remains only as a first-run fallback for
  never-cached npm-registry specs; GitHub specs that somehow reach load() uncached are resolved
  offline from the lockfile or fail with a clear error (never an unauthenticated network call).
- Install retries on HTTP 403 with exponential backoff (10s base, 120s cap; extra attempts =
  `MM_PLUGIN_INSTALL_MAX_RETRIES`, default 5, production sets 10). `reinstallPlugins` in
  config.ini forces a full reinstall. A startup warning fires when installs are needed but
  `GITHUB_TOKEN` is absent.

**Why:** restart loops previously made unauthenticated api.github.com requests on every boot
(the old `pacote.manifest()` probe runs in-process and reads no npmrc) — a crash loop exhausted
the 60 req/hr IP quota in minutes and the loop could never recover. With the cache, a crash loop
makes zero GitHub requests.

**Requirements for deployers:**
- Pin GitHub plugin specs to exact commits: `plugins[] = npm:owner/repo#<full-sha>` — unpinned
  specs install whatever is on the default branch at fetch time (the bot logs a warning when
  queueing an unpinned GitHub plugin).
- Keep `GITHUB_TOKEN` set in the runtime environment (the Dockerfile CMD turns it into
  `/root/.npmrc`). Without it, installs still work but are unauthenticated and rate-limited.
- `db/` must be a persistent volume, or the cache only survives restarts, not redeploys.
- If `useGitForGitHubPlugins` is enabled, installs resolve via git and GitHub specs are not
  cached — the zero-network invariant does not hold; this is not used in production.

**Merge notes:** all logic lives in the `pluginSources.npm` body + helpers above it in
`src/plugins.js`. Upstream changes elsewhere in the file merge cleanly.

## 4. Error resilience

**What:** `EAI_AGAIN` (transient DNS failure) is added to Eris's safe-to-ignore error codes; "Invalid channel ID:" Eris cache-race errors are ignored; ignored errors log a `[Eris warning]` line; uncaught/unhandled errors additionally print a one-line `[Error summary]` to stdout (type/code/message) so root causes survive truncated stack traces in noisy logs.

**Why:** transient DNS failures (EAI_AGAIN) and a known Eris cache-race error crashed the bot during network blips; the one-line summaries keep root causes visible in truncated production logs.

**Merge notes:** bot.js additions cluster around `SAFE_TO_IGNORE_ERROR_CODES`; index.js adds `getStdoutErrorSummary()` + one console.log in `errorHandler`.

## 5. SQLite connection pool

**What:** The sqlite connection is pinned to a single pooled connection (min 1 / max 1, 60s acquire timeout, 30s idle timeout).

**Why:** Serialized queries avoided SQLITE_BUSY errors under the bot's load.

**Merge notes:** Block append inside the `sqlite` branch of knexConfig.js.

## 6. Docker/infra

**What:** `Dockerfile` (node:24-alpine + git; CMD writes `/root/.npmrc` from `GITHUB_TOKEN`
before `exec npm start`), `docker-compose.yml` (reference local setup: config.ini bind-mount,
db + node_modules volumes), `.dockerignore`; `packages/` contains pinned gitlinks (commit
references, no .gitmodules) of the external plugins in use: CloseAddons, LogSearch,
MMEmergencyLink, Ping, and modmailbot-formatter (pinned to
`Marvel-Discord/modmailbot-formatter` — our fork carrying the Express-5 `app._router`
compatibility fix; see fork PR #1 / upstream funkyhippo#7). The gitlinks are **reference pins
only** — nothing is baked from them; plugins are installed at runtime by the §3 machinery, and
the config.ini spec pins are expected to match these gitlink commits.

Production does NOT use docker-compose.yml — it runs the `marvel-modmail` Komodo stack with the
locally built encrypted image `marvel-modmail-enc` (config at
`/home/nimrod/code/Marvel-Modmail/config.ini`, encrypted DB volume `db-encrypted`, env
`GITHUB_TOKEN` / `MM_PLUGIN_INSTALL_MAX_RETRIES=10` / `DB_PASSPHRASE`). The stack's entrypoint
must write the npmrc like the Dockerfile CMD does (the author's wrapper historically did).
**Wrapper trap:** an image that declares its own `CMD` (e.g. `CMD ["npm", "start"]`) overrides
the base image's npmrc-writing CMD — wrapper images must inherit the base CMD (declare no CMD
of their own) or write `/root/.npmrc` themselves.

**Do NOT bake plugins into the image by COPYing into `node_modules`** — the next
`npm install` prunes directories that aren't in package-lock.json.

**Merge notes:** These files are fork-only; upstream has no docker files. Gitlink pins update via `git add packages/<name>` after entering the dir and checking out the desired commit.

## 7. Privacy policy

**What:** Our privacy policy served by upstream's built-in privacy-policy feature from `PRIVACY_POLICY.md` (repo root; contact marvel@rocked03.dev).

**Merge notes:** File content only; upstream's webserver.js serves it verbatim.

## Merging upstream

```
git fetch upstream
git switch -c merge-upstream-<version>
git merge upstream/master
# resolve conflicts file-by-file using the sections above as the divergence map
# after resolving: git diff upstream/master...HEAD should again match this document's inventory
npm run lint && node src/index.js (with local config)
# PR into master; keep this document updated with anything new
```

## Deploying

Rebuild the `marvel-modmail-enc` image from `master` on the host, then redeploy the Komodo stack `marvel-modmail`. The host config.ini must contain `oauthClientSecret` (and optionally `confidentialAccessRoleIds`, `confidentialAccessUserIds`). Verify the startup log shows `Starting Modmail v<version> (<sha>)` and `Loaded N plugins`. The Discord application must have `https://<config.url>/auth` registered as an OAuth2 redirect URI (Discord Developer Portal → the app → OAuth2 → Redirects); the production bot already has this registered.

Plugin config must pin exact commits, e.g.:

    plugins[] = npm:MMPlugins/CloseAddons#7e9503da9f01e0fa61e5e3939846346a7e258240
    plugins[] = npm:MMPlugins/LogSearch#cc0c94fe9834fb2f04c043c05e97edb0727e3732
    plugins[] = npm:DarkView/MMEmergencyLink#b20ad5dd2248753211ee1647834f1a1908c886b3
    plugins[] = npm:MMPlugins/Ping#a27582f6f18f1df6ed0503d135adbb674fa65129
    plugins[] = npm:Marvel-Discord/modmailbot-formatter#1708280cdd3c3dd761bffd51124e22ddeebd4565

After the first successful boot, `db/plugin-names.json` should list all five specs mapped to
their package names (logsearch, modmailmsgclose, modmailping, emergencylink,
modmailbot-formatter). Subsequent boots log `Plugin '<spec>' already installed, skipping.` for
each and make no GitHub requests.

## Restart-loop runbook

If the bot crash-loops at startup:

1. Check whether the loop makes GitHub requests at all: steady-state boots with plugins cached
   make **zero**. Repeated `Retrying npm plugin install (attempt N/M)` lines mean the container
   lost `node_modules` (fresh layer) AND `db/plugin-names.json` (cache) — inspect
   `db/plugin-names.json` and the volume mounts.
2. `Plugin install hit HTTP 403/rate limit` + `GITHUB_TOKEN is not set` warning → the npmrc
   write is missing: verify `GITHUB_TOKEN` in the stack env and that the entrypoint/CMD wrote
   `/root/.npmrc`.
3. A plugin failing to `require()` with `MODULE_NOT_FOUND` after an install usually means the
   package was pruned (see §6 warning) or the lockfile reverse-lookup missed (uncached spec) —
   delete `db/plugin-names.json` to force a clean re-resolve.
4. `reinstallPlugins = true` in config.ini forces a full reinstall on next boot (remove it
   afterwards).
