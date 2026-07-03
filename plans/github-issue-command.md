# Plan: `/openrecapper-issue` — Describe It in Plain Text, LLM Drafts the GitHub Issue

## Goal

Add a Discord slash command **`/openrecapper-issue`** with **one free-text
input**: the user just describes the feature/bug/idea in plain language. An
**LLM turns that into a structured issue title + Markdown description**, the bot
files it on GitHub (**direct** REST call, no Cloudflare Worker), optionally
emails configured recipients, and then **replies publicly in the same channel**
to the user, showing the generated **title + description + a link to the issue**
so they can open it and **edit it on GitHub** if anything's off.

## Decisions locked in

- **Single plain-text input.** No separate `title` / `body` / `type` options —
  the LLM derives all of those from the user's description.
- **LLM drafting** reuses the existing relay LLM path (`RelayClient.summarize`,
  as `SummaryService` already does).
- **Direct GitHub call**, not via a Cloudflare Worker (bot already holds
  high-value secrets; a fine-grained PAT scoped to *Issues: write* on one repo is
  a low-blast-radius addition). Worker kept as a documented future alternative.
- **Public in-channel reply** (NOT ephemeral) that shows title, description, and
  the issue link, so the reporter (and others) can see it and edit on GitHub.
- **Email on creation** reuses the relay email path; recipients from
  `ISSUE_EMAIL_TO` only, no fallback (if unset, no issue emails).
- **Command name:** `openrecapper-issue`.

## Architecture

```
  Discord user
      │  /openrecapper-issue text:"the stop button doesn't work when two calls run"
      ▼
  Bot (this repo)
   • src/commands/openrecapper-issue.ts  – slash command, perms, rate limit
   • src/services/issue-draft-service.ts – LLM: raw text -> {title, body, type}
   • src/services/github-issue-client.ts – direct fetch() to GitHub REST API
      │
      │  1) IssueDraftService.draft(rawText)  ──► relay LLM ──► {title, body, type}
      │
      ├─►2) POST https://api.github.com/repos/{owner}/{repo}/issues
      │        Authorization: Bearer <GITHUB_TOKEN>
      │        { title, body, labels: [type] }  -> { html_url, number }
      │
      └─►3) (best-effort) RelayClient.email(recipient, …) per ISSUE_EMAIL_TO entry
      ▼
  4) PUBLIC reply in the same channel (embed):
       **#<n> <title>**  (links to <url>)
       <description preview>
       "Edit on GitHub if anything's off: <url>"
```

## Config additions (`src/config.ts`)

```ts
// GitHub issue filing (optional). Feature self-disables if token/owner/repo
// are unset (the command tells the user it's not configured).
GITHUB_TOKEN: process.env.GITHUB_TOKEN || '',        // fine-grained PAT, Issues:write, single repo
GITHUB_OWNER: process.env.GITHUB_OWNER || '',        // e.g. "anuraj"
GITHUB_REPO:  process.env.GITHUB_REPO  || '',        // e.g. "openrecapper"

// Who to email when an issue is filed. Comma-separated. Standalone — if unset,
// NO issue emails are sent (no fallback to SUMMARY_EMAIL_TO).
ISSUE_EMAIL_TO: process.env.ISSUE_EMAIL_TO || '',
```

`validateConfig()` does not hard-require these — optional feature. Note the LLM
drafting depends on the **relay** being configured (`RELAY_TOKEN`), which is
already an existing optional dependency.

## LLM drafting (`src/services/issue-draft-service.ts`)

New service, same shape/pattern as `SummaryService` (system + user prompt →
`RelayClient.summarize`), but with a **strict JSON output contract** so we can
map cleanly to a GitHub issue.

```ts
export interface IssueDraft { title: string; body: string; type: 'bug' | 'feature' | 'task'; }

export class IssueDraftService {
  static isConfigured(): boolean { return RelayClient.isConfigured(); }
  static async draft(rawText: string): Promise<IssueDraft>;  // see contract below
}
```

- **System prompt (role + contract):** "You convert a user's plain-text report
  into ONE GitHub issue. Output ONLY minified JSON with keys `title` (≤80 chars,
  imperative, no trailing period), `body` (GitHub-flavored Markdown), and `type`
  (`bug` | `feature` | `task`). For bugs, structure the body with **Steps to
  Reproduce / Expected / Actual** when derivable. Never invent details not
  implied by the input; if information is missing, note it rather than guessing."
- **User prompt:** the raw text (clamped to a sane max, e.g. ≤4000 chars).
- **Parsing:** strip any code fences, `JSON.parse`, validate keys, clamp lengths,
  coerce `type` to the allowed set (default `task`).
- **Fallback (robustness):** if the relay is **unconfigured**, or the LLM output
  is unparseable/invalid, fall back to a mechanical draft:
  `title` = first line / first ~70 chars of the raw text; `body` = the raw text
  verbatim; `type` = `task`. The command then notes the issue was filed from the
  raw text without AI formatting. This keeps the command functional whenever
  GitHub is configured, even if the relay is down.

## GitHub client (`src/services/github-issue-client.ts`)

Small, no SDK — Node's global `fetch`, same retry/timeout discipline as
`RelayClient.post`:

```ts
export class GithubIssueClient {
  static isConfigured(): boolean {
    return !!Config.GITHUB_TOKEN && !!Config.GITHUB_OWNER && !!Config.GITHUB_REPO;
  }
  static async createIssue(input: { title: string; body: string; labels?: string[] })
    : Promise<{ url: string; number: number }>;
  // POST /repos/{owner}/{repo}/issues
  //   headers: Authorization: Bearer <GITHUB_TOKEN>, Accept: application/vnd.github+json,
  //            User-Agent: <Config.BOT_NAME>  (GitHub requires a UA)
  //   body: { title, body, labels }  -> map { html_url, number } to { url, number }
  // 3-attempt backoff for transient/5xx; on non-2xx throw a sanitized error.
}
```

- **User-Agent header required** by GitHub — use `Config.BOT_NAME`.
- On non-2xx, log detail but throw a generic error (never surface GitHub's raw
  body to Discord).

## Command (`src/commands/openrecapper-issue.ts`)

- **Name:** `openrecapper-issue`.
- **Options (single):**
  - `text` (string, **required**) — "Describe the feature, bug, or idea in your
    own words." That's it. No title/body/type options.
- **Permissions (gated):** reuse the `/record` pattern — `ManageGuild` **or** an
  explicit per-guild grant (`hasRecordPermission`). The reply is public and it
  writes to a real repo, so don't leave it open to everyone.
- **Unconfigured (GitHub):** if `!GithubIssueClient.isConfigured()`, reply
  (ephemeral) `⚠️ Issue filing isn't configured on this bot.` and stop.
- **Rate limit:** simple per-user in-memory limiter (e.g. N/hour) to protect the
  repo/channel from spam bursts.
- **Attribution footer** appended to the issue body:
  `\n\n---\n_Filed from Discord by <@userId> in <#channelId>._`
- **Flow:**
  1. `deferReply()` — **public** (not ephemeral); LLM + GitHub may take a few
     seconds, so the "thinking…" state matters.
  2. `const draft = await IssueDraftService.draft(text)` (with fallback above).
  3. `const { url, number } = await GithubIssueClient.createIssue({ title: draft.title, body: draft.body + footer, labels: [draft.type] })`.
  4. Best-effort email to `ISSUE_EMAIL_TO` recipients (catch + note on failure).
  5. **Public reply** as an embed:
     - Embed **title**: `#<number> <draft.title>`, linked (`url`) to the issue.
     - Embed **description**: the drafted Markdown (Discord embed descriptions
       allow up to 4096 chars; truncate with a "…full text on GitHub" note if
       longer).
     - A line: `✏️ Not quite right? Edit it on GitHub: <url>`.
     - Embed footer: filed-by attribution + label; append the email warning if
       email failed, or a "drafted from raw text (AI unavailable)" note if the
       fallback was used.
  6. On `createIssue` failure: friendly public (or ephemeral) error, no email.

Note on "editing": the reporter edits the issue **on GitHub** via the link
(title/body are fully editable there). We are not building an in-Discord edit
flow in this MVP — the link is the edit affordance. (A future enhancement could
add "✏️ Edit / 🗑️ Close" buttons that call the GitHub API; see Open Questions.)

## Email-on-creation

Unchanged from prior decision:
- Recipients = `ISSUE_EMAIL_TO` (comma-separated), trimmed/filtered. **No
  fallback** — unset ⇒ no issue emails.
- Only if `RelayClient.isConfigured()` **and** ≥1 recipient; else skip silently.
- `RelayClient.email(to, …)` takes a single `to` → **loop** per recipient.
- **Best-effort, non-fatal:** email failure never fails the command or rolls back
  the issue; note it in the reply footer.

Email content:
```
Subject: [<BOT_NAME>] New issue #<n>: <title>
Body:
  A new issue was filed from Discord.

  #<n> <title>
  <url>

  Filed by @<user> in #<channel> (guild <guildId>)

  ---
  <body>
```

## Registration

- Add `openrecapperIssueCommand` to the `commands` collection in `src/index.ts`.
- Include it in `src/register-commands.ts` so the slash command is published.

## Env + docs

- `.env.example`: add `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO`,
  `ISSUE_EMAIL_TO`.
- README: short "GitHub issues (optional)" section — mint a fine-grained PAT
  (Issues: Read & Write on the one repo), note that drafting uses the relay LLM
  and email reuses the relay.

## Security & abuse considerations

- **Public repo ⇒ public issues**, and the **reply is public in-channel** too —
  whatever the user types (and the LLM's rendering of it) is visible to the
  channel and the world. Keep the command gated; say so in the description.
- **Prompt-injection awareness:** the raw text is untrusted and goes to the LLM.
  Keep the system prompt authoritative, constrain output to the JSON contract,
  and **validate/clamp** the parsed result (title length, allowed `type`) rather
  than trusting the model blindly. The model only drafts text — it never chooses
  the repo, labels beyond the mapped `type`, or recipients.
- **Least-privilege token:** fine-grained PAT, *Issues: write* on the single
  target repo only. Rotate periodically.
- **No secret/detail leakage:** generic errors to Discord; details to logs.
- **Attribution footer** on every issue.

## Scope / effort

- **Small–medium, additive.** New: `issue-draft-service.ts` (~70 lines),
  `github-issue-client.ts` (~60 lines), `openrecapper-issue.ts` (~110 lines).
  Edits: `config.ts` (4 vars), `index.ts` + `register-commands.ts`,
  `.env.example`, README.
- No Worker, no `wrangler`, no new deploy. No changes to the recording pipeline.

## Testing plan

1. **IssueDraftService:** valid LLM JSON → parsed draft; fenced JSON → stripped
   and parsed; malformed output → mechanical fallback; relay unconfigured →
   mechanical fallback; `type` coerced to allowed set; title/body clamped.
2. **GithubIssueClient:** `isConfigured()` gating; maps `{ html_url, number }` →
   `{ url, number }`; non-2xx throws sanitized error.
3. **Command:** GitHub unconfigured → "not configured", no calls; unauthorized
   user → denied, no calls; rate limit trips after N; public reply embed shows
   title, description, and edit link.
4. **Email:** `ISSUE_EMAIL_TO` set + relay configured → one email per recipient;
   email failure → issue still created, reply footer notes the warning; unset →
   no email.
5. **End-to-end:** against a throwaway test repo, run `/openrecapper-issue` with a
   messy plain-text bug report; confirm a well-formed issue (title/body/label +
   attribution footer) appears, the public channel reply links to it, editing on
   GitHub works, and the email arrives (if configured).

## Open questions / decisions

1. **Email recipients:** DECIDED — dedicated `ISSUE_EMAIL_TO` only, no fallback.
2. **In-Discord editing:** MVP uses the GitHub link as the edit affordance.
   Optional future enhancement: message buttons ("✏️ Edit title/body", "🗑️
   Close") that PATCH the issue via the API. Not in scope now.
3. **Reply visibility on failure:** success reply is public; should a *failed*
   attempt be ephemeral (less channel noise) or public? (Recommend: ephemeral on
   failure, public on success.)
4. **One repo or per-guild routing:** MVP single repo via env; guild→repo map
   later if needed.

## Alternative (not chosen): Cloudflare Worker

Routing through a Worker keeps the GitHub credential off the bot host and
centralizes rate-limiting/abuse control — worthwhile for a multi-tenant/hosted
deployment. For this self-hosted, single-operator bot the direct approach is
simpler and the security delta is small. The Worker remains a clean future
upgrade: point `GithubIssueClient` at the Worker instead of GitHub, moving the
token off-host without touching the command or the LLM drafting.
