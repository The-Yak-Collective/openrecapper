import fs from 'fs';
import path from 'path';
import { Config } from '../config';

/**
 * Per-guild override for WHERE session summaries/transcripts are posted.
 *
 * Default behaviour (no override): results post to the text channel where
 * `/record` was invoked. When an override is set for a guild, results post to
 * the configured channel instead.
 */
export interface SummaryChannelSetting {
  guildId: string;
  channelId: string;
  setBy: string;
  setAt: string;
}

interface SummaryChannelFile {
  settings: SummaryChannelSetting[];
}

let settings: SummaryChannelSetting[] | null = null;
let storeLocked = false;

export function getSummaryChannelsPath(): string {
  return (
    Config.SUMMARY_CHANNELS_FILE ||
    path.join(__dirname, '..', '..', 'data', 'summary-channels.json')
  );
}

export function loadSummaryChannels(): SummaryChannelSetting[] {
  const filePath = getSummaryChannelsPath();
  if (!fs.existsSync(filePath)) {
    settings = [];
    return settings;
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as SummaryChannelFile;
    settings = Array.isArray(parsed.settings) ? parsed.settings : [];
  } catch (err) {
    console.error('[SummaryChannelStore] Failed to read settings file, treating as empty:', err);
    settings = [];
  }
  return settings;
}

export function getSummaryChannels(): SummaryChannelSetting[] {
  if (settings === null) loadSummaryChannels();
  return settings!;
}

/** Return the configured summary channel id for a guild, or null if unset. */
export function getSummaryChannelForGuild(guildId: string): string | null {
  const found = getSummaryChannels().find((s) => s.guildId === guildId);
  return found ? found.channelId : null;
}

function withStoreLock<T>(fn: () => T): T {
  if (storeLocked) {
    throw new Error('Summary channel store is already mutating; retry the command in a moment');
  }
  storeLocked = true;
  try {
    return fn();
  } finally {
    storeLocked = false;
  }
}

function persist(): void {
  const filePath = getSummaryChannelsPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body: SummaryChannelFile = { settings: getSummaryChannels() };
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(body, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, filePath);
}

/**
 * Set (or update) the summary channel for a guild.
 * Returns the setting and whether it was newly created vs. updated.
 */
export function setSummaryChannel(
  guildId: string,
  channelId: string,
  setBy: string,
): { setting: SummaryChannelSetting; created: boolean } {
  return withStoreLock(() => {
    const list = getSummaryChannels();
    const existing = list.find((s) => s.guildId === guildId);
    if (existing) {
      existing.channelId = channelId;
      existing.setBy = setBy;
      existing.setAt = new Date().toISOString();
      persist();
      return { setting: existing, created: false };
    }
    const setting: SummaryChannelSetting = {
      guildId,
      channelId,
      setBy,
      setAt: new Date().toISOString(),
    };
    list.push(setting);
    persist();
    return { setting, created: true };
  });
}

/** Clear the summary channel override for a guild. Returns true if one existed. */
export function clearSummaryChannel(guildId: string): boolean {
  return withStoreLock(() => {
    const list = getSummaryChannels();
    const idx = list.findIndex((s) => s.guildId === guildId);
    if (idx === -1) return false;
    list.splice(idx, 1);
    persist();
    return true;
  });
}
