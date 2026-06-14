import { Config } from '../config';

/**
 * Client for the optional "relay" HTTP service at Config.RELAY_URL. The relay
 * bridges to an LLM provider (for summaries) and an email gateway, so this bot
 * needs no third-party LLM/email API keys directly. If RELAY_TOKEN is unset the
 * bot still records and transcribes; summaries + email are simply skipped.
 *
 * Expected relay API (you provide the implementation):
 *   POST /summarize { system, prompt, model?, maxTokens } -> { text }
 *   POST /email     { to, subject, body }                 -> 200 OK
 * Both authenticated with the `X-Relay-Token` header.
 */
export class RelayClient {
  static isConfigured(): boolean {
    return !!Config.RELAY_TOKEN && !!Config.RELAY_URL;
  }

  private static async post(path: string, body: any, timeoutMs: number): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${Config.RELAY_URL}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Relay-Token': Config.RELAY_TOKEN,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(`relay ${path} ${res.status}: ${data?.error || 'unknown error'}`);
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Generate a summary via the LLM Gateway. Returns the Markdown text. */
  static async summarize(system: string, prompt: string, maxTokens = 2500): Promise<string> {
    const data = await this.post('/summarize', {
      system,
      prompt,
      model: Config.SUMMARY_MODEL || undefined,
      maxTokens,
    }, 120_000);
    return (data.text || '').trim();
  }

  /** Send a plain-text email via the relay's email gateway. */
  static async email(to: string, subject: string, body: string): Promise<void> {
    await this.post('/email', { to, subject, body }, 30_000);
  }
}
