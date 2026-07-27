# OpenRecapper repo guidance

This checkout may contain both the public OpenRecapper repository and legacy/private deployment history. Be explicit about which branch base you use.

## Remotes

- `origin` is the public GitHub repo: `The-Yak-Collective/openrecapper`.
- `private` is legacy/archived YC deployment history. Treat it as read-only unless the user explicitly asks otherwise.

## Branching rules

- For normal feature work or PRs to GitHub, always branch from current public main:
  ```bash
  git fetch origin
  git switch -c <feature-branch> origin/main
  ```
- **`main` is the source of truth and the deploy source** (see below). The
  legacy `deploy/openrecapper-yc` branch is retained only as history — as of
  the 2026-07-27 merge its tree is identical to `origin/main`. Do not add new
  deploy-only divergence to it; land fixes on `main` and deploy from `main`.
- If you ever need a genuinely deploy-scoped, non-public hotfix branch, name it
  clearly (e.g. `yc/<name>`) and never open a public PR from it.
- Before pushing, verify the base with:
  ```bash
  git branch -vv
  git merge-base --is-ancestor origin/main HEAD && echo "contains origin/main"
  git log --oneline --decorate --graph --max-count=8
  ```

## Deployment (Hetzner bot — deploy from `main`)

The live YC bot runs on the Hetzner box, **not** on this exe.dev VM.

- **Host:** SSH alias `hetzner-yak` (`~/.ssh/config`), root login.
- **Location:** `/opt/openrecapper`, a git checkout of `origin/main`
  (`origin` push is DISABLED there — pull only).
- **Runtime:** `openrecapper.service` (systemd), `ExecStart=/usr/bin/node dist/index.js`,
  `EnvironmentFile=/opt/openrecapper/.env`, Node v22.
- **Secrets/config** live only in `/opt/openrecapper/.env` (gitignored), never in the repo.

### Build caveat

Hetzner has **production-only `node_modules`** — `typescript` and `tsx` are
NOT installed there, so `npm run build` / `npm run register` cannot run on the
Hetzner box directly. Build `dist/` on this exe.dev VM (which has full devDeps)
and rsync it over. The compiled `dist/register-commands.js` runs with plain
`node` on Hetzner (config auto-loads `../.env` via dotenv).

### Deploy procedure (verified 2026-07-27)

```bash
# --- On this exe.dev VM: build dist/ from origin/main ---
git fetch origin
git worktree add /tmp/or-main origin/main         # clean checkout of main
cd /tmp/or-main
ln -sfn ~/openrecapper/node_modules node_modules  # reuse devDeps toolchain
cp ~/openrecapper/tsconfig.json .                 # tsconfig is gitignored
npx tsc                                           # -> dist/

# --- Safety: never deploy during an active recording ---
ssh hetzner-yak 'find /opt/openrecapper/recordings -maxdepth 1 -type d -mmin -20 | grep . \
  && echo ACTIVE-DO-NOT-RESTART || echo safe'

# --- On Hetzner: sync repo to origin/main, back up + swap dist/ ---
ssh hetzner-yak 'cd /opt/openrecapper && git fetch origin && \
  git checkout main && git reset --hard origin/main'
ssh hetzner-yak "cp -r /opt/openrecapper/dist /opt/openrecapper/dist.backup.$(date -u +%Y%m%dT%H%M%SZ)"
rsync -az --delete /tmp/or-main/dist/ hetzner-yak:/opt/openrecapper/dist/

# --- Re-register slash commands (global) + clear stale guild copies ---
ssh hetzner-yak 'cd /opt/openrecapper && node dist/register-commands.js'

# --- Restart + verify health ---
ssh hetzner-yak 'systemctl restart openrecapper && sleep 6 && \
  systemctl is-active openrecapper && journalctl -u openrecapper -n 25 --no-pager'
```

A healthy startup logs `Logged in as OpenRecapper#3993`, loaded schedules, and
four `[HealthCheck] ✅` lines (Deepgram, Relay, R2, Schedules). Timestamped
`dist.backup.*` dirs in `/opt/openrecapper` are prior releases; roll back by
rsync'ing one back into `dist/` and restarting.

Deployment does not imply a branch is public-PR-ready, but public repo branches
and the deploy source are now the same: keep everything based on `origin/main`.

## exe.dev relay: build & wire-up

`relay-exedev/` is a reference implementation of the relay HTTP service the bot
uses for AI summaries and email (`GET /health`, `POST /summarize`, `POST /email`,
all but `/health` authenticated via the `X-Relay-Token` header). It bridges to
exe.dev's link-local LLM and email gateways (see the exe.dev docs at
https://exe.dev/docs.md for the gateway addresses), so **it only works on an
exe.dev VM**. Full API and env-var docs: `relay-exedev/README.md`.

There is no build step — it's plain ESM JavaScript (`server.mjs`) run directly
by Node (needs a Node with global `fetch`, i.e. v18+; hosts here use v24).
Unlike the bot, changing it never requires `npm run build`.

To wire it up on a fresh exe.dev VM:

```bash
# 1. Generate the shared secret
openssl rand -hex 24

# 2. Install the systemd unit: copy relay-exedev/relay.service.example to
#    /etc/systemd/system/relay.service, set the real RELAY_TOKEN in the
#    Environment= line, and fix WorkingDirectory/ExecStart/User paths for the host.
sudo systemctl daemon-reload
sudo systemctl enable --now relay.service

# 3. Point the bot at it — in the bot's .env:
#      RELAY_URL=http://127.0.0.1:8787
#      RELAY_TOKEN=<same value as the unit's RELAY_TOKEN>
#    then restart the bot service.

# 4. Verify
curl -s http://127.0.0.1:8787/health   # -> {"ok":true}
```

The token lives only in the systemd unit (and the bot's `.env`) — never commit
a real token to the repo. If `RELAY_TOKEN` is unset on the bot side, recording
and transcription still work; summaries and email are skipped gracefully.
