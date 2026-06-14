import { Transform, TransformCallback } from 'stream';
import prism from 'prism-media';

/**
 * Wraps prism-media's Opus decoder as a simple Transform stream.
 * Input: Opus packets from Discord VoiceReceiver
 * Output: signed 16-bit LE PCM at 48kHz stereo
 */
export class OpusDecodingStream extends Transform {
  private decoder: any;

  constructor() {
    super();
    this.decoder = new prism.opus.Decoder({
      rate: 48000,
      channels: 2,
      frameSize: 960,
    });

    this.decoder.on('data', (chunk: Buffer) => {
      this.push(chunk);
    });

    this.decoder.on('error', (err: Error) => {
      console.error('[OpusDecoder] Error:', err.message);
    });
  }

  _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      this.decoder.write(chunk);
    } catch (err) {
      // Silently skip malformed packets
    }
    callback();
  }

  _flush(callback: TransformCallback): void {
    this.decoder.end();
    callback();
  }
}
