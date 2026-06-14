# Discord Bot Setup Guide

## 1. Create a Discord Application

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **"New Application"** → name it (e.g., "OpenRecapper") → **Create**
3. Note the **Application ID** — this is your `DISCORD_CLIENT_ID`

## 2. Create the Bot User

1. In your application, go to **Bot** (left sidebar)
2. Click **"Reset Token"** → copy the token → this is your `DISCORD_TOKEN`
3. Under **Privileged Gateway Intents**, enable:
   - ✅ **Server Members Intent** (to resolve display names)
   - ✅ **Message Content Intent** (optional, for future features)

> ⚠️ **Never share or commit your bot token.** If leaked, immediately reset it in the Developer Portal.

## 3. Configure OAuth2 Permissions

The bot needs these permissions:

| Permission | Why |
|---|---|
| Connect | Join voice channels |
| Speak | Required for voice connection |
| Use Voice Activity | Receive audio from users |
| Send Messages | Post transcripts to text channels |
| Attach Files | Upload transcript & audio files |
| Read Message History | Context for transcript channel |

**Permission integer:** `3165184`

## 4. Generate the Invite URL

1. Go to **OAuth2 → URL Generator** in your application
2. Select scopes:
   - ✅ `bot`
   - ✅ `applications.commands`
3. Select bot permissions (see table above), or use this direct URL:

```
https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=3165184&scope=bot%20applications.commands
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
# Register /record, /stop, /status with Discord
npm run register

# Start the bot
npm run dev
```

You should see: `✅ Logged in as YourBot#1234`

## 7. Token Management Best Practices

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
