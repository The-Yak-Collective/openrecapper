# Feature: guild-event-triggered recording (start on Active, stop when channel empties)

Fresh-session prompt. Self-contained. You are working on **OpenRecapper**, a
Discord voice-recording + transcription + AI-summary bot at `~/openrecapper` on
an exe.dev VM.

## Read first
- Root `AGENTS.md` and the `docs/deploy-from-main` branch's `AGENTS.md` — they
  define branching rules and the Hetzner deploy procedure.
- **The live bot runs on Hetzner** (`ssh hetzner-yak`, `/opt/openrecapper`,
  systemd `openrecapper.service`), NOT on this VM. This VM only runs the relay.
  Build `dist/` on the VM (Hetzner has prod-only node_modules, no tsc/tsx) and
  rsync it over.
- This branch was created from `origin/main` and seeded with this note only.

## Goal
Let organizers manage standing/one-off calls using **Discord's native Scheduled
Events** UI instead of (or alongside) our `/schedule` cron command. When an
event goes live, auto-start recording its voice channel; stop when the call
ends. Surface the transcript/summary back to the humans.

## Confirmed API facts (researched 2026-07-27 — re-verify if you deviate)
- **Scheduled events have NO file/attachment field.** You cannot attach a
  recording/transcript to an event. Editable fields: name, description (~1000
  chars), cover image, start/end time, channel, entity_type/metadata, and a
  `recurrence_rule` (RRULE subset — natively supports biweekly).
- **`GuildScheduledEvents` gateway intent is required** and is NOT currently
  enabled. It is **non-privileged** (no dashboard toggle needed). Add it in
  `src/index.ts` to the `intents:` array on the MAIN client only (the voice-only
  recorder identities keep minimal intents):
      GatewayIntentBits.GuildScheduledEvents
  discord.js then emits `Events.GuildScheduledEventUpdate` (old, new),
  `...Create`, `...Delete`, `...UserAdd/Remove`.
- **Start trigger:** on `GuildScheduledEventUpdate`, when status transitions to
  `Active` (GuildScheduledEventStatus.Active) and `entityType` is Voice/Stage,
  start recording `event.channel` (or `event.channelId`).
- **Stop trigger — IMPORTANT nuance:** do NOT rely on the `Completed` status to
  stop, because:
  - For **recurring** events, Discord does NOT send `Completed` on end — it
    sends a `Scheduled` update for the next occurrence. So a Completed listener
    silently never fires for our biweekly calls.
  - Once status is `COMPLETED`/`CANCELED` it can no longer be updated.
  Instead, **stop when the voice channel empties of humans** (voice-state based —
  the same signal Task/branch "presence-aware-silence-timeout" uses). Discord
  itself auto-sets a VOICE event to COMPLETED after the channel has no users for
  a few minutes, so channel-empty is the reliable, shared stop condition. Handle
  `Completed`/`Deleted`/`Canceled` as belt-and-suspenders stop signals too.

## Surfacing results ("don't events disappear when done?")
Yes — once an event completes it can't be edited and drops from the active
events UI, so **do not** plan to write results onto a finished event. Options,
in preference order:
1. **Post results as a normal message** (transcript/summary as message
   attachments) in the event's associated text channel — the durable path. This
   is essentially what scheduled `/record` runs already do; reuse that flow.
2. Optionally, **while the event is still Active**, edit its `description` to add
   a "recording in progress / results will be posted in #channel" line. Only do
   this before it flips to Completed.

## Implementation sketch
- `src/index.ts`: add the intent + register handlers for
  `Events.GuildScheduledEventUpdate` (and Create/Delete for logging/cleanup).
- New service e.g. `src/services/event-trigger-service.ts` that maps an event ->
  a recording via the existing `WorkerManager.startRecording({guildId,
  channelId, requesterId: botUserId, textChannelId, callName})` and stop paths.
  Derive `callName` from `event.name` + ISO date (see `src/services/call-naming.ts`).
  Pick the text channel: reuse the summary-channel store
  (`src/services/summary-channel-store.ts`) / same default logic as
  `/schedule`.
- **Avoid double-recording.** The cron `/schedule` and native events could both
  target the same voice channel. `WorkerManager` already guards one recording
  per channel (see `tests/test-channel-guard.ts`) — confirm the event path goes
  through that same guard and degrades gracefully (log + skip) if already
  recording.
- **Coexistence policy:** decide + document whether native events are
  opt-in per guild (recommend a feature flag / config, default OFF) so enabling
  the intent doesn't silently change behavior for existing guilds.

## Deliverables
1. A short design note committed to the repo confirming the constraints above
   and the chosen coexistence policy.
2. Implementation behind that policy (default-off if any double-record risk).
3. Tests in `tests/` (plain tsx script style — see `tests/test-channel-guard.ts`):
   event->Active starts a recording; channel-empty stops it; already-recording
   channel is skipped, not double-started.
4. Update `README.md` (there's a "Scheduled recording" section) to document the
   native-events path and how to enable it.

## Workflow (you're on a feature branch already)
- Verify base: `git fetch origin && git merge-base --is-ancestor origin/main HEAD`.
- `npm run build` and `npm test` must pass; add tests for new logic.
- Commit with clear messages; push; open a PR to `origin/main` per `AGENTS.md`.
- **Deploy only after** confirming with the user AND the active-recording safety
  check: `ssh hetzner-yak 'find /opt/openrecapper/recordings -maxdepth 1 -type d
  -mmin -5 | grep . && echo ACTIVE || echo safe'` — verify it's not just the
  cleanup job (a dir containing summary.md + transcript.* is finished, not live;
  check for `.active` markers / recent file mtimes). Back up `dist/` on Hetzner,
  rsync, re-register slash commands **only if commands changed**, restart, and
  confirm health lines (Logged in, schedules loaded, 4x HealthCheck ok).
- Deploy note: the Hetzner box may currently be on branch
  `feat/schedule-biweekly-and-oneoff` rather than `main`. Reconcile (merge that
  branch to main, re-point Hetzner at main) so you're not layering on a
  divergent base.
