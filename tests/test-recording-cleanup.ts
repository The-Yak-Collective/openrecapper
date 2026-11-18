import fs from 'fs';
import os from 'os';
import path from 'path';
import { removeRedundantCombinedPcm, freeDiskMb } from '../src/services/recording-cleanup';

let failed = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? '✅' : '❌'} ${name}`);
  if (!cond) failed++;
}

function freshDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orc-cleanup-'));
}

// Case 1: complete WAV next to combined.pcm → PCM removed, WAV kept
{
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, 'combined.pcm'), Buffer.alloc(1000));
  fs.writeFileSync(path.join(dir, 'recording.wav'), Buffer.alloc(1044));
  const freed = removeRedundantCombinedPcm(dir);
  check('Case 1: redundant combined.pcm removed', freed === 1000 && !fs.existsSync(path.join(dir, 'combined.pcm')));
  check('Case 1: recording.wav kept', fs.existsSync(path.join(dir, 'recording.wav')));
  fs.rmSync(dir, { recursive: true, force: true });
}

// Case 2: truncated WAV (e.g. disk filled mid-conversion) → PCM kept
{
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, 'combined.pcm'), Buffer.alloc(1000));
  fs.writeFileSync(path.join(dir, 'recording.wav'), Buffer.alloc(500));
  const freed = removeRedundantCombinedPcm(dir);
  check('Case 2: truncated WAV keeps combined.pcm', freed === 0 && fs.existsSync(path.join(dir, 'combined.pcm')));
  fs.rmSync(dir, { recursive: true, force: true });
}

// Case 3: no WAV at all → PCM kept
{
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, 'combined.pcm'), Buffer.alloc(1000));
  const freed = removeRedundantCombinedPcm(dir);
  check('Case 3: missing WAV keeps combined.pcm', freed === 0 && fs.existsSync(path.join(dir, 'combined.pcm')));
  fs.rmSync(dir, { recursive: true, force: true });
}

// Case 3b: DO_NOT_DELETE marker → PCM kept even with a complete WAV
{
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, 'combined.pcm'), Buffer.alloc(1000));
  fs.writeFileSync(path.join(dir, 'recording.wav'), Buffer.alloc(1044));
  fs.writeFileSync(path.join(dir, 'DO_NOT_DELETE.md'), 'keep');
  const freed = removeRedundantCombinedPcm(dir);
  check('Case 3b: protected session keeps combined.pcm', freed === 0 && fs.existsSync(path.join(dir, 'combined.pcm')));
  fs.rmSync(dir, { recursive: true, force: true });
}

// Case 4: freeDiskMb returns a plausible number
{
  const mb = freeDiskMb(os.tmpdir());
  check('Case 4: freeDiskMb reports free space', mb !== null && mb >= 0);
}

if (failed > 0) {
  console.error(`\n${failed} recording-cleanup test(s) failed.`);
  process.exit(1);
}
console.log('\nAll recording-cleanup tests passed.');
