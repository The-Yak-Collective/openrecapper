import { Config } from '../config';
import { RelayClient } from './relay-client';

/**
 * AI session summary tailored for a recurring study group that meets to read
 * and discuss a particular reading (book chapter, paper, essay, etc.).
 *
 * Summaries are generated via the optional relay service (see RelayClient).
 * Skips gracefully when the relay is not configured so the rest of the
 * pipeline is unaffected.
 */
export class SummaryService {
  static isConfigured(): boolean {
    return RelayClient.isConfigured();
  }

  /** System prompt: defines the summarizer's role and output contract. */
  private static systemPrompt(): string {
    return [
      `You are a meticulous note-taker for a recurring ${Config.SUMMARY_GROUP_NAME} that meets to read and discuss a shared reading (e.g. a book chapter, paper, or essay).`,
      `You are given a speaker-diarized transcript of one session. Speakers may be labeled by name or as "Speaker N".`,
      ``,
      `Write notes that would help both attendees and people who missed the session. Be faithful to what was actually said — never invent points, citations, or conclusions. If something is unclear or the audio was garbled, say so rather than guessing.`,
      `Capture the substance of the discussion (ideas, arguments, disagreements), not just logistics.`,
      `IMPORTANT — do NOT attribute points, ideas, arguments, or quotes to any speaker. The diarization is unreliable, so attribution causes errors. Write everything in an attribution-free, impersonal style (e.g. "The group discussed...", "One view was that...", "It was argued that..."). Never use participant names or "Speaker N" labels to assign who said what. The only exception is third parties who are referenced/cited in the discussion (e.g. a book's author) — those may be named.`,
      `Keep it concise and skimmable. Use the exact Markdown section structure requested by the user. Omit a section (with a short "None noted." line) if the transcript genuinely contains nothing for it.`,
    ].join('\n');
  }

  /** User prompt: the study-group reading-discussion template + transcript. */
  private static userPrompt(transcriptText: string, participants: string[]): string {
    const roster = participants.length ? participants.join(', ') : '(names not detected)';
    return [
      `Produce session notes using EXACTLY the following Markdown structure and headings:`,
      ``,
      `## 📖 The Reading`,
      `Name the specific reading under discussion (title/author/chapter) if it can be identified from the conversation. If it cannot be determined, write "Not clearly identified in the discussion."`,
      ``,
      `## 🧭 Overview`,
      `2–4 sentences summarizing what this session covered and the overall arc of the conversation.`,
      ``,
      `## 💡 Key Points & Themes`,
      `Bulleted list of the main ideas, arguments, and themes discussed. Group related points. Do NOT attribute any point to a speaker — keep it impersonal.`,
      ``,
      `## 🔀 Questions & Disagreements`,
      `Open questions raised, points of confusion, and any disagreements or competing interpretations among participants.`,
      ``,
      `## 🔗 References Mentioned`,
      `Any other books, papers, people, tools, or concepts referenced during the discussion. Bullet list. "None noted." if there were none.`,
      ``,
      `## ✅ Action Items & Next Time`,
      `Concrete follow-ups the group agreed on and what the group plans to read or discuss next. Do NOT attribute follow-ups to specific people — keep it impersonal. "None noted." if none.`,
      ``,
      `## ⭐ Memorable Quotes`,
      `0–3 short, verbatim quotes that capture an interesting moment. Do NOT attribute the quotes to any speaker — list the quote text only. Skip if nothing stands out.`,
      ``,
      `---`,
      `Participants (for context only — do NOT attribute any points or quotes to them): ${roster}`,
      ``,
      `Transcript:`,
      `"""`,
      transcriptText,
      `"""`,
    ].join('\n');
  }

  /**
   * Generate a Markdown summary from the transcript text. Returns null if not
   * configured or on error (caller should treat summary as optional).
   */
  static async summarize(transcriptText: string, participants: string[]): Promise<string | null> {
    if (!this.isConfigured()) {
      console.warn('[Summary] Relay not configured (RELAY_TOKEN unset), skipping AI summary');
      return null;
    }
    const trimmed = (transcriptText || '').trim();
    if (trimmed.length < 200) {
      console.log('[Summary] Transcript too short to summarize, skipping');
      return null;
    }

    // Guard against very long transcripts blowing the context window. Keep the
    // start of the session but retain the tail (often action items / next read).
    const MAX_CHARS = 240_000;
    let body = trimmed;
    if (body.length > MAX_CHARS) {
      const head = body.slice(0, Math.floor(MAX_CHARS * 0.7));
      const tail = body.slice(-Math.floor(MAX_CHARS * 0.3));
      body = `${head}\n\n[... transcript truncated for length ...]\n\n${tail}`;
      console.log(`[Summary] Transcript truncated from ${trimmed.length} to ${body.length} chars`);
    }

    try {
      const text = await RelayClient.summarize(this.systemPrompt(), this.userPrompt(body, participants));
      if (!text) {
        console.error('[Summary] Relay returned no content');
        return null;
      }
      console.log(`[Summary] Generated summary (${text.length} chars) via relay`);
      return text;
    } catch (err: any) {
      console.error(`[Summary] Failed to generate summary: ${err?.message || err}`);
      return null;
    }
  }
}
