# Design note: native Scheduled-Event–triggered recording

Status: implemented, **default OFF** (opt-in per guild). See
`src/services/event-trigger-service.ts`, wiring in `src/index.ts`, tests in
`tests/test-event-trigger.ts`.

## Goal

Let organizers manage standing/one-off calls from Discord's built-in **Scheduled
Events** UI, alongside our `/schedule` cron command. When an event goes live,
auto-start recording its voice channel; stop when the call ends; surface the
transcript/summary back to a text channel.

## Confirmed Discord API constraints (verified 2026-07-27, discord.js 14.25.1)

- **No file/attachment field on events.** You cannot attach a recording or
  transcript to a Scheduled Event. Editable fields: name, description (~1000
  chars), cover image, start/end time, channel, entity type/metadata, and a
  `recurrence_rule`. → results must be surfaced elsewhere (see below).
- **`GuildScheduledEvents` gateway intent required** to receive
  `guildScheduledEvent*` events. It is **non-privileged** (no dashboard toggle).
  Added to the MAIN client only in `src/index.ts`; voice-only recorder
  identities keep minimal intents.
- **Start signal:** `Events.GuildScheduledEventUpdate` where the status
  transitions to `Active` and `entityType` is `Voice`/`StageInstance`.
- **Stop signal — important nuance:** do **not** rely on the `Completed` status.
  - For **recurring** events Discord does not send `Completed` on end; it sends a
    `Scheduled` update for the next occurrence. A Completed-only listener would
    silently never fire for biweekly calls.
  - Once an event is `Completed`/`Canceled` it can no longer be edited.
  - Discord itself auto-sets a Voice event to `Completed` after the channel has
    had no users for a few minutes.
  - → The **primary, reliable stop is the voice channel emptying of humans** —
    the same signal the existing auto-stop uses. `Completed`/`Canceled`/`Delete`
    are handled as **belt-and-suspenders** stops.

## Chosen design

- **Start:** on `GuildScheduledEventUpdate`, `shouldStartForTransition(old, new)`
  returns true only for a *transition into* `Active` (old status ≠ Active, so we
  react once per go-live, not on every edit while live) for a Voice/Stage entity
  with a channel. We then call the existing
  `WorkerManager.startRecording({ guildId, channelId, requesterId: botUserId,
  textChannelId, callName })`.
- **Stop:** reuses the shared `VoiceStateUpdate` auto-stop already in
  `src/index.ts` (bot is last human in the channel → `stopRecording`). Terminal
  status transitions and event deletion additionally call `stopForEvent`, which
  is a no-op if the channel isn't being recorded.
- **Call name:** `adHocCallName(event.name)` → `"<event name> <YYYY-MM-DD>"`,
  matching `/schedule` naming and R2 meeting-folder derivation.
- **Text channel:** the guild's `/set-summary-channel` override if set; else the
  guild system channel; else the first text channel the bot can post in. If none
  is usable we **skip the start** (results would be unsurfaceable) and log how to
  fix it. This mirrors `/schedule`'s "must have a text channel" requirement.

## Surfacing results

Events cannot hold files and vanish from the active-events UI once complete, so
we do **not** write results onto a finished event. Instead:

1. **Primary:** results post as a normal message (summary + transcript/subtitle
   attachments + R2 links) in the resolved text channel — the exact durable path
   `/record` and `/schedule` runs already use (`WorkerManager` delivery).
2. **Optional, while still Active:** `annotateActiveEvent` appends a
   "🔴 Recording in progress — results will be posted in #channel" line to the
   event description (only before it flips to Completed; guarded against
   double-append and the 1000-char cap).

## Coexistence & double-record safety

`/schedule` cron and native events can target the same voice channel.
`WorkerManager.startRecording` enforces **one recording per channel** via a
synchronous channel reservation (`tests/test-channel-guard.ts`). The event path
goes through that same guard: a fast-path `isRecording` check skips early, and a
lost start race throws `AlreadyRecordingError`, which we catch and downgrade to a
logged skip. `NoRecorderAvailableError` is likewise handled gracefully.

## Coexistence policy: opt-in, default OFF

Adding the (non-privileged) intent alone must not silently change behavior for
existing guilds, so native-event recording is gated by the
`GUILD_EVENT_RECORDING` env var:

| value                         | effect                              |
| ----------------------------- | ----------------------------------- |
| unset / `off` / `false` / `0` | disabled (default)                  |
| `on` / `all` / `true` / `1`   | enabled for every guild             |
| `<id>,<id>,...`               | enabled only for the listed guilds  |

Guilds not opted in still emit the gateway events, but every handler returns
early (`skipped: not enabled for guild`).
