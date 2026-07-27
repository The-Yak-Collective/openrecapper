#!/usr/bin/env npx tsx
/**
 * test-channel-guard.ts — Unit tests for WorkerManager's one-bot-per-channel
 * reservation guard.
 *
 * Plain tsx script (no test framework — mirrors test-mixdown.ts): each case
 * throws on failure and logs ✅ on success. Runs in a fresh process, so the
 * WorkerManager singleton starts empty; the guard's private reserve/release
 * primitives are reached via an `as any` cast (the codebase's established
 * test-access style).
 *
 * This guards the multi-recorder invariant: two near-simultaneous starts for
 * the same channel must not both proceed (which would put two recorder bots
 * into one voice channel). The reservation is synchronous, so exercising the
 * primitive directly faithfully models the concurrent-start race.
 *
 * Run:  npx tsx tests/test-channel-guard.ts
 */

import { WorkerManager } from '../src/services/worker-manager';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const m = WorkerManager.getInstance() as any;

// ─── Case 1: A second reservation for the same channel is rejected ────
{
  assert(m.reserveChannel('C1') === true, 'first reservation of C1 should win');
  assert(m.reserveChannel('C1') === false, 'a concurrent second reservation of C1 must be rejected');
  console.log('✅ Case 1: only one start can reserve a given channel at a time');
}

// ─── Case 2: Releasing a pending reservation frees the channel ────────
{
  m.releasePendingChannel('C1');
  assert(m.reserveChannel('C1') === true, 'C1 should be reservable again after release');
  m.releasePendingChannel('C1');
  console.log('✅ Case 2: releasing a mid-startup reservation frees the channel');
}

// ─── Case 3: Different channels reserve independently ─────────────────
{
  assert(m.reserveChannel('A') === true, 'reserve channel A');
  assert(m.reserveChannel('B') === true, 'reserve channel B (independent of A)');
  assert(m.reserveChannel('A') === false, 'A is still held');
  m.releasePendingChannel('A');
  m.releasePendingChannel('B');
  console.log('✅ Case 3: distinct channels reserve independently');
}

console.log('\nAll channel-guard tests passed.');
