import fs from 'fs';
import path from 'path';

interface Segment {
  speaker: string;
  start: number;
  end: number;
  text: string;
}

interface TranscriptResult {
  srt: string;
  text: string;
  segments: Segment[];
}

export class TranscriptionService {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Transcribe using Deepgram Nova-3 REST API with diarization.
   * Sends the combined WAV and lets Deepgram handle speaker separation.
   */
  async transcribeSession(wavPath: string): Promise<TranscriptResult> {
    const stats = fs.statSync(wavPath);
    if (stats.size < 1000) {
      console.log('[Transcription] Audio file too small, skipping');
      return { srt: '', text: 'No audio captured.', segments: [] };
    }

    const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
    console.log(`[Transcription] Sending ${path.basename(wavPath)} to Deepgram Nova-3 (${sizeMB}MB)`);

    const params = new URLSearchParams({
      model: 'nova-3',
      smart_format: 'true',
      diarize: 'true',
      utterances: 'true',
      punctuate: 'true',
      paragraphs: 'true',
    });

    // Stream the file to avoid loading it all into memory
    const fileStream = fs.createReadStream(wavPath);

    const response = await fetch(
      `https://api.deepgram.com/v1/listen?${params.toString()}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Token ${this.apiKey}`,
          'Content-Type': 'audio/wav',
          'Content-Length': stats.size.toString(),
        },
        body: fileStream as any,
        // @ts-ignore - duplex needed for streaming body in Node
        duplex: 'half',
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Deepgram API error ${response.status}: ${errText}`);
    }

    const result: any = await response.json();
    const segments: Segment[] = [];

    // Use utterances for speaker-labeled segments
    if (result?.results?.utterances) {
      for (const utt of result.results.utterances) {
        const speakerNum = utt.speaker ?? 0;
        segments.push({
          speaker: `Speaker ${speakerNum}`,
          start: utt.start,
          end: utt.end,
          text: utt.transcript.trim(),
        });
      }
    } else if (result?.results?.channels?.[0]?.alternatives?.[0]) {
      // Fallback: no utterances, use full transcript
      const alt = result.results.channels[0].alternatives[0];
      segments.push({
        speaker: 'Speaker 0',
        start: 0,
        end: result.metadata?.duration || 0,
        text: alt.transcript.trim(),
      });
    }

    console.log(`[Transcription] Got ${segments.length} segments from Deepgram`);

    // Sort segments chronologically — defensive against out-of-order returns
    segments.sort((a, b) => a.start - b.start);

    return {
      srt: this.toSRT(segments),
      text: this.toPlainText(segments),
      segments,
    };
  }

  private toSRT(segments: Segment[]): string {
    return segments
      .map((seg, i) => {
        const startTs = this.formatSRTTime(seg.start);
        const endTs = this.formatSRTTime(seg.end);
        return `${i + 1}\n${startTs} --> ${endTs}\n[${seg.speaker}]: ${seg.text}\n`;
      })
      .join('\n');
  }

  private toPlainText(segments: Segment[]): string {
    let text = '';
    let lastSpeaker = '';

    for (const seg of segments) {
      if (seg.speaker !== lastSpeaker) {
        if (text) text += '\n';
        text += `\n[${seg.speaker}]:\n`;
        lastSpeaker = seg.speaker;
      }
      text += `${seg.text} `;
    }

    return text.trim();
  }

  private formatSRTTime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.round((seconds % 1) * 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  }
}
