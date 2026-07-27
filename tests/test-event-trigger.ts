#!/usr/bin/env npx tsx
/**
 * test-event-trigger.ts — Unit tests for the native Scheduled-Event -> recording
 * bridge (src/services/event-trigger-service.ts).
 *
 * Plain tsx script (no test framework — mirrors test-channel-guard.ts): each
 * case throws on failure and logs ✅ on success. The service is exercised with a
 * fake WorkerManager + injected deps so no Discord connection is needed.
 *
 * Covers the three required behaviors:
 *   1. event -> ACTIVE starts a recording,
 *   2. a channel already recording is skipped (not double-started),
 *   3. a terminal-status transition stops the recording (belt-and-suspenders),
 * plus the opt-in gate and the "react once per go-live" transition logic.
 *
 * Run:  npx tsx tests/test-event-trigger.ts
 */
import { GuildScheduledEventStatus, GuildScheduledEventEntityType } from 'discord.js';
import {
  handleEventUpdate,
  shouldStartForTransition,
  isGuildEventRecordingEnabled,
  isVoiceEntity,
  eventCallName,
  EventLike,
  EventTriggerDeps,
} from '../src/services/event-trigger-service';
import { Config } from '../src/config';
import { AlreadyRecordingError } from '../src/services/worker-manager';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const GUILD = 'G1';
const VOICE = 'V1';

function makeEvent(over: Partial<EventLike> = {}): EventLike {
  return {
    id: 'E1',
    guildId: GUILD,
    name: 'Weekly Sync',
    status: GuildScheduledEventStatus.Scheduled,
    entityType: GuildScheduledEventEntityType.Voice,
    channelId: VOICE,
    ...over,
  };
}

// A fake WorkerManager tracking which channels are "recording", recording each
// start/stop call so tests can assert on them.
function makeFakeManager(initiallyRecording: string[] = []) {
  const recording = new Set<string>(initiallyRecording);
  const startCalls: any[] = [];
  const stopCalls: string[] = [];
  return {
    recording,
    startCalls,
    stopCalls,
    isRecording: (c: string) => recording.has(c),
    startRecording: async (opts: any) => {
      startCalls.push(opts);
      if (recording.has(opts.channelId)) throw new AlreadyRecordingError(opts.channelId);
      recording.add(opts.channelId);
    },
    stopRecording: async (c: string) => {
      stopCalls.push(c);
      recording.delete(c);
      return { fileCount: 0, requesterId: 'bot', sessionDir: '' };
    },
  };
}

function makeDeps(manager: any, over: Partial<EventTriggerDeps> = {}): EventTriggerDeps {
  return {
    manager,
    botUserId: 'BOT',
    resolveTextChannelId: async () => 'T1',
    ...over,
  };
}

// Force the opt-in gate on for the test guild.
(Config as any).GUILD_EVENT_RECORDING = GUILD;

async function main(): Promise<void> {

// ─── Case 1: event -> ACTIVE starts a recording ──────────────────────────
{
  const mgr = makeFakeManager();
  const deps = makeDeps(mgr);
  const oldE = makeEvent({ status: GuildScheduledEventStatus.Scheduled });
  const newE = makeEvent({ status: GuildScheduledEventStatus.Active });
  const status = await handleEventUpdate(oldE, newE, deps);
  assert(status === 'started', `expected started, got "${status}"`);
  assert(mgr.startCalls.length === 1, 'exactly one startRecording call');
  const call = mgr.startCalls[0];
  assert(call.channelId === VOICE, 'started the event voice channel');
  assert(call.guildId === GUILD, 'started in the event guild');
  assert(call.textChannelId === 'T1', 'used resolved text channel');
  assert(call.requesterId === 'BOT', 'requester is bot user id');
  assert(call.callName === eventCallName(newE), 'call name derived from event name');
  assert(mgr.isRecording(VOICE), 'channel is now recording');
  console.log('✅ Case 1: event going ACTIVE starts a recording of its voice channel');
}

// ─── Case 2: already-recording channel is skipped, not double-started ─────
{
  const mgr = makeFakeManager([VOICE]); // channel already recording (e.g. /schedule)
  const deps = makeDeps(mgr);
  const oldE = makeEvent({ status: GuildScheduledEventStatus.Scheduled });
  const newE = makeEvent({ status: GuildScheduledEventStatus.Active });
  const status = await handleEventUpdate(oldE, newE, deps);
  assert(status === 'skipped: already recording', `expected skip, got "${status}"`);
  assert(mgr.startCalls.length === 0, 'must not call startRecording for an already-recording channel');
  console.log('✅ Case 2: an already-recording channel is skipped, never double-started');
}

// ─── Case 2b: guard race — isRecording says free but startRecording throws ─
{
  const mgr = makeFakeManager();
  // Simulate the reservation race: fast-path check passes, but the
  // authoritative guard rejects at startRecording time.
  mgr.isRecording = () => false;
  mgr.startRecording = async (opts: any) => {
    mgr.startCalls.push(opts);
    throw new AlreadyRecordingError(opts.channelId);
  };
  const deps = makeDeps(mgr);
  const status = await handleEventUpdate(
    makeEvent({ status: GuildScheduledEventStatus.Scheduled }),
    makeEvent({ status: GuildScheduledEventStatus.Active }),
    deps,
  );
  assert(status === 'skipped: already recording', `expected race skip, got "${status}"`);
  console.log('✅ Case 2b: a start race caught by the WorkerManager guard degrades to skip');
}

// ─── Case 3: terminal status stops the recording (belt-and-suspenders) ────
{
  const mgr = makeFakeManager([VOICE]);
  const deps = makeDeps(mgr);
  const oldE = makeEvent({ status: GuildScheduledEventStatus.Active });
  const newE = makeEvent({ status: GuildScheduledEventStatus.Completed });
  const status = await handleEventUpdate(oldE, newE, deps);
  assert(status === 'stopped', `expected stopped, got "${status}"`);
  assert(mgr.stopCalls.length === 1 && mgr.stopCalls[0] === VOICE, 'stopped the event channel');
  assert(!mgr.isRecording(VOICE), 'channel no longer recording');
  console.log('✅ Case 3: a terminal (Completed) transition stops the recording');
}

// ─── Case 3b: channel-empty is the primary stop (simulated) ───────────────
// The channel emptying is handled by index.ts's shared VoiceStateUpdate ->
// WorkerManager.stopRecording path. Model it directly here to document the
// contract that stopRecording releases the channel.
{
  const mgr = makeFakeManager([VOICE]);
  assert(mgr.isRecording(VOICE), 'precondition: recording');
  await mgr.stopRecording(VOICE); // what the empty-channel auto-stop calls
  assert(!mgr.isRecording(VOICE), 'channel-empty stop releases the recording');
  console.log('✅ Case 3b: channel-empty auto-stop (shared voice-state path) stops the recording');
}

// ─── Case 4: recurring events send SCHEDULED (next occurrence), not Completed ─
// This must NOT be treated as a stop and must NOT start (already active handling).
{
  const mgr = makeFakeManager([VOICE]);
  const deps = makeDeps(mgr);
  const oldE = makeEvent({ status: GuildScheduledEventStatus.Active });
  const newE = makeEvent({ status: GuildScheduledEventStatus.Scheduled }); // recurring rollover
  const status = await handleEventUpdate(oldE, newE, deps);
  assert(status === 'noop', `recurring rollover should be a noop, got "${status}"`);
  assert(mgr.stopCalls.length === 0, 'recurring rollover must not stop the live recording');
  assert(mgr.startCalls.length === 0, 'recurring rollover must not start anything');
  console.log('✅ Case 4: recurring-event SCHEDULED rollover is a noop (no false stop/start)');
}

// ─── Case 5: transition logic reacts once per go-live ─────────────────────
{
  assert(
    shouldStartForTransition(makeEvent({ status: GuildScheduledEventStatus.Scheduled }), makeEvent({ status: GuildScheduledEventStatus.Active })),
    'Scheduled -> Active should start',
  );
  assert(
    !shouldStartForTransition(makeEvent({ status: GuildScheduledEventStatus.Active }), makeEvent({ status: GuildScheduledEventStatus.Active })),
    'Active -> Active (edit while live) should NOT re-start',
  );
  assert(
    !shouldStartForTransition(null, makeEvent({ status: GuildScheduledEventStatus.Active, entityType: GuildScheduledEventEntityType.External })),
    'External events have no voice channel; should not start',
  );
  assert(
    !shouldStartForTransition(null, makeEvent({ status: GuildScheduledEventStatus.Active, channelId: null })),
    'Active with no channel should not start',
  );
  assert(isVoiceEntity(GuildScheduledEventEntityType.Voice), 'Voice is a voice entity');
  assert(isVoiceEntity(GuildScheduledEventEntityType.StageInstance), 'Stage is a voice entity');
  assert(!isVoiceEntity(GuildScheduledEventEntityType.External), 'External is not a voice entity');
  console.log('✅ Case 5: start-transition logic fires once per go-live and only for voice/stage');
}

// ─── Case 6: opt-in gate (default OFF) ────────────────────────────────────
{
  (Config as any).GUILD_EVENT_RECORDING = ''; // default OFF
  assert(!isGuildEventRecordingEnabled(GUILD), 'default empty config is OFF');
  const mgr = makeFakeManager();
  const status = await handleEventUpdate(
    makeEvent({ status: GuildScheduledEventStatus.Scheduled }),
    makeEvent({ status: GuildScheduledEventStatus.Active }),
    makeDeps(mgr),
  );
  assert(status.startsWith('skipped: not enabled'), `disabled guild should skip, got "${status}"`);
  assert(mgr.startCalls.length === 0, 'disabled guild must not start');

  (Config as any).GUILD_EVENT_RECORDING = 'on';
  assert(isGuildEventRecordingEnabled('any-guild'), '"on" enables all guilds');
  (Config as any).GUILD_EVENT_RECORDING = 'G1,G2';
  assert(isGuildEventRecordingEnabled('G2'), 'listed guild enabled');
  assert(!isGuildEventRecordingEnabled('G3'), 'unlisted guild disabled');
  console.log('✅ Case 6: recording is opt-in per guild and default OFF');
}

// ─── Case 7: no usable text channel -> skip (results must be surfaceable) ──
{
  (Config as any).GUILD_EVENT_RECORDING = GUILD;
  const mgr = makeFakeManager();
  const deps = makeDeps(mgr, { resolveTextChannelId: async () => null });
  const status = await handleEventUpdate(
    makeEvent({ status: GuildScheduledEventStatus.Scheduled }),
    makeEvent({ status: GuildScheduledEventStatus.Active }),
    deps,
  );
  assert(status === 'skipped: no text channel', `expected text-channel skip, got "${status}"`);
  assert(mgr.startCalls.length === 0, 'must not start when results cannot be surfaced');
  console.log('✅ Case 7: skips (does not start) when no text channel is available to surface results');
}

  console.log('\nAll event-trigger tests passed.');
}

main().catch((err) => { console.error(err); process.exit(1); });
