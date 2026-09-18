# Discord Bot Setup Guide

## 1. Create a Discord Application

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **"New Application"** → name it (e.g., "OpenRecapper") → **Create**
3. Note the **Application ID** — this is your `DISCORD_CLIENT_ID`

## 2. Create the Bot User

1. In your application, go to **Bot** (left sidebar)
2. Click **"Reset Token"** → copy the token → this is your `DISCORD_TOKEN`
3. Under **Privileged Gateway Intents**, enable:
   - ✅ **Message Content Intent** — **required.** The bot requests this
     privileged intent on startup, so it must be enabled or login fails with a
     "disallowed intents" error. (It's used to forward message text for the
     optional Grapevine feature, but is requested unconditionally.)
   - ⬜ **Server Members Intent** — not required. Display names are resolved by
     fetching individual members over REST, which doesn't need this intent.
     Leave it off unless you add a feature that needs the full member list.

> ⚠️ **Never share or commit your bot token.** If leaked, immediately reset it in the Developer Portal.

## 3. Configure OAuth2 Permissions

The bot needs these permissions:

| Permission | Why |
|---|---|
| View Channel | See the text/voice channels it operates in |
| Connect | Join voice channels |
| Speak | Required for the voice connection (the bot stays muted) |
| Send Messages | Post transcripts/summaries to text channels |
| Attach Files | Upload transcript & audio files |
| Embed Links | Render R2 download links posted in results |
| Read Message History | Context for the transcript channel |

**Permission integer:** `3263488`

## 4. Generate the Invite URL

1. Go to **OAuth2 → URL Generator** in your application
2. Select scopes:
   - ✅ `bot`
   - ✅ `applications.commands`
3. Select bot permissions (see table above), or use this direct URL:

```
https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=3263488&scope=bot%20applications.commands
```

4. Replace `YOUR_CLIENT_ID` with your Application ID
5. Open the URL → select your server → **Authorize**

## 5. Set Up Environment

```bash
cp .env.example .env
```

Edit `.env` and fill in the three required values:

```env
DISCORD_TOKEN=your-bot-token-here
DISCORD_CLIENT_ID=your-application-id-here
DEEPGRAM_API_KEY=your-deepgram-api-key-here
```

All other variables are optional — see the comments in `.env.example`.

### Getting a Deepgram API Key

Transcription (both live and batch) uses [Deepgram](https://deepgram.com/).

1. Sign up at [console.deepgram.com](https://console.deepgram.com/) and create an API key.
2. Put it in `.env` as `DEEPGRAM_API_KEY`.
3. Deepgram is usage-billed; new accounts include free credit to start.

## 6. Register Slash Commands & Start

```bash
# Register the slash commands (/record, /stop, /status, /schedule,
# /record-access, /set-summary-channel, /openrecapper-issue, /grapevine,
# /test-schedule) with Discord
npm run register

# Start the bot
npm run dev
```

You should see: `✅ Logged in as YourBot#1234`

## 7. Adding More Bots for Concurrent Recordings (optional)

Discord allows each bot identity **one voice connection per server**. To
record N meetings in the same server at the same time (e.g. parallel workshop
tracks), you need N bot identities. You do **not** run N copies of the bot —
one process drives all of them via `DISCORD_TOKENS`.

- The **first** token is the *primary*: it handles slash commands, live
  transcript posts, results, and delivery (and can record too).
- Every further token is a *voice-only recorder* identity. The bot picks a free
  one automatically each time `/record` runs.
- The number of tokens is the per-server concurrency limit.

For each extra bot:

1. **Create another application** in the Developer Portal (steps 1–2 above).
   If your existing app lives under a Team, create the new one under the same
   Team so they stay grouped. Name it distinguishably (e.g. `OpenRecapper-2`)
   and reuse the same icon if you want them to look alike in the member list.
2. **Reset Token** and copy it — it is shown only once. Enable **Message
   Content Intent** on it too: recorders don't strictly need it, but doing so
   lets you promote any of them to primary later without a "disallowed
   intents" login failure.
3. **Invite it to the server** with the same URL as step 4, substituting the
   new app's Application ID. This is the step people forget — a token whose
   bot isn't in the server simply doesn't add capacity there.
4. On private voice channels, check the **channel-level permission
   overrides**: the invite grants server-wide permissions, but a private
   channel can still deny the new bot's role `View Channel` / `Connect`.

Then edit `.env` — replace `DISCORD_TOKEN` with a comma-separated list,
**primary first**:

```env
DISCORD_TOKENS=<primary-token>,<recorder-2-token>,<recorder-3-token>
DISCORD_CLIENT_ID=<primary application id>   # unchanged
```

`DISCORD_CLIENT_ID` stays the primary's ID; slash commands are registered only
there, so there is no need to re-run `npm run register`. Restart the bot and
confirm the log shows one `✅ Logged in as …` plus one
`✅ Recorder logged in as …` line per extra token. A recorder that fails to log
in does **not** stop the bot — it just quietly reduces capacity — so do check
the log rather than assuming.

**Load notes for several simultaneous recordings:**

- Discord-side load is negligible; each identity has its own voice connection
  and all REST traffic stays on the primary.
- Disk is the main risk on the host. Each speaker is written as 48 kHz stereo
  PCM (~700 MB per hour of session once they have spoken), plus a combined
  PCM + WAV at stop. Four 90-minute rooms with ~8 speakers each can consume
  tens of GB before cleanup. Check `df -h` beforehand.
- Live transcription opens one Deepgram streaming connection per speaker per
  session; check your Deepgram plan's concurrency limit if you expect many
  speakers across several rooms.
- Post-processing at `/stop` (mixdown, batch transcription, summary, upload)
  is CPU-heavy and limited to two sessions at a time. If several rooms stop
  together, the rest queue and finish a few minutes later — nothing is lost.

## 8. Token Management Best Practices

- **Never commit `.env`** — it's in `.gitignore`
- **Rotate tokens** if anyone who shouldn't have access sees them
- **Use separate tokens** for dev vs. production
- **Reset immediately** via Developer Portal → Bot → Reset Token if compromised
- **Bot tokens don't expire** — they're valid until manually reset

## Troubleshooting

| Issue | Fix |
|---|---|
| "Missing Access" | Bot lacks permissions — re-invite with correct perms |
| "Unknown Channel" | Bot isn't in the server with that channel |
| Commands not showing | Run `npm run register` and wait ~1 hour for global propagation |
| No audio captured | Ensure "Use Voice Activity" perm + users aren't server-muted |
| Transcription errors | Check `DEEPGRAM_API_KEY` + Deepgram account billing status |
