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

- **`/record`** — Start recording a voice channel (required `channel:` and `name:` picker). Usable by server managers or users granted access with `/record-access grant`.
- **`/record-access`** — Admin command to grant/list/revoke non-admin users who may use `/record`.
- **`/stop`** — Stop recording a voice channel (required `channel:`), transcribe, and post results.
- **Concurrent recordings** *(optional)* — Record several meetings in the same server at once by supplying extra bot tokens via `DISCORD_TOKENS`.
- **`/status`** — Show active recording sessions.
- **`/set-summary-channel`** — Choose which text channel session summaries are posted in (`set`/`clear`/`show`); defaults to the channel where `/record` ran.
- **`/openrecapper-issue`** — Describe a bug, feature, or idea and have it filed as a GitHub issue.
- **Real-time transcription** — Live transcript streamed to a text channel as people talk.
- **Batch transcription** — High-quality Deepgram Nova-3 transcription with speaker diarization on stop.
- **AI session summary** *(optional)* — A structured Markdown recap after the call (overview, key points, questions/disagreements, references, action items, quotes).
- **Email delivery** *(optional)* — Emails the summary + transcript links to a configured address.
- **Cloud archival** *(optional)* — Uploads recordings/transcripts to any S3-compatible bucket (e.g. Cloudflare R2) with download links.
- **Auto-stop** — Stops automatically when everyone leaves the voice channel.
- **Scheduled recording** *(optional)* — Auto-join standing calls on a schedule, managed at runtime with `/schedule`.
- **Silence timeout** — Auto-leaves and cleans up if a call has no voice activity for a configurable window (default 20 min).
- **Recording cleanup** — Prunes old audio files on a retention schedule while keeping transcripts/summaries.
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

   **Multiple concurrent recordings per server** *(optional)*: Discord allows
   each bot identity only one voice connection per server, so recording N
   meetings in the same server at once requires N bot tokens. Set
   `DISCORD_TOKENS` (comma-separated, primary first) instead of
   `DISCORD_TOKEN` — the token count is the per-server concurrency limit.
   The primary token handles all slash commands and delivery (and can record
   too); the rest are voice-only recorder identities. For each extra token:
   create another bot application in the Discord Developer Portal and invite
   it to your server(s) with Connect + Speak permissions (a recorder not
   invited to a server simply doesn't count toward that server's capacity).
   Single-token setups can keep using `DISCORD_TOKEN` unchanged.

   **Meeting names for `/record`**: set `RECORD_MEETING_NAMES` to a
   comma-separated list of names shown in the required `name:` picker. The list
   is a hard allow-list — `/record` validates the chosen name against it
   server-side and rejects anything not on the list, so only these names can
   ever be recorded. The recording date is appended automatically, e.g.
   `RECORD_MEETING_NAMES=SIG-FPT,SIG-P4B,SIG-MRG,SIG-DRG`.
   R2 uploads are grouped under folders named for these meetings, e.g.
   `recordings/SIG-FPT/YYYY-MM-DD/...`.

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

Permissions integer `3263488`: View Channel, Connect, Speak (required even
though the bot is muted), Send Messages, Attach Files, Embed Links, Read Message
History. (Use Slash Commands is granted by the `applications.commands` scope, not
a permission bit.)

OAuth2 scopes: `bot`, `applications.commands`.

Intents (all requested on startup): `Guilds`, `GuildVoiceStates`,
`GuildMessages`, `GuildMessageReactions`, and `MessageContent`. The last is a
**privileged** intent, so **Message Content Intent must be enabled** in the
Developer Portal or login fails — see [DISCORD_SETUP.md](DISCORD_SETUP.md).
`GuildMessageReactions` + `MessageContent` are only actually used by Grapevine,
but are requested regardless.

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

**Reference implementation:** a ready-made relay ships in
[`relay-exedev/`](relay-exedev/) — a small Node service that bridges these two
endpoints to [exe.dev](https://exe.dev)'s LLM and email gateways, so the bot
gets summaries and email without you holding any third-party API keys. It must
run on an exe.dev VM (the gateways are link-local). See
[`relay-exedev/README.md`](relay-exedev/README.md) for its env vars and
endpoint reference, and `relay-exedev/relay.service.example` for a sample
systemd unit. On any other host, use it as a template for your own relay.

## Scheduled recording (optional)

The bot can auto-join and record standing calls on a schedule, managed at
runtime with the **`/schedule`** command (requires Manage Server):

```
/schedule add voice_channel:#standup days:mon,fri time:11:15 text_channel:#transcriptions
/schedule list
/schedule edit | remove | pause | resume
```

`days` accepts names/aliases (`mon,fri`, `weekdays`, `weekends`, `daily`),
`time` is 24-hour `HH:MM`, and `timezone` is any IANA zone (default
`America/New_York`). Schedules persist to `data/schedules.json` and survive
restarts. Each active schedule must have an explicit text channel for live
transcript/results (`/schedule add text_channel:...` or `/schedule edit ...
text_channel:...`). Use `/test-schedule` to trigger one manually.

The legacy `SCHEDULED_*` env vars (see `.env.example`) are still honored as a
**one-time seed**: if no `data/schedules.json` exists on first start, they create
the first schedule, after which the JSON store is authoritative.

A configurable **silence timeout** (`SILENCE_TIMEOUT_MINUTES`, default 20) makes
the bot auto-leave a call with no voice activity, and old audio files are pruned
after `RECORDING_RETENTION_DAYS` (default 7) while transcripts are kept.

### Native Discord Scheduled Events (optional, opt-in)

Instead of (or alongside) `/schedule`, organizers can drive recording from
Discord's built-in **Events** UI. When a **Voice/Stage** scheduled event goes
live, the bot auto-joins and records its voice channel; when the call ends the
recording stops and the transcript/summary is posted to a text channel — the
same delivery flow as `/record` and `/schedule`. Discord's native `recurrence`
(e.g. biweekly) works, so standing calls can be managed entirely from the Events
UI.

Because events can't hold attachments and disappear from the UI once completed,
results are **not** written back onto the event; they post as a normal message
in the target text channel (the guild's `/set-summary-channel`, else the system
channel, else the first text channel the bot can post in). While the event is
still live, its description is annotated with where results will land.

Stopping is driven by the **voice channel emptying of humans** (not the event's
`Completed` status — Discord doesn't emit `Completed` for recurring events, it
rolls over to the next occurrence). `Completed`/`Canceled`/`Deleted` are handled
as extra safety-net stops.

This is **opt-in and default OFF** so enabling the (non-privileged)
`GuildScheduledEvents` gateway intent doesn't silently change behavior. Enable
via the `GUILD_EVENT_RECORDING` env var:

```
GUILD_EVENT_RECORDING=off              # default — disabled
GUILD_EVENT_RECORDING=on               # enable for every guild
GUILD_EVENT_RECORDING=<guildId>,<...>  # enable only for listed guild ids
```

Recording still funnels through the one-recording-per-channel guard, so a
channel already recorded by `/schedule` or `/record` is skipped, never
double-started. Design details: [`docs/GUILD_EVENT_RECORDING.md`](docs/GUILD_EVENT_RECORDING.md).

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
├── commands/                         # /record /record-access /stop /status /schedule
│                                     #   /test-schedule /set-summary-channel
│                                     #   /openrecapper-issue /grapevine
├── workers/
│   └── voice-worker.ts               # Voice channel recorder (per-user streams)
└── services/
    ├── worker-manager.ts             # Session orchestration, transcription, upload, summary, email
    ├── recorder-pool.ts              # Leases recorder identities for concurrent recordings
    ├── opus-decoder.ts               # Opus → PCM transform stream
    ├── silence-filler.ts             # Pads gaps so per-user tracks stay time-aligned
    ├── transcription-service.ts      # Deepgram batch transcription (REST)
    ├── live-transcription-service.ts # Deepgram real-time streaming (WebSocket)
    ├── storage-service.ts            # S3-compatible (R2) upload
    ├── recording-cleanup.ts          # Prunes old audio files on a retention schedule
    ├── scheduler.ts                  # node-cron auto-join for standing calls
    ├── schedule-store.ts             # Persists standing-call schedules (data/schedules.json)
    ├── cron-format.ts                # Translates /schedule inputs ↔ 5-field cron expressions
    ├── call-naming.ts                # Call naming + ISO-date slugs
    ├── record-permission-store.ts    # Per-guild /record access allow-list
    ├── summary-channel-store.ts      # Per-guild override for where summaries are posted
    ├── summary-service.ts            # AI session summary
    ├── relay-client.ts               # Relay client (LLM summary + email)
    ├── issue-draft-service.ts        # Turns /openrecapper-issue text into an issue draft (via relay)
    ├── github-issue-client.ts        # Files GitHub issues via a fine-grained PAT
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
