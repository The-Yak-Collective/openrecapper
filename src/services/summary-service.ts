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
      `Capture the substance of the discussion (ideas, arguments, disagreements), not just logistics. Attribute notable points to speakers when the transcript makes the attribution clear; otherwise keep it general.`,
      `IMPORTANT — names: the user message provides an authoritative "Participants" roster of attendee names. The transcript is auto-generated speech-to-text, so it often misspells names phonetically (e.g. a surname "Acks" may appear as "Aks"). Always spell every participant's name exactly as it appears in the roster, and silently correct any transcript spelling that clearly refers to a roster participant. Only use a name not in the roster if it plainly refers to a third party (e.g. a cited author) and not to an attendee.`,
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
      `Bulleted list of the main ideas, arguments, and themes discussed. Attribute to a speaker when clear (e.g. "**Ben:** ..."). Group related points.`,
      ``,
      `## 🔀 Questions & Disagreements`,
      `Open questions raised, points of confusion, and any disagreements or competing interpretations among participants.`,
      ``,
      `## 🔗 References Mentioned`,
      `Any other books, papers, people, tools, or concepts referenced during the discussion. Bullet list. "None noted." if there were none.`,
      ``,
      `## ✅ Action Items & Next Time`,
      `Concrete follow-ups, who agreed to do what (if stated), and what the group plans to read or discuss next. "None noted." if none.`,
      ``,
      `## ⭐ Memorable Quotes`,
      `0–3 short, verbatim quotes that capture an interesting moment, with the speaker if known. Skip if nothing stands out.`,
      ``,
      `---`,
      `Participants (AUTHORITATIVE name spellings — use these exact spellings for attendees): ${roster}`,
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
