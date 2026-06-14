import * as cron from 'node-cron';
import { WorkerManager } from './worker-manager';
import { getClient } from '../client';
import { TextChannel } from 'discord.js';
import { scheduledCallName } from './call-naming';

const SCHEDULED_GUILD_ID = process.env.SCHEDULED_GUILD_ID || '';
const SCHEDULED_VOICE_CHANNEL_ID = process.env.SCHEDULED_VOICE_CHANNEL_ID || '';
const SCHEDULED_TEXT_CHANNEL_ID = process.env.SCHEDULED_TEXT_CHANNEL_ID || '';
const SCHEDULED_CRON = process.env.SCHEDULED_CRON || '15 11 * * 1,5';
const SCHEDULED_TIMEZONE = process.env.SCHEDULED_TIMEZONE || 'America/New_York';

let scheduledTask: ReturnType<typeof cron.schedule> | null = null;

/**
 * Trigger the scheduled recording immediately (used by cron and /test-schedule).
 * Joins the configured voice channel and starts recording.
 */
export async function triggerScheduledRecording(): Promise<string> {
  if (!SCHEDULED_GUILD_ID || !SCHEDULED_VOICE_CHANNEL_ID) {
    throw new Error('SCHEDULED_GUILD_ID and SCHEDULED_VOICE_CHANNEL_ID must be set');
  }

  const client = getClient();
  const botUserId = client.user?.id;
  if (!botUserId) {
    throw new Error('Bot client user not available');
  }

  const manager = WorkerManager.getInstance();

  if (manager.isRecording(SCHEDULED_VOICE_CHANNEL_ID)) {
    const msg = `Already recording <#${SCHEDULED_VOICE_CHANNEL_ID}>, skipping scheduled trigger`;
    console.log(`[Scheduler] ${msg}`);
    return msg;
  }

  // Resolve text channel: explicit env var > find #transcriptions > throw
  let textChannelId = SCHEDULED_TEXT_CHANNEL_ID;
  if (!textChannelId) {
    const guild = client.guilds.cache.get(SCHEDULED_GUILD_ID);
    if (!guild) {
      throw new Error(`Guild ${SCHEDULED_GUILD_ID} not found in cache`);
    }
    const transcriptionChannel = guild.channels.cache.find(
      (ch) => ch.name === 'transcriptions' && ch.isTextBased()
    ) as TextChannel | undefined;

    if (transcriptionChannel) {
      textChannelId = transcriptionChannel.id;
      console.log(`[Scheduler] Resolved text channel: #${transcriptionChannel.name} (${textChannelId})`);
    } else {
      throw new Error('No #transcriptions channel found and SCHEDULED_TEXT_CHANNEL_ID not set');
    }
  }

  const callName = scheduledCallName();
  console.log(`[Scheduler] Firing scheduled recording "${callName}" — guild=${SCHEDULED_GUILD_ID} voice=${SCHEDULED_VOICE_CHANNEL_ID} text=${textChannelId}`);

  await manager.startRecording({
    guildId: SCHEDULED_GUILD_ID,
    channelId: SCHEDULED_VOICE_CHANNEL_ID,
    requesterId: botUserId,
    textChannelId,
    callName,
  });

  const msg = `Scheduled recording started in <#${SCHEDULED_VOICE_CHANNEL_ID}>`;
  console.log(`[Scheduler] ${msg}`);
  return msg;
}

/**
 * Start the cron-based scheduler. Call once after ClientReady.
 */
export function startScheduler(): void {
  if (!SCHEDULED_GUILD_ID || !SCHEDULED_VOICE_CHANNEL_ID) {
    console.log('[Scheduler] No SCHEDULED_GUILD_ID / SCHEDULED_VOICE_CHANNEL_ID set, skipping scheduler');
    return;
  }

  if (!cron.validate(SCHEDULED_CRON)) {
    console.error(`[Scheduler] Invalid cron expression: ${SCHEDULED_CRON}`);
    return;
  }

  console.log(`[Scheduler] Scheduling recording with cron "${SCHEDULED_CRON}" (timezone: ${SCHEDULED_TIMEZONE}) — guild=${SCHEDULED_GUILD_ID} voice=${SCHEDULED_VOICE_CHANNEL_ID}`);

  scheduledTask = cron.schedule(SCHEDULED_CRON, async () => {
    console.log(`[Scheduler] Cron fired at ${new Date().toISOString()} (timezone: ${SCHEDULED_TIMEZONE})`);
    try {
      await triggerScheduledRecording();
    } catch (err) {
      console.error('[Scheduler] Failed to start scheduled recording:', err);
    }
  }, {
    timezone: SCHEDULED_TIMEZONE,
  });
}

/**
 * Stop the scheduler (for clean shutdown).
 */
export function stopScheduler(): void {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    console.log('[Scheduler] Scheduler stopped');
  }
}
