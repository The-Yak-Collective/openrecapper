import { VoiceWorker, StopResult } from '../workers/voice-worker';
import { TranscriptionService } from './transcription-service';
import { StorageService } from './storage-service';
import { SummaryService } from './summary-service';
import { RelayClient } from './relay-client';
import { LiveTranscriptionService } from './live-transcription-service';
import { Config } from '../config';
import { TextChannel } from 'discord.js';
import path from 'path';
import fs from 'fs';

export interface RecordingSession {
  guildId: string;
  channelId: string;
  requesterId: string;
  textChannelId: string;
  callName: string;
  worker: VoiceWorker;
  liveTranscription: LiveTranscriptionService | null;
  startedAt: number;
  silenceCheckTimer: ReturnType<typeof setInterval> | null;
}

export interface StartRecordingOptions {
  guildId: string;
  channelId: string;
  requesterId: string;
  textChannelId: string;
  // Human-readable call name (e.g. "CADS 2026-06-08"). Defaults are applied by
  // callers (scheduler / commands); falls back to a generic label if absent.
  callName?: string;
}

export interface SessionInfo {
  guildId: string;
  channelId: string;
  startedAt: number;
  speakerCount: number;
}

export class WorkerManager {
  private static instance: WorkerManager;
  private sessions: Map<string, RecordingSession> = new Map();

  static getInstance(): WorkerManager {
    if (!WorkerManager.instance) {
      WorkerManager.instance = new WorkerManager();
    }
    return WorkerManager.instance;
  }

  async startRecording(options: StartRecordingOptions): Promise<void> {
    const sessionDir = path.join(
      Config.RECORDINGS_DIR,
      `${options.guildId}_${options.channelId}_${Date.now()}`
    );
    fs.mkdirSync(sessionDir, { recursive: true });

    // Set up live transcription — look for a #transcriptions channel, fall back to text channel
    let liveTranscription: LiveTranscriptionService | null = null;
    try {
      const { getClient } = require('../client');
      const client = getClient();
      const guild = client.guilds.cache.get(options.guildId);
      if (guild) {
        // Look for a channel named "transcriptions"
        const transcriptionChannel = guild.channels.cache.find(
          (ch: any) => ch.name === 'transcriptions' && ch.isTextBased()
        ) as TextChannel | undefined;

        const targetChannel = transcriptionChannel ||
          (await client.channels.fetch(options.textChannelId)) as TextChannel;

        if (targetChannel?.isTextBased()) {
          liveTranscription = new LiveTranscriptionService(targetChannel as TextChannel);
          console.log(`[WorkerManager] Live transcription will post to #${targetChannel.name}`);
        }
      }
    } catch (err) {
      console.error('[WorkerManager] Failed to set up live transcription:', err);
    }

    const worker = new VoiceWorker({
      guildId: options.guildId,
      channelId: options.channelId,
      outputDir: sessionDir,
      liveTranscription: liveTranscription || undefined,
    });

    await worker.start();

    const callName = options.callName || `Call ${new Date().toISOString().slice(0, 10)}`;
    const session: RecordingSession = {
      ...options,
      callName,
      worker,
      liveTranscription,
      startedAt: Date.now(),
      silenceCheckTimer: null,
    };
    this.sessions.set(options.channelId, session);

    // Start silence-timeout monitoring if configured
    this.startSilenceMonitor(session);

    console.log(`[WorkerManager] Started recording "${callName}" in channel ${options.channelId}`);
  }

  async stopRecording(channelId: string): Promise<{ fileCount: number; requesterId: string; sessionDir: string }> {
    const session = this.sessions.get(channelId);
    if (!session) {
      throw new Error('No active session for this channel');
    }

    // Clear silence-timeout timer
    if (session.silenceCheckTimer) {
      clearInterval(session.silenceCheckTimer);
      session.silenceCheckTimer = null;
    }

    // Close live transcription streams first to flush final results
    if (session.liveTranscription) {
      try {
        await session.liveTranscription.close();
        console.log('[WorkerManager] Live transcription closed');
      } catch (err) {
        console.error('[WorkerManager] Error closing live transcription:', err);
      }
    }

    const result = await session.worker.stop();
    this.sessions.delete(channelId);

    console.log(`[WorkerManager] Stopped recording in channel ${channelId}, ${result.files.length} files`);

    // Kick off transcription in background
    this.transcribeAndDeliver(result, session).catch((err) => {
      console.error('[WorkerManager] Transcription failed:', err);
    });

    return {
      fileCount: result.files.length,
      requesterId: session.requesterId,
      sessionDir: result.sessionDir,
    };
  }

  private async transcribeAndDeliver(
    stopResult: StopResult,
    session: RecordingSession
  ): Promise<void> {
    const { files, userMap, userStartTimes, sessionStartedAt } = stopResult;
    const { getClient } = require('../client');
    const client = getClient();

    // Resolve the text channel to post results
    let textChannel: any;
    try {
      textChannel = await client.channels.fetch(session.textChannelId);
    } catch (err) {
      console.error('[WorkerManager] Could not fetch text channel:', err);
    }

    if (files.length === 0) {
      console.log('[WorkerManager] No audio files to transcribe');
      if (textChannel?.isTextBased?.()) {
        await textChannel.send(`\u26a0\ufe0f Recording in <#${session.channelId}> ended with no audio captured.`);
      }
      return;
    }

    // Merge all per-user PCM files into one combined WAV via proper mixdown
    const sessionDir = stopResult.sessionDir;
    const combinedPcmPath = path.join(sessionDir, 'combined.pcm');
    const combinedWavPath = path.join(sessionDir, 'recording.wav');

    await this.mixdownPcmFiles(files, userStartTimes, sessionStartedAt, combinedPcmPath);

    // Convert combined PCM to WAV (streaming)
    await this.pcmToWavStream(combinedPcmPath, combinedWavPath);

    // Resolve user IDs to display names
    const speakerNames: Map<string, string> = new Map();
    try {
      const guild = client.guilds.cache.get(session.guildId);
      if (guild) {
        for (const [, userId] of userMap) {
          try {
            const member = await guild.members.fetch(userId);
            speakerNames.set(userId, member.displayName || member.user.username);
          } catch {
            speakerNames.set(userId, `User ${userId.slice(-4)}`);
          }
        }
      }
    } catch (err) {
      console.error('[WorkerManager] Error resolving speaker names:', err);
    }

    // Transcribe with Deepgram Nova-3 (diarization handles speaker separation)
    const transcriptionService = new TranscriptionService(Config.DEEPGRAM_API_KEY);
    const transcript = await transcriptionService.transcribeSession(combinedWavPath);

    // Build speaker roster header
    const rosterLines = Array.from(speakerNames.values()).map((name) => `  - ${name}`);
    const rosterHeader = rosterLines.length > 0
      ? `Participants:\n${rosterLines.join('\n')}\n\n---\n\n`
      : '';

    // Write output files
    const srtPath = path.join(sessionDir, 'transcript.srt');
    const txtPath = path.join(sessionDir, 'transcript.txt');
    const metadataPath = path.join(sessionDir, 'metadata.json');

    fs.writeFileSync(srtPath, transcript.srt);
    fs.writeFileSync(txtPath, rosterHeader + transcript.text);
    fs.writeFileSync(metadataPath, JSON.stringify({
      guildId: session.guildId,
      channelId: session.channelId,
      requesterId: session.requesterId,
      startedAt: new Date(session.startedAt).toISOString(),
      stoppedAt: new Date().toISOString(),
      speakers: Object.fromEntries(speakerNames),
      segmentCount: transcript.segments.length,
    }, null, 2));

    // Count unique speakers from segments
    const speakerCount = new Set(transcript.segments.map((s) => s.speaker)).size;

    console.log(`[WorkerManager] Transcripts saved to ${sessionDir}`);

    // Generate an AI summary (study-group reading-discussion template).
    // Optional: no-ops gracefully if SUMMARY_API_KEY is unset or on error.
    let summaryText: string | null = null;
    const summaryPath = path.join(sessionDir, 'summary.md');
    try {
      const participants = Array.from(speakerNames.values());
      summaryText = await SummaryService.summarize(rosterHeader + transcript.text, participants);
      if (summaryText) {
        const summaryDoc = `# ${session.callName} — Session Notes\n\n` +
          `${rosterHeader}${summaryText}\n`;
        summaryText = summaryDoc;
        fs.writeFileSync(summaryPath, summaryDoc);
        console.log(`[WorkerManager] Summary saved to ${summaryPath}`);
      }
    } catch (err) {
      console.error('[WorkerManager] Summary generation failed:', err);
    }

    // Upload to R2 cloud storage
    let r2Prefix = '';
    if (StorageService.isConfigured()) {
      try {
        const storage = new StorageService();
        const uploadResult = await storage.uploadSession(sessionDir);
        r2Prefix = uploadResult.prefix;
        console.log(`[WorkerManager] Uploaded to R2: ${r2Prefix}`);
      } catch (err) {
        console.error('[WorkerManager] R2 upload failed:', err);
      }
    } else {
      console.warn('[WorkerManager] R2 not configured, skipping cloud upload');
    }

    // Email the summary + transcript to the configured recipient via the relay.
    // The relay email path is plain-text only (no attachments), so we put the
    // summary in the body and link the uploaded summary.md + transcript files.
    if (Config.SUMMARY_EMAIL_TO && RelayClient.isConfigured()) {
      try {
        const durSec = Math.round((Date.now() - session.startedAt) / 1000);
        const durStr = `${Math.floor(durSec / 60)}m ${durSec % 60}s`;
        const participantList = Array.from(speakerNames.values()).join(', ') || '(names not detected)';
        const publicBase = Config.R2_PUBLIC_URL;
        let links = '';
        if (r2Prefix && publicBase) {
          links = `\n\nDownloads:\n` +
            (summaryText ? `  Summary (.md): ${publicBase}/${r2Prefix}/summary.md\n` : '') +
            `  Transcript (.txt): ${publicBase}/${r2Prefix}/transcript.txt\n` +
            `  Subtitles (.srt): ${publicBase}/${r2Prefix}/transcript.srt\n` +
            `  Audio (.wav): ${publicBase}/${r2Prefix}/recording.wav`;
        }
        const bodyParts = [
          `${session.callName}`,
          ``,
          `Duration: ${durStr}`,
          `Speakers: ${speakerCount}`,
          `Participants: ${participantList}`,
          links ? links.trimStart() : '',
          ``,
          `---`,
          ``,
          summaryText ? summaryText : '(No AI summary was generated for this session.)',
          ``,
          `---`,
          `Full transcript:`,
          ``,
          transcript.text,
        ];
        await RelayClient.email(
          Config.SUMMARY_EMAIL_TO,
          `[${Config.BOT_NAME}] ${session.callName} — notes & transcript`,
          bodyParts.join('\n')
        );
        console.log(`[WorkerManager] Emailed summary to ${Config.SUMMARY_EMAIL_TO}`);
      } catch (err) {
        console.error('[WorkerManager] Failed to email summary:', err);
      }
    }

    // Post to the text channel where /record was invoked
    if (textChannel?.isTextBased?.()) {
      const durationSec = Math.round((Date.now() - session.startedAt) / 1000);
      const mins = Math.floor(durationSec / 60);
      const secs = durationSec % 60;

      const attachments: any[] = [
        { attachment: Buffer.from(transcript.text), name: 'transcript.txt' },
        { attachment: Buffer.from(transcript.srt), name: 'transcript.srt' },
      ];

      // Attach the AI summary document if one was generated.
      if (summaryText) {
        attachments.unshift({ attachment: Buffer.from(summaryText), name: 'summary.md' });
      }

      // Attach the audio file if it's under 25MB (Discord limit)
      if (fs.existsSync(combinedWavPath)) {
        const wavSize = fs.statSync(combinedWavPath).size;
        if (wavSize < 25 * 1024 * 1024) {
          attachments.push({ attachment: combinedWavPath, name: 'recording.wav' });
        } else {
          console.log(`[WorkerManager] Audio file too large for Discord (${(wavSize / 1024 / 1024).toFixed(1)}MB), skipping attachment`);
        }
      }

      try {
        let r2Note = '';
        if (r2Prefix) {
          const publicBase = Config.R2_PUBLIC_URL;
          if (publicBase) {
            r2Note = `\n\n📁 **Recordings:**\n` +
              (summaryText ? `📝 Summary: ${publicBase}/${r2Prefix}/summary.md\n` : '') +
              `🔊 Audio: ${publicBase}/${r2Prefix}/recording.wav\n` +
              `📄 Transcript: ${publicBase}/${r2Prefix}/transcript.txt\n` +
              `🎬 Subtitles: ${publicBase}/${r2Prefix}/transcript.srt`;
          } else {
            r2Note = `\n**Archived:** \`${r2Prefix}\``;
          }
        }
        // Header message with metadata, R2 links, and file attachments.
        await textChannel.send({
          content: `\ud83d\udcdd **${session.callName}** — transcription complete for <#${session.channelId}>\n\n**Duration:** ${mins}m ${secs}s\n**Speakers:** ${speakerCount}\n**Requested by:** <@${session.requesterId}>${r2Note}`,
          files: attachments,
        });

        // Post the FULL summary inline, split across as many messages as needed
        // (Discord caps each message at 2000 chars). summary.md remains attached
        // above for download, but readers no longer have to open it.
        if (summaryText) {
          const chunks = WorkerManager.chunkText(summaryText);
          for (let i = 0; i < chunks.length; i++) {
            const suffix = chunks.length > 1 ? `\n\n*(${i + 1}/${chunks.length})*` : '';
            await textChannel.send({ content: chunks[i] + suffix });
          }
        }
      } catch (err) {
        console.error('[WorkerManager] Failed to post to text channel:', err);
      }
    } else {
      console.warn('[WorkerManager] Text channel not available, falling back to DM');
      try {
        const user = await client.users.fetch(session.requesterId);
        await user.send({
          content: `\ud83d\udcdd **Transcription complete** for <#${session.channelId}>`,
          files: [
            { attachment: Buffer.from(transcript.text), name: 'transcript.txt' },
            { attachment: Buffer.from(transcript.srt), name: 'transcript.srt' },
          ],
        });
      } catch (err) {
        console.error('[WorkerManager] Failed to DM requester:', err);
      }
    }
  }

  /**
   * Mix multiple per-user PCM files into a single combined PCM file.
   * Each user's audio is offset by their start time relative to session start,
   * so they align temporally. Mixing is done sample-by-sample with saturation clipping.
   * 
   * Audio format: 48kHz, 16-bit signed LE, stereo (4 bytes per sample frame).
   * Processing is done in chunks to keep memory usage bounded.
   */
  /**
   * Split text into chunks that each fit within Discord's message limit.
   * Prefers to break on paragraph (blank line) then line boundaries to keep
   * Markdown readable; hard-splits only as a last resort for very long lines.
   */
  private static chunkText(text: string, limit = 1900): string[] {
    const chunks: string[] = [];
    let current = '';

    const pushCurrent = () => {
      if (current.trim().length > 0) chunks.push(current.replace(/\n+$/, ''));
      current = '';
    };

    for (const para of text.split('\n\n')) {
      const block = para + '\n\n';
      if (block.length > limit) {
        // Paragraph itself too big: fall back to line-by-line.
        pushCurrent();
        for (const line of para.split('\n')) {
          let ln = line;
          while (ln.length > limit) {
            // Last resort: hard-split an over-long single line.
            pushCurrent();
            chunks.push(ln.slice(0, limit));
            ln = ln.slice(limit);
          }
          if (current.length + ln.length + 1 > limit) pushCurrent();
          current += ln + '\n';
        }
        current += '\n';
        continue;
      }
      if (current.length + block.length > limit) pushCurrent();
      current += block;
    }
    pushCurrent();
    return chunks.length ? chunks : [''];
  }

  private async mixdownPcmFiles(
    files: string[],
    userStartTimes: Map<string, number>,
    sessionStartedAt: number,
    outputPath: string
  ): Promise<void> {
    const SAMPLE_RATE = 48000;
    const CHANNELS = 2;
    const BYTES_PER_SAMPLE = 2; // 16-bit
    const FRAME_SIZE = CHANNELS * BYTES_PER_SAMPLE; // 4 bytes per sample frame
    const BYTES_PER_MS = SAMPLE_RATE * FRAME_SIZE / 1000; // bytes per millisecond

    // Filter to valid, non-empty PCM files
    const validFiles = files.filter(f => fs.existsSync(f) && fs.statSync(f).size > 0);
    if (validFiles.length === 0) {
      // Write empty file
      fs.writeFileSync(outputPath, Buffer.alloc(0));
      return;
    }

    // Calculate each file's offset in bytes from session start
    interface TrackInfo {
      filePath: string;
      offsetBytes: number; // how many zero bytes to prepend
      fileSize: number;    // actual PCM data size
      totalBytes: number;  // offsetBytes + fileSize
    }

    const tracks: TrackInfo[] = validFiles.map(filePath => {
      const startTime = userStartTimes.get(filePath) ?? sessionStartedAt;
      const offsetMs = Math.max(0, startTime - sessionStartedAt);
      // Align offset to frame boundary (multiple of FRAME_SIZE)
      const rawOffsetBytes = Math.round(offsetMs * BYTES_PER_MS);
      const offsetBytes = Math.floor(rawOffsetBytes / FRAME_SIZE) * FRAME_SIZE;
      const fileSize = fs.statSync(filePath).size;
      // Truncate fileSize to frame boundary
      const alignedFileSize = Math.floor(fileSize / FRAME_SIZE) * FRAME_SIZE;
      return {
        filePath,
        offsetBytes,
        fileSize: alignedFileSize,
        totalBytes: offsetBytes + alignedFileSize,
      };
    });

    // Total output length = max of (offset + file size) across all tracks
    const totalOutputBytes = Math.max(...tracks.map(t => t.totalBytes));
    if (totalOutputBytes === 0) {
      fs.writeFileSync(outputPath, Buffer.alloc(0));
      return;
    }

    console.log(`[WorkerManager] Mixing ${tracks.length} tracks, output length: ${(totalOutputBytes / BYTES_PER_MS / 1000).toFixed(1)}s`);
    for (const t of tracks) {
      console.log(`[WorkerManager]   Track ${path.basename(t.filePath)}: offset=${(t.offsetBytes / BYTES_PER_MS / 1000).toFixed(1)}s, duration=${(t.fileSize / BYTES_PER_MS / 1000).toFixed(1)}s`);
    }

    // Process in chunks to keep memory bounded
    // 1 second of audio = 48000 * 4 = 192000 bytes. Use 5-second chunks.
    const CHUNK_BYTES = SAMPLE_RATE * FRAME_SIZE * 5; // 5 seconds = 960000 bytes

    const writeStream = fs.createWriteStream(outputPath);

    // Open file descriptors for all tracks
    const fds = tracks.map(t => fs.openSync(t.filePath, 'r'));

    try {
      let outputPosition = 0;

      while (outputPosition < totalOutputBytes) {
        const chunkSize = Math.min(CHUNK_BYTES, totalOutputBytes - outputPosition);
        const chunkEnd = outputPosition + chunkSize;

        // Start with silence
        const mixBuffer = Buffer.alloc(chunkSize, 0);

        for (let trackIdx = 0; trackIdx < tracks.length; trackIdx++) {
          const track = tracks[trackIdx];
          const fd = fds[trackIdx];

          // This track's audio occupies [track.offsetBytes, track.offsetBytes + track.fileSize) in output space
          const trackDataStart = track.offsetBytes;
          const trackDataEnd = track.offsetBytes + track.fileSize;

          // Find overlap between this chunk and this track's data region
          const overlapStart = Math.max(outputPosition, trackDataStart);
          const overlapEnd = Math.min(chunkEnd, trackDataEnd);

          if (overlapStart >= overlapEnd) continue; // No overlap

          const overlapLength = overlapEnd - overlapStart;

          // Read from the file at the corresponding offset
          const fileReadOffset = overlapStart - trackDataStart;
          const trackBuf = Buffer.alloc(overlapLength);
          const bytesRead = fs.readSync(fd, trackBuf, 0, overlapLength, fileReadOffset);

          if (bytesRead === 0) continue;

          // Mix into the output buffer
          const mixOffset = overlapStart - outputPosition;
          const samplesToMix = Math.floor(bytesRead / BYTES_PER_SAMPLE);

          for (let i = 0; i < samplesToMix; i++) {
            const bytePos = i * BYTES_PER_SAMPLE;
            const mixBytePos = mixOffset + bytePos;

            // Read current mix value and track value as int16 LE
            const mixVal = mixBuffer.readInt16LE(mixBytePos);
            const trackVal = trackBuf.readInt16LE(bytePos);

            // Add with saturation clipping
            const sum = mixVal + trackVal;
            const clipped = Math.max(-32768, Math.min(32767, sum));
            mixBuffer.writeInt16LE(clipped, mixBytePos);
          }
        }

        // Write chunk, applying backpressure
        const canContinue = writeStream.write(mixBuffer);
        if (!canContinue) {
          await new Promise<void>(resolve => writeStream.once('drain', resolve));
        }

        outputPosition += chunkSize;
      }
    } finally {
      // Close all file descriptors
      for (const fd of fds) {
        fs.closeSync(fd);
      }
    }

    // Finish writing
    writeStream.end();
    await new Promise<void>((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });

    console.log(`[WorkerManager] Mixdown complete: ${outputPath} (${(fs.statSync(outputPath).size / 1024 / 1024).toFixed(1)}MB)`);
  }

  private async pcmToWavStream(pcmPath: string, wavPath: string): Promise<void> {
    const sampleRate = 48000;
    const channels = 2;
    const bitsPerSample = 16;
    const byteRate = sampleRate * channels * (bitsPerSample / 8);
    const blockAlign = channels * (bitsPerSample / 8);
    const dataSize = fs.statSync(pcmPath).size;

    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    const writeStream = fs.createWriteStream(wavPath);
    writeStream.write(header);

    await new Promise<void>((resolve, reject) => {
      const readStream = fs.createReadStream(pcmPath);
      readStream.pipe(writeStream);
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
      readStream.on('error', reject);
    });
  }

  isRecording(channelId: string): boolean {
    return this.sessions.has(channelId);
  }

  getActiveSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => ({
      guildId: s.guildId,
      channelId: s.channelId,
      startedAt: s.startedAt,
      speakerCount: s.worker.getSpeakerCount(),
    }));
  }

  /**
   * Start a periodic check for silence timeout on a recording session.
   * If no opus packets have been received for SILENCE_TIMEOUT_MINUTES,
   * the bot auto-stops the recording, leaves the voice channel, and
   * cleans up the empty session directory.
   */
  private startSilenceMonitor(session: RecordingSession): void {
    const timeoutMinutes = Config.SILENCE_TIMEOUT_MINUTES;
    if (timeoutMinutes <= 0) {
      console.log(`[SilenceMonitor] Disabled (SILENCE_TIMEOUT_MINUTES=0)`);
      return;
    }

    const timeoutMs = timeoutMinutes * 60 * 1000;
    // Check every 60 seconds
    const CHECK_INTERVAL_MS = 60_000;

    console.log(`[SilenceMonitor] Monitoring channel ${session.channelId} — timeout: ${timeoutMinutes} min`);

    session.silenceCheckTimer = setInterval(async () => {
      const lastActivity = session.worker.getLastVoiceActivityAt();
      const now = Date.now();

      // If no audio has ever been received, measure from session start
      const referenceTime = lastActivity > 0 ? lastActivity : session.startedAt;
      const silentMs = now - referenceTime;

      if (silentMs >= timeoutMs) {
        console.log(
          `[SilenceMonitor] No voice activity for ${Math.round(silentMs / 60000)} min ` +
          `in channel ${session.channelId} — auto-stopping`
        );
        await this.silenceAutoStop(session);
      }
    }, CHECK_INTERVAL_MS);
  }

  /**
   * Auto-stop a recording session due to silence timeout.
   * Leaves the voice channel, posts a message, and cleans up the empty
   * session directory. Does NOT kick off transcription (there's nothing
   * to transcribe).
   */
  private async silenceAutoStop(session: RecordingSession): Promise<void> {
    const channelId = session.channelId;

    // Prevent double-stop if this fires while a manual stop is in progress
    if (!this.sessions.has(channelId)) return;

    // Clear the timer first to prevent re-entry
    if (session.silenceCheckTimer) {
      clearInterval(session.silenceCheckTimer);
      session.silenceCheckTimer = null;
    }

    // Close live transcription streams
    if (session.liveTranscription) {
      try {
        await session.liveTranscription.close();
      } catch (err) {
        console.error('[SilenceMonitor] Error closing live transcription:', err);
      }
    }

    // Capture audio state BEFORE stop() (which may clear internal state)
    const hadAudio = session.worker.hasReceivedAudio();

    // Stop the worker (disconnects from voice)
    const result = await session.worker.stop();
    this.sessions.delete(channelId);
    const sessionDir = result.sessionDir;

    console.log(
      `[SilenceMonitor] Stopped recording in channel ${channelId} ` +
      `(hadAudio=${hadAudio}, files=${result.files.length})`
    );

    // Clean up the empty recording directory if no audio was ever captured
    if (!hadAudio && fs.existsSync(sessionDir)) {
      try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        console.log(`[SilenceMonitor] Cleaned up empty session dir: ${sessionDir}`);
      } catch (err) {
        console.error(`[SilenceMonitor] Failed to clean up session dir:`, err);
      }
    }

    // Post a brief message to the text channel
    try {
      const { getClient } = require('../client');
      const client = getClient();
      const textChannel = await client.channels.fetch(session.textChannelId);
      if (textChannel?.isTextBased?.()) {
        const timeoutMinutes = Config.SILENCE_TIMEOUT_MINUTES;
        await (textChannel as TextChannel).send(
          `🔇 Recording ended — no voice activity detected for ${timeoutMinutes} minutes. ` +
          `Leaving <#${channelId}>.`
        );
      }
    } catch (err) {
      console.error('[SilenceMonitor] Failed to post timeout message:', err);
    }
  }
}
