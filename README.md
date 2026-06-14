# OpenRecapper

An open-source Discord bot that **records voice channels**, produces
**speaker-labeled transcripts**, and writes a structured **AI call summary** —
overview, key points, open questions, references, and action items — then
optionally emails it to your group.

> **Self-hosted.** There is no shared/hosted instance, and **no “Add to
> Discord” invite link** — by design. You run your own bot with your own Discord
> application, Deepgram account, and (optional) storage and summarization
> services. Installing OpenRecapper means creating your own Discord app and
> inviting *that* (see [Setup](#setup) and [DISCORD_SETUP.md](DISCORD_SETUP.md)),
> not clicking an invite to someone else's bot.

## Features

- **`/record`** — Join a voice channel and start recording (optional `name:`).
- **`/stop`** — Stop recording, transcribe, and post results.
- **`/status`** — Show active recording sessions.
- **Real-time transcription** — Live transcript streamed to a text channel as people talk.
- **Batch transcription** — High-quality Deepgram Nova-3 transcription with speaker diarization on stop.
- **AI session summary** *(optional)* — A structured Markdown recap after the call (overview, key points, questions/disagreements, references, action items, quotes).
- **Email delivery** *(optional)* — Emails the summary + transcript links to a configured address.
- **Cloud archival** *(optional)* — Uploads recordings/transcripts to any S3-compatible bucket (e.g. Cloudflare R2) with download links.
- **Auto-stop** — Stops automatically when everyone leaves the voice channel.
- **Scheduled recording** *(optional)* — Auto-join a standing call on a cron schedule.
- **DAVE E2EE** — Supports Discord's end-to-end encryption for voice.
- **Startup health check** — Validates the Deepgram key on boot and can DM an alert if it's dead.
- **Grapevine** *(optional)* — Cross-server reaction forwarding via webhook. See [`docs/GRAPEVINE.md`](docs/GRAPEVINE.md).

## How it works

1. The bot joins the voice channel and subscribes to each user's audio stream.
2. Opus packets are decoded to 48kHz 16-bit stereo PCM.
3. **While recording:** PCM is streamed to per-user Deepgram WebSockets for live transcription, posted to Discord every few seconds with speaker names.
4. **On stop:** Per-user tracks are combined into a single WAV and sent to Deepgram Nova-3 for high-quality batch transcription with diarization.
5. Artifacts (WAV, transcript) are optionally uploaded to your S3-compatible bucket.
6. Results are posted to Discord; an AI summary + email are sent if a relay is configured.

## What you need to bring

Each operator runs and pays for their own:

- **Discord application + bot token** (free) — see [DISCORD_SETUP.md](DISCORD_SETUP.md).
- **Deepgram account + API key** — speech-to-text (live + batch). Usage-billed.
- **Hosting** — anywhere that runs Node.js 22 (your laptop, a VPS, a container).
- *(optional)* **S3-compatible storage** (e.g. Cloudflare R2) for archival + download links.
- *(optional)* **A “relay” service** you run for AI summaries + email (see below).

## Setup

**Requirements:** Node.js 22+ (required by `@discordjs/voice` 0.19+) and a
toolchain able to build native modules (`@discordjs/opus`, `sodium-native`,
`@snazzah/davey`).

1. **Clone and install**
   ```bash
   git clone https://github.com/The-Yak-Collective/openrecapper.git
   cd openrecapper
   npm install
   ```

2. **Configure**
   ```bash
   cp .env.example .env
   # edit .env — see comments there for required vs optional vars
   ```
   Required: `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DEEPGRAM_API_KEY`.
   Everything else is optional. See [DISCORD_SETUP.md](DISCORD_SETUP.md) for
   creating the Discord app and inviting the bot.

3. **Register slash commands** (against your own app)
   ```bash
   npm run register
   ```

4. **Run**
   ```bash
   npm run dev     # development (tsx, no build step)
   # or, for production:
   npm run build   # compile TypeScript to dist/
   npm start       # node dist/index.js
   ```

## Bot permissions

Permissions integer `3165184`: Connect, Speak (required even though the bot is
muted), Send Messages, Attach Files, Read Message History, Use Slash Commands.

OAuth2 scopes: `bot`, `applications.commands`.

Intents: `Guilds`, `GuildVoiceStates` (+ `GuildMessageReactions` and
`MessageContent` only if you use Grapevine).

## AI summaries & email (optional)

Summaries and email are produced by a small **companion “relay” HTTP service**
that you run and point at your own LLM provider and email gateway. This keeps
LLM/email credentials out of the bot. If `RELAY_TOKEN` is unset, the bot still
records and transcribes — summaries and email are simply skipped.

The bot calls two authenticated endpoints (header `X-Relay-Token`):

```
POST /summarize  { system, prompt, model?, maxTokens }  ->  { text }
POST /email      { to, subject, body }                  ->  200 OK
```

Implement those against whatever LLM/email services you prefer, set `RELAY_URL`
and `RELAY_TOKEN`, and the bot will post AI summaries and send email after each
call. Tune `SUMMARY_GROUP_NAME` to fit your context (e.g. “engineering
standup”, “book club”).

## Scheduled recording (optional)

The bot can auto-join and record a standing call on a cron schedule. Set
`SCHEDULED_GUILD_ID`, `SCHEDULED_VOICE_CHANNEL_ID`, `SCHEDULED_TEXT_CHANNEL_ID`,
`SCHEDULED_CRON`, and `SCHEDULED_TIMEZONE` (see `.env.example`). Use
`/test-schedule` to trigger the same code path manually.

## Privacy & consent

This bot records and transcribes voice conversations. **You are responsible**
for obtaining participant consent and complying with your server's rules and
applicable laws. Be aware that:

- Recordings are written to local disk (`RECORDINGS_DIR`).
- If storage is configured, recordings/transcripts are uploaded to your bucket
  and may be reachable via public download links.
- Session folders and metadata include Discord user IDs and display names.
- Retention, access control, and deletion are entirely up to you.

## Deployment

OpenRecapper is a standard Node.js app and runs anywhere Node 22 does. Common
options:

- **[exe.dev](https://exe.dev/i/rlTIGN3KYBROR72) VM (recommended):** OpenRecapper is developed and
  run on an exe.dev VM and it's a great fit — a persistent Node 22 box with
  systemd, SSH, and an HTTPS proxy, so you can `npm run build`, drop in a systemd
  unit, and leave the bot running 24/7. This is what the maintainers use.
- **Local / VPS:** `npm run build` then run `node dist/index.js` under a process
  manager (systemd, pm2, etc.).
- **Docker:** a [`Dockerfile`](Dockerfile) is included.

Keep secrets in environment variables (or your platform's secret store), never
in the repo. There is no shared hosting or shared credentials — each fork runs
its own instance and pays for its own Discord app, Deepgram, storage, and host.

## Architecture

```
src/
├── index.ts                          # Bot entry, interaction router, auto-stop, reaction handler
├── client.ts                         # Shared Discord client reference
├── config.ts                         # Environment config
├── register-commands.ts              # Slash command registration script
├── commands/                         # /record /stop /status /test-schedule /grapevine
├── workers/
│   └── voice-worker.ts               # Voice channel recorder (per-user streams)
└── services/
    ├── worker-manager.ts             # Session orchestration, transcription, upload, summary, email
    ├── opus-decoder.ts               # Opus → PCM transform stream
    ├── silence-filler.ts             # Pads gaps so per-user tracks stay time-aligned
    ├── transcription-service.ts      # Deepgram batch transcription (REST)
    ├── live-transcription-service.ts # Deepgram real-time streaming (WebSocket)
    ├── storage-service.ts            # S3-compatible (R2) upload
    ├── scheduler.ts                  # node-cron auto-join for standing calls
    ├── call-naming.ts                # Call naming + ISO-date slugs
    ├── summary-service.ts            # AI session summary
    ├── relay-client.ts               # Relay client (LLM summary + email)
    ├── health-check.ts               # Startup Deepgram/relay health probes
    └── grapevine-service.ts          # Cross-server reaction forwarding
```

## Tech stack

- [discord.js](https://discord.js.org/) v14 + [@discordjs/voice](https://github.com/discordjs/discord.js/tree/main/packages/voice) (dev build with DAVE receive fix)
- [@snazzah/davey](https://github.com/Snazzah/davey) — DAVE E2EE native module
- [Deepgram Nova-3](https://deepgram.com/) — batch + streaming transcription
- [node-cron](https://github.com/node-cron/node-cron) — scheduled auto-join
- Optional: any S3-compatible store (e.g. [Cloudflare R2](https://developers.cloudflare.com/r2/)) for archival
- Node.js 22, TypeScript

## License

[MIT](LICENSE).
