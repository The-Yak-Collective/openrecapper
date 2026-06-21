import fs from 'fs';
import path from 'path';
import { Config } from '../config';

/**
 * Automatic cleanup of old recording files.
 *
 * After a recording is transcribed and uploaded to R2, the raw audio files
 * (.pcm, combined.pcm, .wav) are no longer needed but are kept for a
 * configurable retention period (default 7 days) as redundancy.
 *
 * This service scans the recordings directory and removes large audio files
 * from sessions that are older than the retention period AND have been
 * successfully processed (transcript files exist). Small metadata files
 * (transcript.txt, transcript.srt, metadata.json, summary.md) are preserved.
 */

/** File extensions to delete during cleanup (case-insensitive). */
const LARGE_FILE_PATTERNS = ['.pcm', '.wav'];

/** Files to always keep (even if they match a large-file pattern). */
const KEEP_FILES = new Set(['transcript.txt', 'transcript.srt', 'metadata.json', 'summary.md']);

interface CleanupResult {
  /** Number of session directories scanned. */
  scanned: number;
  /** Number of sessions that had files cleaned up. */
  cleaned: number;
  /** Number of sessions skipped (too new or not yet processed). */
  skipped: number;
  /** Total bytes freed. */
  bytesFreed: number;
}

/**
 * Extract the session creation timestamp from the directory name.
 * Directory format: `{guildId}_{channelId}_{Date.now()}`
 * Returns the epoch millis, or null if the format doesn't match.
 */
function getSessionTimestamp(dirName: string): number | null {
  const parts = dirName.split('_');
  if (parts.length < 3) return null;
  const ts = parseInt(parts[parts.length - 1], 10);
  if (isNaN(ts) || ts < 1_000_000_000_000) return null; // sanity: must be a plausible epoch millis
  return ts;
}

/**
 * Check whether a session directory has been successfully processed.
 * A session is considered processed if it contains a transcript.txt OR transcript.srt file.
 */
function isSessionProcessed(sessionDir: string): boolean {
  try {
    const files = fs.readdirSync(sessionDir);
    return files.includes('transcript.txt') || files.includes('transcript.srt');
  } catch {
    return false;
  }
}

/**
 * Run cleanup of old recording files.
 * Scans RECORDINGS_DIR for session subdirectories older than the retention
 * period that have been successfully processed, and deletes large audio files.
 */
export function cleanupOldRecordings(): CleanupResult {
  const retentionDays = Config.RECORDING_RETENTION_DAYS;
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  const cutoffTime = Date.now() - retentionMs;
  const recordingsDir = Config.RECORDINGS_DIR;

  const result: CleanupResult = {
    scanned: 0,
    cleaned: 0,
    skipped: 0,
    bytesFreed: 0,
  };

  if (!fs.existsSync(recordingsDir)) {
    console.log('[RecordingCleanup] Recordings directory does not exist, nothing to clean');
    return result;
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(recordingsDir);
  } catch (err) {
    console.error('[RecordingCleanup] Failed to read recordings directory:', err);
    return result;
  }

  for (const entry of entries) {
    const sessionDir = path.join(recordingsDir, entry);

    // Only process directories
    try {
      if (!fs.statSync(sessionDir).isDirectory()) continue;
    } catch {
      continue;
    }

    result.scanned++;

    // Extract timestamp from directory name
    const sessionTs = getSessionTimestamp(entry);
    if (sessionTs === null) {
      // Can't determine age — skip
      result.skipped++;
      continue;
    }

    // Check if old enough
    if (sessionTs > cutoffTime) {
      result.skipped++;
      continue;
    }

    // Check if processed
    if (!isSessionProcessed(sessionDir)) {
      // Not processed — don't delete audio files, they may still be needed
      result.skipped++;
      continue;
    }

    // Delete large audio files, keep transcripts/metadata
    let sessionBytesFreed = 0;
    try {
      const files = fs.readdirSync(sessionDir);
      for (const file of files) {
        if (KEEP_FILES.has(file)) continue;

        const ext = path.extname(file).toLowerCase();
        if (!LARGE_FILE_PATTERNS.includes(ext)) continue;

        const filePath = path.join(sessionDir, file);
        try {
          const stat = fs.statSync(filePath);
          fs.unlinkSync(filePath);
          sessionBytesFreed += stat.size;
        } catch (err) {
          console.error(`[RecordingCleanup] Failed to delete ${filePath}:`, err);
        }
      }
    } catch (err) {
      console.error(`[RecordingCleanup] Failed to list files in ${sessionDir}:`, err);
      continue;
    }

    if (sessionBytesFreed > 0) {
      result.cleaned++;
      result.bytesFreed += sessionBytesFreed;
      console.log(
        `[RecordingCleanup] Cleaned ${entry}: removed ${formatBytes(sessionBytesFreed)} of audio files`
      );
    }
  }

  return result;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

/**
 * Start the periodic cleanup scheduler.
 * Runs cleanup immediately (on startup) and then once every 24 hours.
 * Returns the interval handle for testing/cleanup.
 */
export function startCleanupScheduler(): NodeJS.Timeout {
  // Run immediately on startup
  runCleanup();

  // Schedule daily cleanup (every 24 hours)
  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
  return setInterval(runCleanup, TWENTY_FOUR_HOURS);
}

function runCleanup(): void {
  try {
    const retentionDays = Config.RECORDING_RETENTION_DAYS;
    console.log(`[RecordingCleanup] Running cleanup (retention: ${retentionDays} days)...`);
    const result = cleanupOldRecordings();
    console.log(
      `[RecordingCleanup] Done: scanned=${result.scanned}, cleaned=${result.cleaned}, ` +
      `skipped=${result.skipped}, freed=${formatBytes(result.bytesFreed)}`
    );
  } catch (err) {
    console.error('[RecordingCleanup] Unexpected error during cleanup:', err);
  }
}
