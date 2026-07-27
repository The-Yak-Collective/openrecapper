/**
 * event-trigger-service.ts — Bridge Discord's native Scheduled Events to the
 * recording pipeline.
 *
 * WHY: organizers want to manage standing/one-off calls from Discord's built-in
 * "Events" UI instead of (or alongside) our `/schedule` cron command. When an
 * event goes live, we auto-start recording its voice channel; when the call
 * ends we stop and surface the transcript/summary.
 *
 * START trigger: `Events.GuildScheduledEventUpdate` where status transitions to
 * ACTIVE and the entity is Voice/Stage — start recording `event.channel`.
 *
 * STOP trigger: the voice channel emptying of humans is the PRIMARY,
 * reliable stop (handled by the shared VoiceStateUpdate auto-stop in
 * `src/index.ts`, exactly as for `/record` and `/schedule` runs). We do NOT
 * rely on the COMPLETED status because Discord does not emit it for RECURRING
 * events (it sends a SCHEDULED update for the next occurrence instead). We
 * still treat COMPLETED / CANCELED / DELETED as belt-and-suspenders stop
 * signals.
 *
 * COEXISTENCE / SAFETY: `WorkerManager` enforces one recording per voice
 * channel (see tests/test-channel-guard.ts). The event path funnels through the
 * same `startRecording` guard, so a channel already being recorded by `/record`
 * or `/schedule` is logged-and-skipped, never double-started.
 *
 * OPT-IN: gated by the `GUILD_EVENT_RECORDING` env var (default OFF), so merely
 * enabling the (non-privileged) GuildScheduledEvents gateway intent does not
 * silently change behavior for existing guilds.
 *
 * The exported handlers accept an optional `deps` object so the pure
 * start/stop decisions can be unit-tested without a live Discord connection.
 */
import {
  GuildScheduledEvent,
  GuildScheduledEventStatus,
  GuildScheduledEventEntityType,
  ChannelType,
  Client,
  TextChannel,
} from 'discord.js';
import { Config } from '../config';
import { WorkerManager, AlreadyRecordingError } from './worker-manager';
import { NoRecorderAvailableError } from './recorder-pool';
import { adHocCallName } from './call-naming';
import { getSummaryChannelForGuild } from './summary-channel-store';

/** Minimal shape of a scheduled event we depend on (kept loose for tests). */
export interface EventLike {
  id: string;
  guildId: string | null;
  // Partial events (uncached) can have a null name; callers tolerate it.
  name: string | null;
  status: GuildScheduledEventStatus | number;
  entityType: GuildScheduledEventEntityType | number;
  channelId: string | null;
}

export interface EventTriggerDeps {
  manager: Pick<WorkerManager, 'isRecording' | 'startRecording' | 'stopRecording'>;
  /** Bot user id used as the synthetic requester for event-started recordings. */
  botUserId: string;
  /** Resolve a text channel id for live/result delivery, or null if none usable. */
  resolveTextChannelId: (guildId: string, event: EventLike) => Promise<string | null>;
  /** Optional: edit the still-Active event's description with an in-progress note. */
  annotateActiveEvent?: (event: EventLike, textChannelId: string) => Promise<void>;
}

/**
 * Is native-event recording enabled for this guild?
 *   ''/'off'/'false'/'0'/'no'  -> disabled (default)
 *   'on'/'all'/'true'/'1'/'yes' -> enabled for every guild
 *   '<id>,<id>,...'             -> enabled only for the listed guild ids
 */
export function isGuildEventRecordingEnabled(guildId: string | null | undefined): boolean {
  const raw = (Config.GUILD_EVENT_RECORDING || '').trim();
  if (!raw) return false;
  const lower = raw.toLowerCase();
  if (['off', 'false', '0', 'no', 'disabled'].includes(lower)) return false;
  if (['on', 'all', 'true', '1', 'yes', 'enabled'].includes(lower)) return true;
  if (!guildId) return false;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(guildId);
}

/** Is this a Voice or Stage entity (i.e. something with a voice channel)? */
export function isVoiceEntity(entityType: number): boolean {
  return (
    entityType === GuildScheduledEventEntityType.Voice ||
    entityType === GuildScheduledEventEntityType.StageInstance
  );
}

/**
 * Pure decision: should a status transition start a recording? True only when
 * the NEW status is ACTIVE, the OLD status was not already ACTIVE (so we react
 * once per go-live, not on every subsequent edit while active), and the entity
 * is Voice/Stage with a channel.
 */
export function shouldStartForTransition(oldEvent: EventLike | null, newEvent: EventLike): boolean {
  if (newEvent.status !== GuildScheduledEventStatus.Active) return false;
  if (oldEvent && oldEvent.status === GuildScheduledEventStatus.Active) return false;
  if (!isVoiceEntity(newEvent.entityType)) return false;
  if (!newEvent.channelId) return false;
  return true;
}

/** Terminal statuses that should stop any recording tied to the event's channel. */
export function isTerminalStatus(status: number): boolean {
  return (
    status === GuildScheduledEventStatus.Completed ||
    status === GuildScheduledEventStatus.Canceled
  );
}

/** Build the call name for an event-triggered recording: "<event name> <ISO date>". */
export function eventCallName(event: EventLike): string {
  return adHocCallName(event.name || 'Scheduled event');
}

/**
 * Handle a GuildScheduledEventUpdate. Starts on go-live; stops (belt-and-
 * suspenders) on terminal status. Returns a short status string for logging/tests.
 */
export async function handleEventUpdate(
  oldEvent: EventLike | null,
  newEvent: EventLike,
  deps: EventTriggerDeps,
): Promise<string> {
  if (!isGuildEventRecordingEnabled(newEvent.guildId)) return 'skipped: not enabled for guild';

  if (shouldStartForTransition(oldEvent, newEvent)) {
    return startForEvent(newEvent, deps);
  }

  // Belt-and-suspenders: a terminal transition stops any recording we own on
  // that channel. The primary stop is the channel emptying of humans.
  if (isTerminalStatus(newEvent.status) && newEvent.channelId) {
    return stopForEvent(newEvent, deps);
  }

  return 'noop';
}

/** Start a recording for a go-live event. */
export async function startForEvent(event: EventLike, deps: EventTriggerDeps): Promise<string> {
  const guildId = event.guildId;
  const channelId = event.channelId;
  if (!guildId || !channelId) return 'skipped: missing guild/channel';

  // Fast-path friendly skip; the authoritative guard is inside startRecording.
  if (deps.manager.isRecording(channelId)) {
    console.log(`[EventTrigger] Channel ${channelId} already recording — skipping event "${event.name}"`);
    return 'skipped: already recording';
  }

  const textChannelId = await deps.resolveTextChannelId(guildId, event);
  if (!textChannelId) {
    console.warn(
      `[EventTrigger] No usable text channel for event "${event.name}" in guild ${guildId}; ` +
        'cannot surface results — skipping. Set one with /set-summary-channel.',
    );
    return 'skipped: no text channel';
  }

  const callName = eventCallName(event);
  console.log(
    `[EventTrigger] Event "${event.name}" [${event.id}] went ACTIVE — starting recording ` +
      `"${callName}" guild=${guildId} voice=${channelId} text=${textChannelId}`,
  );

  try {
    await deps.manager.startRecording({
      guildId,
      channelId,
      requesterId: deps.botUserId,
      textChannelId,
      callName,
    });
  } catch (err) {
    if (err instanceof AlreadyRecordingError) {
      console.log(`[EventTrigger] Channel ${channelId} already recording (race) — skipping event "${event.name}"`);
      return 'skipped: already recording';
    }
    if (err instanceof NoRecorderAvailableError) {
      console.warn(`[EventTrigger] All recorder bots busy — skipping event "${event.name}" in guild ${guildId}`);
      return 'skipped: no recorder available';
    }
    console.error(`[EventTrigger] Failed to start recording for event "${event.name}":`, err);
    return 'error: start failed';
  }

  // Optional: while the event is still ACTIVE, note where results will land.
  if (deps.annotateActiveEvent) {
    try {
      await deps.annotateActiveEvent(event, textChannelId);
    } catch (err) {
      console.error('[EventTrigger] Failed to annotate active event description:', err);
    }
  }

  return 'started';
}

/** Stop a recording tied to an event's channel (terminal-status/delete path). */
export async function stopForEvent(event: EventLike, deps: EventTriggerDeps): Promise<string> {
  const channelId = event.channelId;
  if (!channelId) return 'skipped: no channel';
  if (!deps.manager.isRecording(channelId)) return 'noop: not recording';

  console.log(
    `[EventTrigger] Event "${event.name}" [${event.id}] reached terminal state — ` +
      `stopping recording in channel ${channelId} (belt-and-suspenders)`,
  );
  try {
    await deps.manager.stopRecording(channelId);
    return 'stopped';
  } catch (err) {
    console.error(`[EventTrigger] Failed to stop recording for event "${event.name}":`, err);
    return 'error: stop failed';
  }
}

// ── Default deps wired to the live singletons + Discord client ───────────────

/**
 * Resolve where an event's live transcript + results should post:
 *   1. the guild's /set-summary-channel override, if set;
 *   2. the guild system channel (welcome-messages channel), if text & sendable;
 *   3. the first text channel the bot can send messages in.
 * Returns null if none is usable (caller logs & skips).
 */
export async function defaultResolveTextChannelId(
  client: Client,
  guildId: string,
): Promise<string | null> {
  const override = (() => {
    try {
      return getSummaryChannelForGuild(guildId);
    } catch {
      return null;
    }
  })();
  if (override) return override;

  const guild = client.guilds.cache.get(guildId) || (await client.guilds.fetch(guildId).catch(() => null));
  if (!guild) return null;

  const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));

  const sendable = (ch: any): boolean => {
    if (!ch || ch.type !== ChannelType.GuildText) return false;
    if (!me) return true;
    const perms = ch.permissionsFor(me);
    return !!perms?.has('SendMessages') && !!perms?.has('ViewChannel');
  };

  if (guild.systemChannel && sendable(guild.systemChannel)) return guild.systemChannel.id;

  const channels = guild.channels.cache.filter(sendable);
  const first = channels.first() as TextChannel | undefined;
  return first ? first.id : null;
}

/** Build the production deps object from the live client + WorkerManager. */
export function defaultDeps(client: Client): EventTriggerDeps {
  const botUserId = client.user?.id || 'event-trigger';
  return {
    manager: WorkerManager.getInstance(),
    botUserId,
    resolveTextChannelId: (guildId) => defaultResolveTextChannelId(client, guildId),
    annotateActiveEvent: async (event, textChannelId) => {
      // Only editable while still ACTIVE; once COMPLETED it can no longer change.
      const full = event as unknown as GuildScheduledEvent;
      if (typeof (full as any).edit !== 'function') return;
      if (full.status !== GuildScheduledEventStatus.Active) return;
      const note = `\n\n🔴 Recording in progress — transcript & summary will be posted in <#${textChannelId}>.`;
      const existing = full.description || '';
      if (existing.includes('Recording in progress')) return;
      const next = (existing + note).slice(0, 1000);
      await full.edit({ description: next });
    },
  };
}
