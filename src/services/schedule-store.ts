import fs from 'fs';
import path from 'path';
import { Config } from '../config';

/**
 * A single standing-call schedule. Persisted to data/schedules.json.
 * `cron` is a standard 5-field cron expression evaluated in `timezone`.
 */
export interface Schedule {
  /** Short, stable, URL/command-safe id (base36). */
  id: string;
  /** Human label; also used as the call-name prefix (e.g. "CADS" -> "CADS 2026-06-22"). */
  name: string;
  guildId: string;
  voiceChannelId: string;
  /** Optional explicit text channel for results; falls back to #transcriptions if unset. */
  textChannelId?: string;
  /** 5-field cron expression (min hour day-of-month month day-of-week). */
  cron: string;
  /** IANA timezone the cron is evaluated in (e.g. "America/New_York"). */
  timezone: string;
  /** When true the schedule is retained but its cron job is not active. */
  paused: boolean;
  /** Discord user id of whoever created it (or the bot id for the legacy seed). */
  createdBy: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
}

interface ScheduleFile {
  schedules: Schedule[];
}

/** Fields a caller supplies when creating a schedule (id/createdAt are generated). */
export type NewScheduleInput = Omit<Schedule, 'id' | 'createdAt'> &
  Partial<Pick<Schedule, 'paused'>>;

// In-memory cache. Loaded lazily / on first access and kept in sync by mutators.
let schedules: Schedule[] | null = null;

/** Resolve the on-disk path for schedules.json. */
export function getSchedulesPath(): string {
  return (
    Config.SCHEDULES_FILE ||
    path.join(__dirname, '..', '..', 'data', 'schedules.json')
  );
}

/** Whether the schedules file already exists on disk. */
export function scheduleFileExists(): boolean {
  return fs.existsSync(getSchedulesPath());
}

/** Read schedules from disk into the in-memory cache, returning the list. */
export function loadSchedules(): Schedule[] {
  const filePath = getSchedulesPath();
  if (!fs.existsSync(filePath)) {
    schedules = [];
    return schedules;
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as ScheduleFile;
    schedules = Array.isArray(parsed.schedules) ? parsed.schedules : [];
  } catch (err) {
    console.error('[ScheduleStore] Failed to read schedules file, treating as empty:', err);
    schedules = [];
  }
  return schedules;
}

/** Get the cached schedules, loading from disk on first use. */
export function getSchedules(): Schedule[] {
  if (schedules === null) loadSchedules();
  return schedules!;
}

/** Get all schedules for a given guild. */
export function getSchedulesForGuild(guildId: string): Schedule[] {
  return getSchedules().filter((s) => s.guildId === guildId);
}

/** Find a schedule by id (across all guilds). */
export function getSchedule(id: string): Schedule | undefined {
  return getSchedules().find((s) => s.id === id);
}

function persist(): void {
  const filePath = getSchedulesPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body: ScheduleFile = { schedules: getSchedules() };
  fs.writeFileSync(filePath, JSON.stringify(body, null, 2) + '\n', 'utf8');
}

/** Generate a short, collision-checked base36 id. */
export function generateId(): string {
  const existing = new Set(getSchedules().map((s) => s.id));
  for (let attempt = 0; attempt < 50; attempt++) {
    // 4 base36 chars from random + a time nibble; short but ample for a handful of schedules.
    const id = Math.floor(Math.random() * 36 ** 4)
      .toString(36)
      .padStart(4, '0');
    if (!existing.has(id)) return id;
  }
  // Extremely unlikely fallback.
  return Date.now().toString(36);
}

/** Create + persist a new schedule, returning the stored record. */
export function addSchedule(input: NewScheduleInput): Schedule {
  const schedule: Schedule = {
    id: generateId(),
    name: input.name,
    guildId: input.guildId,
    voiceChannelId: input.voiceChannelId,
    textChannelId: input.textChannelId,
    cron: input.cron,
    timezone: input.timezone,
    paused: input.paused ?? false,
    createdBy: input.createdBy,
    createdAt: new Date().toISOString(),
  };
  getSchedules().push(schedule);
  persist();
  return schedule;
}

/**
 * Merge a partial patch into an existing schedule and persist.
 * Returns the updated record, or undefined if no schedule has that id.
 */
export function updateSchedule(
  id: string,
  patch: Partial<Omit<Schedule, 'id' | 'createdAt'>>,
): Schedule | undefined {
  const list = getSchedules();
  const idx = list.findIndex((s) => s.id === id);
  if (idx === -1) return undefined;
  list[idx] = { ...list[idx], ...patch, id: list[idx].id, createdAt: list[idx].createdAt };
  persist();
  return list[idx];
}

/** Remove a schedule by id. Returns true if one was removed. */
export function removeSchedule(id: string): boolean {
  const list = getSchedules();
  const idx = list.findIndex((s) => s.id === id);
  if (idx === -1) return false;
  list.splice(idx, 1);
  persist();
  return true;
}
