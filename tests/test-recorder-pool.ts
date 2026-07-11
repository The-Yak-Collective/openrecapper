#!/usr/bin/env npx tsx
/**
 * test-recorder-pool.ts — Unit tests for the RecorderPool allocator.
 *
 * Plain tsx script (no test framework — mirrors test-mixdown.ts): each case
 * throws on failure and logs ✅ on success. Fake clients are duck-typed and
 * cast; each case uses a FRESH pool instance (never getInstance(), which
 * would leak singleton state between cases).
 *
 * Run:  npx tsx tests/test-recorder-pool.ts
 */

import { RecorderPool } from '../src/services/recorder-pool';
import { Client } from 'discord.js';

function fakeClient(tag: string, guildIds: string[], ready = true): Client {
  return {
    isReady: () => ready,
    user: { tag, id: tag },
    guilds: { cache: new Map(guildIds.map((g) => [g, {}])) },
  } as unknown as Client;
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ─── Case 1: Exhaustion ───────────────────────────────────────────────
{
  const pool = new RecorderPool();
  const c1 = fakeClient('rec-1', ['G']);
  const c2 = fakeClient('rec-2', ['G']);
  pool.register(c1);
  pool.register(c2);

  const l1 = pool.allocate('G');
  const l2 = pool.allocate('G');
  assert(l1 !== null, 'first allocate should succeed');
  assert(l2 !== null, 'second allocate should succeed');
  assert(l1!.client !== l2!.client, 'the two leases must use distinct clients');
  const l3 = pool.allocate('G');
  assert(l3 === null, 'third allocate must return null when both clients are busy');
  console.log('✅ Case 1: exhaustion — 2 clients allow 2 allocations, third is null');
}

// ─── Case 2: Release frees a slot ─────────────────────────────────────
{
  const pool = new RecorderPool();
  const c1 = fakeClient('rec-1', ['G']);
  pool.register(c1);

  const l1 = pool.allocate('G');
  assert(l1 !== null, 'allocate should succeed');
  assert(pool.allocate('G') === null, 'second allocate should fail while lease held');
  pool.release(l1!);
  const l2 = pool.allocate('G');
  assert(l2 !== null, 'allocate should succeed again after release');
  console.log('✅ Case 2: release frees the slot for re-allocation');
}

// ─── Case 3: Per-guild isolation ──────────────────────────────────────
{
  const pool = new RecorderPool();
  const c1 = fakeClient('rec-1', ['A', 'B']);
  pool.register(c1);

  const la = pool.allocate('A');
  const lb = pool.allocate('B');
  assert(la !== null, 'allocate in guild A should succeed');
  assert(lb !== null, 'allocate in guild B should succeed');
  assert(la!.client === lb!.client, 'both leases should use the same (only) client');
  assert(pool.allocate('A') === null, 'second allocate in guild A must fail');
  console.log('✅ Case 3: one client can record in two different guilds at once');
}

// ─── Case 4: Membership check ─────────────────────────────────────────
{
  const pool = new RecorderPool();
  const c1 = fakeClient('rec-1', ['A']);
  pool.register(c1);

  assert(pool.allocate('B') === null, 'allocate must fail for a guild the client is not in');
  assert(pool.capacityForGuild('B') === 0, 'capacityForGuild must be 0 for a non-member guild');
  assert(pool.capacityForGuild('A') === 1, 'capacityForGuild must be 1 for the member guild');
  console.log('✅ Case 4: clients not invited to a guild are never allocated there');
}

// ─── Case 5: Not-ready clients skipped ────────────────────────────────
{
  const pool = new RecorderPool();
  const notReady = fakeClient('rec-down', ['G'], false);
  const ready = fakeClient('rec-up', ['G']);
  pool.register(notReady);
  pool.register(ready);

  assert(pool.capacityForGuild('G') === 1, 'not-ready client must not count toward capacity');
  const l1 = pool.allocate('G');
  assert(l1 !== null, 'allocate should still succeed via the ready client');
  assert(l1!.client === ready, 'the ready client must be the one allocated');
  assert(pool.allocate('G') === null, 'no second allocation — the not-ready client is skipped');
  console.log('✅ Case 5: not-ready clients are skipped and excluded from capacity');
}

// ─── Case 6: Counters ─────────────────────────────────────────────────
{
  const pool = new RecorderPool();
  const c1 = fakeClient('rec-1', ['G']);
  const c2 = fakeClient('rec-2', ['G']);
  pool.register(c1);
  pool.register(c2);

  assert(pool.capacityForGuild('G') === 2, 'capacity should be 2');
  assert(pool.inUseForGuild('G') === 0, 'in-use should start at 0');

  const l1 = pool.allocate('G');
  assert(pool.inUseForGuild('G') === 1, 'in-use should be 1 after one allocation');
  const l2 = pool.allocate('G');
  assert(pool.inUseForGuild('G') === 2, 'in-use should be 2 after two allocations');
  assert(pool.capacityForGuild('G') === 2, 'capacity is unaffected by allocations');

  pool.release(l1!);
  assert(pool.inUseForGuild('G') === 1, 'in-use should drop to 1 after release');
  pool.release(l2!);
  assert(pool.inUseForGuild('G') === 0, 'in-use should drop to 0 after both released');
  console.log('✅ Case 6: capacityForGuild / inUseForGuild track allocations correctly');
}

console.log('\nAll recorder-pool tests passed.');
