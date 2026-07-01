import { Transform, TransformCallback } from 'stream';
import prism from 'prism-media';

/**
 * Wraps prism-media's Opus decoder as a simple Transform stream.
 * Input: Opus packets from Discord VoiceReceiver
 * Output: signed 16-bit LE PCM at 48kHz stereo
 *
 * Resilience: prism's Opus decoder destroys itself when libopus rejects a
 * packet (e.g. "The compressed data passed is corrupted"). That happens when
 * we subscribe to a user who is ALREADY speaking when the bot joins — Discord
 * delivers a partial/mid-stream first frame that libopus cannot decode. Once
 * the inner decoder is destroyed, every subsequent packet is silently dropped,
 * so the user's entire session (recording AND live transcription) is lost.
 *
 * To prevent that, we isolate the inner prism decoder, swallow its fatal error,
 * and transparently recreate it so only the single bad packet is dropped and
 * the rest of the user's audio keeps decoding.
 */
export class OpusDecodingStream extends Transform {
  private decoder: any;

  constructor() {
    super();
    this.createDecoder();
  }

  private createDecoder(): void {
    const decoder = new prism.opus.Decoder({
      rate: 48000,
      channels: 2,
      frameSize: 960,
    });

    decoder.on('data', (chunk: Buffer) => {
      this.push(chunk);
    });

    decoder.on('error', (err: Error) => {
      // prism calls done(err) on a bad packet, which destroys this decoder.
      // Log and rebuild so the next packet decodes normally. Guard against
      // re-entrancy: only rebuild if this is still the active decoder.
      if (this.decoder === decoder) {
        console.warn(`[OpusDecoder] Recovered from decode error (recreating decoder): ${err.message}`);
        try {
          decoder.removeAllListeners();
          decoder.destroy();
        } catch {}
        this.createDecoder();
      }
    });

    this.decoder = decoder;
  }

  _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      // If the decoder was destroyed (e.g. by a prior error mid-event), rebuild.
      if (!this.decoder || this.decoder.destroyed) {
        this.createDecoder();
      }
      this.decoder.write(chunk);
    } catch (err) {
      // Silently skip malformed packets the write itself rejects.
    }
    callback();
  }

  _flush(callback: TransformCallback): void {
    try {
      if (this.decoder && !this.decoder.destroyed) {
        this.decoder.end();
      }
    } catch {}
    callback();
  }
}
