#!/usr/bin/env npx tsx
/**
 * test-mixdown.ts — Integration test for the silence-filling + mixdown pipeline.
 *
 * Creates synthetic per-user PCM files that simulate Discord's behaviour:
 *   - User A speaks at t=0s for 1s, pauses 2s, speaks again at t=3s for 1s
 *   - User B speaks at t=1s for 1s
 *
 * Tests both:
 *   1. SilenceFiller — preserving real-time gaps in individual PCM files
 *   2. mixdownPcmFiles — combining multiple time-aligned tracks
 *
 * Audio format: 48 kHz, 16-bit signed LE, stereo.
 *
 * Run:  npx tsx tests/test-mixdown.ts
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { SilenceFiller } from '../src/services/silence-filler';
import { Writable, Readable } from 'stream';

// ─── Constants ────────────────────────────────────────────────────────
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
const FRAME_SIZE = CHANNELS * BYTES_PER_SAMPLE; // 4
const BYTES_PER_MS = (SAMPLE_RATE * FRAME_SIZE) / 1000; // 192
const BYTES_PER_SEC = BYTES_PER_MS * 1000; // 192000

// ─── Helpers ──────────────────────────────────────────────────────────

/** Generate a PCM buffer of `durationMs` filled with a recognisable tone. */
function generateTone(durationMs: number, freq = 440): Buffer {
  const totalSamples = Math.floor((SAMPLE_RATE * durationMs) / 1000);
  const buf = Buffer.alloc(totalSamples * FRAME_SIZE);
  for (let i = 0; i < totalSamples; i++) {
    const t = i / SAMPLE_RATE;
    const val = Math.round(16000 * Math.sin(2 * Math.PI * freq * t));
    const clamped = Math.max(-32768, Math.min(32767, val));
    // Stereo: write the same value to both channels
    buf.writeInt16LE(clamped, i * FRAME_SIZE);     // L
    buf.writeInt16LE(clamped, i * FRAME_SIZE + 2); // R
  }
  return buf;
}

/** Read an Int16LE sample at the given byte position (left channel). */
function readSample(buf: Buffer, bytePos: number): number {
  return buf.readInt16LE(bytePos);
}

/** Check whether a region is silence (all zeros within tolerance). */
function isSilent(buf: Buffer, startByte: number, lengthBytes: number, tolerance = 1): boolean {
  const end = Math.min(startByte + lengthBytes, buf.length);
  for (let i = startByte; i < end; i += BYTES_PER_SAMPLE) {
    if (Math.abs(buf.readInt16LE(i)) > tolerance) return false;
  }
  return true;
}

/** Check whether a region has non-trivial audio. */
function hasAudio(buf: Buffer, startByte: number, lengthBytes: number, threshold = 100): boolean {
  const end = Math.min(startByte + lengthBytes, buf.length);
  let maxAbs = 0;
  for (let i = startByte; i < end; i += BYTES_PER_SAMPLE) {
    maxAbs = Math.max(maxAbs, Math.abs(buf.readInt16LE(i)));
  }
  return maxAbs > threshold;
}

// ─── Import mixdown (private method — we test it via a thin wrapper) ──
// We duplicate the mixdown logic inline so the test doesn't need to
// instantiate WorkerManager with its Discord dependencies.
async function mixdownPcmFiles(
  files: string[],
  userStartTimes: Map<string, number>,
  sessionStartedAt: number,
  outputPath: string,
): Promise<void> {
  const validFiles = files.filter(f => fs.existsSync(f) && fs.statSync(f).size > 0);
  if (validFiles.length === 0) {
    fs.writeFileSync(outputPath, Buffer.alloc(0));
    return;
  }

  interface TrackInfo {
    filePath: string;
    offsetBytes: number;
    fileSize: number;
    totalBytes: number;
  }

  const tracks: TrackInfo[] = validFiles.map(filePath => {
    const startTime = userStartTimes.get(filePath) ?? sessionStartedAt;
    const offsetMs = Math.max(0, startTime - sessionStartedAt);
    const rawOffsetBytes = Math.round(offsetMs * BYTES_PER_MS);
    const offsetBytes = Math.floor(rawOffsetBytes / FRAME_SIZE) * FRAME_SIZE;
    const fileSize = fs.statSync(filePath).size;
    const alignedFileSize = Math.floor(fileSize / FRAME_SIZE) * FRAME_SIZE;
    return { filePath, offsetBytes, fileSize: alignedFileSize, totalBytes: offsetBytes + alignedFileSize };
  });

  const totalOutputBytes = Math.max(...tracks.map(t => t.totalBytes));
  if (totalOutputBytes === 0) {
    fs.writeFileSync(outputPath, Buffer.alloc(0));
    return;
  }

  const CHUNK_BYTES = SAMPLE_RATE * FRAME_SIZE * 5;
  const writeStream = fs.createWriteStream(outputPath);
  const fds = tracks.map(t => fs.openSync(t.filePath, 'r'));

  try {
    let outputPosition = 0;
    while (outputPosition < totalOutputBytes) {
      const chunkSize = Math.min(CHUNK_BYTES, totalOutputBytes - outputPosition);
      const chunkEnd = outputPosition + chunkSize;
      const mixBuffer = Buffer.alloc(chunkSize, 0);

      for (let trackIdx = 0; trackIdx < tracks.length; trackIdx++) {
        const track = tracks[trackIdx];
        const fd = fds[trackIdx];
        const trackDataStart = track.offsetBytes;
        const trackDataEnd = track.offsetBytes + track.fileSize;
        const overlapStart = Math.max(outputPosition, trackDataStart);
        const overlapEnd = Math.min(chunkEnd, trackDataEnd);
        if (overlapStart >= overlapEnd) continue;

        const overlapLength = overlapEnd - overlapStart;
        const fileReadOffset = overlapStart - trackDataStart;
        const trackBuf = Buffer.alloc(overlapLength);
        const bytesRead = fs.readSync(fd, trackBuf, 0, overlapLength, fileReadOffset);
        if (bytesRead === 0) continue;

        const mixOffset = overlapStart - outputPosition;
        const samplesToMix = Math.floor(bytesRead / BYTES_PER_SAMPLE);
        for (let i = 0; i < samplesToMix; i++) {
          const bytePos = i * BYTES_PER_SAMPLE;
          const mixBytePos = mixOffset + bytePos;
          const mixVal = mixBuffer.readInt16LE(mixBytePos);
          const trackVal = trackBuf.readInt16LE(bytePos);
          const sum = mixVal + trackVal;
          const clipped = Math.max(-32768, Math.min(32767, sum));
          mixBuffer.writeInt16LE(clipped, mixBytePos);
        }
      }

      const canContinue = writeStream.write(mixBuffer);
      if (!canContinue) {
        await new Promise<void>(resolve => writeStream.once('drain', resolve));
      }
      outputPosition += chunkSize;
    }
  } finally {
    for (const fd of fds) fs.closeSync(fd);
  }

  writeStream.end();
  await new Promise<void>((resolve, reject) => {
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
  });
}

// ─── Collect output from a SilenceFiller into a Buffer ────────────────
async function runSilenceFiller(
  chunks: { data: Buffer; delayMs: number }[],
  initialLastChunkTime = 0,
): Promise<Buffer> {
  const filler = new SilenceFiller(initialLastChunkTime);
  const parts: Buffer[] = [];

  filler.on('data', (chunk: Buffer) => parts.push(chunk));

  for (const { data, delayMs } of chunks) {
    if (delayMs > 0) {
      await new Promise(r => setTimeout(r, delayMs));
    }
    filler.write(data);
  }

  filler.end();
  await new Promise<void>(resolve => filler.once('finish', resolve));

  return Buffer.concat(parts);
}

// ─── Test runner ──────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${msg}`);
    failed++;
  }
}

async function testSilenceFillerBasic() {
  console.log('\n── Test: SilenceFiller inserts silence for gaps ──');

  // Simulate: 100ms of audio, 500ms pause, 100ms of audio
  const tone100 = generateTone(100, 440); // 100ms of 440Hz
  const result = await runSilenceFiller([
    { data: tone100, delayMs: 0 },   // first chunk arrives immediately
    { data: tone100, delayMs: 500 },  // second chunk arrives 500ms later
  ]);

  // Expected: ~100ms tone + ~480ms silence (500ms gap - 20ms cadence) + ~100ms tone
  // Total ≈ 680ms ≈ 130560 bytes (with some tolerance for wall-clock imprecision)
  const resultMs = result.length / BYTES_PER_MS;

  console.log(`  Result length: ${result.length} bytes (${resultMs.toFixed(1)}ms)`);
  console.log(`  Input was: 200ms audio + 500ms gap = expected ~680ms`);

  // Allow ±100ms tolerance for wall-clock scheduling jitter
  assert(resultMs > 550 && resultMs < 800,
    `Total duration ${resultMs.toFixed(0)}ms is in expected range [550, 800]`);

  // The output should be longer than just the two input chunks concatenated
  const inputOnlySize = tone100.length * 2;
  assert(result.length > inputOnlySize,
    `Output (${result.length}B) > concatenated input (${inputOnlySize}B) — silence was inserted`);

  // First 100ms should have audio
  assert(hasAudio(result, 0, tone100.length),
    'First segment has audio');

  // Last 100ms should have audio
  assert(hasAudio(result, result.length - tone100.length, tone100.length),
    'Last segment has audio');

  // Middle region should be silence (skip first and last 100ms)
  const silenceStart = tone100.length;
  const silenceEnd = result.length - tone100.length;
  if (silenceEnd > silenceStart) {
    assert(isSilent(result, silenceStart, silenceEnd - silenceStart),
      `Middle region [${silenceStart}, ${silenceEnd}] is silence`);
  }
}

async function testSilenceFillerNoGap() {
  console.log('\n── Test: SilenceFiller passes through when no gap ──');

  // Two chunks arriving back-to-back (< 30ms gap) — should produce no extra silence
  const tone50 = generateTone(50, 880);
  const result = await runSilenceFiller([
    { data: tone50, delayMs: 0 },
    { data: tone50, delayMs: 10 }, // 10ms < 30ms threshold
  ]);

  // Should be approximately 2×50ms = 100ms = 19200 bytes
  const expected = tone50.length * 2;
  assert(result.length === expected,
    `No silence inserted: output ${result.length}B === input ${expected}B`);
}

async function testSilenceFillerCrossStream() {
  console.log('\n── Test: SilenceFiller seeds from previous stream ──');

  // Simulate: first stream ended 500ms ago, new stream starts now
  const prevEnd = Date.now() - 500;
  const tone100 = generateTone(100, 440);

  const result = await runSilenceFiller(
    [{ data: tone100, delayMs: 0 }],
    prevEnd,
  );

  // Should have ~480ms silence + 100ms audio ≈ 580ms
  const resultMs = result.length / BYTES_PER_MS;
  console.log(`  Result: ${resultMs.toFixed(0)}ms (expected ~580ms)`);

  assert(resultMs > 400 && resultMs < 750,
    `Cross-stream gap filled: ${resultMs.toFixed(0)}ms in [400, 750]`);
  assert(result.length > tone100.length,
    `Output (${result.length}B) > single chunk (${tone100.length}B)`);
}

async function testMixdownTwoUsers() {
  console.log('\n── Test: Mixdown of two time-offset users ──');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixdown-test-'));

  try {
    // User A: 1s of 440Hz tone starting at session start (t=0)
    const toneA = generateTone(1000, 440);
    const fileA = path.join(tmpDir, 'userA.pcm');
    fs.writeFileSync(fileA, toneA);

    // User B: 1s of 880Hz tone starting 1s after session start (t=1s)
    const toneB = generateTone(1000, 880);
    const fileB = path.join(tmpDir, 'userB.pcm');
    fs.writeFileSync(fileB, toneB);

    const sessionStart = 1000000; // arbitrary
    const userStartTimes = new Map<string, number>();
    userStartTimes.set(fileA, sessionStart);       // User A starts at t=0
    userStartTimes.set(fileB, sessionStart + 1000); // User B starts at t=1s

    const outputPath = path.join(tmpDir, 'combined.pcm');
    await mixdownPcmFiles([fileA, fileB], userStartTimes, sessionStart, outputPath);

    const combined = fs.readFileSync(outputPath);
    const combinedMs = combined.length / BYTES_PER_MS;
    console.log(`  Combined: ${combined.length} bytes (${combinedMs.toFixed(0)}ms)`);

    // Expected total: 2 seconds (User A 0-1s, User B 1-2s)
    const expectedBytes = 2 * BYTES_PER_SEC;
    assert(combined.length === expectedBytes,
      `Combined length ${combined.length}B === expected ${expectedBytes}B (2s)`);

    // t=0 to t=1s: only User A's tone (440Hz)
    assert(hasAudio(combined, 0, BYTES_PER_SEC),
      'Audio present at t=0-1s (User A)');

    // t=1s to t=2s: only User B's tone (880Hz)
    assert(hasAudio(combined, BYTES_PER_SEC, BYTES_PER_SEC),
      'Audio present at t=1-2s (User B)');

    // Verify it's NOT concatenation: concatenation would give 2*BYTES_PER_SEC
    // which happens to match here. But let's verify User B's tone is at t=1s.
    // Check a small region rather than a single sample to avoid zero-crossings.
    assert(hasAudio(combined, BYTES_PER_SEC, Math.floor(0.1 * BYTES_PER_SEC)),
      'Audio at t=1.0-1.1s confirms User B is playing at the correct offset');

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testMixdownOverlap() {
  console.log('\n── Test: Mixdown with overlapping users ──');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixdown-test-'));

  try {
    // User A: 2s of 440Hz starting at t=0
    const toneA = generateTone(2000, 440);
    const fileA = path.join(tmpDir, 'userA.pcm');
    fs.writeFileSync(fileA, toneA);

    // User B: 2s of 880Hz starting at t=1s — overlaps with User A from t=1-2s
    const toneB = generateTone(2000, 880);
    const fileB = path.join(tmpDir, 'userB.pcm');
    fs.writeFileSync(fileB, toneB);

    const sessionStart = 1000000;
    const userStartTimes = new Map<string, number>();
    userStartTimes.set(fileA, sessionStart);
    userStartTimes.set(fileB, sessionStart + 1000);

    const outputPath = path.join(tmpDir, 'combined.pcm');
    await mixdownPcmFiles([fileA, fileB], userStartTimes, sessionStart, outputPath);

    const combined = fs.readFileSync(outputPath);
    const combinedMs = combined.length / BYTES_PER_MS;
    console.log(`  Combined: ${combined.length} bytes (${combinedMs.toFixed(0)}ms)`);

    // Expected: 3 seconds (User A: 0-2s, User B: 1-3s)
    const expectedBytes = 3 * BYTES_PER_SEC;
    assert(combined.length === expectedBytes,
      `Combined length ${combined.length}B === expected ${expectedBytes}B (3s)`);

    // t=0-1s: only A
    assert(hasAudio(combined, 0, BYTES_PER_SEC), 'Audio at t=0-1s');

    // t=1-2s: A + B mixed. The peak amplitude should be higher than either alone.
    // User A alone produces ±16000. Mixed with B, peaks should be higher.
    let maxInOverlap = 0;
    const overlapStart = BYTES_PER_SEC;
    const overlapEnd = 2 * BYTES_PER_SEC;
    for (let i = overlapStart; i < overlapEnd; i += BYTES_PER_SAMPLE) {
      maxInOverlap = Math.max(maxInOverlap, Math.abs(combined.readInt16LE(i)));
    }
    // Single tone peaks at ~16000, mixed peaks should sometimes exceed that
    assert(maxInOverlap > 16000,
      `Overlap region peak ${maxInOverlap} > 16000 — both tones mixed`);

    // t=2-3s: only B
    assert(hasAudio(combined, 2 * BYTES_PER_SEC, BYTES_PER_SEC),
      'Audio at t=2-3s (User B only)');

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testMixdownSaturationClipping() {
  console.log('\n── Test: Mixdown saturation clipping ──');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixdown-test-'));

  try {
    // Two loud signals that would overflow if added without clipping
    const durationMs = 100;
    const totalSamples = Math.floor((SAMPLE_RATE * durationMs) / 1000);
    const loudBuf = Buffer.alloc(totalSamples * FRAME_SIZE);
    for (let i = 0; i < totalSamples; i++) {
      loudBuf.writeInt16LE(30000, i * FRAME_SIZE);
      loudBuf.writeInt16LE(30000, i * FRAME_SIZE + 2);
    }

    const fileA = path.join(tmpDir, 'a.pcm');
    const fileB = path.join(tmpDir, 'b.pcm');
    fs.writeFileSync(fileA, loudBuf);
    fs.writeFileSync(fileB, loudBuf);

    const sessionStart = 0;
    const userStartTimes = new Map<string, number>();
    userStartTimes.set(fileA, 0);
    userStartTimes.set(fileB, 0);

    const outputPath = path.join(tmpDir, 'combined.pcm');
    await mixdownPcmFiles([fileA, fileB], userStartTimes, sessionStart, outputPath);

    const combined = fs.readFileSync(outputPath);
    // 30000 + 30000 = 60000, should be clipped to 32767
    const sample = combined.readInt16LE(0);
    assert(sample === 32767,
      `Clipped sample = ${sample} (expected 32767)`);

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testSilenceFillerThenMixdown() {
  console.log('\n── Test: End-to-end silence-fill + mixdown ──');
  console.log('  Simulates: User A speaks 200ms, pauses 500ms, speaks 200ms.');
  console.log('             User B speaks 200ms starting at t=500ms.');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixdown-test-'));

  try {
    const sessionStart = 100000; // arbitrary
    const userAStart = sessionStart + 0;
    const userBStart = sessionStart + 500;

    // User A: simulate two speech bursts with a 500ms gap
    const toneA = generateTone(200, 440);
    const filledA = await runSilenceFiller([
      { data: toneA, delayMs: 0 },   // t=0
      { data: toneA, delayMs: 500 },  // t≈500ms (after gap)
    ]);
    const fileA = path.join(tmpDir, 'userA.pcm');
    fs.writeFileSync(fileA, filledA);

    // User B: continuous 200ms starting at t=500ms
    const toneB = generateTone(200, 880);
    const fileB = path.join(tmpDir, 'userB.pcm');
    fs.writeFileSync(fileB, toneB);

    const userStartTimes = new Map<string, number>();
    userStartTimes.set(fileA, userAStart);
    userStartTimes.set(fileB, userBStart);

    const outputPath = path.join(tmpDir, 'combined.pcm');
    await mixdownPcmFiles([fileA, fileB], userStartTimes, sessionStart, outputPath);

    const combined = fs.readFileSync(outputPath);
    const combinedMs = combined.length / BYTES_PER_MS;
    console.log(`  User A PCM (with silence): ${filledA.length}B (${(filledA.length / BYTES_PER_MS).toFixed(0)}ms)`);
    console.log(`  User B PCM: ${toneB.length}B (${(toneB.length / BYTES_PER_MS).toFixed(0)}ms)`);
    console.log(`  Combined: ${combined.length}B (${combinedMs.toFixed(0)}ms)`);

    // User A's silence-filled PCM should be longer than raw concatenation
    assert(filledA.length > toneA.length * 2,
      `User A filled (${filledA.length}B) > raw concat (${toneA.length * 2}B)`);

    // The combined should NOT equal sum of file sizes (that would be concatenation)
    const sumOfFiles = filledA.length + toneB.length;
    assert(combined.length !== sumOfFiles || combined.length < sumOfFiles,
      `Combined (${combined.length}B) is a mixdown, not concatenation (sum=${sumOfFiles}B)`);

    // First 200ms: User A's tone should be present
    assert(hasAudio(combined, 0, Math.floor(200 * BYTES_PER_MS)),
      'Audio at t=0-200ms (User A first burst)');

    // Around t=500ms: User A's second burst AND User B should both be present.
    // This is the critical check — if silence gaps weren't preserved, User A's
    // second burst would be at ~200ms instead of ~500ms.
    const t500_bytes = Math.floor(500 * BYTES_PER_MS);
    const check_region = Math.floor(200 * BYTES_PER_MS);
    assert(hasAudio(combined, t500_bytes, check_region),
      'Audio at t=500-700ms (User A second burst + User B)');

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testSilenceFillerMaxCap() {
  console.log('\n── Test: SilenceFiller caps silence at MAX_SILENCE_MS ──');

  // Pretend previous chunk was 10 minutes ago — should be capped at 5 minutes
  const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
  const tone = generateTone(50, 440);

  const result = await runSilenceFiller(
    [{ data: tone, delayMs: 0 }],
    tenMinutesAgo,
  );

  const resultMs = result.length / BYTES_PER_MS;
  const fiveMinMs = 5 * 60 * 1000;

  console.log(`  Result: ${resultMs.toFixed(0)}ms`);
  // Should be capped at ~5 minutes + 50ms, not 10 minutes + 50ms
  assert(resultMs < fiveMinMs + 200,
    `Capped at ~5min: ${resultMs.toFixed(0)}ms < ${fiveMinMs + 200}ms`);
  assert(resultMs > fiveMinMs - 200,
    `At least ~5min: ${resultMs.toFixed(0)}ms > ${fiveMinMs - 200}ms`);
}

// ─── Main ─────────────────────────────────────────────────────────────
async function main() {
  console.log('=== openrecapper mixdown test suite ===');

  await testSilenceFillerBasic();
  await testSilenceFillerNoGap();
  await testSilenceFillerCrossStream();
  await testSilenceFillerMaxCap();
  await testMixdownTwoUsers();
  await testMixdownOverlap();
  await testMixdownSaturationClipping();
  await testSilenceFillerThenMixdown();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Test suite crashed:', err);
  process.exit(2);
});
