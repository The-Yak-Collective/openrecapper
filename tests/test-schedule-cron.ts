#!/usr/bin/env npx tsx
/**
 * test-schedule-cron.ts — Unit tests for the /schedule cron helpers that back
 * the biweekly (every-N-weeks) and one-off-date features.
 *
 * Plain tsx script (no framework — mirrors the other tests): each assertion
 * increments a counter; a mismatch logs and flips the exit code.
 *
 * Covers:
 *   • parseInterval  — parsing the `every` option (weekly/biweekly/"N weeks")
 *   • buildOneOffCron/parseOneOffCron — the `m h D M *` one-off shape
 *   • shouldFireThisWeek/weeksSinceAnchor — the fire-time week-parity gate,
 *     including robustness across a year boundary (the reason we anchor to a
 *     date rather than use ISO odd/even week numbers)
 *   • describeCron — humanized output for one-off and interval schedules
 *   • nextFireDate — anchoring biweekly phase to the next real occurrence
 *
 * Run:  npx tsx tests/test-schedule-cron.ts
 */

import {
  parseInterval,
  buildOneOffCron,
  parseOneOffCron,
  shouldFireThisWeek,
  weeksSinceAnchor,
  describeCron,
  nextFireDate,
} from '../src/services/cron-format';

let pass = 0;
let fail = 0;
function eq(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
  } else {
    fail++;
    console.log(`❌ ${msg}\n   got ${a}\n   exp ${e}`);
  }
}
function throws(fn: () => void, msg: string): void {
  try {
    fn();
    fail++;
    console.log(`❌ ${msg} (expected throw)`);
  } catch {
    pass++;
  }
}

// ── parseInterval ────────────────────────────────────────────────────────────
eq(parseInterval(''), 1, 'parseInterval empty -> 1');
eq(parseInterval('weekly'), 1, 'parseInterval weekly -> 1');
eq(parseInterval('biweekly'), 2, 'parseInterval biweekly -> 2');
eq(parseInterval('fortnightly'), 2, 'parseInterval fortnightly -> 2');
eq(parseInterval('2 weeks'), 2, 'parseInterval "2 weeks" -> 2');
eq(parseInterval('every 3 weeks'), 3, 'parseInterval "every 3 weeks" -> 3');
eq(parseInterval('4'), 4, 'parseInterval "4" -> 4');
throws(() => parseInterval('0'), 'parseInterval 0 rejected');
throws(() => parseInterval('13 weeks'), 'parseInterval 13 rejected');
throws(() => parseInterval('nonsense'), 'parseInterval nonsense rejected');

// ── one-off cron round-trip ──────────────────────────────────────────────────
eq(buildOneOffCron('2026-08-15', '11:15'), '15 11 15 8 *', 'buildOneOffCron');
eq(parseOneOffCron('15 11 15 8 *'), { minute: 15, hour: 11, day: 15, month: 8 }, 'parseOneOffCron');
eq(parseOneOffCron('15 11 * * 1'), null, 'parseOneOffCron rejects weekly shape');
throws(() => buildOneOffCron('2026-02-31', '10:00'), 'buildOneOffCron rejects impossible date');

// ── describeCron ─────────────────────────────────────────────────────────────
eq(
  describeCron('15 11 15 8 *', 'America/New_York', { oneOff: true }),
  'once on August 15 at 11:15 America/New_York',
  'describeCron one-off',
);
eq(
  describeCron('15 11 * * 3', 'America/New_York', { intervalWeeks: 2, anchor: '2026-07-29' }),
  'every 2 weeks on Wed at 11:15 America/New_York (from 2026-07-29)',
  'describeCron biweekly',
);
eq(
  describeCron('15 11 * * 1,5', 'America/New_York'),
  'Mon, Fri at 11:15 America/New_York',
  'describeCron plain weekly unchanged',
);

// ── week-parity gate ─────────────────────────────────────────────────────────
const tz = 'America/New_York';
eq(shouldFireThisWeek(2, '2026-07-29', tz, new Date('2026-07-29T15:15:00Z')), true, 'gate: anchor week fires');
eq(shouldFireThisWeek(2, '2026-07-29', tz, new Date('2026-08-05T15:15:00Z')), false, 'gate: off-week skipped');
eq(shouldFireThisWeek(2, '2026-07-29', tz, new Date('2026-08-12T15:15:00Z')), true, 'gate: +2 weeks fires');
eq(shouldFireThisWeek(2, '2026-07-29', tz, new Date('2026-07-22T15:15:00Z')), false, 'gate: before anchor skipped');
eq(shouldFireThisWeek(1, undefined, tz, new Date()), true, 'gate: weekly always fires');
eq(shouldFireThisWeek(undefined, undefined, tz, new Date()), true, 'gate: absent interval fires');
// Year-boundary robustness: anchor Dec 31 2025 (Wed), +2 civil weeks = Jan 14 2026.
eq(weeksSinceAnchor('2025-12-31', tz, new Date('2026-01-14T15:00:00Z')), 2, 'weeksSinceAnchor across new year');

// ── nextFireDate anchoring ───────────────────────────────────────────────────
// Wed 2026-07-29 12:00 ET, next Wed@11:15 -> today's slot passed -> next Wed.
eq(nextFireDate([3], 11, 15, tz, new Date('2026-07-29T16:00:00Z')), '2026-08-05', 'nextFireDate slot passed');
// Wed 2026-07-29 09:00 ET, next Wed@11:15 -> today.
eq(nextFireDate([3], 11, 15, tz, new Date('2026-07-29T13:00:00Z')), '2026-07-29', 'nextFireDate slot upcoming');
// Wed, Mon/Fri -> next Fri.
eq(nextFireDate([1, 5], 11, 15, tz, new Date('2026-07-29T16:00:00Z')), '2026-07-31', 'nextFireDate multi-day');

console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
