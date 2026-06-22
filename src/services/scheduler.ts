import * as cron from 'node-cron';
import { WorkerManager } from './worker-manager';
import { getClient } from '../client';
import { TextChannel, ChannelType } from 'discord.js';
import { isoDate } from './call-naming';
import {
  Schedule,
  NewScheduleInput,
  addSchedule,
  updateSchedule,
  removeSchedule,
  getSchedule,
  getSchedules,
  loadSchedules,
  scheduleFileExists,
} from './schedule-store';

// Legacy single-schedule env vars. Only used ONCE to seed data/schedules.json
// the first time this runs without that file. After the file exists, these are
// ignored entirely — the JSON store is the sole source of truth.
const LEGACY_GUILD_ID = process.env.SCHEDULED_GUILD_ID || '';
const LEGACY_VOICE_CHANNEL_ID = process.env.SCHEDULED_VOICE_CHANNEL_ID || '';
const LEGACY_TEXT_CHANNEL_ID = process.env.SCHEDULED_TEXT_CHANNEL_ID || '';
const LEGACY_CRON = process.env.SCHEDULED_CRON || '15 11 * * 1,5';
const LEGACY_TIMEZONE = process.env.SCHEDULED_TIMEZONE || 'America/New_York';
const LEGACY_NAME = process.env.SCHEDULED_NAME || 'Standing call';

// One live cron task per active (non-paused) schedule, keyed by schedule id.
const tasks = new Map<string, ReturnType<typeof cron.schedule>>();

/** The call name used for a schedule's recording: "<name> <ISODATE>". */
function callNameFor(schedule: Schedule): string {
  return `${schedule.name} ${isoDate()}`;
}

/**
 * Fire the recording for a single schedule by id. Used by cron and by
 * `/schedule` test paths. Resolves the explicit per-schedule text channel.
 */
export async function triggerScheduledRecording(id: string): Promise<string> {
  const schedule = getSchedule(id);
  if (!schedule) {
    throw new Error(`No schedule with id "${id}"`);
  }

  const client = getClient();
  const botUserId = client.user?.id;
  if (!botUserId) {
    throw new Error('Bot client user not available');
  }

  const manager = WorkerManager.getInstance();

  if (manager.isRecording(schedule.voiceChannelId)) {
    const msg = `Already recording <#${schedule.voiceChannelId}>, skipping scheduled trigger`;
    console.log(`[Scheduler] ${msg}`);
    return msg;
  }

  const guild = client.guilds.cache.get(schedule.guildId);
  if (!guild) {
    throw new Error(`Guild ${schedule.guildId} not found in cache`);
  }

  if (!schedule.textChannelId) {
    throw new Error(`Schedule "${schedule.name}" [${schedule.id}] has no text channel configured; edit it with ${scheduleEditHint(schedule)}`);
  }

  const textChannel = await client.channels.fetch(schedule.textChannelId).catch(() => null) as TextChannel | null;
  if (!textChannel?.isTextBased?.() || textChannel.type !== ChannelType.GuildText) {
    throw new Error(`Configured text channel ${schedule.textChannelId} is missing or is not a server text channel`);
  }
  const textChannelId = textChannel.id;

  const callName = callNameFor(schedule);
  console.log(
    `[Scheduler] Firing scheduled recording "${callName}" [${schedule.id}] — guild=${schedule.guildId} voice=${schedule.voiceChannelId} text=${textChannelId}`,
  );

  await manager.startRecording({
    guildId: schedule.guildId,
    channelId: schedule.voiceChannelId,
    requesterId: botUserId,
    textChannelId,
    callName,
  });

  const msg = `Scheduled recording started in <#${schedule.voiceChannelId}>`;
  console.log(`[Scheduler] ${msg}`);
  return msg;
}

/**
 * (Re)build the live cron task for a single schedule. Stops any existing task
 * for that id, then creates a fresh one unless the schedule is paused, missing
 * required routing config, or has invalid cron. This is the only place tasks are created.
 */
export function scheduleEditHint(schedule: Pick<Schedule, 'id'>): string {
  return `/schedule edit schedule:${schedule.id} text_channel:#transcriptions`;
}

export function invalidScheduleReason(schedule: Schedule): string | null {
  if (schedule.paused) return 'paused';
  if (!schedule.textChannelId) return `missing text channel — set one with ${scheduleEditHint(schedule)}`;
  if (!cron.validate(schedule.cron)) return `invalid cron: ${schedule.cron}`;
  return null;
}

function backfillLegacyTextChannels(): void {
  if (!LEGACY_TEXT_CHANNEL_ID) return;

  const missingTextChannel = getSchedules().filter((schedule) => !schedule.textChannelId);
  if (missingTextChannel.length === 0) return;

  for (const schedule of missingTextChannel) {
    updateSchedule(schedule.id, { textChannelId: LEGACY_TEXT_CHANNEL_ID });
  }

  console.warn(
    `[Scheduler] Backfilled textChannelId=${LEGACY_TEXT_CHANNEL_ID} for ${missingTextChannel.length} legacy schedule(s) ` +
      'from SCHEDULED_TEXT_CHANNEL_ID. data/schedules.json remains canonical; future changes should use /schedule edit.',
  );
}

function syncTask(schedule: Schedule): boolean {
  // Tear down any existing task for this id first.
  removeTask(schedule.id);

  const invalidReason = invalidScheduleReason(schedule);
  if (invalidReason) {
    const level = schedule.paused ? 'log' : 'error';
    console[level](`[Scheduler] Schedule "${schedule.name}" [${schedule.id}] is not active: ${invalidReason}.`);
    return false;
  }

  const task = cron.schedule(
    schedule.cron,
    async () => {
      console.log(
        `[Scheduler] Cron fired for "${schedule.name}" [${schedule.id}] at ${new Date().toISOString()} (timezone: ${schedule.timezone})`,
      );
      try {
        await triggerScheduledRecording(schedule.id);
      } catch (err) {
        console.error(`[Scheduler] Failed to start scheduled recording [${schedule.id}]:`, err);
      }
    },
    { timezone: schedule.timezone },
  );

  tasks.set(schedule.id, task);
  console.log(
    `[Scheduler] Scheduled "${schedule.name}" [${schedule.id}] cron="${schedule.cron}" (timezone: ${schedule.timezone}) — guild=${schedule.guildId} voice=${schedule.voiceChannelId}`,
  );
  return true;
}

/** Stop + drop the live task for a schedule id (if any). */
function removeTask(id: string): void {
  const existing = tasks.get(id);
  if (existing) {
    existing.stop();
    tasks.delete(id);
  }
}

/**
 * Start the scheduler. Call once after ClientReady.
 *
 * Seed-once migration: if data/schedules.json is absent and the legacy
 * SCHEDULED_* env vars are set, write them as the first schedule (and log it).
 * After the file exists, env vars are ignored and the JSON store is canonical.
 */
export function startScheduler(): void {
  if (!scheduleFileExists()) {
    if (LEGACY_GUILD_ID && LEGACY_VOICE_CHANNEL_ID) {
      const seeded = addSchedule({
        name: LEGACY_NAME,
        guildId: LEGACY_GUILD_ID,
        voiceChannelId: LEGACY_VOICE_CHANNEL_ID,
        textChannelId: LEGACY_TEXT_CHANNEL_ID || undefined,
        cron: LEGACY_CRON,
        timezone: LEGACY_TIMEZONE,
        paused: false,
        createdBy: getClient().user?.id || 'legacy-env',
      });
      console.log(
        `[Scheduler] Seeded first schedule from legacy SCHEDULED_* env vars: "${seeded.name}" [${seeded.id}] cron="${seeded.cron}" tz=${seeded.timezone}. ` +
          `Env vars are now ignored; data/schedules.json is canonical. Manage via /schedule.`,
      );
    } else {
      console.log('[Scheduler] No schedules file and no legacy SCHEDULED_* env vars — starting with zero schedules.');
      loadSchedules(); // initialize empty in-memory cache
    }
  } else {
    loadSchedules();
    console.log(`[Scheduler] Loaded ${getSchedules().length} schedule(s) from store.`);
  }

  backfillLegacyTextChannels();

  let schedulable = 0;
  for (const schedule of getSchedules()) {
    if (syncTask(schedule)) schedulable++;
  }

  const active = tasks.size;
  const total = getSchedules().length;
  console.log(`[Scheduler] Active cron tasks: ${active}/${total} (${total - schedulable} paused or invalid).`);
}

// ── Mutators ────────────────────────────────────────────────────────────────
// Each persists via the store, then re-syncs ONLY the affected task.

export function createSchedule(input: NewScheduleInput): Schedule {
  const schedule = addSchedule(input);
  syncTask(schedule);
  return schedule;
}

export function editSchedule(
  id: string,
  patch: Partial<Omit<Schedule, 'id' | 'createdAt'>>,
): Schedule | undefined {
  const updated = updateSchedule(id, patch);
  if (updated) syncTask(updated);
  return updated;
}

export function deleteSchedule(id: string): boolean {
  const removed = removeSchedule(id);
  if (removed) removeTask(id);
  return removed;
}

export function pauseSchedule(id: string): Schedule | undefined {
  return editSchedule(id, { paused: true });
}

export function resumeSchedule(id: string): Schedule | undefined {
  return editSchedule(id, { paused: false });
}

/** Stop all live tasks (clean shutdown). Does not modify the store. */
export function stopScheduler(): void {
  for (const id of [...tasks.keys()]) {
    removeTask(id);
  }
  console.log('[Scheduler] All scheduled tasks stopped.');
}
