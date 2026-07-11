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
- For deployed YC bot hotfixes only, branch from `deploy/openrecapper-yc`, and make the branch name clearly deployment-scoped, e.g. `yc/<name>`.
- Do not create public feature branches from `deploy/openrecapper-yc`.
- Before pushing, verify the base with:
  ```bash
  git branch -vv
  git merge-base --is-ancestor origin/main HEAD && echo "contains origin/main"
  git log --oneline --decorate --graph --max-count=8
  ```

## Deployment note

The Hetzner bot can be deployed from built `dist/`, but deployment does not imply the source branch is suitable for a public PR. Keep public repo branches based on `origin/main`.

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
