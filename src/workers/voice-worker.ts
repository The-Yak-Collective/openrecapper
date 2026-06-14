import {
  joinVoiceChannel,
  VoiceConnection,
  VoiceConnectionStatus,
  entersState,
  EndBehaviorType,
} from '@discordjs/voice';
import * as dgVoice from '@discordjs/voice';
import { createWriteStream, WriteStream } from 'fs';
import path from 'path';
import { Transform } from 'stream';
import { OpusDecodingStream } from '../services/opus-decoder';
import { SilenceFiller } from '../services/silence-filler';
import { LiveTranscriptionService } from '../services/live-transcription-service';

export interface VoiceWorkerOptions {
  guildId: string;
  channelId: string;
  outputDir: string;
  liveTranscription?: LiveTranscriptionService;
}

export interface StopResult {
  files: string[];
  userMap: Map<string, string>; // filePath -> userId
  userStartTimes: Map<string, number>; // filePath -> timestamp (ms) when user's audio first started
  sessionStartedAt: number; // timestamp (ms) when the VoiceWorker started
  sessionDir: string;
}

interface UserStream {
  filePath: string;
  writeStream: WriteStream;
  userId: string;
  startedAt: number; // Date.now() when this user's stream first started writing
}

export class VoiceWorker {
  private options: VoiceWorkerOptions;
  private connection: VoiceConnection | null = null;
  private userStreams: Map<string, UserStream> = new Map();
  private speaking: Set<string> = new Set();
  private sessionStartedAt: number = 0;
  // Track the first time each user started speaking (persists across stream reconnections)
  // Key: userId, Value: { filePath, startedAt }
  private userFirstStart: Map<string, { filePath: string; startedAt: number }> = new Map();
  // Track wall-clock ms when the last PCM chunk was written for each user.
  // Persists across opus-stream reconnections so a new SilenceFiller can fill
  // the gap between the old stream's end and the new stream's start.
  private userLastChunkTime: Map<string, number> = new Map();

  constructor(options: VoiceWorkerOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    this.sessionStartedAt = Date.now();
    const { getClient } = require('../client');
    const client = getClient();

    const guild = client.guilds.cache.get(this.options.guildId);
    if (!guild) throw new Error(`Guild ${this.options.guildId} not found`);

    this.connection = joinVoiceChannel({
      channelId: this.options.channelId,
      guildId: this.options.guildId,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
      // daveEncryption defaults to true - required by Discord (4017 if disabled)
    });

    // Log connection state changes (only significant ones)
    this.connection.on('stateChange', (oldState, newState) => {
      if (oldState.status !== newState.status) {
        console.log(`[VoiceWorker] Connection: ${oldState.status} -> ${newState.status}`);
      }
      // Capture networking errors
      if ('networking' in newState) {
        const networking = (newState as any).networking;
        if (networking) {
          networking.on?.('close', (code: any) => {
            console.log(`[VoiceWorker] Networking WS close code: ${code}`);
          });
          networking.on?.('error', (err: any) => {
            console.error(`[VoiceWorker] Networking error:`, err);
          });
        }
      }
    });

    this.connection.on('error', (error) => {
      console.error(`[VoiceWorker] Connection error:`, error);
    });

    // Wait for connection to be ready
    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 30_000);
    } catch (err) {
      console.error(`[VoiceWorker] Failed to reach Ready state. Current status: ${this.connection.state.status}`);
      // Log full state for debugging
      console.error(`[VoiceWorker] Full state:`, JSON.stringify(this.connection.state, (key, val) => {
        if (key === 'ws' || key === 'networking') return '[object]';
        return val;
      }, 2));
      this.connection.destroy();
      throw err;
    }
    console.log(`[VoiceWorker] Connected to channel ${this.options.channelId}`);

    // Listen for audio
    const receiver = this.connection.receiver;

    console.log(`[VoiceWorker] Receiver ready, listening for speaking events...`);

    receiver.speaking.on('start', (userId: string) => {
      if (this.userStreams.has(userId)) return; // Already recording this user
      this.startUserStream(userId, receiver);
    });
  }

  private startUserStream(userId: string, receiver: any): void {
    const filePath = path.join(this.options.outputDir, `${userId}.pcm`);
    // Append mode: if the opus stream auto-closes on silence and restarts,
    // we don't lose earlier audio
    const writeStream = createWriteStream(filePath, { flags: 'a' });

    // Use Manual end behavior — we control when the stream ends (at stop time)
    // This keeps a single long-lived subscription for the entire recording session
    const opusStream = receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.Manual,
      },
    });

    const decoder = new OpusDecodingStream();

    // SilenceFiller inserts zero-filled PCM to preserve real-time gaps.
    // Discord only delivers opus packets during active speech; without this,
    // the PCM file would concatenate speech segments with no silence between
    // them, destroying temporal alignment in the mixdown.
    //
    // If this user had a previous opus stream that auto-closed (silence timeout),
    // seed the SilenceFiller with the last chunk timestamp so the gap between
    // streams is properly filled with silence in the PCM file.
    const prevLastChunk = this.userLastChunkTime.get(userId) ?? 0;
    const silenceFiller = new SilenceFiller(prevLastChunk);

    // If live transcription is enabled, tee the decoded PCM to both file and Deepgram.
    // NOTE: Live transcription gets the raw decoded stream (without silence filling)
    // because Deepgram expects continuous speech, not padded silence.
    const live = this.options.liveTranscription;
    if (live) {
      let sendPcm: ((chunk: Buffer) => void) | null = null;
      const earlyBuffer: Buffer[] = [];

      // Tee raw decoder output to live transcription (no silence filling)
      decoder.on('data', (chunk: Buffer) => {
        if (sendPcm) {
          sendPcm(chunk);
        } else {
          earlyBuffer.push(chunk);
        }
      });

      // Open Deepgram stream async, flush buffered audio when ready
      live.openStreamForUser(userId).then((send) => {
        sendPcm = send;
        for (const buf of earlyBuffer) {
          sendPcm(buf);
        }
        earlyBuffer.length = 0;
      }).catch((err) => {
        console.error(`[VoiceWorker] Failed to open live stream for ${userId}:`, err);
      });

      // Silence-filled stream goes to the file for correct mixdown
      silenceFiller.pipe(writeStream, { end: false });
      decoder.pipe(silenceFiller);
    } else {
      decoder.pipe(silenceFiller).pipe(writeStream, { end: false });
    }

    opusStream.pipe(decoder);

    // If the opus stream auto-closes (e.g. ~30s silence despite Manual mode),
    // clean up so the next speaking event can re-subscribe.
    // Persist the SilenceFiller's last-chunk time so the next stream can fill
    // the gap between this stream's end and the next stream's start.
    opusStream.on('end', () => {
      const lastTime = silenceFiller.getLastChunkTime();
      if (lastTime > 0) {
        this.userLastChunkTime.set(userId, lastTime);
      }
      console.log(`[VoiceWorker] Opus stream ended for user ${userId} (will re-subscribe on next speech)`);
      this.userStreams.delete(userId);
      // Close the Deepgram WS for this user so it doesn't timeout
      if (this.options.liveTranscription) {
        this.options.liveTranscription.closeStreamForUser(userId);
      }
    });

    const now = Date.now();
    this.userStreams.set(userId, { filePath, writeStream, userId, startedAt: now });

    // Track the first time this user ever started speaking in the session
    // (subsequent reconnections after silence don't update this)
    if (!this.userFirstStart.has(userId)) {
      this.userFirstStart.set(userId, { filePath, startedAt: now });
      console.log(`[VoiceWorker] Started recording user ${userId} at offset ${now - this.sessionStartedAt}ms`);
    } else {
      console.log(`[VoiceWorker] Resumed recording user ${userId} (stream reconnected after silence)`);
    }
  }

  async stop(): Promise<StopResult> {
    // Destroy voice connection
    if (this.connection) {
      this.connection.destroy();
      this.connection = null;
    }

    // Close all currently-open write streams
    for (const [, userStream] of this.userStreams) {
      userStream.writeStream.end();
    }

    // Build results from userFirstStart (which tracks ALL users who ever spoke,
    // even if their stream auto-closed due to silence)
    const files: string[] = [];
    const userMap = new Map<string, string>();
    const userStartTimes = new Map<string, number>();

    for (const [userId, info] of this.userFirstStart) {
      files.push(info.filePath);
      userMap.set(info.filePath, userId);
      userStartTimes.set(info.filePath, info.startedAt);
    }

    this.userStreams.clear();
    this.userFirstStart.clear();
    this.userLastChunkTime.clear();
    this.speaking.clear();

    return {
      files,
      userMap,
      userStartTimes,
      sessionStartedAt: this.sessionStartedAt,
      sessionDir: this.options.outputDir,
    };
  }

  getSpeakerCount(): number {
    return this.userStreams.size;
  }
}
