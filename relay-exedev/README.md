# relay-exedev

A small companion HTTP service that bridges the OpenRecapper bot's
`/summarize` and `/email` calls to **exe.dev's** LLM and email gateways. It
lets the bot produce AI summaries and send email without the bot (or its
operator) holding any third-party LLM or email API keys — the relay talks to
exe.dev's link-local gateways instead.

This is a **reference implementation**, checked into the repo as
`relay-exedev/` for documentation and portability. See the root
[`README.md` → "AI summaries & email (optional)"](../README.md#ai-summaries--email-optional)
section for how the bot side of this integration works.

## Must run on an exe.dev VM

The relay talks to exe.dev's LLM and email gateways, which are link-local
addresses that only resolve to something useful on an exe.dev VM. The gateway
URLs are not hardcoded — set them via `RELAY_LLM_GATEWAY` and
`RELAY_EMAIL_GATEWAY`, looking up the addresses in the
[exe.dev docs](https://exe.dev/docs.md).

## Environment variables

| Var | Required | Default | Notes |
| --- | --- | --- | --- |
| `RELAY_TOKEN` | yes | — | Shared secret. Must match the bot's `RELAY_TOKEN` exactly. The process refuses to start if this is unset. |
| `RELAY_LLM_GATEWAY` | yes | — | exe.dev LLM gateway URL (Anthropic-compatible Messages API). See the [exe.dev docs](https://exe.dev/docs.md). The process refuses to start if unset. |
| `RELAY_EMAIL_GATEWAY` | yes | — | exe.dev email gateway URL. See the [exe.dev docs](https://exe.dev/docs.md). The process refuses to start if unset. |
| `RELAY_PORT` | no | `8787` | Port the relay listens on. Always binds `127.0.0.1` only, never exposed externally. |
| `RELAY_MODEL` | no | `claude-sonnet-4-6` | Default model used for `/summarize` when the request doesn't specify one. |

The relay does not load a `.env` file — it reads the process environment, so
set these in the systemd unit's `Environment=` lines (see
`relay.service.example`) or however you launch the process.

Generate a token with:

```bash
openssl rand -hex 24
```

## How the bot connects

Set these in the bot's `.env` (see `src/config.ts`):

```
RELAY_URL=http://127.0.0.1:8787
RELAY_TOKEN=<same value as this relay's RELAY_TOKEN>
```

If `RELAY_TOKEN` is unset on the bot side, the bot still records and
transcribes as normal — summaries and email are simply skipped
(`src/services/relay-client.ts`). Both endpoints below are authenticated with
an `X-Relay-Token` header that must match this relay's `RELAY_TOKEN`.

## Endpoint reference

### `GET /health`

No auth required. Returns:

```json
{ "ok": true }
```

### `POST /summarize`

Requires `X-Relay-Token` header.

Request body:

```json
{ "system": "...", "prompt": "...", "model": "...", "maxTokens": 2500 }
```

- `system`, `model`, `maxTokens` are optional (`model` defaults to
  `RELAY_MODEL`, `maxTokens` defaults to `2500`).
- `prompt` is sent as the user message content.

Response:

```json
{ "text": "...", "truncated": false }
```

- `truncated` is `true` when the model stopped because it hit the `maxTokens`
  hard cap, i.e. the returned text is cut off. The bot uses this to warn the
  channel that the summary is incomplete.

### `POST /email`

Requires `X-Relay-Token` header.

Request body:

```json
{ "to": "...", "subject": "...", "body": "..." }
```

- `to` and `subject` are required; `body` defaults to an empty string.
- Recipient must be you, a teammate, or someone who has logged into the
  shared exe.dev VM (anti-spam), and sends are rate-limited.

Response:

```json
{ "ok": true }
```

## Deployment note (this host)

On this host, the **live** relay does not currently run from this repo copy —
it runs from `/home/exedev/relay/server.mjs`, managed by the
`relay.service` systemd unit. After editing the live copy, restart it with:

```bash
sudo systemctl restart relay.service
```

See `relay-exedev/relay.service.example` in this directory for a sanitized
copy of that unit file. Cutting the live service over to run from this repo
copy is a separate, later step — not part of adding this reference copy.
