import { Config } from '../config';

/**
 * Minimal client for filing issues on GitHub directly from the bot (no SDK,
 * no companion Worker). Uses a fine-grained PAT (Config.GITHUB_TOKEN) scoped to
 * "Issues: write" on the single target repo (Config.GITHUB_OWNER/GITHUB_REPO).
 *
 * The feature self-disables when any of token/owner/repo are unset; the
 * /openrecapper-issue command checks isConfigured() first.
 */
export interface CreatedIssue {
  url: string;
  number: number;
}

export class GithubIssueClient {
  static isConfigured(): boolean {
    return !!Config.GITHUB_TOKEN && !!Config.GITHUB_OWNER && !!Config.GITHUB_REPO;
  }

  /**
   * Create a GitHub issue. Retries transient/5xx failures with backoff; throws a
   * sanitized Error on non-2xx (details are logged, never surfaced to Discord).
   */
  static async createIssue(input: {
    title: string;
    body: string;
    labels?: string[];
  }): Promise<CreatedIssue> {
    const url = `https://api.github.com/repos/${Config.GITHUB_OWNER}/${Config.GITHUB_REPO}/issues`;
    const payload = {
      title: input.title,
      body: input.body,
      ...(input.labels && input.labels.length ? { labels: input.labels } : {}),
    };

    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${Config.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'X-GitHub-Api-Version': '2022-11-28',
            // GitHub rejects requests without a User-Agent.
            'User-Agent': Config.BOT_NAME || 'OpenRecapper',
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        if (res.ok) {
          const data: any = await res.json().catch(() => ({}));
          if (!data?.html_url || typeof data?.number !== 'number') {
            throw new Error('GitHub returned an unexpected issue payload');
          }
          return { url: data.html_url, number: data.number };
        }

        // Read body for logs only; never surface to Discord.
        const detail = await res.text().catch(() => '');
        console.error(`[GithubIssueClient] create issue ${res.status}: ${detail.slice(0, 500)}`);
        // 4xx (bad token, perms, validation, rate-limit-with-no-retry) won't be
        // fixed by retrying — fail fast. Only 5xx/429 fall through to backoff.
        if (res.status < 500 && res.status !== 429) {
          throw new Error(`GitHub responded ${res.status}`);
        }
        lastError = new Error(`GitHub responded ${res.status}`);
      } catch (err) {
        // AbortError / network failure — retryable. (Non-retryable 4xx is thrown
        // above and re-thrown here below.)
        lastError = err;
        console.warn(`[GithubIssueClient] attempt ${attempt}/3 failed:`, err);
        // Re-throw non-retryable 4xx immediately (finally still clears the timer).
        if (err instanceof Error && /^GitHub responded 4\d\d$/.test(err.message)) {
          throw err;
        }
      } finally {
        clearTimeout(timer);
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 2_000));
    }
    throw lastError instanceof Error ? lastError : new Error('Failed to create GitHub issue');
  }
}
