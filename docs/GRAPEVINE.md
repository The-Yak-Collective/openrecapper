# Grapevine: cross-server reaction forwarding

React with a configured emoji on a message in one Discord server, and the bot
will forward (re-post) that message into a designated channel of another
server via a webhook. The forwarded post uses the original author's display
name and avatar (prefixed with " (via grapevine)") so the cross-pollination
feels natural.

## How it works

1. A user reacts to a message with a configured emoji (e.g. 🍇).
2. The bot checks `grapevine-routes.json` for a matching route
   (source guild + optional source channel + emoji).
3. The bot POSTs to the destination webhook URL with the message content,
   author identity, and any attachment URLs. Mentions are stripped from the
   forwarded copy so nobody gets pinged.

The bot needs to be a member of the source server (with read access to
the source channel). The destination server only needs the webhook — the
bot does **not** need to be a member there.

## Setup

### 1. Create a webhook in the destination channel

In the destination Discord server: **Channel settings → Integrations →
Webhooks → New Webhook**. Copy the webhook URL. Treat it as a secret.

### 2. Configure routes

Copy `grapevine-routes.example.json` to `grapevine-routes.json` in the
project root (or set `GRAPEVINE_ROUTES_FILE` to a custom path) and edit:

```json
{
  "routes": [
    {
      "label": "Server A -> Server B #lounge",
      "sourceGuildId": "111111111111111111",
      "sourceChannelId": "222222222222222222",
      "emoji": "🍇",
      "destinationWebhookUrl": "https://discord.com/api/webhooks/.../...",
      "threshold": 1
    }
  ]
}
```

Fields:
- `sourceGuildId` (required) — the server where reactions are watched.
- `sourceChannelId` (optional) — restrict to a single channel; omit to match any channel in the guild.
- `emoji` (required) — Unicode emoji (e.g. `🍇`) or a custom emoji's **name**.
- `destinationWebhookUrl` (required) — webhook in the target channel.
- `threshold` (optional, default 1) — require N reactions before forwarding (acts as a "two people vouched for this" gate).
- `allowedRoleIds` (optional) — only members with one of these source-guild roles can trigger.
- `label` (optional) — shown in `/grapevine list` and logs.

### 3. Reload at runtime

After editing the JSON, run `/grapevine reload` in any server where the
bot is present (requires Manage Server permission). `/grapevine list`
shows the active routes.

### 4. Required Discord intents

Grapevine needs three additional intents beyond the recording features:
`GuildMessages`, `GuildMessageReactions`, and **`MessageContent`** (the
last is **privileged** — toggle it on in the Discord Developer Portal
under your bot → "Privileged Gateway Intents"). Without `MessageContent`,
forwarded messages will have empty bodies.

### 5. Bot permissions in the source channel

The bot's role needs: View Channel, Read Message History, Add Reactions
(optional — used if you later want the bot to confirm forwarding by
reacting back). Send Messages is **not** required for grapevine itself.

## Operational notes

- **Dedupe**: within a single bot process, the same message will only be
  forwarded once per route (further reactions of the same emoji are
  ignored). A bot restart clears the dedupe set.
- **Privacy**: the forwarded copy strips @everyone/@here/role/user pings so
  the cross-server post never accidentally rings anyone in the destination.
- **Attachments**: attachment URLs are appended to the forwarded content.
  Discord's CDN URLs are publicly accessible, so attachments will render
  inline in the destination channel.
- **Edits/deletes**: forwards are one-shot snapshots. Edits and deletes to
  the source message do not propagate.
- **Threads**: the source message may live in a thread; forwarding still
  works. The destination webhook posts to its configured channel
  (not a thread) unless the URL includes `?thread_id=...`.
