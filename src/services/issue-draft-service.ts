import { RelayClient } from './relay-client';

export type IssueType = 'bug' | 'feature' | 'task';

export interface IssueDraft {
  title: string;
  body: string;
  type: IssueType;
  /** True when produced by the mechanical fallback (LLM unavailable/unparseable). */
  fallback: boolean;
}

const ALLOWED_TYPES: IssueType[] = ['bug', 'feature', 'task'];
const MAX_INPUT_CHARS = 4000;
const MAX_TITLE_CHARS = 80;
const MAX_BODY_CHARS = 8000;

/**
 * Turns a user's free-text report into a structured GitHub issue draft
 * (title + Markdown body + type) using the relay LLM, the same way
 * SummaryService does. Always returns a usable draft: if the relay is
 * unconfigured or the model output can't be parsed, it degrades to a mechanical
 * draft built from the raw text so the command still works whenever GitHub is
 * configured.
 */
export class IssueDraftService {
  static isConfigured(): boolean {
    return RelayClient.isConfigured();
  }

  private static systemPrompt(): string {
    return [
      `You convert a user's plain-text report into ONE GitHub issue.`,
      `Output ONLY minified JSON (no code fences, no prose) with exactly these keys:`,
      `  "title": string — concise, imperative, <= ${MAX_TITLE_CHARS} chars, no trailing period.`,
      `  "body": string — GitHub-flavored Markdown describing the issue.`,
      `  "type": one of "bug", "feature", "task".`,
      `For bugs, structure the body with "**Steps to Reproduce**", "**Expected**", and "**Actual**" sections when they can be derived from the input.`,
      `For features/tasks, briefly state the motivation and the desired outcome.`,
      `Never invent details, versions, or reproduction steps that aren't implied by the input; if key information is missing, note it under a "**Needs clarification**" line rather than guessing.`,
      `Do not include @mentions or issue/PR references that would notify people.`,
    ].join('\n');
  }

  private static userPrompt(rawText: string): string {
    return [
      `Convert the following report into the JSON issue described above.`,
      ``,
      `Report:`,
      `"""`,
      rawText,
      `"""`,
    ].join('\n');
  }

  static async draft(rawText: string): Promise<IssueDraft> {
    const cleaned = (rawText || '').trim().slice(0, MAX_INPUT_CHARS);

    if (this.isConfigured() && cleaned.length > 0) {
      try {
        const raw = await RelayClient.summarize(this.systemPrompt(), this.userPrompt(cleaned));
        const parsed = this.parse(raw);
        if (parsed) return parsed;
        console.warn('[IssueDraft] LLM output could not be parsed; using mechanical fallback');
      } catch (err: any) {
        console.error(`[IssueDraft] LLM draft failed, using fallback: ${err?.message || err}`);
      }
    }

    return this.mechanicalFallback(cleaned);
  }

  /** Parse + validate the model's JSON output. Returns null if unusable. */
  private static parse(raw: string): IssueDraft | null {
    if (!raw) return null;
    // Models sometimes wrap JSON in ```json fences or add stray text; extract the
    // first {...} block.
    const stripped = raw.replace(/```(?:json)?/gi, '').trim();
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;

    let obj: any;
    try {
      obj = JSON.parse(stripped.slice(start, end + 1));
    } catch {
      return null;
    }

    const title = typeof obj?.title === 'string' ? obj.title.trim() : '';
    const body = typeof obj?.body === 'string' ? obj.body.trim() : '';
    if (!title || !body) return null;

    const type: IssueType = ALLOWED_TYPES.includes(obj?.type) ? obj.type : 'task';
    return {
      title: title.slice(0, MAX_TITLE_CHARS),
      body: body.slice(0, MAX_BODY_CHARS),
      type,
      fallback: false,
    };
  }

  /** Build a usable draft from the raw text when the LLM is unavailable. */
  private static mechanicalFallback(cleaned: string): IssueDraft {
    const text = cleaned || 'No description provided.';
    const firstLine = text.split('\n')[0].trim();
    const title = (firstLine.length > MAX_TITLE_CHARS ? firstLine.slice(0, MAX_TITLE_CHARS - 1) + '…' : firstLine)
      || 'New issue from Discord';
    return {
      title,
      body: text.slice(0, MAX_BODY_CHARS),
      type: 'task',
      fallback: true,
    };
  }
}
