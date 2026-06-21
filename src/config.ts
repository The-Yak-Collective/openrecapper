import { config } from 'dotenv';
import path from 'path';

// Load .env from project root (ignored in production if not present)
config({ path: path.join(__dirname, '..', '.env') });

export const Config = {
  DISCORD_TOKEN: process.env.DISCORD_TOKEN!,
  DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID!,
  DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY!,
  // Display name used in health-check alerts and email subjects.
  BOT_NAME: process.env.BOT_NAME || 'OpenRecapper',
  RECORDINGS_DIR: process.env.RECORDINGS_DIR || path.join(__dirname, '..', 'recordings'),
  R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID || '',
  R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID || '',
  R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY || '',
  R2_BUCKET: process.env.R2_BUCKET || '',
  R2_ENDPOINT: process.env.R2_ENDPOINT || '',
  R2_PUBLIC_URL: process.env.R2_PUBLIC_URL || '',
  // User to DM when a startup health check fails (optional).
  ALERT_DISCORD_USER_ID: process.env.ALERT_DISCORD_USER_ID || '',
  // AI summary + email are routed through a small companion "relay" HTTP
  // service that bridges to an LLM provider (for summaries) and an email
  // gateway. Summarization/email are skipped gracefully if RELAY_TOKEN is unset,
  // so the bot still records and transcribes without a relay configured.
  // See README “AI summaries & email (optional)” for the expected relay API.
  RELAY_URL: process.env.RELAY_URL || 'http://127.0.0.1:8787',
  RELAY_TOKEN: process.env.RELAY_TOKEN || '',
  // Gateway model used for summaries (cost-optimal default). Empty => relay default.
  SUMMARY_MODEL: process.env.SUMMARY_MODEL || '',
  // What the group reads/discusses — tunes the summary template wording.
  SUMMARY_GROUP_NAME: process.env.SUMMARY_GROUP_NAME || 'study group',
  // Where to email the summary + transcript links after each call (optional).
  SUMMARY_EMAIL_TO: process.env.SUMMARY_EMAIL_TO || '',
  // Number of days to keep raw audio files (.pcm, .wav) before auto-cleanup.
  // Transcripts and metadata are always preserved. Default: 7 days.
  RECORDING_RETENTION_DAYS: parseInt(process.env.RECORDING_RETENTION_DAYS || '7', 10),
  // Minutes of silence (no opus packets from any user) before the bot
  // auto-leaves the voice channel. Generous default (20 min) to accommodate
  // study-group silent reading periods. Set to 0 to disable.
  SILENCE_TIMEOUT_MINUTES: parseInt(process.env.SILENCE_TIMEOUT_MINUTES || '20', 10),
  // Optional override for where standing-call schedules are persisted.
  // Defaults to ./data/schedules.json (managed via the /schedule command).
  SCHEDULES_FILE: process.env.SCHEDULES_FILE || '',
};

export function validateConfig() {
  const missing: string[] = [];
  if (!Config.DISCORD_TOKEN) missing.push('DISCORD_TOKEN');
  if (!Config.DISCORD_CLIENT_ID) missing.push('DISCORD_CLIENT_ID');
  if (!Config.DEEPGRAM_API_KEY) missing.push('DEEPGRAM_API_KEY');
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }
}
