import { Transform, TransformCallback } from 'stream';

/**
 * A Transform stream that fills silence gaps in a PCM audio stream.
 *
 * Discord's voice receiver only delivers opus packets while a user is actively
 * speaking. When a user pauses, no packets arrive — the decoded PCM stream
 * simply stalls. If we naively write only the decoded audio to disk, we get a
 * file that concatenates every speech segment back-to-back with no gaps,
 * destroying the real-time timeline.
 *
 * This transform sits between the Opus decoder output and the file write
 * stream. It tracks wall-clock time between chunks and, when a gap exceeds
 * the expected inter-frame interval, emits zero-filled PCM silence to preserve
 * the real-time duration in the output file.
 *
 * Audio format assumed: 48 kHz, 16-bit signed LE, stereo.
 * Opus frame size: 960 samples → 20 ms → 3840 bytes per frame.
 */
export class SilenceFiller extends Transform {
  private static readonly SAMPLE_RATE = 48000;
  private static readonly CHANNELS = 2;
  private static readonly BYTES_PER_SAMPLE = 2;
  private static readonly FRAME_SIZE =
    SilenceFiller.CHANNELS * SilenceFiller.BYTES_PER_SAMPLE; // 4 bytes per stereo sample
  private static readonly BYTES_PER_MS =
    (SilenceFiller.SAMPLE_RATE * SilenceFiller.FRAME_SIZE) / 1000; // 192

  /**
   * Opus delivers 20 ms frames. We allow up to 1.5× that before treating the
   * gap as real silence, so small scheduling jitter doesn't create spurious
   * silence inserts.
   */
  private static readonly GAP_THRESHOLD_MS = 30;

  /**
   * Safety cap: if the clock gap is larger than this we clamp the silence
   * insert.  Protects against system-sleep or massive GC pauses inflating
   * the file unreasonably.  5 minutes should be far more than any real
   * in-meeting silence.
   */
  private static readonly MAX_SILENCE_MS = 5 * 60 * 1000;

  /** Wall-clock ms when the last chunk was received (0 = first chunk). */
  private lastChunkTime = 0;

  /** Total silence bytes injected (for diagnostics). */
  private silenceBytesInserted = 0;

  /** Number of gaps filled (for diagnostics). */
  private gapsFilled = 0;

  /**
   * @param initialLastChunkTime  If provided, treat this as the wall-clock ms
   *   when the previous stream's last chunk arrived.  Used when an opus stream
   *   auto-closes and a new SilenceFiller is created for the same user —
   *   ensures the gap between streams is filled with silence.
   */
  constructor(initialLastChunkTime = 0) {
    super();
    this.lastChunkTime = initialLastChunkTime;
  }

  _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    const now = Date.now();

    if (this.lastChunkTime > 0) {
      const gapMs = now - this.lastChunkTime;

      if (gapMs > SilenceFiller.GAP_THRESHOLD_MS) {
        // Subtract one frame-worth (20 ms) because the current chunk itself
        // represents the audio *for* the current moment — the silence is only
        // the interval *between* the previous chunk and this one, minus the
        // expected 20 ms cadence.
        const silenceMs = Math.min(
          gapMs - 20,
          SilenceFiller.MAX_SILENCE_MS,
        );

        if (silenceMs > 0) {
          // Align to frame boundary
          const rawBytes = Math.round(silenceMs * SilenceFiller.BYTES_PER_MS);
          const alignedBytes =
            Math.floor(rawBytes / SilenceFiller.FRAME_SIZE) *
            SilenceFiller.FRAME_SIZE;

          if (alignedBytes > 0) {
            // Emit silence in ≤ 192 KB blocks to avoid huge single allocations
            const BLOCK = 192_000; // ~1 second
            let remaining = alignedBytes;
            while (remaining > 0) {
              const sz = Math.min(remaining, BLOCK);
              this.push(Buffer.alloc(sz, 0));
              remaining -= sz;
            }

            this.silenceBytesInserted += alignedBytes;
            this.gapsFilled++;
          }
        }
      }
    }

    this.lastChunkTime = now;
    this.push(chunk);
    callback();
  }

  _flush(callback: TransformCallback): void {
    if (this.gapsFilled > 0) {
      const silenceSec = (
        this.silenceBytesInserted /
        SilenceFiller.BYTES_PER_MS /
        1000
      ).toFixed(1);
      console.log(
        `[SilenceFiller] Filled ${this.gapsFilled} gap(s), inserted ${silenceSec}s of silence`,
      );
    }
    callback();
  }

  /** Diagnostics: total silence bytes emitted by this instance. */
  getSilenceBytesInserted(): number {
    return this.silenceBytesInserted;
  }

  /** Diagnostics: number of gaps filled by this instance. */
  getGapsFilled(): number {
    return this.gapsFilled;
  }

  /** Wall-clock ms when the last input chunk was received.  Used to seed
   *  the next SilenceFiller if the stream reconnects. */
  getLastChunkTime(): number {
    return this.lastChunkTime;
  }
}
