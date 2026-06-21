# Changelog

All notable changes to OpenRecapper are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/The-Yak-Collective/openrecapper/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/The-Yak-Collective/openrecapper/releases/tag/v1.1.0
[1.0.0]: https://github.com/The-Yak-Collective/openrecapper/releases/tag/v1.0.0
