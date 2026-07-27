# Feature: presence-aware silence timeout (fix silent-reading auto-leave)

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

## Problem
Many of our calls open with ~20 minutes of **silent reading**. The bot's
silence monitor auto-leaves after `SILENCE_TIMEOUT_MINUTES` (default **20**) of
no opus packets from anyone — so it can bail right as (or before) the reading
ends. Relevant code: `startSilenceMonitor()` / `silenceAutoStop()` in
`src/services/worker-manager.ts` (~line 1049+). It polls every 60s and stops
when `now - lastVoiceActivityAt >= timeout`, measuring from `startedAt` if no
audio has arrived yet. Config lives in `src/config.ts`
(`SILENCE_TIMEOUT_MINUTES`, default 20).

## Interim mitigation (no rebuild)
`SILENCE_TIMEOUT_MINUTES` is env-driven, so bumping it is a one-line edit to
`/opt/openrecapper/.env` on Hetzner + `systemctl restart openrecapper` — no
build/rsync. Offer this first if the user wants immediate relief. (But the real
fix below is preferred; a plain 30-min bump also makes a genuinely empty channel
linger 30 min.)

## Chosen design (decided with the user)
**Presence-aware timeout.** Distinguish "silent but humans present" (intentional
reading — keep recording) from "channel empty of humans" (leave promptly):

- **Humans present in the voice channel:** long silence tolerance. Keep this on
  `SILENCE_TIMEOUT_MINUTES` but raise the effective value so a full opening read
  never trips it. (Confirm target with user; the read is ~20 min, so the
  humans-present tolerance should be comfortably above that or effectively "do
  not auto-leave on silence alone while humans are present.")
- **Channel empty of humans:** **8-minute** fast leave (user chose 8, not 2-3).
  Add a new config `EMPTY_CHANNEL_TIMEOUT_MINUTES` (default **8**).
- **No separate initial-read grace window needed** — the presence check already
  covers the opening read (humans are present during it), so drop that idea.

Apply the presence-aware logic **everywhere** the silence/empty behavior lives —
audit for other auto-leave paths (empty-channel checks, voice-state handlers in
`src/index.ts`, `worker-manager.ts`) and make them consistent with the two knobs.

## Implementation notes
- Non-bot member count for a voice channel:
  `guild.channels.cache.get(channelId)?.members` filtered to `!member.user.bot`.
  (The bot's own recorder identity is a member — exclude bots.)
- In `startSilenceMonitor()`'s interval: choose the timeout based on whether any
  humans are currently present; if empty use `EMPTY_CHANNEL_TIMEOUT_MINUTES`,
  else `SILENCE_TIMEOUT_MINUTES`. Consider also reacting immediately to
  voice-state-update (last human leaves) rather than waiting up to 60s.
- Preserve existing behavior: "clean up the empty session dir if no audio was
  ever captured" in `silenceAutoStop()`; the one-recording-per-channel guard;
  and posting the brief text-channel message on auto-stop.
- Document both knobs in `src/config.ts` and `.env.example`.

## Deliverables
1. Presence-aware timeout implemented across all auto-leave paths, with
   `SILENCE_TIMEOUT_MINUTES` (humans present) and `EMPTY_CHANNEL_TIMEOUT_MINUTES`
   (empty, default 8) config.
2. Tests in `tests/` (plain tsx script style — see `tests/test-channel-guard.ts`):
   humans-present + long silence => stays recording; channel empty => leaves
   after ~8 min; no-audio-ever cleanup path still fires.
3. Docs updated (`src/config.ts` comments, `.env.example`, and the relevant
   README section on silence timeout / retention).

## Workflow (you're on a feature branch already)
- Verify base: `git fetch origin && git merge-base --is-ancestor origin/main HEAD`.
- `npm run build` and `npm test` must pass; add tests for new logic.
- Commit with clear messages; push; open a PR to `origin/main` per `AGENTS.md`.
- **Deploy only after** confirming with the user AND the active-recording safety
  check: `ssh hetzner-yak 'find /opt/openrecapper/recordings -maxdepth 1 -type d
  -mmin -5 | grep . && echo ACTIVE || echo safe'` — verify it's not just the
  cleanup job (a dir containing summary.md + transcript.* is finished, not live;
  check for `.active` markers / recent file mtimes). Back up `dist/` on Hetzner,
  rsync, restart (no slash-command re-register needed unless commands changed),
  and confirm health lines (Logged in, schedules loaded, 4x HealthCheck ok).
- Deploy note: the Hetzner box may currently be on branch
  `feat/schedule-biweekly-and-oneoff` rather than `main`. Reconcile (merge that
  branch to main, re-point Hetzner at main) so you're not layering on a
  divergent base.
