# Changelog

All notable changes to OpenRecapper are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.1] - 2026-06-22

Security and reliability hardening patch following the 2026-06-22 review.

### Security
- Added default and runtime Manage Server checks for `/record`, `/stop`, and
  `/test-schedule`.
- Scoped `/status` to the invoking server.
- Rejected cross-server channel/session mismatches.
- Stopped surfacing raw internal error messages to Discord users.
- Added Discord webhook URL validation for Grapevine routes.

### Reliability
- Added retry handling for Deepgram batch transcription.
- Preserves the mixed WAV and attempts cloud upload even if transcription fails.
- Writes `transcription-failed.txt` and metadata for failed transcription sessions.
- Added graceful SIGINT/SIGTERM handling for active recordings.
- Added `session.active` markers and non-destructive orphan-session detection on boot.
- Added retries for relay and R2 operations.
- Added an R2 startup health probe.

### Scheduling
- Live transcription now posts to the explicit invoking/scheduled text channel
  instead of magic-finding `#transcriptions`.
- `/schedule add` defaults to the invoking text channel when `text_channel` is
  omitted.
- Scheduled recordings now validate the configured text channel before firing.
- Schedule-store writes are now atomic and serialized.

### Tooling / Dependencies
- Updated `@discordjs/voice` to stable `0.19.2`.
- Updated dependency overrides for a clean `npm audit`.
- Added `npm test` for the mixdown test suite.
- Updated the Docker image to Node 22.
- Expanded `.gitignore` for local agent/VM scratch files.

## [1.1.0] - 2026-06-21

### Added
- **Standing-call schedule UI** — `/schedule list | add | edit | remove | pause | resume`
  to manage multiple auto-record schedules at runtime (no restart). Schedules
  persist to `data/schedules.json`; each is referenced by a short id with
  autocomplete. Admin-gated (Manage Server); grantable to a role via Discord's
  native command permissions.
- **Silence timeout** — the bot auto-leaves a voice channel after a configurable
  period with no voice activity (`SILENCE_TIMEOUT_MINUTES`, default 20), so a
  cancelled call doesn't leave it recording indefinitely. Cleans up the empty
  session and skips transcription/summary.
- **Automatic recording cleanup** — old, already-transcribed audio files are
  pruned on a retention schedule (`RECORDING_RETENTION_DAYS`, default 7) to keep
  disk usage bounded; transcripts/summaries are preserved.

### Changed
- Scheduler refactored from a single env-var-driven cron job to managing N jobs
  from the schedule store. Legacy `SCHEDULED_*` env vars now seed the store once
  on first run, then are ignored (the JSON store is canonical).

## [1.0.0] - 2026-06-14

- Initial public release: voice-channel recording, live + batch (Deepgram
  Nova-3) transcription with diarization, optional AI summary + email via a
  companion relay, optional S3/R2 archival, scheduled auto-join, auto-stop, and
  DAVE E2EE support.

[Unreleased]: https://github.com/The-Yak-Collective/openrecapper/compare/v1.1.1...HEAD
[1.1.1]: https://github.com/The-Yak-Collective/openrecapper/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/The-Yak-Collective/openrecapper/releases/tag/v1.1.0
[1.0.0]: https://github.com/The-Yak-Collective/openrecapper/releases/tag/v1.0.0
